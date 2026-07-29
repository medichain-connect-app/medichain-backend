'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../util');
const contractService = require('../services/contractService');

const router = express.Router();
router.use(requireAuth);

/** GET /api/blockchain/access-log?recordUuid= — full on-chain audit log. */
router.get(
  '/access-log',
  asyncHandler(async (req, res) => {
    const { recordUuid } = req.query;
    if (!recordUuid) return res.status(400).json({ error: 'recordUuid is required' });
    res.json(await contractService.getAccessLog(recordUuid));
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

/**
 * GET /api/blockchain/encrypted-key?recordUuid= — doctor retrieves the AES key
 * string stored on-chain. Signed/queried from the caller's (doctor's) wallet.
 */
router.get(
  '/encrypted-key',
  asyncHandler(async (req, res) => {
    const { recordUuid } = req.query;
    if (!recordUuid) return res.status(400).json({ error: 'recordUuid is required' });
    const encryptedKey = await contractService.getEncryptedKey({
      doctorProfileId: req.user.id,
      recordUuid,
    });
    res.json({ encryptedKey });
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

module.exports = router;
