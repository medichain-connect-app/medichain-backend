'use strict';

const { admin } = require('../supabase');

/**
 * Off-chain access audit trail (table `access_events`).
 *
 * Every grant and revoke is written here in the same request that changes
 * `shared_records`, so the patient's access history never depends on the
 * blockchain transaction succeeding. On-chain entries are matched against
 * these rows when the history is read (see routes/blockchain.js).
 */

/**
 * Record grant/revoke events. Never throws: a failed audit write is logged and
 * must not undo or block the share/revoke the patient just made.
 *
 * @param {object} p
 * @param {'granted'|'revoked'} p.action
 * @param {string[]} p.recordIds
 * @param {string} p.patientId   profile id of the patient
 * @param {string} p.doctorId    doctors.id
 * @param {string|null} [p.expiresAt] ISO expiry for grants
 */
async function recordAccessEvents({ action, recordIds, patientId, doctorId, expiresAt = null }) {
  if (!recordIds || !recordIds.length) return;
  try {
    const doctorProfileId = await doctorProfileIdFor(doctorId);
    const rows = recordIds.map((recordId) => ({
      record_id: recordId,
      patient_id: patientId,
      doctor_id: doctorId,
      doctor_profile_id: doctorProfileId,
      action,
      expires_at: action === 'granted' ? expiresAt : null,
    }));
    const { error } = await admin.from('access_events').insert(rows);
    if (error) throw error;
  } catch (e) {
    console.error(`[audit] recording "${action}" failed:`, e.message);
  }
}

/**
 * Access events for one record, or for all of a patient's records, oldest
 * first, with the doctor's name. Returns [] if the table doesn't exist yet.
 */
async function loadAccessEvents({ recordId, patientId, limit = 500 }) {
  let query = admin
    .from('access_events')
    .select('id, record_id, patient_id, doctor_id, doctor_profile_id, action, expires_at, created_at')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (recordId) query = query.eq('record_id', recordId);
  if (patientId) query = query.eq('patient_id', patientId);

  const { data, error } = await query;
  if (error) {
    console.error('[audit] loading access events failed:', error.message);
    return [];
  }
  const events = data || [];
  const doctorIds = [...new Set(events.map((e) => e.doctor_id))];
  const names = {};
  if (doctorIds.length) {
    const { data: doctors } = await admin.from('doctors').select('id, name').in('id', doctorIds);
    for (const d of doctors || []) names[d.id] = d.name;
  }
  return events.map((e) => ({
    ...e,
    created_at: toIso(e.created_at),
    expires_at: toIso(e.expires_at),
    doctor_name: names[e.doctor_id] || null,
  }));
}

async function doctorProfileIdFor(doctorId) {
  const { data } = await admin
    .from('doctors')
    .select('profile_id')
    .eq('id', doctorId)
    .maybeSingle();
  return data ? data.profile_id : null;
}

/** Normalize a DB timestamp to ISO-8601 UTC (a value with no offset is UTC). */
function toIso(value) {
  if (!value) return null;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : `${value}Z`).toISOString();
}

module.exports = { recordAccessEvents, loadAccessEvents, toIso };
