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
