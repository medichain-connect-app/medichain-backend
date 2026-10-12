'use strict';

const express = require('express');
const { admin } = require('../supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../util');
const contractService = require('../services/contractService');

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

    const entries = await contractService.getAccessLog(recordUuid);
    const names = await namesForAddresses(
      entries.flatMap((e) => [e.doctorAddress, e.patientAddress])
    );
    res.json(
      entries.map((e) => ({
        ...e,
        doctorName: names[e.doctorAddress.toLowerCase()] || null,
        patientName: names[e.patientAddress.toLowerCase()] || null,
      }))
    );
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

/** Map wallet addresses (lowercased) → profile full names. */
async function namesForAddresses(addresses) {
  const unique = [...new Set(addresses)];
  if (!unique.length) return {};
  const { data } = await admin
    .from('user_wallets')
    .select('address, profile:profiles!profile_id(full_name)')
    .in('address', unique);
  const names = {};
  for (const row of data || []) {
    if (row.profile && row.profile.full_name) {
      names[row.address.toLowerCase()] = row.profile.full_name;
    }
  }
  return names;
}

module.exports = router;
