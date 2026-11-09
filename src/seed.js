// A fictional demo restaurant for sales demos: 20 tables, a café menu and some live activity.
const { newToken, tx, addTables } = require('./db');
const { hashPassword } = require('./auth');
const { ensureOpenBill, addBillItem } = require('./bills');
const { POLICY_VERSION } = require('./privacy');

const DEMO_USERNAME = 'demo';
const DEMO_NAME = 'קפה טקסס';

const MENU = [
  ['קפה ומשקאות חמים', 'אספרסו', 'כפול, מפולי הבית', 1000],
  ['קפה ומשקאות חמים', 'קפוצ׳ינו', 'אפשר על חלב שיבולת שועל', 1600],
  ['קפה ומשקאות חמים', 'לאטה', '', 1700],
  ['קפה ומשקאות חמים', 'תה צמחים', 'נענע, לואיזה ומרווה טריות', 1200],
  ['משקאות קרים', 'לימונדה', 'לימונים סחוטים ונענע', 1400],
  ['משקאות קרים', 'אייס קפה', '', 1800],
  ['משקאות קרים', 'מיץ תפוזים סחוט', '', 1800],
  ['ארוחות בוקר', 'שקשוקה', 'עגבניות, פלפלים, 2 ביצים ולחם הבית', 5800],
  ['ארוחות בוקר', 'ארוחת בוקר ישראלית', 'ביצים לבחירה, סלט, גבינות, מטבלים, לחם ושתייה חמה', 7200],
  ['ארוחות בוקר', 'טוסט גבינות', 'גבינה צהובה, בולגרית ועגבנייה', 4200],
  ['סלטים וכריכים', 'סלט ירקות', 'ירקות קצוצים, טחינה ושמן זית', 4200],
  ['סלטים וכריכים', 'סלט קינואה', 'קינואה, בטטה, עלים ושקדים קלויים', 5200],
  ['סלטים וכריכים', 'כריך חביתה', 'חביתת עשבי תיבול בבאגט', 3800],
  ['מאפים וקינוחים', 'קרואסון חמאה', '', 1600],
  ['מאפים וקינוחים', 'עוגת גבינה', 'פרוסה, עם קרם פירות יער', 3200],
  ['מאפים וקינוחים', 'בראוניז', 'חם, עם כדור גלידת וניל', 2600],
];

// orderingEnabled=false is "payment only": diners see the bill and pay; staff enter the items.
function createRestaurant(db, { name, username, password, tables = 20, orderingEnabled = false }) {
  return tx(db, () => {
    const id = Number(db.prepare('INSERT INTO restaurants (name, username, password_hash, ordering_enabled) VALUES (?, ?, ?, ?)')
      .run(name, username, hashPassword(password), orderingEnabled ? 1 : 0).lastInsertRowid);
    addTables(db, id, tables);
    return id;
  });
}

function loadMenu(db, restaurantId) {
  db.prepare('DELETE FROM menu_items WHERE restaurant_id = ? AND id NOT IN (SELECT menu_item_id FROM order_items WHERE menu_item_id IS NOT NULL)').run(restaurantId);
  db.prepare('UPDATE menu_items SET deleted = 1 WHERE restaurant_id = ?').run(restaurantId);
  const ins = db.prepare('INSERT INTO menu_items (restaurant_id, category, name, description, price, position) VALUES (?, ?, ?, ?, ?, ?)');
  MENU.forEach(([category, name, description, price], i) => ins.run(restaurantId, category, name, description, price, i + 1));
}

