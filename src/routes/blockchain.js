'use strict';

const express = require('express');
const { admin } = require('../supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../util');
const contractService = require('../services/contractService');
const { loadAccessEvents } = require('../services/auditService');

const router = express.Router();
router.use(requireAuth);

/** GET /api/blockchain/info — network + contract details for explorer links. */
router.get('/info', (_req, res) => res.json(contractService.networkInfo()));

/**
 * GET /api/blockchain/access-log?recordUuid= — the record's on-chain audit log,
 * with doctor/patient names added. Only the record's patient, or a doctor it is
 * shared with, can see it (enforced by Supabase RLS on medical_records).
 */
router.get(
  '/access-log',
  asyncHandler(async (req, res) => {
    const { recordUuid } = req.query;
    if (!recordUuid) return res.status(400).json({ error: 'recordUuid is required' });

    const { data: record, error } = await req.supabase
      .from('medical_records')
      .select('id')
      .eq('id', recordUuid)
      .maybeSingle();
    if (error) throw error;
    if (!record) return res.status(404).json({ error: 'Record not found' });

    // ?withExpiry=1 adds each grant's expiry and derived "expired" entries.
    const withExpiry = req.query.withExpiry === '1';
    const [chainEntries, events] = await Promise.all([
      contractService.getAccessLog(recordUuid, { withExpiry }),
      loadAccessEvents({ recordId: recordUuid }),
    ]);
    const people = await profilesForAddresses(
      chainEntries.flatMap((e) => [e.doctorAddress, e.patientAddress])
    );
    const named = chainEntries
      // Expiries are derived again below, over on-chain and off-chain grants.
      .filter((e) => e.action !== 'expired')
      .map((e) => ({
        ...e,
        doctorKey: people[e.doctorAddress.toLowerCase()]?.profileId || e.doctorAddress.toLowerCase(),
        doctorName: people[e.doctorAddress.toLowerCase()]?.name || null,
        patientName: people[e.patientAddress.toLowerCase()]?.name || null,
      }));
    const merged = withOffChainEvents(named, events, withExpiry);
    const log = await withViewDurations(merged, recordUuid, people);
    res.json(withExpiry ? withExpiredEntries(log) : log);
  })
);

/** GET /api/blockchain/has-access?doctorAddress=&recordUuid= */
router.get(
  '/has-access',
  asyncHandler(async (req, res) => {
    const { doctorAddress, recordUuid } = req.query;
    if (!doctorAddress || !recordUuid) {
      return res
        .status(400)
        .json({ error: 'doctorAddress and recordUuid are required' });
    }
    res.json({ hasAccess: await contractService.hasAccess({ doctorAddress, recordUuid }) });
  })
);

/** GET /api/blockchain/doctors-with-access?recordUuid= */
router.get(
  '/doctors-with-access',
  asyncHandler(async (req, res) => {
    const { recordUuid } = req.query;
    if (!recordUuid) return res.status(400).json({ error: 'recordUuid is required' });
    res.json(await contractService.getDoctorsWithAccess(recordUuid));
  })
);

/** POST /api/blockchain/log-view — Body: { recordUuid }. Best-effort. */
router.post(
  '/log-view',
  asyncHandler(async (req, res) => {
    const { recordUuid } = req.body;
    if (!recordUuid) return res.status(400).json({ error: 'recordUuid is required' });
    const tx = await contractService.logView({
      doctorProfileId: req.user.id,
      recordUuid,
    });
    res.json({ ok: true, tx });
  })
);

/** POST /api/blockchain/log-download — Body: { recordUuid }. Best-effort. */
router.post(
  '/log-download',
  asyncHandler(async (req, res) => {
    const { recordUuid } = req.body;
    if (!recordUuid) return res.status(400).json({ error: 'recordUuid is required' });
    const tx = await contractService.logDownload({
      doctorProfileId: req.user.id,
      recordUuid,
    });
    res.json({ ok: true, tx });
  })
);

/** Map wallet addresses (lowercased) → { profileId, name }. */
async function profilesForAddresses(addresses) {
  const unique = [...new Set(addresses)];
  if (!unique.length) return {};
  const { data } = await admin
    .from('user_wallets')
    .select('address, profile_id, profile:profiles!profile_id(full_name)')
    .in('address', unique);
  const people = {};
  for (const row of data || []) {
    people[row.address.toLowerCase()] = {
      profileId: row.profile_id,
      name: (row.profile && row.profile.full_name) || null,
    };
  }
  return people;
}

// A view's on-chain entry is written when the file is served, a moment before
// the viewer starts its session; pair them if they're this close together.
const SESSION_MATCH_MS = 5 * 60 * 1000;
// A session that hasn't reported for this long is no longer open.
const SESSION_STALE_MS = 60 * 1000;

/**
 * Add how long each view lasted (`viewSeconds`, `viewOngoing`) to the matching
 * on-chain "viewed" entry. Durations are measured by the viewer's heartbeats
 * and stored off-chain — reporting every few seconds on-chain would cost gas
 * for each report. Sessions with no matching on-chain entry (e.g. the chain
 * write failed) are added as off-chain "viewed" entries.
 */
