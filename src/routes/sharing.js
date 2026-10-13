'use strict';

const express = require('express');
const { admin } = require('../supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, resolveDoctorId } = require('../util');
const contractService = require('../services/contractService');
const walletService = require('../services/walletService');

const router = express.Router();
router.use(requireAuth);

/**
 * POST /api/sharing/share — share records with a doctor.
 * Body: { recordIds: [], doctorId, expiresAt? (ISO or null) }
 * Upserts shared_records then best-effort grants on-chain access.
 */
router.post(
  '/share',
  asyncHandler(async (req, res) => {
    const { recordIds, doctorId, expiresAt } = req.body;
    if (!Array.isArray(recordIds) || !recordIds.length || !doctorId) {
      return res
        .status(400)
        .json({ error: 'recordIds[] and doctorId are required' });
    }

    if (expiresAt && !(new Date(expiresAt).getTime() > Date.now())) {
      return res.status(400).json({ error: 'expiresAt must be a future date' });
    }
    const expiresAtIso = expiresAt ? new Date(expiresAt).toISOString() : null;
    const rows = recordIds.map((rid) => ({
      record_id: rid,
      patient_id: req.user.id,
      doctor_id: doctorId,
      revoked_at: null,
      expires_at: expiresAtIso,
    }));

    const { error } = await req.supabase
      .from('shared_records')
      .upsert(rows, { onConflict: 'record_id,doctor_id' });
    if (error) throw error;

    // Blockchain grant — fire-and-forget, never blocks the response.
    grantBlockchainAccess({
      patientProfileId: req.user.id,
      recordIds,
      doctorId,
      expiresAt: expiresAtIso,
    }).catch((e) =>
      console.error('[sharing] blockchain grant failed (non-fatal):', e.message)
    );

    res.json({ count: rows.length });
  })
);

/**
 * POST /api/sharing/revoke — revoke one share.
 * Body: { recordId, doctorId }
 */
router.post(
  '/revoke',
  asyncHandler(async (req, res) => {
    const { recordId, doctorId } = req.body;
    if (!recordId || !doctorId) {
      return res.status(400).json({ error: 'recordId and doctorId are required' });
    }

    const { error } = await req.supabase
      .from('shared_records')
      .update({ revoked_at: new Date().toISOString() })
      .eq('record_id', recordId)
      .eq('doctor_id', doctorId);
    if (error) throw error;

    revokeBlockchainAccess({
      patientProfileId: req.user.id,
      recordId,
      doctorId,
    }).catch((e) =>
      console.error('[sharing] blockchain revoke failed (non-fatal):', e.message)
    );

    res.json({ ok: true });
  })
);

/**
 * GET /api/sharing/mine — every record the patient currently shares (not
 * revoked), with record + doctor details and expiry, newest first. Expired
 * shares are included and flagged so the patient can see and clear them.
 */
router.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const { data: shares, error } = await req.supabase
      .from('shared_records')
      .select('id, record_id, doctor_id, shared_at, expires_at')
      .eq('patient_id', req.user.id)
      .filter('revoked_at', 'is', null)
      .order('shared_at', { ascending: false });
    if (error) throw error;
    if (!shares || !shares.length) return res.json([]);

    const recordIds = [...new Set(shares.map((s) => s.record_id))];
    const doctorIds = [...new Set(shares.map((s) => s.doctor_id))];
    const [{ data: records, error: rErr }, { data: doctors, error: dErr }] = await Promise.all([
      req.supabase.from('medical_records').select('id, title, category').in('id', recordIds),
      req.supabase.from('doctors').select('id, name, specialization, hospital_name').in('id', doctorIds),
    ]);
    if (rErr) throw rErr;
    if (dErr) throw dErr;

    const recordById = new Map((records || []).map((r) => [r.id, r]));
    const doctorById = new Map((doctors || []).map((d) => [d.id, d]));
    const now = Date.now();

    res.json(
      shares
        // Drop shares whose record has since been deleted.
        .filter((s) => recordById.has(s.record_id))
        .map((s) => {
          const record = recordById.get(s.record_id);
          const doctor = doctorById.get(s.doctor_id) || {};
          return {
            id: s.id,
            recordId: s.record_id,
            recordTitle: record.title,
            recordCategory: record.category,
            doctorId: s.doctor_id,
            doctorName: doctor.name || null,
            doctorSpecialization: doctor.specialization || null,
            doctorHospital: doctor.hospital_name || null,
            sharedAt: toIso(s.shared_at),
            expiresAt: toIso(s.expires_at),
            expired: !!s.expires_at && new Date(toIso(s.expires_at)).getTime() <= now,
          };
        })
    );
  })
);

