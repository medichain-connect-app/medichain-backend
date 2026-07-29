'use strict';

const express = require('express');
const { anon, admin } = require('../supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../util');
const walletService = require('../services/walletService');

const router = express.Router();

/**
 * POST /api/auth/signup
 * Body: { email, password, fullName, role }
 * Mirrors the Flutter SupabaseService.signUp + server-side wallet generation.
 */
router.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const { email, password, fullName, role } = req.body;
    if (!email || !password || !fullName || !role) {
      return res
        .status(400)
        .json({ error: 'email, password, fullName and role are required' });
    }

    // Step 1 — create the auth user.
    const { data: signUpData, error: signUpError } = await anon.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, role } },
    });
    if (signUpError) {
      return res.status(400).json({ error: signUpError.message });
    }

    // Step 2 — try to obtain an active session (email confirmation may block this).
    let session = signUpData.session;
    let user = signUpData.user;
    if (!session) {
      const { data: signInData } = await anon.auth.signInWithPassword({
        email,
        password,
      });
      session = signInData.session || null;
      user = signInData.user || user;
    }

    // Step 3 — guarantee a profiles row exists (service role bypasses RLS).
    if (user) {
      await admin.from('profiles').upsert(
        { id: user.id, email, full_name: fullName, role },
        { onConflict: 'id' }
      );
      // Step 4 — generate + custody an Ethereum wallet for this user.
      try {
        await walletService.ensureWallet(user.id);
      } catch (e) {
        console.error('[auth] wallet generation failed:', e.message);
      }
    }

    if (!session) {
      return res.status(202).json({
        needsEmailConfirmation: true,
        message:
          'Account created! Please confirm your email, then sign in.',
        user: user ? publicUser(user, role) : null,
      });
    }

    return res.json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      user: publicUser(user, role),
    });
  })
);

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { data, error } = await anon.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.session) {
      return res.status(401).json({ error: error ? error.message : 'Login failed' });
    }

    const role = await roleFor(data.user.id);
    return res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: publicUser(data.user, role),
    });
  })
);

/**
 * POST /api/auth/refresh
 * Body: { refresh_token }
 */
router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ error: 'refresh_token is required' });
    }
    const { data, error } = await anon.auth.refreshSession({ refresh_token });
    if (error || !data.session) {
      return res.status(401).json({ error: error ? error.message : 'Refresh failed' });
    }
    const role = await roleFor(data.user.id);
    return res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: publicUser(data.user, role),
    });
  })
);

/** POST /api/auth/logout — stateless on the server; client just drops tokens. */
router.post('/logout', (_req, res) => res.json({ ok: true }));

/** GET /api/auth/me — current user + role. */
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const role = await roleFor(req.user.id);
    res.json({ user: publicUser(req.user, role) });
  })
);

/** GET /api/auth/role — mirrors SupabaseService.getUserRole. */
router.get(
  '/role',
  requireAuth,
  asyncHandler(async (req, res) => {
    const role = await roleFor(req.user.id);
    res.json({ role });
  })
);

// ── helpers ──────────────────────────────────────────────────────────────

async function roleFor(userId) {
  const { data } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  return data ? data.role : null;
}

function publicUser(user, role) {
  return {
    id: user.id,
    email: user.email,
    full_name:
      (user.user_metadata && user.user_metadata.full_name) || null,
    role: role || (user.user_metadata && user.user_metadata.role) || null,
  };
}

module.exports = router;
