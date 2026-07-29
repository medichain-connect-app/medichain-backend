'use strict';

require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    // We don't hard-crash here so the server can still boot for routes that
    // don't need every secret (e.g. blockchain can be absent in pure-DB dev).
    console.warn(`[config] Warning: environment variable ${name} is not set.`);
  }
  return value;
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*',

  supabase: {
    url: required('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  pinata: {
    jwt: process.env.PINATA_JWT || '',
    gateway: process.env.PINATA_GATEWAY || '',
    pinEndpoint: 'https://api.pinata.cloud/pinning/pinFileToIPFS',
  },

  blockchain: {
    rpcUrl: process.env.BLOCKCHAIN_RPC_URL || 'http://127.0.0.1:8545',
    chainId: parseInt(process.env.BLOCKCHAIN_CHAIN_ID || '31337', 10),
    contractAddress:
      process.env.CONTRACT_ADDRESS ||
      '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  },

  walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || '',

 email: {
   resendApiKey: process.env.RESEND_API_KEY || '',
   from: process.env.EMAIL_FROM || 'MediChain <onboarding@resend.dev>',
 },
};

module.exports = config;
