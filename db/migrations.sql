-- ───────────────────────────────────────────────────────────────────────────
-- MediChain backend — one-time database migration.
--
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query) for
-- the project the backend points at. It adds the table the backend needs to
-- custody each user's Ethereum wallet.
--
-- Everything else (profiles, doctors, patients, medical_records,
-- doctor_requests, appointment_requests, shared_records) is assumed to already
-- exist from the original app.
-- ───────────────────────────────────────────────────────────────────────────

-- Server-custodied Ethereum wallets. The private key is AES-256-GCM encrypted
-- by the backend (WALLET_ENCRYPTION_KEY) before it is stored here.
create table if not exists public.user_wallets (
  profile_id     uuid primary key references public.profiles (id) on delete cascade,
  address        text not null,
  encrypted_key  text not null,
  created_at     timestamptz not null default now()
);

-- RLS on, with NO policies: only the backend's service_role key (which bypasses
-- RLS) can read/write this table. The anon/authenticated keys never touch it.
alter table public.user_wallets enable row level security;

-- profiles.wallet_address is written by the original app; make sure it exists.
alter table public.profiles
  add column if not exists wallet_address text;

-- ── Sharing with expiry and revocation (safe to re-run) ─────────────────────
alter table public.shared_records
  add column if not exists revoked_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists shared_at  timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.shared_records'::regclass
      and conname = 'shared_records_record_doctor_unique'
  ) then
    alter table public.shared_records
      add constraint shared_records_record_doctor_unique unique (record_id, doctor_id);
  end if;
end $$;

-- ── How long doctors view shared records ───────────────────────────────────
-- One row per time a doctor opens a shared record in the secure viewer.
-- active_seconds counts only time the record was on screen. Written and read
-- only by the backend (service role); RLS on with no policies.
create table if not exists public.record_view_sessions (
  id                 uuid primary key default gen_random_uuid(),
  record_id          uuid not null references public.medical_records (id) on delete cascade,
  patient_id         uuid not null,
  doctor_profile_id  uuid not null references public.profiles (id) on delete cascade,
  started_at         timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  ended_at           timestamptz,
  active_seconds     integer not null default 0
);

create index if not exists record_view_sessions_record_idx
  on public.record_view_sessions (record_id, started_at);

alter table public.record_view_sessions enable row level security;
