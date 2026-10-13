'use strict';

const express = require('express');
const multer = require('multer');
const { admin } = require('../supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, resolveDoctorId } = require('../util');
const encryptionService = require('../services/encryptionService');
const pinataService = require('../services/pinataService');
const contractService = require('../services/contractService');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

function guessMimeType(filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.heic')) return 'image/heic';
  return 'application/octet-stream';
}

/** GET /api/records — all of the caller's records, newest first. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.supabase
      .from('medical_records')
      .select()
      .eq('patient_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  })
);

/**
 * POST /api/records/upload — multipart (file, title, category).
 * End-to-end pipeline: encrypt → hash → pin to IPFS → save metadata.
 * Mirrors the Flutter UploadService.uploadFile pipeline (server-side now).
 */
router.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const { title, category } = req.body;
    if (!title || !category) {
      return res.status(400).json({ error: 'title and category are required' });
    }

    const bytes = req.file.buffer;
    const filename = req.file.originalname;

    // 1. Encrypt (AES-256-CBC) + SHA-256 the ciphertext.
    const encrypted = encryptionService.encryptBytes(bytes);

    // 2. Pin the ciphertext to IPFS via Pinata. We deliberately don't leak the
    //    original filename to Pinata's dashboard.
    const pin = await pinataService.uploadBytes({
      bytes: encrypted.ciphertext,
      filename: `medichain_${Date.now()}.bin`,
      keyValues: { patient_id: req.user.id, category },
    });

    // 3. Save metadata to Supabase.
    const { data: inserted, error } = await req.supabase
      .from('medical_records')
      .insert({
        patient_id: req.user.id,
        title,
        category,
        filename,
        mime_type: guessMimeType(filename),
        file_size_bytes: bytes.length,
        cid: pin.cid,
        sha256: encrypted.sha256Hex,
        encrypted_key: encrypted.keyBase64,
        iv: encrypted.ivBase64,
      })
      .select('id')
      .single();
    if (error) throw error;

    res.json({
      recordId: inserted.id,
      cid: pin.cid,
      sha256: encrypted.sha256Hex,
      sizeBytes: bytes.length,
    });
  })
);

/** GET /api/records/:id — a single record's metadata (RLS enforced). */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.supabase
      .from('medical_records')
      .select()
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    res.json(data);
  })
);

/**
 * GET /api/records/:id/download?purpose=view|download — fetch ciphertext from
 * IPFS, verify the hash, decrypt, and stream the plaintext back.
 *
 * The owning patient may download. Anyone else (a doctor) must hold an active
 * share — not revoked, not expired — and may only view (purpose=view), never
 * download. Each doctor view is written to the on-chain audit log.
 */
router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const { data: record, error } = await req.supabase
      .from('medical_records')
      .select()
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!record) return res.status(404).json({ error: 'Record not found' });

    const isOwner = record.patient_id === req.user.id;
    if (!isOwner) {
      if (req.query.purpose !== 'view') {
        return res.status(403).json({
          error: 'Shared records can be viewed in MediChain but not downloaded.',
        });
      }
      if (!(await hasActiveShare(req, record.id))) {
        return res.status(403).json({ error: 'Your access to this record has ended.' });
      }
    }

    const ciphertext = await pinataService.downloadByCid(record.cid);
    if (!encryptionService.verifyHash(ciphertext, record.sha256)) {
      return res.status(422).json({
        error:
          'Integrity check failed: hash mismatch. The file may have been tampered with.',
      });
    }

    const plaintext = encryptionService.decryptBytes({
      ciphertext,
      keyBase64: record.encrypted_key,
      ivBase64: record.iv,
    });

    if (!isOwner) {
      // Fire-and-forget: the audit log must never hold up or break the view.
      contractService.logView({ doctorProfileId: req.user.id, recordUuid: record.id });
    }

    res.setHeader('Content-Type', record.mime_type || 'application/octet-stream');
    // Nothing may cache decrypted medical files.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${isOwner ? 'attachment' : 'inline'}; filename="${(record.filename || 'record').replace(/"/g, '')}"`
    );
    res.send(plaintext);
  })
);

