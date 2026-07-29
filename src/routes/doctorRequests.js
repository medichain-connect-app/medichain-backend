'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, resolveDoctorId } = require('../util');

const router = express.Router();
router.use(requireAuth);

// ── Patient side ───────────────────────────────────────────────────────────

/** GET /api/doctor-requests/mine — { doctor_id, status } for the patient. */
router.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.supabase
      .from('doctor_requests')
      .select('doctor_id, status')
      .eq('patient_id', req.user.id);
    if (error) throw error;
    res.json(data || []);
  })
);

/** GET /api/doctor-requests/mine/accepted-doctors?limit=5 — joined to doctor. */
router.get(
  '/mine/accepted-doctors',
  asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit || '5', 10);
    const { data, error } = await req.supabase
      .from('doctor_requests')
      .select(
        'doctor_id, doctor:doctors!doctor_id(id, name, specialization, hospital_name)'
      )
      .eq('patient_id', req.user.id)
      .eq('status', 'accepted')
      .limit(limit);
    if (error) throw error;
    res.json(data || []);
  })
);

/** GET /api/doctor-requests/status?doctorId= — this patient↔doctor status. */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const { doctorId } = req.query;
    if (!doctorId) return res.status(400).json({ error: 'doctorId is required' });
    const { data, error } = await req.supabase
      .from('doctor_requests')
      .select('status')
      .eq('patient_id', req.user.id)
      .eq('doctor_id', doctorId)
      .maybeSingle();
    if (error) throw error;
    res.json({ status: data ? data.status : 'none' });
  })
);

/**
 * POST /api/doctor-requests — patient requests a connection with a doctor.
 * Body: { doctorId }. Idempotent (re-requests reset status to 'pending').
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { doctorId } = req.body;
    if (!doctorId) return res.status(400).json({ error: 'doctorId is required' });

    const { data: existing } = await req.supabase
      .from('doctor_requests')
      .select('id, status')
      .eq('patient_id', req.user.id)
      .eq('doctor_id', doctorId)
      .maybeSingle();

    if (!existing) {
      const { error } = await req.supabase.from('doctor_requests').insert({
        patient_id: req.user.id,
        doctor_id: doctorId,
        status: 'pending',
      });
      if (error) throw error;
    } else {
      const { error } = await req.supabase
        .from('doctor_requests')
        .update({ status: 'pending' })
        .eq('id', existing.id);
      if (error) throw error;
    }
    res.json({ ok: true, status: 'pending' });
  })
);

// ── Doctor side ────────────────────────────────────────────────────────────

/** GET /api/doctor-requests/incoming?status=pending — for the logged-in doctor. */
router.get(
  '/incoming',
  asyncHandler(async (req, res) => {
    const status = req.query.status || 'pending';
    const doctorId = await resolveDoctorId(req.supabase, req.user.id);
    if (!doctorId) return res.json([]);
    const { data, error } = await req.supabase
      .from('doctor_requests')
      .select(
        'id, created_at, patient_id, patient:profiles!patient_id(id, full_name, email)'
      )
      .eq('doctor_id', doctorId)
      .eq('status', status)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  })
);

/** GET /api/doctor-requests/incoming/accepted — accepted patients (joined). */
router.get(
  '/incoming/accepted',
  asyncHandler(async (req, res) => {
    const doctorId = await resolveDoctorId(req.supabase, req.user.id);
    if (!doctorId) return res.json([]);
    const { data, error } = await req.supabase
      .from('doctor_requests')
      .select('patient_id, patient:profiles!patient_id(id, full_name, email)')
      .eq('doctor_id', doctorId)
      .eq('status', 'accepted');
    if (error) throw error;
    res.json(data || []);
  })
);

/** GET /api/doctor-requests/incoming/accepted/count — { count }. */
router.get(
  '/incoming/accepted/count',
  asyncHandler(async (req, res) => {
    const doctorId = await resolveDoctorId(req.supabase, req.user.id);
    if (!doctorId) return res.json({ count: 0 });
    const { data, error } = await req.supabase
      .from('doctor_requests')
      .select('id')
      .eq('doctor_id', doctorId)
      .eq('status', 'accepted');
    if (error) throw error;
    res.json({ count: (data || []).length });
  })
);

/** GET /api/doctor-requests/:id — single request joined to patient(*). */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.supabase
      .from('doctor_requests')
      .select(
        'id, status, created_at, patient_id, patient:profiles!patient_id(*)'
      )
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    res.json(data);
  })
);

/** PATCH /api/doctor-requests/:id — set status (accept/reject). Body: { status }. */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    const { error } = await req.supabase
      .from('doctor_requests')
      .update({ status })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  })
);

module.exports = router;
