const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
require('dotenv').config();

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

// In-memory store mapping a one-time `state` token -> discordId, plus a
// pending-result store the Discord bot polls after the popup completes.
// (Stateless/short-lived; fine for this use case. Swap for Redis if you
// run multiple server instances.)
const pendingStates = new Map(); // state -> { discordId, createdAt }
const completedResults = new Map(); // discordId -> { email, googleName, completedAt }

function createApp({ onGoogleEmailReceived }) {
  const app = express();

  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: true,
    })
  );

  // Step 1: bot generates this link and DMs it to the user.
  // GET /auth?discord_id=123456789
  app.get('/auth', (req, res) => {
    const discordId = req.query.discord_id;
    if (!discordId) {
      return res.status(400).send('Missing discord_id parameter.');
    }

    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, { discordId, createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });

    res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  // Step 2: Google redirects back here after the user signs in.
  app.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(renderResultPage('Sign-in was cancelled. You can close this window.'));
    }

    const pending = pendingStates.get(state);
    if (!pending) {
      return res.status(400).send(renderResultPage('This sign-in link is invalid or expired. Please run /register again in Discord.'));
    }
    pendingStates.delete(state);

    try {
      // Exchange code for tokens
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: process.env.GOOGLE_REDIRECT_URI,
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenRes.json();

      if (!tokenData.access_token) {
        throw new Error('No access token returned from Google: ' + JSON.stringify(tokenData));
      }

      // Fetch user info (email)
      const userInfoRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userInfo = await userInfoRes.json();

      if (!userInfo.email) {
        throw new Error('No email returned from Google userinfo endpoint');
      }

      completedResults.set(pending.discordId, {
        email: userInfo.email,
        googleName: userInfo.name || '',
        completedAt: Date.now(),
      });

      // Let the bot know immediately (push), in addition to the poll-based
      // fallback below, so the Discord side can respond as fast as possible.
      if (onGoogleEmailReceived) {
        onGoogleEmailReceived(pending.discordId, userInfo.email, userInfo.name || '');
      }

      res.send(
        renderResultPage(
          `Signed in as ${escapeHtml(userInfo.email)}. You can close this window and return to Discord.`
        )
      );
    } catch (err) {
      console.error('OAuth callback error:', err);
      res.status(500).send(renderResultPage('Something went wrong during sign-in. Please try /register again, or contact an admin.'));
    }
  });

  // Used by the bot as a fallback if the push callback was missed (e.g. bot restarted).
  app.get('/internal/result/:discordId', (req, res) => {
    const result = completedResults.get(req.params.discordId);
    if (!result) return res.status(404).json({ found: false });
    res.json({ found: true, ...result });
  });

  app.get('/health', (req, res) => res.send('ok'));

  return app;
}

function renderResultPage(message) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Discord Registration</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #2b2d31; color: #f2f3f5; }
  .card { background: #313338; padding: 32px 40px; border-radius: 8px; max-width: 420px; text-align: center; }
</style>
</head>
<body><div class="card"><p>${escapeHtml(message)}</p></div></body>
</html>`;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Periodic cleanup of stale pending states (>10 min old)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, data] of pendingStates.entries()) {
    if (data.createdAt < cutoff) pendingStates.delete(state);
  }
}, 5 * 60 * 1000);

module.exports = { createApp, completedResults };
