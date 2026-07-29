'use strict';

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'medichain-backend' }));
app.get('/', (_req, res) =>
  res.json({ service: 'medichain-backend', docs: 'See backend/README.md' })
);

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/profiles', require('./routes/profiles'));
app.use('/api/patients', require('./routes/patients'));
app.use('/api/doctors', require('./routes/doctors'));
app.use('/api/doctor-requests', require('./routes/doctorRequests'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/records', require('./routes/records'));
app.use('/api/sharing', require('./routes/sharing'));
app.use('/api/blockchain', require('./routes/blockchain'));
app.use('/api/wallet', require('./routes/wallet'));

// ── 404 ─────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ── Error handler ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`MediChain backend listening on http://localhost:${config.port}`);
});

module.exports = app;
