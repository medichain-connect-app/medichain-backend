'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

/**
 * Admin client — uses the service_role key and bypasses Row-Level Security.
 * Use ONLY for privileged, server-owned operations (wallet custody, guaranteed
 * profile creation). Never expose its results directly to an unauthenticated
 * caller without your own authorization checks.
 */
const admin = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

/**
 * Anonymous client — used for auth calls (signUp / signInWithPassword) that
 * don't yet have a user token.
 */
const anon = createClient(config.supabase.url, config.supabase.anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Build a per-request client bound to a specific user's access token, so every
 * query runs under that user's Row-Level Security context — exactly like the
 * Flutter app used to when it held the session locally.
 */
function clientForToken(accessToken) {
  return createClient(config.supabase.url, config.supabase.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

module.exports = { admin, anon, clientForToken };
