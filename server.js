const path = require('node:path');
const { openDb, seedDemo } = require('./src/db');
const { mockProvider } = require('./src/payments');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

const db = openDb(process.env.DB_FILE || path.join(__dirname, 'data', 'texas2000.db'));
seedDemo(db);

const app = createApp({ db, provider: mockProvider, adminPin: ADMIN_PIN, publicUrl: process.env.PUBLIC_URL });
app.listen(PORT, () => {
  console.log(`Texas2000 running on http://localhost:${PORT}`);
  console.log(`Staff dashboard: http://localhost:${PORT}/admin.html  (PIN: ${ADMIN_PIN === '1234' ? '1234 — change via ADMIN_PIN' : 'set via ADMIN_PIN'})`);
});
