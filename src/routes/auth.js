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

/**
 * POST /api/auth/google
 * Body: { idToken }
 *
 * Signs in (or silently creates) a Supabase user from a Google ID token —
 * same idea as /login, just a different credential. If this is a brand-new
 * user with no `profiles` row yet, we do NOT guess a role. We return the
 * session early with `needsRoleSelection: true` so the app can ask
 * "Patient or Doctor?" and then call /api/auth/complete-profile using the
 * session we already handed back here.
 */
router.post(
  '/google',
  asyncHandler(async (req, res) => {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }

    const { data, error } = await anon.auth.signInWithIdToken({
      provider: 'google',
      token: idToken,
    });
    if (error || !data.session) {
      return res
        .status(401)
        .json({ error: error ? error.message : 'Google sign-in failed' });
    }

    const { user, session } = data;

    const { data: existingProfile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    if (!existingProfile) {
      return res.json({
        needsRoleSelection: true,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user: publicUser(user, null),
      });
    }

    return res.json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      user: publicUser(user, existingProfile.role),
    });
  })
);

/**
 * POST /api/auth/complete-profile
 * Body: { role }
 * Requires the bearer token that /api/auth/google just issued.
 *
 * Finishes onboarding for a first-time Google sign-in: creates the
 * `profiles` row (same as step 3 of /signup) and the custodied wallet (same
 * as step 4 of /signup), now that we know the chosen role.
 */
router.post(
  '/complete-profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { role } = req.body;
    if (!role || !['patient', 'doctor'].includes(role)) {
      return res.status(400).json({ error: "role must be 'patient' or 'doctor'" });
    }

    const fullName =
      (req.user.user_metadata && req.user.user_metadata.full_name) ||
      req.user.email;

    await admin.from('profiles').upsert(
      { id: req.user.id, email: req.user.email, full_name: fullName, role },
      { onConflict: 'id' }
    );
    try {
      await walletService.ensureWallet(req.user.id);
    } catch (e) {
      console.error('[auth] wallet generation failed:', e.message);
    }

    res.json({ user: publicUser(req.user, role) });
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