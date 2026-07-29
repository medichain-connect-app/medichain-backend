'use strict';

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../util');
const encryptionService = require('../services/encryptionService');
const pinataService = require('../services/pinataService');

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
 * GET /api/records/:id/download — fetch ciphertext from IPFS, verify the hash,
 * decrypt, and stream the plaintext back. Mirrors RecordsService.decryptRecord.
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

    res.setHeader('Content-Type', record.mime_type || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${(record.filename || 'record').replace(/"/g, '')}"`
    );
    res.send(plaintext);
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