/**
 * GET /api/sharing/with-doctor?doctorId= — record ids the patient currently
 * shares with this doctor. Expired shares don't count, so they can be re-shared.
 */
router.get(
  '/with-doctor',
  asyncHandler(async (req, res) => {
    const { doctorId } = req.query;
    if (!doctorId) return res.status(400).json({ error: 'doctorId is required' });
    const { data, error } = await req.supabase
      .from('shared_records')
      .select('record_id, expires_at')
      .eq('patient_id', req.user.id)
      .eq('doctor_id', doctorId)
      .filter('revoked_at', 'is', null);
    if (error) throw error;
    const now = Date.now();
    res.json(
      (data || [])
        .filter((r) => !r.expires_at || new Date(toIso(r.expires_at)).getTime() > now)
        .map((r) => r.record_id)
    );
  })
);

/**
 * GET /api/sharing/with-me?patientId= — records shared WITH the logged-in doctor
 * (optionally scoped to one patient). Expired shares are filtered out.
 */
router.get(
  '/with-me',
  asyncHandler(async (req, res) => {
    const doctorId = await resolveDoctorId(req.supabase, req.user.id);
    if (!doctorId) return res.json([]);

    let query = req.supabase
      .from('shared_records')
      .select(
        'id, shared_at, patient_id, expires_at, record:medical_records!record_id(*)'
      )
      .eq('doctor_id', doctorId)
      .filter('revoked_at', 'is', null);

    if (req.query.patientId) query = query.eq('patient_id', req.query.patientId);

    const { data, error } = await query.order('shared_at', { ascending: false });
    if (error) throw error;

    const now = Date.now();
    const filtered = (data || []).filter(
      (s) => !s.expires_at || new Date(toIso(s.expires_at)).getTime() > now
    );
    res.json(filtered);
  })
);

/**
 * Normalize a database timestamp to ISO-8601 UTC. A `timestamp without time
 * zone` column comes back with no offset, which browsers would read as local
 * time and shift every expiry by the viewer's UTC offset.
 */
function toIso(value) {
  if (!value) return null;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : `${value}Z`).toISOString();
}

// ── Blockchain helpers (fire-and-forget) ────────────────────────────────────

async function grantBlockchainAccess({
  patientProfileId,
  recordIds,
  doctorId,
  expiresAt,
}) {
  const doctorWallet = await doctorWalletAddress(doctorId);
  if (!doctorWallet) {
    console.warn('[sharing] doctor has no wallet — skipping blockchain grant');
    return;
  }
  const expiresAtUnix = expiresAt
    ? Math.floor(new Date(expiresAt).getTime() / 1000)
    : 0;

  // Grants are relayed one at a time; the record's AES key never goes on-chain.
  for (const recordId of recordIds) {
    try {
      await contractService.grantAccess({
        patientProfileId,
        doctorAddress: doctorWallet,
        recordUuid: recordId,
        expiresAt: expiresAtUnix,
      });
    } catch (e) {
      console.error(`[sharing] grantAccess for ${recordId} failed:`, e.shortMessage || e.message);
    }
  }
}

async function revokeBlockchainAccess({ patientProfileId, recordId, doctorId }) {
  const doctorWallet = await doctorWalletAddress(doctorId);
  if (!doctorWallet) {
    console.warn('[sharing] doctor has no wallet — skipping blockchain revoke');
    return;
  }
  await contractService.revokeAccess({
    patientProfileId,
    doctorAddress: doctorWallet,
    recordUuid: recordId,
  });
}

async function doctorWalletAddress(doctorId) {
  const { data: doctor } = await admin
    .from('doctors')
    .select('profile_id')
    .eq('id', doctorId)
    .maybeSingle();
  if (!doctor) return null;
  // Creates the doctor's wallet if their account predates wallets.
  return walletService.ensureWallet(doctor.profile_id);
}

module.exports = router;