/** True if the calling doctor has a share of this record that is neither revoked nor expired. */
async function hasActiveShare(req, recordId) {
  const doctorId = await resolveDoctorId(req.supabase, req.user.id);
  if (!doctorId) return false;
  const { data, error } = await req.supabase
    .from('shared_records')
    .select('expires_at')
    .eq('record_id', recordId)
    .eq('doctor_id', doctorId)
    .filter('revoked_at', 'is', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  if (!data.expires_at) return true;
  // A timestamp without time zone comes back with no offset; it is UTC.
  const at = /([zZ]|[+-]\d{2}:?\d{2})$/.test(data.expires_at) ? data.expires_at : `${data.expires_at}Z`;
  return new Date(at).getTime() > Date.now();
}

// ── View sessions: how long a doctor actually looked at a record ───────────

// The viewer reports every 15s while the record is on screen. Credit at most
// this much per report, so a stalled or tampered client can't add time.
const MAX_CREDIT_SECONDS = 20;

/**
 * POST /api/records/:id/view-sessions — a doctor's secure viewer opened the
 * record. Requires an active share. Returns { sessionId }.
 */
router.post(
  '/:id/view-sessions',
  asyncHandler(async (req, res) => {
    const { data: record, error } = await req.supabase
      .from('medical_records')
      .select('id, patient_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!record) return res.status(404).json({ error: 'Record not found' });
    if (record.patient_id === req.user.id) return res.json({ sessionId: null });
    if (!(await hasActiveShare(req, record.id))) {
      return res.status(403).json({ error: 'Your access to this record has ended.' });
    }

    const { data: session, error: insertError } = await admin
      .from('record_view_sessions')
      .insert({ record_id: record.id, patient_id: record.patient_id, doctor_profile_id: req.user.id })
      .select('id')
      .single();
    if (insertError) throw insertError;
    res.json({ sessionId: session.id });
  })
);

/**
 * POST /api/records/:id/view-sessions/:sessionId/heartbeat
 * Body: { visible: boolean, end?: boolean }. Credits the time since the last
 * report if the record was on screen; `end` closes the session. Answers
 * `accessEnded: true` once the share is revoked or expired.
 */
router.post(
  '/:id/view-sessions/:sessionId/heartbeat',
  asyncHandler(async (req, res) => {
    const { data: session, error } = await admin
      .from('record_view_sessions')
      .select('id, last_seen_at, active_seconds, ended_at')
      .eq('id', req.params.sessionId)
      .eq('record_id', req.params.id)
      .eq('doctor_profile_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!session) return res.status(404).json({ error: 'View session not found' });
    if (session.ended_at) return res.json({ activeSeconds: session.active_seconds, ended: true });

    const now = new Date();
    const sinceLast = Math.max(0, (now - new Date(session.last_seen_at)) / 1000);
    const credit = req.body.visible ? Math.min(sinceLast, MAX_CREDIT_SECONDS) : 0;
    const activeSeconds = Math.round(session.active_seconds + credit);

    // If the share was revoked or expired mid-view, end the session; the viewer closes.
    const accessEnded = !(await hasActiveShare(req, req.params.id));
    const ended = !!req.body.end || accessEnded;

    const update = { last_seen_at: now.toISOString(), active_seconds: activeSeconds };
    if (ended) update.ended_at = now.toISOString();
    const { error: updateError } = await admin
      .from('record_view_sessions')
      .update(update)
      .eq('id', session.id);
    if (updateError) throw updateError;
    res.json({ activeSeconds, ended, accessEnded });
  })
);

/** DELETE /api/records/:id — remove the Supabase row (IPFS pin lingers). */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { error } = await req.supabase
      .from('medical_records')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  })
);

module.exports = router;
