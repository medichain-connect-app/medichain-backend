# MediChain — Backend

A standalone **Express / Node.js** API server that holds all of MediChain's
backend logic. It was extracted out of the Flutter app's `lib/services/` so it
can run on its own server, exactly like the `blockchain/` folder runs the
Hardhat node separately.

The Flutter app (`../lib`) is now a pure frontend: it talks **only** to this
server over HTTP and never touches Supabase, Pinata, or the blockchain directly.

## What lives here

| Concern | Was (Flutter) | Now (this server) |
|---|---|---|
| Auth + profiles | `supabase_service.dart` | `routes/auth.js`, `routes/profiles.js` |
| Doctors / connections | direct Supabase in screens | `routes/doctors.js`, `routes/doctorRequests.js` |
| Appointments | `appointment_service.dart` | `routes/appointments.js` |
| Records (list/get/delete) | `records_service.dart` | `routes/records.js` |
| Upload (encrypt→pin→save) | `upload_service.dart` | `routes/records.js` (`POST /upload`) |
| AES-256 encryption | `encryption_service.dart` | `services/encryptionService.js` |
| IPFS / Pinata | `pinata_service.dart` | `services/pinataService.js` |
| Sharing | `sharing_service.dart` | `routes/sharing.js` |
| Blockchain contract | `contract_service.dart` | `services/contractService.js`, `routes/blockchain.js` |
| Ethereum wallet | `wallet_service.dart` (on device) | `services/walletService.js` (server-custodied) |

Secrets that used to ship inside the APK (the Pinata JWT, the blockchain
signing key) now live only on the server.

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- A [Supabase](https://supabase.com) project (the same one the app already uses)
- A [Pinata](https://app.pinata.cloud) account (IPFS pinning)
- Optional: a running blockchain node (local Hardhat from `../blockchain`, or a
  Polygon RPC) if you want the on-chain access log / grants to work

## Setup

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Configure secrets

```bash
cp .env .env
```

Fill in `.env`:

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — Project settings → API.
- `SUPABASE_SERVICE_ROLE_KEY` — same page, the **service_role** secret. Server-only.
- `PINATA_JWT`, `PINATA_GATEWAY` — Pinata API key (with `pinFileToIPFS`) + gateway subdomain.
- `BLOCKCHAIN_RPC_URL`, `BLOCKCHAIN_CHAIN_ID`, `CONTRACT_ADDRESS` — your node + deployed contract.
- `WALLET_ENCRYPTION_KEY` — 32-byte hex for encrypting custodied keys. Generate one:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `RESEND_API_KEY` (optional) — enables appointment-confirmation emails.

### 3. Run the database migration

The server needs one new table (`user_wallets`) to custody each user's Ethereum
key. Open the Supabase dashboard → **SQL Editor** → paste and run
[`db/migrations.sql`](db/migrations.sql). It's safe to run more than once.

### 4. Start the server

```bash
npm run dev     # auto-restart on change (node --watch)
# or
npm start
```

You should see:

```
MediChain backend listening on http://localhost:3000
```

Sanity check:

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"medichain-backend"}
```

## How the Flutter app finds this server

The app reads `API_BASE_URL` from its own `../.env`. See the
[root README](../README.md#running-the-project) for the emulator/device values:

| Runs on | `API_BASE_URL` |
|---|---|
| Android emulator | `http://10.0.2.2:3000` |
| iOS simulator / desktop / web | `http://localhost:3000` |
| Physical phone (same Wi-Fi) | `http://<your-laptop-LAN-IP>:3000` |

## API surface

All endpoints are under `/api`. Everything except `POST /api/auth/signup` and
`POST /api/auth/login` requires an `Authorization: Bearer <access_token>` header
(the token returned by login). User-scoped queries run under that user's
Supabase Row-Level Security, exactly as the app did before.

```
POST   /api/auth/signup            { email, password, fullName, role }
POST   /api/auth/login             { email, password }
POST   /api/auth/refresh           { refresh_token }
GET    /api/auth/me
GET    /api/auth/role

GET    /api/profiles/me
PATCH  /api/profiles/me            { full_name }
GET    /api/profiles/me/stats
POST   /api/profiles/wallet        { wallet_address }

GET    /api/patients/me
PUT    /api/patients/me            { date_of_birth, gender, ... }

GET    /api/doctors                [?specialization= | ?ids=a,b]
GET    /api/doctors/specializations
GET    /api/doctors/me
PUT    /api/doctors/me             { fullName, doctor: {...} }
GET    /api/doctors/:id
GET    /api/doctors/:id/wallet

GET    /api/doctor-requests/mine
GET    /api/doctor-requests/mine/accepted-doctors?limit=
GET    /api/doctor-requests/status?doctorId=
POST   /api/doctor-requests        { doctorId }
GET    /api/doctor-requests/incoming?status=
GET    /api/doctor-requests/incoming/accepted
GET    /api/doctor-requests/incoming/accepted/count
GET    /api/doctor-requests/:id
PATCH  /api/doctor-requests/:id    { status }

POST   /api/appointments           { doctorId, preferredDate, preferredTime, notes? }
GET    /api/appointments/exists?doctorId=
GET    /api/appointments/pending
GET    /api/appointments/pending/count
POST   /api/appointments/:id/confirm  { patientEmail, ... }
DELETE /api/appointments/:id

GET    /api/records
POST   /api/records/upload         (multipart: file, title, category)
GET    /api/records/:id
GET    /api/records/:id/download    → decrypted bytes
DELETE /api/records/:id

POST   /api/sharing/share          { recordIds[], doctorId, expiresAt? }
POST   /api/sharing/revoke         { recordId, doctorId }
GET    /api/sharing/with-doctor?doctorId=
GET    /api/sharing/with-me?patientId=

GET    /api/blockchain/access-log?recordUuid=
GET    /api/blockchain/has-access?doctorAddress=&recordUuid=
GET    /api/blockchain/doctors-with-access?recordUuid=
GET    /api/blockchain/encrypted-key?recordUuid=
POST   /api/blockchain/log-view     { recordUuid }
POST   /api/blockchain/log-download { recordUuid }

GET    /api/wallet/address
```

## Deploying to another server

This is a plain Express app — deploy it anywhere Node runs (Render, Railway,
Fly.io, a VPS, etc.):

1. Set the same `.env` variables in the host's environment.
2. Run the `db/migrations.sql` migration against your Supabase project once.
3. `npm ci && npm start` (or a process manager like `pm2`).
4. Point the Flutter app's `API_BASE_URL` at the deployed HTTPS URL.

> Note on the blockchain: if you deploy the API to the cloud but keep using a
> **local** Hardhat node, the server won't be able to reach `127.0.0.1:8545`.
> Either run the node on the same host, or point `BLOCKCHAIN_RPC_URL` at a
> public RPC (Polygon Amoy/mainnet) with the contract deployed there.
