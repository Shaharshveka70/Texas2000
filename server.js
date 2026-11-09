const path = require('node:path');
const { openDb } = require('./src/db');
const { seedDemo } = require('./src/seed');
const { mockProvider } = require('./src/payments');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';

const db = openDb(process.env.DB_FILE || path.join(__dirname, 'data', 'texas2000.db'));
if (process.env.SEED_DEMO !== 'false') seedDemo(db, DEMO_PASSWORD);

const app = createApp({ db, provider: mockProvider, publicUrl: process.env.PUBLIC_URL });
app.listen(PORT, () => {
  console.log(`Texas2000 running on http://localhost:${PORT}`);
  console.log(`Staff login: http://localhost:${PORT}/login  (demo user: demo / ${DEMO_PASSWORD})`);
});
