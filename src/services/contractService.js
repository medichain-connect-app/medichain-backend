'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const walletService = require('./walletService');

/**
 * Interacts with the deployed `MediAccessControl` smart contract.
 *
 * Writes are gasless for users: the acting user's server-custodied wallet signs
 * an EIP-712 ForwardRequest, and the relayer wallet submits it through the
 * trusted ERC-2771 forwarder and pays the gas. The contract still sees the user
 * as the sender. Reads are free eth_call queries.
 *
 * Solidity ActionType enum: GRANTED=0, REVOKED=1, VIEWED=2, DOWNLOADED=3.
 */

const ABI = [
  'function grantAccess(address doctor, bytes32 recordId, uint256 expiresAt)',
  'function revokeAccess(address doctor, bytes32 recordId)',
  'function logView(bytes32 recordId)',
  'function logDownload(bytes32 recordId)',
  'function hasAccess(address doctor, bytes32 recordId) view returns (bool)',
  'function getAccessLog(bytes32 recordId) view returns (tuple(address doctor, uint64 timestamp, uint8 action, address patient, uint64 blockNumber)[])',
  'function getDoctorsWithAccess(bytes32 recordId) view returns (address[])',
  'function getActiveRecordsForDoctor(address doctor) view returns (bytes32[])',
  'function getRecordOwner(bytes32 recordId) view returns (address)',
];

const FORWARD_REQUEST_DATA =
  'tuple(address from, address to, uint256 value, uint256 gas, uint48 deadline, bytes data, bytes signature)';

const FORWARDER_ABI = [
  'function nonces(address owner) view returns (uint256)',
  `function execute(${FORWARD_REQUEST_DATA} request) payable`,
];

// Must match OpenZeppelin ERC2771Forwarder's EIP-712 type exactly.
const FORWARD_REQUEST_TYPES = {
  ForwardRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'gas', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint48' },
    { name: 'data', type: 'bytes' },
  ],
};

// Tip paid per unit of gas. Polygon requires at least 25 gwei; nodes often
// suggest far more than blocks actually need, so the tip is fixed and configurable.
const PRIORITY_FEE = ethers.parseUnits(String(config.blockchain.priorityFeeGwei), 'gwei');

const ACTION_LABELS = ['granted', 'revoked', 'viewed', 'downloaded'];

const contractInterface = new ethers.Interface(ABI);

let _provider;
function provider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl, config.blockchain.chainId, {
      staticNetwork: true,
      // ethers otherwise reuses identical answers for 250ms, which hands back a
      // stale relayer nonce when two relays run back to back.
      cacheTimeout: -1,
    });
  }
  return _provider;
}

let _relayer;
function relayer() {
  if (!config.blockchain.relayerPrivateKey) {
    throw new Error('RELAYER_PRIVATE_KEY is not configured');
  }
  if (!_relayer) {
    const key = config.blockchain.relayerPrivateKey;
    _relayer = new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`, provider());
  }
  return _relayer;
}

function readContract() {
  return new ethers.Contract(config.blockchain.contractAddress, ABI, provider());
}

function forwarder(runner) {
  if (!config.blockchain.forwarderAddress) {
    throw new Error('FORWARDER_ADDRESS is not configured');
  }
  return new ethers.Contract(config.blockchain.forwarderAddress, FORWARDER_ABI, runner);
}

async function feeOverrides() {
  const block = await provider().getBlock('latest');
  const baseFee = (block && block.baseFeePerGas) || 0n;
  // Twice the base fee leaves room for it to rise before the tx is mined.
  return { maxPriorityFeePerGas: PRIORITY_FEE, maxFeePerGas: baseFee * 2n + PRIORITY_FEE };
}

// The relayer sends one transaction at a time so its nonces never collide.
let relayQueue = Promise.resolve();
function serialize(task) {
  const run = relayQueue.then(task, task);
  relayQueue = run.catch(() => {});
  return run;
}

/**
 * Sign `fnName(args)` as the user and have the relayer submit it.
 * Resolves to the transaction hash once mined; rejects if it reverts.
 */
async function relay(profileId, fnName, args) {
  const user = await walletService.loadSigner(profileId, null);
  if (!user) {
    throw new Error('No Ethereum wallet found for this user.');
  }

  const to = config.blockchain.contractAddress;
  const data = contractInterface.encodeFunctionData(fnName, args);

  // Estimating as the user surfaces contract reverts (e.g. "no valid access")
  // before anything is signed or paid for.
  const estimated = await provider().estimateGas({ from: user.address, to, data });
  const gas = (estimated * 12n) / 10n + 10000n;

  return serialize(async () => {
    const fwd = forwarder(relayer());
    const nonce = await fwd.nonces(user.address);
    const deadline = Math.floor(Date.now() / 1000) + 10 * 60;

    const domain = {
      name: 'MediChainForwarder',
      version: '1',
      chainId: config.blockchain.chainId,
      verifyingContract: config.blockchain.forwarderAddress,
    };
    const signature = await user.signTypedData(domain, FORWARD_REQUEST_TYPES, {
      from: user.address,
      to,
      value: 0n,
      gas,
      nonce,
      deadline,
      data,
    });

    const tx = await fwd.execute(
      { from: user.address, to, value: 0n, gas, deadline, data, signature },
      await feeOverrides()
    );
    await tx.wait();
    return tx.hash;
  });
}

// ── Patient: grant / revoke ────────────────────────────────────────────────

async function grantAccess({ patientProfileId, doctorAddress, recordUuid, expiresAt = 0 }) {
  const recordId = walletService.recordIdToBytes32(recordUuid);
  const doctor = ethers.getAddress(doctorAddress);
  // Re-sharing an already-shared record is a no-op on-chain.
  if (await readContract().hasAccess(doctor, recordId)) return null;
  return relay(patientProfileId, 'grantAccess', [doctor, recordId, BigInt(expiresAt)]);
}

async function revokeAccess({ patientProfileId, doctorAddress, recordUuid }) {
  const recordId = walletService.recordIdToBytes32(recordUuid);
  const doctor = ethers.getAddress(doctorAddress);
  if (!(await readContract().hasAccess(doctor, recordId))) return null;
  return relay(patientProfileId, 'revokeAccess', [doctor, recordId]);
}

// ── Doctor: log actions ────────────────────────────────────────────────────

async function logView({ doctorProfileId, recordUuid }) {
  return sendLogAction(doctorProfileId, recordUuid, 'logView');
}

async function logDownload({ doctorProfileId, recordUuid }) {
  return sendLogAction(doctorProfileId, recordUuid, 'logDownload');
}

async function sendLogAction(profileId, recordUuid, fnName) {
  try {
    return await relay(profileId, fnName, [walletService.recordIdToBytes32(recordUuid)]);
  } catch (e) {
    // Best-effort: audit-log failures must never break the main flow.
    console.error(`[contractService] ${fnName} error (non-fatal):`, e.shortMessage || e.message);
    return null;
  }
}

// ── Read queries ───────────────────────────────────────────────────────────

async function hasAccess({ doctorAddress, recordUuid }) {
  try {
    const recordId = walletService.recordIdToBytes32(recordUuid);
    return await readContract().hasAccess(ethers.getAddress(doctorAddress), recordId);
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
      recordIdHex: recordId,
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

/** Public network details the apps use to link to the block explorer. */
function networkInfo() {
  return {
    network: config.blockchain.networkName,
    chainId: config.blockchain.chainId,
    contractAddress: config.blockchain.contractAddress,
    explorerUrl: config.blockchain.explorerUrl || null,
  };
}

module.exports = {
  grantAccess,
  revokeAccess,
  logView,
  logDownload,
  hasAccess,
  getAccessLog,
  getDoctorsWithAccess,
  networkInfo,
};
