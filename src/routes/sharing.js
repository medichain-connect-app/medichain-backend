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

/** GET /api/sharing/with-doctor?doctorId= — record ids the patient shares now. */
router.get(
  '/with-doctor',
  asyncHandler(async (req, res) => {
    const { doctorId } = req.query;
    if (!doctorId) return res.status(400).json({ error: 'doctorId is required' });
    const { data, error } = await req.supabase
      .from('shared_records')
      .select('record_id')
      .eq('patient_id', req.user.id)
      .eq('doctor_id', doctorId)
      .filter('revoked_at', 'is', null);
    if (error) throw error;
    res.json((data || []).map((r) => r.record_id));
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
      (s) => !s.expires_at || new Date(s.expires_at).getTime() > now
    );
    res.json(filtered);
  })
);

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

  for (const recordId of recordIds) {
    try {
      const { data: row } = await admin
        .from('medical_records')
        .select('encrypted_key, iv')
        .eq('id', recordId)
        .maybeSingle();
      if (!row) continue;
      const encryptedKeyForDoctor = `${row.encrypted_key}|${row.iv}`;
      await contractService.grantAccess({
        patientProfileId,
        doctorAddress: doctorWallet,
        recordUuid: recordId,
        encryptedKeyForDoctor,
        expiresAt: expiresAtUnix,
      });
    } catch (e) {
      console.error(`[sharing] grantAccess for ${recordId} failed:`, e.message);
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
  return walletService.getAddress(doctor.profile_id);
}

module.exports = router;
