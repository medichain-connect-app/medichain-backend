'use strict';

const express = require('express');
const { admin } = require('../supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, resolveDoctorId } = require('../util');
const contractService = require('../services/contractService');
const walletService = require('../services/walletService');
const { recordAccessEvents, loadAccessEvents } = require('../services/auditService');

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

    // Off-chain audit entry, written before responding so the access history
    // shows the grant right away, whatever happens on-chain.
    await recordAccessEvents({
      action: 'granted',
      recordIds,
      patientId: req.user.id,
      doctorId,
      expiresAt: expiresAtIso,
    });

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

    // Only an active share is revoked, so a repeat click keeps the original
    // revoke time and doesn't log a second revoke.
    const { data: revoked, error } = await req.supabase
      .from('shared_records')
      .update({ revoked_at: new Date().toISOString() })
      .eq('record_id', recordId)
      .eq('doctor_id', doctorId)
      .eq('patient_id', req.user.id)
      .filter('revoked_at', 'is', null)
      .select('record_id');
    if (error) throw error;
    if (!revoked || !revoked.length) return res.json({ ok: true, alreadyRevoked: true });

    await recordAccessEvents({
      action: 'revoked',
      recordIds: [recordId],
      patientId: req.user.id,
      doctorId,
    });

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
 * GET /api/sharing/mine — records the patient currently shares (not revoked,
 * not expired), with record + doctor details and expiry, newest first. Expired
 * shares are left out: access has already ended, and the record's access
 * history shows when.
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
        // Drop shares that have expired or whose record has been deleted.
        .filter((s) => !s.expires_at || new Date(toIso(s.expires_at)).getTime() > now)
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
 * GET /api/sharing/activity — the patient's access log across all their
 * records, newest first: every grant (with its expiry), revoke, automatic
 * expiry and doctor view (with how long it lasted).
 */
router.get(
  '/activity',
  asyncHandler(async (req, res) => {
    const patientId = req.user.id;
    const [events, { data: sessions, error: sErr }, { data: records, error: rErr }] = await Promise.all([
      loadAccessEvents({ patientId, limit: 1000 }),
      admin
        .from('record_view_sessions')
        .select('id, record_id, doctor_profile_id, started_at, last_seen_at, ended_at, active_seconds')
        .eq('patient_id', patientId)
        .order('started_at', { ascending: false })
        .limit(500),
      req.supabase.from('medical_records').select('id, title, category').eq('patient_id', patientId),
    ]);
    if (rErr) throw rErr;
    if (sErr) console.error('[sharing] loading view sessions failed:', sErr.message);

    const recordById = new Map((records || []).map((r) => [r.id, r]));

    // Doctor names for views (sessions store the doctor's profile id).
    const viewerIds = [...new Set((sessions || []).map((s) => s.doctor_profile_id))];
    const viewerNames = {};
    if (viewerIds.length) {
      const { data: doctors } = await admin.from('doctors').select('profile_id, name').in('profile_id', viewerIds);
      for (const d of doctors || []) viewerNames[d.profile_id] = d.name;
    }

    const now = Date.now();
    const items = [];
    events.forEach((e, i) => {
      items.push({
        id: e.id,
        action: e.action,
        recordId: e.record_id,
        doctorId: e.doctor_id,
        doctorName: e.doctor_name,
        at: e.created_at,
        expiresAt: e.action === 'granted' ? e.expires_at : undefined,
      });
      // Expiry needs no request, so it is derived: the grant ran out before
      // the next grant/revoke for the same record and doctor (or before now).
      if (e.action !== 'granted' || !e.expires_at) return;
      const next = events
        .slice(i + 1)
        .find((n) => n.record_id === e.record_id && n.doctor_id === e.doctor_id);
      const endedAt = next ? new Date(next.created_at).getTime() : now;
      if (new Date(e.expires_at).getTime() <= endedAt) {
        items.push({
          id: `${e.id}-expired`,
          action: 'expired',
          recordId: e.record_id,
          doctorId: e.doctor_id,
          doctorName: e.doctor_name,
          at: e.expires_at,
        });
      }
    });
    for (const s of sessions || []) {
      items.push({
        id: s.id,
        action: 'viewed',
        recordId: s.record_id,
        doctorName: viewerNames[s.doctor_profile_id] || null,
        at: toIso(s.started_at),
        viewSeconds: s.active_seconds,
        viewOngoing: !s.ended_at && now - new Date(toIso(s.last_seen_at)).getTime() < 60 * 1000,
      });
    }

    res.json(
      items
        .filter((it) => recordById.has(it.recordId))
        .map((it) => ({
          ...it,
          recordTitle: recordById.get(it.recordId).title,
          recordCategory: recordById.get(it.recordId).category || null,
        }))
        .sort((a, b) => new Date(b.at) - new Date(a.at))
        .slice(0, 500)
    );
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
