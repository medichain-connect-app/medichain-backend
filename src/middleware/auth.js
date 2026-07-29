'use strict';

const { admin, clientForToken } = require('../supabase');

/**
 * Extracts the Bearer token, verifies it with Supabase, and attaches:
 *   req.accessToken — the raw JWT
 *   req.user        — the Supabase auth user
 *   req.supabase    — a Supabase client scoped to this user (RLS-aware)
 *
 * Mirrors the Flutter app's `Supabase.instance.client.auth.currentUser`:
 * requests without a valid session are rejected with 401.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization bearer token' });
    }

    const { data, error } = await admin.auth.getUser(token);
    if (error || !data || !data.user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    req.accessToken = token;
    req.user = data.user;
    req.supabase = clientForToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth };
