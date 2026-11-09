const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { seedDemo } = require('../src/seed');
const { mockProvider } = require('../src/payments');
const { createApp } = require('../src/app');
const { normalizePhone } = require('../src/routes/customer');

let server, base, db;

before(async () => {
  db = openDb(':memory:');
  seedDemo(db, 'demo1234');
  server = createApp({ db, provider: mockProvider }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Minimal client that keeps a cookie jar (for staff) and a guest token (for diners).
function client() {
  let cookie = '';
  let guest = '';
  const call = async (method, path, body) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (guest) headers['x-guest'] = guest;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    patch: (p, b = {}) => call('PATCH', p, b),
    del: (p) => call('DELETE', p, {}),
    setGuest: (g) => { guest = g; },
  };
}

async function staffLogin(username = 'demo', password = 'demo1234') {
  const c = client();
  const r = await c.post('/api/auth/login', { username, password });
  assert.equal(r.status, 200);
  return c;
}

async function joinTable(token, name = 'שירה', phone = '052-555-1234') {
  const c = client();
  const r = await c.post(`/api/t/${token}/join`, { name, phone });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  c.setGuest(r.data.guestToken);
  return c;
}

const tableToken = (n, username = 'demo') => db.prepare(`
  SELECT t.token FROM tables t JOIN restaurants r ON r.id = t.restaurant_id
  WHERE r.username = ? AND t.number = ?`).get(username, n).token;

describe('phone validation', () => {
  test('accepts Israeli mobile formats', () => {
    assert.equal(normalizePhone('052-555-1234'), '0525551234');
    assert.equal(normalizePhone('+972 52 555 1234'), '0525551234');
    assert.equal(normalizePhone('0771234567'), '0771234567');
  });
  test('rejects junk', () => {
    for (const p of ['', '123', '03-1234567', '05255512345', 'abc']) assert.equal(normalizePhone(p), null, p);
  });
});

describe('staff auth', () => {
  test('demo restaurant has 20 tables with unique QR tokens', async () => {
    const c = await staffLogin();
    const { data } = await c.get('/api/staff/overview');
    assert.equal(data.tables.length, 20);
    assert.equal(new Set(data.tables.map((t) => t.token)).size, 20);
    assert.equal(data.restaurant.isDemo, true);
  });

  test('wrong password is rejected and staff API requires login', async () => {
    assert.equal((await client().post('/api/auth/login', { username: 'demo', password: 'nope' })).status, 401);
    assert.equal((await client().get('/api/staff/overview')).status, 401);
  });

  test('signup creates an isolated restaurant with its own tables', async () => {
    const c = client();
    const r = await c.post('/api/auth/signup', { restaurantName: 'בית קפה בדיקה', username: 'testcafe', password: 'secret123', tables: 20 });
    assert.equal(r.status, 201);
    const { data } = await c.get('/api/staff/overview');
    assert.equal(data.restaurant.name, 'בית קפה בדיקה');
    assert.equal(data.tables.length, 20);
    assert.ok(data.tables.every((t) => !t.bill));

    // Cannot touch another restaurant's data.
    const demoTable = db.prepare("SELECT t.id FROM tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE r.username = 'demo'").get();
    assert.equal((await c.get(`/api/staff/tables/${demoTable.id}`)).status, 404);
    assert.equal((await c.post(`/api/staff/tables/${demoTable.id}/items`, { name: 'x', unitPrice: 100 })).status, 404);

    assert.equal((await client().post('/api/auth/signup', { restaurantName: 'עוד', username: 'TestCafe', password: 'secret123' })).status, 409);
    assert.equal((await client().post('/api/auth/signup', { restaurantName: 'עוד', username: 'other', password: 'short' })).status, 400);
  });

  test('non-JSON writes are refused (CSRF guard)', async () => {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', body: 'username=demo&password=demo1234',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(res.status, 415);
  });
});

describe('diner flow', () => {
  test('must identify before seeing the menu', async () => {
    const t = tableToken(3);
    assert.equal((await client().get(`/api/t/${t}/info`)).status, 200);
    assert.equal((await client().get(`/api/t/${t}/menu`)).status, 401);
    assert.equal((await client().post(`/api/t/${t}/join`, { name: 'א', phone: '0525551234' })).status, 400);
    assert.equal((await client().post(`/api/t/${t}/join`, { name: 'שירה', phone: '12345' })).status, 400);
    const g = await joinTable(t);
    const menu = await g.get(`/api/t/${t}/menu`);
    assert.equal(menu.status, 200);
    assert.ok(menu.data.categories.length >= 3);
  });

  test('a guest token only works at its own table', async () => {
    const g = await joinTable(tableToken(3));
    assert.equal((await g.get(`/api/t/${tableToken(4)}/state`)).status, 401);
  });

  test('order → staff approves → bill → split pay with tip → release table', async () => {
    const t = tableToken(3);
    const staff = await staffLogin();
    const a = await joinTable(t, 'אלון', '0501111111');
    const b = await joinTable(t, 'בר', '0502222222');
    const { data: menu } = await a.get(`/api/t/${t}/menu`);
    const items = menu.categories.flatMap((c) => c.items);
    const shakshuka = items.find((i) => i.name === 'שקשוקה');
    const latte = items.find((i) => i.name === 'לאטה');

    const oa = await a.post(`/api/t/${t}/orders`, { items: [{ menuItemId: shakshuka.id, quantity: 1 }], note: 'בלי פלפל' });
    assert.equal(oa.status, 201);
    const ob = await b.post(`/api/t/${t}/orders`, { items: [{ menuItemId: latte.id, quantity: 2 }] });
    assert.equal(ob.status, 201);

    // Nothing on the bill until staff approve.
    assert.equal((await a.get(`/api/t/${t}/state`)).data.bill, null);
    const overview = (await staff.get('/api/staff/overview')).data;
    const queued = overview.pendingOrders.filter((o) => o.table.label === 'שולחן 3');
    assert.equal(queued.length, 2);
    assert.equal(queued[0].guest.phone, '0501111111');

    assert.equal((await staff.post(`/api/staff/orders/${oa.data.id}/approve`)).status, 200);
    assert.equal((await staff.post(`/api/staff/orders/${oa.data.id}/approve`)).status, 409);
    assert.equal((await staff.post(`/api/staff/orders/${ob.data.id}/approve`)).status, 200);

    const sa = (await a.get(`/api/t/${t}/state`)).data;
    assert.equal(sa.bill.total, shakshuka.price + 2 * latte.price);
    assert.equal(sa.bill.myDue, shakshuka.price);
    assert.equal(sa.orders[0].status, 'approved');

    // Alon pays only for what he ordered, plus a tip.
    const pa = await a.post(`/api/t/${t}/pay`, { billId: sa.bill.id, amount: sa.bill.myDue, tip: 700, method: 'apple_pay' });
    assert.equal(pa.status, 200);
    assert.equal(pa.data.bill.myDue, 0);
    assert.equal(pa.data.bill.status, 'open');

    const sb = (await b.get(`/api/t/${t}/state`)).data;
    assert.equal(sb.bill.myDue, 2 * latte.price);
    assert.equal((await b.post(`/api/t/${t}/pay`, { billId: sb.bill.id, amount: sb.bill.remaining + 1, tip: 0, method: 'bit' })).status, 409);
    const pb = await b.post(`/api/t/${t}/pay`, { billId: sb.bill.id, amount: sb.bill.remaining, tip: 0, method: 'bit' });
    assert.equal(pb.data.bill.status, 'paid');

    // Staff release the table: diners are signed out, the next party starts fresh.
    const detail = (await staff.get(`/api/staff/tables/${overview.tables.find((x) => x.number === 3).id}`)).data;
    assert.equal(detail.bill.tips, 700);
    assert.equal((await staff.post(`/api/staff/bills/${detail.bill.id}/close`)).status, 200);
    assert.equal((await a.get(`/api/t/${t}/state`)).status, 401);
    const next = await joinTable(t, 'חדש', '0503333333');
    assert.equal((await next.get(`/api/t/${t}/state`)).data.bill, null);
  });

  test('rejected orders never reach the bill', async () => {
    const t = tableToken(6);
    const staff = await staffLogin();
    const g = await joinTable(t);
    const { data: menu } = await g.get(`/api/t/${t}/menu`);
    const o = await g.post(`/api/t/${t}/orders`, { items: [{ menuItemId: menu.categories[0].items[0].id, quantity: 1 }] });
    assert.equal((await staff.post(`/api/staff/orders/${o.data.id}/reject`)).status, 200);
    const s = (await g.get(`/api/t/${t}/state`)).data;
    assert.equal(s.bill, null);
    assert.equal(s.orders[0].status, 'rejected');
  });

  test('invalid orders and payments are refused', async () => {
    const t = tableToken(7);
    const g = await joinTable(t);
    const { data: menu } = await g.get(`/api/t/${t}/menu`);
    const id = menu.categories[0].items[0].id;
    assert.equal((await g.post(`/api/t/${t}/orders`, { items: [] })).status, 400);
    assert.equal((await g.post(`/api/t/${t}/orders`, { items: [{ menuItemId: id, quantity: 0 }] })).status, 400);
    assert.equal((await g.post(`/api/t/${t}/orders`, { items: [{ menuItemId: 999999, quantity: 1 }] })).status, 400);
    for (const body of [
      { amount: -5, tip: 0, method: 'card' },
      { amount: 10.5, tip: 0, method: 'card' },
      { amount: 1000, tip: 5000, method: 'card' },
      { amount: 1000, tip: 0, method: 'cash' },
    ]) {
      assert.equal((await g.post(`/api/t/${t}/pay`, body)).status, 400, JSON.stringify(body));
    }
  });

  test('sold-out items and disabled ordering are enforced', async () => {
    const t = tableToken(9);
    const staff = await staffLogin();
    const g = await joinTable(t);
    const item = (await staff.get('/api/staff/menu')).data[0];
    await staff.patch(`/api/staff/menu/${item.id}`, { available: false });
    assert.equal((await g.post(`/api/t/${t}/orders`, { items: [{ menuItemId: item.id, quantity: 1 }] })).status, 409);
    await staff.patch(`/api/staff/menu/${item.id}`, { available: true });

    await staff.patch('/api/staff/settings', { orderingEnabled: false });
    assert.equal((await g.post(`/api/t/${t}/orders`, { items: [{ menuItemId: item.id, quantity: 1 }] })).status, 403);
    await staff.patch('/api/staff/settings', { orderingEnabled: true });
  });
});

describe('demo', () => {
  test('reset restores the sample scenario', async () => {
    const staff = await staffLogin();
    assert.equal((await staff.post('/api/staff/demo/reset')).status, 200);
    const { data } = await staff.get('/api/staff/overview');
    assert.equal(data.pendingOrders.length, 1);
    assert.equal(data.tables.filter((t) => t.bill).length, 4);
    assert.equal((await staff.post('/api/staff/password', { current: 'demo1234', next: 'hijacked1' })).status, 403);
  });

  test('QR code encodes the table link', async () => {
    const r = await fetch(`${base}/qr/${tableToken(1)}.png`);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/t/${tableToken(1)}`)).status, 200);
  });
});
