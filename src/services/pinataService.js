'use strict';

const config = require('../config');

/**
 * Wraps Pinata's pinning REST API. The Pinata JWT now lives server-side only —
 * it never ships inside the mobile app, which was the security concern flagged
 * in the original README.
 *
 * Uses Node 18+ global `fetch`, `FormData` and `Blob`.
 */
class PinataError extends Error {}

async function uploadBytes({ bytes, filename, keyValues }) {
  if (!config.pinata.jwt) throw new PinataError('PINATA_JWT is not configured');

  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);

  form.append(
    'pinataMetadata',
    JSON.stringify({
      name: filename,
      ...(keyValues ? { keyvalues: keyValues } : {}),
    })
  );
  // CID v1 (bafy…) — matches the original app.
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const res = await fetch(config.pinata.pinEndpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.pinata.jwt}` },
    body: form,
  });

  if (res.status !== 200) {
    const body = await res.text();
    throw new PinataError(`Pinata upload failed (HTTP ${res.status}): ${body}`);
  }

  const decoded = await res.json();
  const cid = decoded.IpfsHash;
  if (!cid) throw new PinataError(`Pinata response missing IpfsHash`);

  return {
    cid,
    size: Number(decoded.PinSize) || bytes.length,
    timestamp: decoded.Timestamp || new Date().toISOString(),
  };
}

function gatewayUrlFor(cid) {
  return `https://${config.pinata.gateway}/ipfs/${cid}`;
}

/** Download a previously-pinned file by CID → Buffer. */
async function downloadByCid(cid) {
  const res = await fetch(gatewayUrlFor(cid));
  if (res.status !== 200) {
    throw new PinataError(`Could not fetch CID ${cid} (HTTP ${res.status})`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { uploadBytes, downloadByCid, gatewayUrlFor, PinataError };