// Wipe all activity and recreate a believable mid-service snapshot for the restaurant's current mode.
function resetDemoActivity(db, restaurantId) {
  tx(db, () => {
    const tableIds = db.prepare('SELECT id FROM tables WHERE restaurant_id = ? ORDER BY number').all(restaurantId).map((t) => t.id);
    for (const tid of tableIds) {
      db.prepare('DELETE FROM payments WHERE bill_id IN (SELECT id FROM bills WHERE table_id = ?)').run(tid);
      db.prepare('DELETE FROM bills WHERE table_id = ?').run(tid);
      db.prepare('DELETE FROM orders WHERE table_id = ?').run(tid);
      db.prepare('DELETE FROM guests WHERE table_id = ?').run(tid);
    }
    db.prepare('UPDATE restaurants SET name = ? WHERE id = ?').run(DEMO_NAME, restaurantId);
    const ordering = !!db.prepare('SELECT ordering_enabled FROM restaurants WHERE id = ?').get(restaurantId).ordering_enabled;
    loadMenu(db, restaurantId);

    const menu = Object.fromEntries(db.prepare('SELECT name, id, price FROM menu_items WHERE restaurant_id = ? AND deleted = 0')
      .all(restaurantId).map((m) => [m.name, m]));
    const now = Date.now();
    const guest = (tid, name, phone, minsAgo, marketing = 0) => Number(db.prepare(
      'INSERT INTO guests (table_id, name, phone, token, created_at, privacy_version, marketing_consent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tid, name, phone, newToken(18), now - minsAgo * 60e3, POLICY_VERSION, marketing).lastInsertRowid);
    const order = (tid, gid, lines, { status, minsAgo, note = '' }) => {
      const oid = Number(db.prepare('INSERT INTO orders (table_id, guest_id, status, note, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(tid, gid, status, note, now - minsAgo * 60e3, status === 'pending' ? null : now - (minsAgo - 1) * 60e3).lastInsertRowid);
      const billId = status === 'approved' ? ensureOpenBill(db, tid) : null;
      for (const [itemName, qty] of lines) {
        const m = menu[itemName];
        db.prepare('INSERT INTO order_items (order_id, menu_item_id, name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)')
          .run(oid, m.id, itemName, qty, m.price);
        if (billId) addBillItem(db, billId, { name: itemName, quantity: qty, unitPrice: m.price, guestId: gid, orderId: oid });
      }
      return billId;
    };
    // Items a diner had: ordered through the app (ordering mode) or entered by the waiter (payment-only mode).
    const served = (tid, gid, lines, minsAgo) => {
      if (ordering) return order(tid, gid, lines, { status: 'approved', minsAgo });
      const billId = ensureOpenBill(db, tid);
      for (const [itemName, qty] of lines) addBillItem(db, billId, { name: itemName, quantity: qty, unitPrice: menu[itemName].price });
      return billId;
    };
    const pay = (billId, gid, amount, tip, method) => db.prepare(
      "INSERT INTO payments (bill_id, guest_id, amount, tip, method, status, provider_ref) VALUES (?, ?, ?, ?, ?, 'approved', ?)")
      .run(billId, gid, amount, tip, method, 'mock_demo' + newToken(4));
    const [t1, t2, , , t5, , , t8, , , t11] = tableIds;

    // Table 2: two friends eating, bill open.
    const dana = guest(t2, 'דנה', '0501234567', 40, 1);
    const noam = guest(t2, 'נועם', '0527654321', 38);
    served(t2, dana, [['ארוחת בוקר ישראלית', 1], ['קפוצ׳ינו', 1]], 35);
    served(t2, noam, [['שקשוקה', 1], ['לימונדה', 1]], 34);

    // Table 5 (ordering mode only): just ordered, waiting for staff approval.
    if (ordering) {
      const michal = guest(t5, 'מיכל', '0541112233', 3);
      order(t5, michal, [['קפוצ׳ינו', 2], ['קרואסון חמאה', 2]], { status: 'pending', minsAgo: 1, note: 'אחד הקפוצ׳ינו על שיבולת שועל' });
    }

    // Table 8: one diner already paid their part.
    const ron = guest(t8, 'רון', '0509998877', 55, 1);
    const yael = guest(t8, 'יעל', '0533334444', 54);
    const b8 = served(t8, ron, [['טוסט גבינות', 1], ['אייס קפה', 1]], 50);
    served(t8, yael, [['סלט קינואה', 1], ['מיץ תפוזים סחוט', 1]], 49);
    pay(b8, ron, 6000, 720, 'apple_pay');

    // Table 11: fully paid, waiting for staff to release the table.
    const avi = guest(t11, 'אבי', '0523456789', 70);
    const b11 = served(t11, avi, [['אספרסו', 1], ['עוגת גבינה', 1]], 65);
    pay(b11, avi, 4200, 500, 'bit');
    db.prepare("UPDATE bills SET status = 'paid', closed_at = ? WHERE id = ?").run(new Date().toISOString(), b11);

    // Table 1: a waiter-entered bill with no app orders (e.g. a regular who ordered at the counter).
    const b1 = ensureOpenBill(db, t1);
    addBillItem(db, b1, { name: 'אספרסו', quantity: 2, unitPrice: menu['אספרסו'].price });
  });
}

function seedDemo(db, password) {
  const existing = db.prepare('SELECT id FROM restaurants WHERE username = ?').get(DEMO_USERNAME);
  if (existing) return existing.id;
  const id = createRestaurant(db, { name: DEMO_NAME, username: DEMO_USERNAME, password, tables: 20 });
  resetDemoActivity(db, id);
  return id;
}

module.exports = { seedDemo, resetDemoActivity, createRestaurant, DEMO_USERNAME };
