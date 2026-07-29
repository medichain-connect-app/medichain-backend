'use strict';

const crypto = require('crypto');
const { ethers } = require('ethers');
const config = require('../config');
const { admin } = require('../supabase');

/**
 * Server-custodied Ethereum wallets.
 *
 * In the original app each device generated its own key and kept it in
 * `flutter_secure_storage`. Now that the blockchain calls run on the backend,
 * the backend generates and custodies one key per user. The private key is
 * AES-256-GCM encrypted at rest (with WALLET_ENCRYPTION_KEY) in the
 * `user_wallets` table; only the checksummed address is mirrored into
 * `profiles.wallet_address` for lookups.
 */

function encryptionKey() {
  const hex = config.walletEncryptionKey;
  if (!hex || hex.length < 64) {
    throw new Error(
      'WALLET_ENCRYPTION_KEY must be set to a 32-byte (64 hex char) value'
    );
  }
  return Buffer.from(hex.slice(0, 64), 'hex');
}

function encryptPrivateKey(privateKeyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([
    cipher.update(privateKeyHex, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Store as iv:tag:ciphertext (all hex).
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptPrivateKey(blob) {
  const [ivHex, tagHex, dataHex] = blob.split(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

/**
 * Generate a fresh wallet for a user (if they don't already have one), persist
 * it, and mirror the address to profiles.wallet_address. Idempotent.
 * Returns the checksummed EIP-55 address.
 */
async function ensureWallet(profileId) {
  const existing = await getAddress(profileId);
  if (existing) return existing;

  const wallet = ethers.Wallet.createRandom();
  const address = wallet.address; // checksummed EIP-55
  const privateKey = wallet.privateKey.replace(/^0x/, '');

  await admin.from('user_wallets').upsert(
    {
      profile_id: profileId,
      address,
      encrypted_key: encryptPrivateKey(privateKey),
    },
    { onConflict: 'profile_id' }
  );

  await admin.from('profiles').update({ wallet_address: address }).eq('id', profileId);
  return address;
}

/** The user's checksummed address, or null if no wallet exists yet. */
async function getAddress(profileId) {
  const { data } = await admin
    .from('user_wallets')
    .select('address')
    .eq('profile_id', profileId)
    .maybeSingle();
  return data ? data.address : null;
}

/**
 * An ethers Wallet (signer) for the given user, connected to the RPC provider.
 * Returns null if the user has no wallet on file.
 */
async function loadSigner(profileId, provider) {
  const { data } = await admin
    .from('user_wallets')
    .select('encrypted_key')
    .eq('profile_id', profileId)
    .maybeSingle();
  if (!data) return null;
  const pk = decryptPrivateKey(data.encrypted_key);
  return new ethers.Wallet('0x' + pk, provider);
}

/**
 * Convert a Supabase record UUID → bytes32, matching Solidity's
 * keccak256(abi.encodePacked(bytes(uuid))) and the original Dart
 * WalletService.recordIdToBytes32.
 */
function recordIdToBytes32(uuid) {
  return ethers.keccak256(ethers.toUtf8Bytes(uuid));
}

module.exports = {
  ensureWallet,
  getAddress,
  loadSigner,
  recordIdToBytes32,
};
