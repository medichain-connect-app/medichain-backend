'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../util');
const walletService = require('../services/walletService');

const router = express.Router();
router.use(requireAuth);

/** GET /api/wallet/address — the caller's server-custodied wallet address. */
router.get(
  '/address',
  asyncHandler(async (req, res) => {
    let address = await walletService.getAddress(req.user.id);
    // Lazily create one if a legacy account never had a wallet generated.
    if (!address) {
      try {
        address = await walletService.ensureWallet(req.user.id);
      } catch (e) {
        console.error('[wallet] ensureWallet failed:', e.message);
      }
    }
    res.json({ address });
  })
);

module.exports = router;
