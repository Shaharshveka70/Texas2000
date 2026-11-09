const path = require('node:path');
const { openDb } = require('./src/db');
const { seedDemo } = require('./src/seed');
const { mockProvider } = require('./src/payments');
const { createApp } = require('./src/app');
const { startRetentionJob } = require('./src/privacy');

const PORT = Number(process.env.PORT) || 3000;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';

const db = openDb(process.env.DB_FILE || path.join(__dirname, 'data', 'texas2000.db'));
if (process.env.SEED_DEMO !== 'false') seedDemo(db, DEMO_PASSWORD);

const RETENTION_MONTHS = Number(process.env.PRIVACY_RETENTION_MONTHS) || 12;
startRetentionJob(db, RETENTION_MONTHS);

const app = createApp({
  db,
  provider: mockProvider,
  // Render sets RENDER_EXTERNAL_URL to the service's public address; QR codes must point there.
  publicUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL,
  retentionMonths: RETENTION_MONTHS,
  operator: { name: process.env.OPERATOR_NAME, email: process.env.OPERATOR_EMAIL, address: process.env.OPERATOR_ADDRESS },
});
if (!process.env.OPERATOR_NAME || !process.env.OPERATOR_EMAIL) {
  console.warn('Set OPERATOR_NAME and OPERATOR_EMAIL: they appear in the privacy policy as the contact for privacy requests.');
}
app.listen(PORT, () => {
  console.log(`Texas2000 running on http://localhost:${PORT}`);
  console.log(`Staff login: http://localhost:${PORT}/login  (demo user: demo / ${DEMO_PASSWORD})`);
});
