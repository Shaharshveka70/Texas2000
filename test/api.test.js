const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { openDb, seedDemo } = require('../src/db');
const { mockProvider } = require('../src/payments');
const { createApp } = require('../src/app');

let server, base, db;
const PIN = 'test-pin';

before(async () => {
  db = openDb(':memory:');
  seedDemo(db);
  server = createApp({ db, provider: mockProvider, adminPin: PIN }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const json = (r) => r.json();
const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}),
});
const admin = { 'x-admin-pin': PIN };

function token(i = 0) {
  return db.prepare('SELECT token FROM tables ORDER BY id').all()[i].token;
}

test('customer sees the seeded bill', async () => {
  const data = await fetch(`${base}/api/t/${token()}`).then(json);
  assert.equal(data.bill.total, 2 * 5800 + 4200 + 2 * 1600 + 1400);
  assert.equal(data.bill.remaining, data.bill.total);
});

test('unknown table is 404', async () => {
  assert.equal((await fetch(`${base}/api/t/nope`)).status, 404);
});

test('split payment with tips, then bill becomes paid', async () => {
  const t = token();
  const { bill } = await fetch(`${base}/api/t/${t}`).then(json);
  const half = Math.ceil(bill.total / 2);

  const r1 = await post(`/api/t/${t}/pay`, { billId: bill.id, amount: half, tip: 1000, method: 'apple_pay' });
  assert.equal(r1.status, 200);
  const d1 = await r1.json();
  assert.equal(d1.bill.remaining, bill.total - half);
  assert.equal(d1.bill.status, 'open');

  const tooMuch = await post(`/api/t/${t}/pay`, { billId: bill.id, amount: bill.total, tip: 0, method: 'card' });
  assert.equal(tooMuch.status, 409);

  const r2 = await post(`/api/t/${t}/pay`, { billId: bill.id, amount: bill.total - half, tip: 500, method: 'bit' });
  const d2 = await r2.json();
  assert.equal(d2.bill.status, 'paid');
  assert.equal(d2.bill.remaining, 0);
  assert.equal(d2.bill.tips, 1500);

  const again = await post(`/api/t/${t}/pay`, { billId: bill.id, amount: 100, tip: 0, method: 'card' });
  assert.equal(again.status, 409);
});

test('rejects bad amounts, tips and methods', async () => {
  const t = token(1);
  const tables = await fetch(`${base}/api/admin/tables`, { headers: admin }).then(json);
  const bill = await post(`/api/admin/tables/${tables[1].id}/bill`, {}, admin).then(json);
  await post(`/api/admin/bills/${bill.id}/items`, { name: 'Burger', unit_price: 6900 }, admin);
  for (const body of [
    { amount: -5, tip: 0, method: 'card' },
    { amount: 10.5, tip: 0, method: 'card' },
    { amount: 1000, tip: -1, method: 'card' },
    { amount: 1000, tip: 5000, method: 'card' },
    { amount: 1000, tip: 0, method: 'cash' },
  ]) {
    assert.equal((await post(`/api/t/${t}/pay`, body)).status, 400, JSON.stringify(body));
  }
});

test('admin endpoints require the PIN', async () => {
  assert.equal((await fetch(`${base}/api/admin/tables`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/tables`, { headers: { 'x-admin-pin': 'wrong' } })).status, 401);
});

test('staff can close a paid bill and open a new one', async () => {
  const tables = await fetch(`${base}/api/admin/tables`, { headers: admin }).then(json);
  const t0 = tables[0];
  assert.equal(t0.bill.status, 'paid');
  assert.equal((await post(`/api/admin/bills/${t0.bill.id}/close`, {}, admin)).status, 200);
  const empty = await fetch(`${base}/api/t/${t0.token}`).then(json);
  assert.equal(empty.bill, null);
  assert.equal((await post(`/api/admin/tables/${t0.id}/bill`, {}, admin)).status, 201);
});

test('QR code renders as PNG', async () => {
  const r = await fetch(`${base}/qr/${token()}.png`);
  assert.equal(r.headers.get('content-type'), 'image/png');
});
