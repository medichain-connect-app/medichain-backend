'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../util');

const router = express.Router();
router.use(requireAuth);

/** GET /api/patients/me — the caller's patients row (or null). */
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.supabase
      .from('patients')
      .select()
      .eq('profile_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json(data);
  })
);

/**
 * PUT /api/patients/me — upsert the caller's patients row.
 * Body: { date_of_birth, gender, blood_group, address, emergency_contact }
 * Mirrors edit_profile_screen step 3.
 */
router.put(
  '/me',
  asyncHandler(async (req, res) => {
    const { date_of_birth, gender, blood_group, address, emergency_contact } =
      req.body;
    const { error } = await req.supabase.from('patients').upsert(
      {
        profile_id: req.user.id,
        date_of_birth: date_of_birth || null,
        gender: gender || null,
        blood_group: blood_group || null,
        address: address || null,
        emergency_contact: emergency_contact || null,
      },
      { onConflict: 'profile_id' }
    );
    if (error) throw error;
    res.json({ ok: true });
  })
);

module.exports = router;