async function withViewDurations(entries, recordUuid, people) {
  const { data: sessions, error } = await admin
    .from('record_view_sessions')
    .select('id, doctor_profile_id, started_at, last_seen_at, ended_at, active_seconds')
    .eq('record_id', recordUuid)
    .order('started_at', { ascending: true });
  if (error) {
    // The table may not exist yet; the log is still useful without durations.
    console.error('[blockchain] loading view sessions failed:', error.message);
    return entries;
  }

  const now = Date.now();
  const unmatched = new Set((sessions || []).map((s) => s.id));
  const describe = (s) => ({
    viewSeconds: s.active_seconds,
    viewOngoing: !s.ended_at && now - new Date(s.last_seen_at).getTime() < SESSION_STALE_MS,
  });

  const result = entries.map((e) => {
    if (e.action !== 'viewed') return e;
    const profileId = people[e.doctorAddress.toLowerCase()]?.profileId;
    const at = new Date(e.timestamp).getTime();
    let best = null;
    for (const s of sessions || []) {
      if (!unmatched.has(s.id) || s.doctor_profile_id !== profileId) continue;
      const gap = Math.abs(new Date(s.started_at).getTime() - at);
      if (gap <= SESSION_MATCH_MS && (!best || gap < best.gap)) best = { s, gap };
    }
    if (!best) return e;
    unmatched.delete(best.s.id);
    return { ...e, ...describe(best.s) };
  });

  const byProfile = Object.entries(people).reduce((m, [address, p]) => {
    m[p.profileId] = { address, name: p.name };
    return m;
  }, {});
  const missing = [...new Set((sessions || [])
    .filter((s) => unmatched.has(s.id) && !byProfile[s.doctor_profile_id])
    .map((s) => s.doctor_profile_id))];
  if (missing.length) {
    const { data: profiles } = await admin.from('profiles').select('id, full_name, wallet_address').in('id', missing);
    for (const p of profiles || []) byProfile[p.id] = { address: p.wallet_address || '', name: p.full_name };
  }

  const patient = entries[0];
  for (const s of sessions || []) {
    if (!unmatched.has(s.id)) continue;
    const doctor = byProfile[s.doctor_profile_id] || {};
    result.push({
      doctorAddress: doctor.address || '',
      patientAddress: patient ? patient.patientAddress : '',
      recordIdHex: patient ? patient.recordIdHex : null,
      action: 'viewed',
      timestamp: new Date(s.started_at).toISOString(),
      blockNumber: null,
      offChain: true,
      doctorName: doctor.name || null,
      patientName: patient ? patient.patientName : null,
      ...describe(s),
    });
  }
  return result.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// An on-chain grant/revoke is mined shortly after the request that made it;
// pair it with the off-chain entry for that request if they are this close.
const EVENT_MATCH_MS = 15 * 60 * 1000;

/**
 * Merge the off-chain grant/revoke entries (written in the same request as the
 * share/revoke) with the on-chain ones. A matched on-chain entry keeps its
 * block number; an unmatched off-chain entry — the blockchain write failed or
 * was skipped — is added on its own, so no grant or revoke is ever missing.
 */
function withOffChainEvents(chainEntries, events, withExpiry) {
  const unmatched = new Set(chainEntries.map((_, i) => i));
  const result = [...chainEntries];
  for (const ev of events) {
    const at = new Date(ev.created_at).getTime();
    const key = ev.doctor_profile_id || ev.doctor_id;
    let best = null;
    chainEntries.forEach((c, i) => {
      if (!unmatched.has(i) || c.action !== ev.action || c.doctorKey !== key) return;
      const gap = Math.abs(new Date(c.timestamp).getTime() - at);
      if (gap <= EVENT_MATCH_MS && (!best || gap < best.gap)) best = { i, gap };
    });
    if (best) {
      unmatched.delete(best.i);
      if (withExpiry && ev.action === 'granted') result[best.i] = { ...result[best.i], expiresAt: ev.expires_at };
      continue;
    }
    result.push({
      doctorAddress: '',
      patientAddress: '',
      recordIdHex: null,
      action: ev.action,
      timestamp: ev.created_at,
      blockNumber: null,
      offChain: true,
      doctorKey: key,
      doctorName: ev.doctor_name,
      patientName: null,
      ...(withExpiry && ev.action === 'granted' ? { expiresAt: ev.expires_at } : {}),
    });
  }
  return result.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

/**
 * Add an "expired" entry at the moment each grant ran out, if it ran out
 * before the next grant/revoke for the same doctor. Expiry happens without a
 * request or transaction, so it is derived from the grant's expiry.
 */
function withExpiredEntries(entries) {
  const now = Date.now();
  const result = [...entries];
  entries.forEach((grant, i) => {
    if (grant.action !== 'granted' || !grant.expiresAt) return;
    const next = entries
      .slice(i + 1)
      .find((e) => e.doctorKey === grant.doctorKey && (e.action === 'granted' || e.action === 'revoked'));
    const endedAt = next ? new Date(next.timestamp).getTime() : now;
    if (new Date(grant.expiresAt).getTime() <= endedAt) {
      result.push({
        doctorAddress: grant.doctorAddress,
        patientAddress: grant.patientAddress,
        recordIdHex: grant.recordIdHex,
        action: 'expired',
        timestamp: grant.expiresAt,
        blockNumber: null, // derived: expiry needs no transaction
        doctorKey: grant.doctorKey,
        doctorName: grant.doctorName,
        patientName: grant.patientName,
      });
    }
  });
  // An expiry sorts ahead of a revoke/re-grant in the same second.
  return result.sort(
    (a, b) =>
      new Date(a.timestamp) - new Date(b.timestamp) ||
      (a.action === 'expired' ? -1 : b.action === 'expired' ? 1 : 0)
  );
}

module.exports = router;
