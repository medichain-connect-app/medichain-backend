'use strict';

const config = require('../config');

/**
 * Sends the appointment-confirmation email. Ports the Supabase Edge Function
 * (`send-appointment-email`) the Flutter app used to invoke. Uses Resend if
 * RESEND_API_KEY is configured; otherwise it's a no-op and the caller can fall
 * back to whatever it likes (the original app opened a mailto: link).
 *
 * Returns true if an email was actually dispatched.
 */
async function sendAppointmentEmail({
  patientEmail,
  patientName,
  doctorName,
  hospital,
  date,
  time,
}) {
  if (!config.email.resendApiKey) return false;

  const body =
    `Dear ${patientName},\n\n` +
    `Your appointment with Dr. ${doctorName} has been confirmed.\n\n` +
    `Date: ${date}\n` +
    `Time: ${time}\n` +
    `Location: ${hospital}\n\n` +
    `Please arrive 10 minutes before your scheduled time.\n\n` +
    `MediChain Team`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.email.from,
        to: [patientEmail],
        subject: `Appointment Confirmed — Dr. ${doctorName}`,
        text: body,
      }),
    });
    return res.ok;
  } catch (e) {
    console.error('[emailService] send failed:', e.message);
    return false;
  }
}

module.exports = { sendAppointmentEmail };
