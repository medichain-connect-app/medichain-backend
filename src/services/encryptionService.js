'use strict';

const crypto = require('crypto');

/**
 * AES-256-CBC file encryption — byte-for-byte compatible with the original
 * Flutter `EncryptionService` (package:encrypt, AES/CBC/PKCS7).
 *
 *   - fresh random 32-byte key + 16-byte IV per file
 *   - PKCS7 padding (Node's default for aes-256-cbc)
 *   - SHA-256 of the *ciphertext* for integrity/tamper detection
 *
 * Keys/IVs are returned base64-encoded so they can be stored in the
 * `medical_records` table exactly as before.
 */

function encryptBytes(plaintext) {
  const key = crypto.randomBytes(32); // AES-256
  const iv = crypto.randomBytes(16); // AES block size

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const sha256Hex = crypto.createHash('sha256').update(ciphertext).digest('hex');

  return {
    ciphertext,
    keyBase64: key.toString('base64'),
    ivBase64: iv.toString('base64'),
    sha256Hex,
  };
}

function decryptBytes({ ciphertext, keyBase64, ivBase64 }) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Verify downloaded ciphertext matches the hash we stored. */
function verifyHash(ciphertext, expectedSha256Hex) {
  const actual = crypto.createHash('sha256').update(ciphertext).digest('hex');
  return actual.toLowerCase() === String(expectedSha256Hex).toLowerCase();
}

module.exports = { encryptBytes, decryptBytes, verifyHash };
