'use strict';

const express = require('express');
const { admin } = require('../supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../util');

const router = express.Router();
router.use(requireAuth);

/** GET /api/profiles/me — the caller's full profiles row. */
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.supabase
      .from('profiles')
      .select()
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json(data);
  })
);

/**
 * PATCH /api/profiles/me — update full_name (and keep auth metadata in sync).
 * Body: { full_name }
 * Mirrors edit_profile_screen steps 1 & 2.
 */
router.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const { full_name } = req.body;
    if (typeof full_name === 'string') {
      const { error } = await req.supabase
        .from('profiles')
        .update({ full_name })
        .eq('id', req.user.id);
      if (error) throw error;

      // Keep auth metadata's full_name in sync (non-fatal).
      try {
        await admin.auth.admin.updateUserById(req.user.id, {
          user_metadata: { full_name },
        });
      } catch (e) {
        console.error('[profiles] auth metadata update failed:', e.message);
      }
    }
    res.json({ ok: true });
  })
);

/**
 * POST /api/profiles/wallet — persist a wallet address on the profile.
 * Kept for compatibility with SupabaseService.saveWalletAddress; wallets are
 * normally created server-side at signup.
 * Body: { wallet_address }
 */
router.post(
  '/wallet',
  asyncHandler(async (req, res) => {
    const { wallet_address } = req.body;
    if (!wallet_address) {
      return res.status(400).json({ error: 'wallet_address is required' });
    }
    const { error } = await req.supabase
      .from('profiles')
      .update({ wallet_address })
      .eq('id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  })
);

/**
 * GET /api/profiles/me/stats — counts for the patient profile screen plus the
 * display name/email. Mirrors profile_screen._load().
 */
router.get(
  '/me/stats',
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    let records = 0;
    let doctors = 0;
    let shared = 0;

    try {
      const { data } = await req.supabase
        .from('medical_records')
        .select('id')
        .eq('patient_id', uid);
      records = (data || []).length;
    } catch (_) {}

    try {
      const { data } = await req.supabase
        .from('doctor_requests')
        .select('id, status')
        .eq('patient_id', uid)
        .eq('status', 'accepted');
      doctors = (data || []).length;
    } catch (_) {}

    try {
      const { data } = await req.supabase
        .from('shared_records')
        .select('id')
        .eq('patient_id', uid);
      shared = (data || []).length;
    } catch (_) {}

    let fullName =
      (req.user.user_metadata && req.user.user_metadata.full_name) || 'User';
    let email = req.user.email || '';
    try {
      const { data: profile } = await req.supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', uid)
        .maybeSingle();
      if (profile) {
        fullName = profile.full_name || fullName;
        email = profile.email || email;
      }
    } catch (_) {}

    res.json({ records, doctors, shared, fullName, email });
  })
);

module.exports = router;
