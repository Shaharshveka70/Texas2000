const express = require('express');
const path = require('node:path');
const QRCode = require('qrcode');
const { requireStaff } = require('./auth');
const { authRouter } = require('./routes/auth');
const { customerRouter } = require('./routes/customer');
const { staffRouter } = require('./routes/staff');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ db, provider, publicUrl, operator = {}, retentionMonths = 12 }) {
  const app = express();
  app.set('trust proxy', 1); // correct req.secure / req.ip behind a hosting proxy
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // The QR on each table points here; the page itself reads the token from the URL.
  app.get('/t/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'table.html')));

  app.get('/qr/:token.png', async (req, res) => {
    const table = db.prepare('SELECT token FROM tables WHERE token = ?').get(req.params.token);
    if (!table) return res.status(404).end();
    const base = publicUrl || `${req.protocol}://${req.get('host')}`;
    const png = await QRCode.toBuffer(`${base}/t/${table.token}`, { width: 512, margin: 2 });
    res.set('Cache-Control', 'public, max-age=86400').type('png').send(png);
  });

  // Details shown in the privacy policy (who operates the service, how to reach them).
  app.get('/api/legal', (req, res) => {
    res.json({
      operatorName: operator.name || null,
      operatorEmail: operator.email || null,
      operatorAddress: operator.address || null,
      retentionMonths,
      policyVersion: require('./privacy').POLICY_VERSION,
    });
  });

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  app.use('/vendor/heebo', express.static(path.dirname(require.resolve('@fontsource/heebo/400.css')), { maxAge: '30d' }));

  app.use('/api/auth', authRouter({ db }));
  app.use('/api/t', customerRouter({ db, provider }));
  app.use('/api/staff', requireStaff(db), staffRouter({ db }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}

module.exports = { createApp };
