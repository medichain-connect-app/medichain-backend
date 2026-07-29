'use strict';

const express = require('express');
const { admin } = require('../supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../util');

const router = express.Router();
router.use(requireAuth);

const FULL_SELECT =
  'id, name, specialization, hospital_name, experience_years, ' +
  'license_number, state, city, address, about, education, ' +
  'languages, consultation_fee, available_online, profiles(full_name)';

const SMALL_SELECT = 'id, name, specialization, hospital_name';

/**
 * GET /api/doctors
 *   ?specialization=Cardiology  → ilike filter (specialty_doctors_screen)
 *   ?ids=uuid1,uuid2            → inFilter, small select (send_records_screen)
 *   (none)                      → all doctors, full select (find_doctors_screen)
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { specialization, ids } = req.query;

    if (ids) {
      const idList = String(ids).split(',').map((s) => s.trim()).filter(Boolean);
      const { data, error } = await req.supabase
        .from('doctors')
        .select(SMALL_SELECT)
        .in('id', idList);
      if (error) throw error;
      return res.json(data || []);
    }

    let query = req.supabase.from('doctors').select(FULL_SELECT);
    if (specialization) {
      query = query.ilike('specialization', `%${specialization}%`);
    }
    const { data, error } = await query.order('name', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  })
);

/** GET /api/doctors/specializations — every doctor's specialization (for counts). */
router.get(
  '/specializations',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.supabase
      .from('doctors')
      .select('specialization');
    if (error) throw error;
    res.json(data || []);
  })
);

/** GET /api/doctors/me — the caller's own doctor row (or null). */
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.supabase
      .from('doctors')
      .select()
      .eq('profile_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json(data);
  })
);

/**
 * PUT /api/doctors/me — upsert the caller's doctor profile.
 * Body: { fullName, doctor: { ...columns } }
 * Mirrors doctor_profile_edit_screen._save() (profiles first, then doctors).
 */
router.put(
  '/me',
  asyncHandler(async (req, res) => {
    const { fullName, doctor } = req.body;
    if (!doctor || typeof doctor !== 'object') {
      return res.status(400).json({ error: 'doctor payload is required' });
    }

    // Step A — upsert profiles first (satisfies the FK constraint).
    const { error: pErr } = await req.supabase.from('profiles').upsert(
      {
        id: req.user.id,
        email: req.user.email || '',
        full_name: fullName || doctor.name || '',
        role: 'doctor',
      },
      { onConflict: 'id' }
    );
    if (pErr) throw pErr;

    // Step B — upsert the doctors row.
    const payload = { ...doctor, profile_id: req.user.id };
    delete payload.id; // id is DB-generated / matched via profile_id
    const { data, error } = await req.supabase
      .from('doctors')
      .upsert(payload, { onConflict: 'profile_id' })
      .select()
      .maybeSingle();
    if (error) throw error;
    res.json(data);
  })
);

/** GET /api/doctors/:id — a single doctor's public profile. */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.supabase
      .from('doctors')
      .select(FULL_SELECT)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    res.json(data);
  })
);

/** GET /api/doctors/:id/wallet — the doctor's on-chain wallet address. */
router.get(
  '/:id/wallet',
  asyncHandler(async (req, res) => {
    const { data: doctor } = await admin
      .from('doctors')
      .select('profile_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!doctor) return res.json({ wallet_address: null });

    const { data: profile } = await admin
      .from('profiles')
      .select('wallet_address')
      .eq('id', doctor.profile_id)
      .maybeSingle();
    res.json({ wallet_address: profile ? profile.wallet_address : null });
  })
);

module.exports = router;
