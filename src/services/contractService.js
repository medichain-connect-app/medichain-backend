'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const walletService = require('./walletService');

/**
 * Interacts with the deployed `MediAccessControl` smart contract — the Node
 * port of the Flutter `ContractService`. All write methods sign with the
 * acting user's server-custodied wallet; read methods are free eth_call queries.
 *
 * Solidity ActionType enum: GRANTED=0, REVOKED=1, VIEWED=2, DOWNLOADED=3.
 */

const ABI = [
  'function grantAccess(address doctor, bytes32 recordId, string encryptedKeyForDoctor, uint256 expiresAt)',
  'function revokeAccess(address doctor, bytes32 recordId)',
  'function getEncryptedKey(bytes32 recordId) view returns (string)',
  'function logView(bytes32 recordId)',
  'function logDownload(bytes32 recordId)',
  'function hasAccess(address doctor, bytes32 recordId) view returns (bool)',
  'function getAccessLog(bytes32 recordId) view returns (tuple(address doctor, address patient, bytes32 recordId, uint8 action, uint256 timestamp, uint256 blockNumber)[])',
  'function getDoctorsWithAccess(bytes32 recordId) view returns (address[])',
  'function getActiveRecordsForDoctor(address doctor) view returns (bytes32[])',
  'function getRecordOwner(bytes32 recordId) view returns (address)',
];

const ACTION_LABELS = ['granted', 'revoked', 'viewed', 'downloaded'];

function provider() {
  return new ethers.JsonRpcProvider(config.blockchain.rpcUrl, {
    chainId: config.blockchain.chainId,
    name: 'medichain',
  });
}

function readContract() {
  return new ethers.Contract(config.blockchain.contractAddress, ABI, provider());
}

async function writeContract(profileId) {
  const signer = await walletService.loadSigner(profileId, provider());
  if (!signer) {
    throw new Error(
      'No Ethereum wallet found for this user. Sign out and register again to generate one.'
    );
  }
  return new ethers.Contract(config.blockchain.contractAddress, ABI, signer);
}

// ── Patient: grant / revoke ────────────────────────────────────────────────

async function grantAccess({
  patientProfileId,
  doctorAddress,
  recordUuid,
  encryptedKeyForDoctor,
  expiresAt = 0,
}) {
  const contract = await writeContract(patientProfileId);
  const recordId = walletService.recordIdToBytes32(recordUuid);
  const tx = await contract.grantAccess(
    ethers.getAddress(doctorAddress),
    recordId,
    encryptedKeyForDoctor,
    BigInt(expiresAt)
  );
  await tx.wait();
  return tx.hash;
}

async function revokeAccess({ patientProfileId, doctorAddress, recordUuid }) {
  const contract = await writeContract(patientProfileId);
  const recordId = walletService.recordIdToBytes32(recordUuid);
  const tx = await contract.revokeAccess(
    ethers.getAddress(doctorAddress),
    recordId
  );
  await tx.wait();
  return tx.hash;
}

// ── Doctor: retrieve key + log actions ─────────────────────────────────────

async function getEncryptedKey({ doctorProfileId, recordUuid }) {
  const doctorAddress = await walletService.getAddress(doctorProfileId);
  if (!doctorAddress) return null;
  const recordId = walletService.recordIdToBytes32(recordUuid);
  try {
    // Call FROM the doctor's address so the contract's access modifier passes.
    return await readContract().getEncryptedKey.staticCall(recordId, {
      from: doctorAddress,
    });
  } catch (e) {
    console.error('[contractService] getEncryptedKey error:', e.message);
    return null;
  }
}

async function logView({ doctorProfileId, recordUuid }) {
  return sendLogAction(doctorProfileId, recordUuid, 'logView');
}

async function logDownload({ doctorProfileId, recordUuid }) {
  return sendLogAction(doctorProfileId, recordUuid, 'logDownload');
}

async function sendLogAction(profileId, recordUuid, fnName) {
  try {
    const contract = await writeContract(profileId);
    const recordId = walletService.recordIdToBytes32(recordUuid);
    const tx = await contract[fnName](recordId);
    await tx.wait();
    return tx.hash;
  } catch (e) {
    // Best-effort: audit-log failures must never break the main flow.
    console.error(`[contractService] ${fnName} error (non-fatal):`, e.message);
    return null;
  }
}

// ── Read queries ───────────────────────────────────────────────────────────

async function hasAccess({ doctorAddress, recordUuid }) {
  try {
    const recordId = walletService.recordIdToBytes32(recordUuid);
    return await readContract().hasAccess(
      ethers.getAddress(doctorAddress),
      recordId
    );
  } catch (e) {
    console.error('[contractService] hasAccess error:', e.message);
    return false;
  }
}

async function getAccessLog(recordUuid) {
  try {
    const recordId = walletService.recordIdToBytes32(recordUuid);
    const rows = await readContract().getAccessLog(recordId);
    return rows.map((t) => ({
      doctorAddress: ethers.getAddress(t.doctor),
      patientAddress: ethers.getAddress(t.patient),
      recordIdHex: t.recordId,
      action: ACTION_LABELS[Number(t.action)] || 'granted',
      timestamp: new Date(Number(t.timestamp) * 1000).toISOString(),
      blockNumber: Number(t.blockNumber),
    }));
  } catch (e) {
    console.error('[contractService] getAccessLog error:', e.message);
    return [];
  }
}

async function getDoctorsWithAccess(recordUuid) {
  try {
    const recordId = walletService.recordIdToBytes32(recordUuid);
    const list = await readContract().getDoctorsWithAccess(recordId);
    return list.map((a) => ethers.getAddress(a));
  } catch (e) {
    console.error('[contractService] getDoctorsWithAccess error:', e.message);
    return [];
  }
}

module.exports = {
  grantAccess,
  revokeAccess,
  getEncryptedKey,
  logView,
  logDownload,
  hasAccess,
  getAccessLog,
  getDoctorsWithAccess,
};
