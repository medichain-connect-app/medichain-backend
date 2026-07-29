'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../util');
const emailService = require('../services/emailService');

const router = express.Router();
router.use(requireAuth);

/** yyyy-MM-dd from an ISO string or an already-formatted date. */
function toYmd(value) {
  return String(value).slice(0, 10);
}

/** 'Monday, 5 January 2026' — matches the Flutter EEEE, d MMMM yyyy format. */
function toLongDate(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * POST /api/appointments — patient requests an appointment.
 * Body: { doctorId, preferredDate, preferredTime, notes? }
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { doctorId, preferredDate, preferredTime, notes } = req.body;
    if (!doctorId || !preferredDate || !preferredTime) {
      return res
        .status(400)
        .json({ error: 'doctorId, preferredDate and preferredTime are required' });
    }
    const row = {
      patient_id: req.user.id,
      doctor_id: doctorId,
      preferred_date: toYmd(preferredDate),
      preferred_time: preferredTime,
      status: 'pending',
    };
    if (notes && notes.trim()) row.notes = notes.trim();

    const { error } = await req.supabase.from('appointment_requests').insert(row);
    if (error) throw error;
    res.json({ ok: true });
  })
);

/** GET /api/appointments/exists?doctorId= — patient already has a pending req? */
router.get(
  '/exists',
  asyncHandler(async (req, res) => {
    const { doctorId } = req.query;
    if (!doctorId) return res.status(400).json({ error: 'doctorId is required' });
    const { data } = await req.supabase
      .from('appointment_requests')
      .select('id')
      .eq('patient_id', req.user.id)
      .eq('doctor_id', doctorId)
      .eq('status', 'pending')
      .maybeSingle();
    res.json({ exists: data != null });
  })
);

/** GET /api/appointments/pending — pending requests for the logged-in doctor. */
router.get(
  '/pending',
  asyncHandler(async (req, res) => {
    const { data: doctor } = await req.supabase
      .from('doctors')
      .select('id, name, hospital_name')
      .eq('profile_id', req.user.id)
      .maybeSingle();
    if (!doctor) return res.json([]);

    const { data, error } = await req.supabase
      .from('appointment_requests')
      .select(
        'id, preferred_date, preferred_time, notes, created_at, ' +
          'patient:profiles!appt_fk_patient(id, full_name, email)'
      )
      .eq('doctor_id', doctor.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  })
);

/** GET /api/appointments/pending/count — badge count. */
router.get(
  '/pending/count',
  asyncHandler(async (req, res) => {
    const { data: doctor } = await req.supabase
      .from('doctors')
      .select('id')
      .eq('profile_id', req.user.id)
      .maybeSingle();
    if (!doctor) return res.json({ count: 0 });
    const { data } = await req.supabase
      .from('appointment_requests')
      .select('id')
      .eq('doctor_id', doctor.id)
      .eq('status', 'pending');
    res.json({ count: (data || []).length });
  })
);

/**
 * POST /api/appointments/:id/confirm — doctor confirms an appointment.
 * Sends a confirmation email (best-effort) then flips status to 'confirmed'.
 * Body: { patientEmail, patientName, doctorName, hospital, confirmedDate, confirmedTime }
 */
router.post(
  '/:id/confirm',
  asyncHandler(async (req, res) => {
    const {
      patientEmail,
      patientName,
      doctorName,
      hospital,
      confirmedDate,
      confirmedTime,
    } = req.body;

    const ymd = toYmd(confirmedDate);
    const emailSent = await emailService.sendAppointmentEmail({
      patientEmail,
      patientName,
      doctorName,
      hospital: hospital || 'the clinic',
      date: toLongDate(ymd),
      time: confirmedTime,
    });

    const { error } = await req.supabase
      .from('appointment_requests')
      .update({
        status: 'confirmed',
        confirmed_date: ymd,
        confirmed_time: confirmedTime,
      })
      .eq('id', req.params.id);
    if (error) throw error;

    res.json({ ok: true, emailSent });
  })
);

/** DELETE /api/appointments/:id — doctor declines (deletes) a request. */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { error } = await req.supabase
      .from('appointment_requests')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  })
);

module.exports = router;
