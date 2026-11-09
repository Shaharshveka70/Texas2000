// Staff API. Every query is scoped to the logged-in restaurant (req.restaurant.id).
const express = require('express');
const { tx, addTables } = require('../db');
const { hashPassword, verifyPassword } = require('../auth');
const { currentBill, billSummary, ensureOpenBill, addBillItem, approveOrder, orderWithItems } = require('../bills');
const { GUEST_TTL_MS } = require('./customer');
const { resetDemoActivity, DEMO_USERNAME } = require('../seed');

const MAX_TABLES = 200;

function staffRouter({ db }) {
  const r = express.Router();

  const ownTable = (req, id) =>
    db.prepare('SELECT * FROM tables WHERE id = ? AND restaurant_id = ?').get(Number(id), req.restaurant.id);
  const ownBill = (req, id) => db.prepare(`
    SELECT b.* FROM bills b JOIN tables t ON t.id = b.table_id
    WHERE b.id = ? AND t.restaurant_id = ?`).get(Number(id), req.restaurant.id);
  const ownOrder = (req, id) => db.prepare(`
    SELECT o.* FROM orders o JOIN tables t ON t.id = o.table_id
    WHERE o.id = ? AND t.restaurant_id = ?`).get(Number(id), req.restaurant.id);
  const ownMenuItem = (req, id) =>
    db.prepare('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ? AND deleted = 0').get(Number(id), req.restaurant.id);

  function pendingOrders(restaurantId) {
    return db.prepare(`
      SELECT o.*, t.label AS table_label, t.id AS tid, g.name AS guest_name, g.phone AS guest_phone
      FROM orders o JOIN tables t ON t.id = o.table_id LEFT JOIN guests g ON g.id = o.guest_id
      WHERE t.restaurant_id = ? AND o.status = 'pending' ORDER BY o.id`).all(restaurantId)
      .map((o) => ({
        ...orderWithItems(db, o),
        table: { id: o.tid, label: o.table_label },
        guest: { name: o.guest_name, phone: o.guest_phone },
      }));
  }

  // One call that the dashboard polls: every table's status plus the order queue.
  r.get('/overview', (req, res) => {
    const since = Date.now() - GUEST_TTL_MS;
    const tables = db.prepare('SELECT id, number, label, token FROM tables WHERE restaurant_id = ? ORDER BY number')
      .all(req.restaurant.id);
    const countGuests = db.prepare('SELECT COUNT(*) AS n FROM guests WHERE table_id = ? AND created_at > ? AND ended_at IS NULL');
    const orders = pendingOrders(req.restaurant.id);
    res.json({
      restaurant: { name: req.restaurant.name, username: req.restaurant.username, orderingEnabled: !!req.restaurant.ordering_enabled,
        isDemo: req.restaurant.username.toLowerCase() === DEMO_USERNAME },
      tables: tables.map((t) => {
        const b = billSummary(db, currentBill(db, t.id));
        return {
          ...t,
          bill: b && { id: b.id, status: b.status, total: b.total, paid: b.paid, remaining: b.remaining, tips: b.tips },
          guests: countGuests.get(t.id, since).n,
          pendingOrders: orders.filter((o) => o.table.id === t.id).length,
        };
      }),
      pendingOrders: orders,
    });
  });

  r.get('/tables/:id', (req, res) => {
    const table = ownTable(req, req.params.id);
    if (!table) return res.status(404).json({ error: 'table_not_found' });
    const guests = db.prepare(`
      SELECT id, name, phone, created_at FROM guests
      WHERE table_id = ? AND created_at > ? AND ended_at IS NULL ORDER BY id`).all(table.id, Date.now() - GUEST_TTL_MS);
    const orders = db.prepare(`
      SELECT o.*, g.name AS guest_name FROM orders o LEFT JOIN guests g ON g.id = o.guest_id
      WHERE o.table_id = ? AND o.created_at > ? ORDER BY o.id DESC LIMIT 30`).all(table.id, Date.now() - GUEST_TTL_MS);
    res.json({
      table: { id: table.id, number: table.number, label: table.label, token: table.token },
      bill: billSummary(db, currentBill(db, table.id)),
      guests,
      orders: orders.map((o) => ({ ...orderWithItems(db, o), guest: { name: o.guest_name } })),
    });
  });

  r.post('/tables', (req, res) => {
    const count = req.body?.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ error: 'invalid_count' });
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM tables WHERE restaurant_id = ?').get(req.restaurant.id);
    if (n + count > MAX_TABLES) return res.status(400).json({ error: 'too_many_tables' });
    tx(db, () => addTables(db, req.restaurant.id, count));
    res.status(201).json({ ok: true });
  });

  r.patch('/tables/:id', (req, res) => {
    const table = ownTable(req, req.params.id);
    if (!table) return res.status(404).json({ error: 'table_not_found' });
    const label = String(req.body?.label || '').trim();
    if (!label || label.length > 30) return res.status(400).json({ error: 'invalid_label' });
    db.prepare('UPDATE tables SET label = ? WHERE id = ?').run(label, table.id);
    res.json({ ok: true });
  });

  // Staff add an item to a table's bill (from the menu, or a free-text item).
  r.post('/tables/:id/items', (req, res) => {
    const table = ownTable(req, req.params.id);
    if (!table) return res.status(404).json({ error: 'table_not_found' });
    const quantity = req.body?.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) return res.status(400).json({ error: 'invalid_quantity' });
    let name, unitPrice;
    if (req.body?.menuItemId != null) {
      const item = ownMenuItem(req, req.body.menuItemId);
      if (!item) return res.status(400).json({ error: 'unknown_item' });
      ({ name, price: unitPrice } = item);
    } else {
      name = String(req.body?.name || '').trim();
      unitPrice = req.body?.unitPrice;
      if (!name || !Number.isInteger(unitPrice) || unitPrice < 0) return res.status(400).json({ error: 'invalid_item' });
    }
    tx(db, () => addBillItem(db, ensureOpenBill(db, table.id), { name, quantity, unitPrice }));
    res.status(201).json(billSummary(db, currentBill(db, table.id)));
  });

  r.delete('/items/:id', (req, res) => {
    const item = db.prepare(`
      SELECT bi.* FROM bill_items bi JOIN bills b ON b.id = bi.bill_id JOIN tables t ON t.id = b.table_id
      WHERE bi.id = ? AND t.restaurant_id = ?`).get(Number(req.params.id), req.restaurant.id);
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(item.bill_id);
    if (bill.status !== 'open') return res.status(409).json({ error: 'bill_not_open' });
    const s = billSummary(db, bill);
    if (s.total - item.quantity * item.unit_price < s.paid) return res.status(409).json({ error: 'would_go_below_paid' });
    db.prepare('DELETE FROM bill_items WHERE id = ?').run(item.id);
    res.json(billSummary(db, bill));
  });

  // Release the table: the bill is closed and the diners' sessions end, so the next party starts fresh.
  r.post('/bills/:id/close', (req, res) => {
    const bill = ownBill(req, req.params.id);
    if (!bill) return res.status(404).json({ error: 'bill_not_found' });
    tx(db, () => {
      db.prepare("UPDATE bills SET status = 'closed', closed_at = ? WHERE id = ?").run(new Date().toISOString(), bill.id);
      db.prepare('UPDATE guests SET ended_at = ? WHERE table_id = ? AND ended_at IS NULL').run(Date.now(), bill.table_id);
      db.prepare("UPDATE orders SET status = 'rejected', decided_at = ? WHERE table_id = ? AND status = 'pending'")
        .run(Date.now(), bill.table_id);
    });
    res.json({ ok: true });
  });

  // Release a table that has diners but no bill (e.g. they looked at the menu and left).
  r.post('/tables/:id/release', (req, res) => {
    const table = ownTable(req, req.params.id);
    if (!table) return res.status(404).json({ error: 'table_not_found' });
    if (currentBill(db, table.id)) return res.status(409).json({ error: 'table_has_bill' });
    tx(db, () => {
      db.prepare('UPDATE guests SET ended_at = ? WHERE table_id = ? AND ended_at IS NULL').run(Date.now(), table.id);
      db.prepare("UPDATE orders SET status = 'rejected', decided_at = ? WHERE table_id = ? AND status = 'pending'")
        .run(Date.now(), table.id);
    });
    res.json({ ok: true });
  });

  r.post('/orders/:id/approve', (req, res) => {
    const order = ownOrder(req, req.params.id);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (approveOrder(db, order.id) == null) return res.status(409).json({ error: 'order_not_pending' });
    res.json({ ok: true });
  });

  r.post('/orders/:id/reject', (req, res) => {
    const order = ownOrder(req, req.params.id);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    const info = db.prepare("UPDATE orders SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(Date.now(), order.id);
    if (!info.changes) return res.status(409).json({ error: 'order_not_pending' });
    res.json({ ok: true });
  });

  // ---------- Menu ----------

  r.get('/menu', (req, res) => {
    res.json(db.prepare(`
      SELECT id, category, name, description, price, available, position FROM menu_items
      WHERE restaurant_id = ? AND deleted = 0 ORDER BY position, id`).all(req.restaurant.id)
      .map((i) => ({ ...i, available: !!i.available })));
  });

  function menuFields(body, partial) {
    const out = {};
    for (const k of ['category', 'name', 'description']) {
      if (body[k] === undefined) { if (!partial && k !== 'description') return null; continue; }
      const v = String(body[k]).trim();
      if ((k !== 'description' && !v) || v.length > (k === 'description' ? 200 : 60)) return null;
      out[k] = v;
    }
    if (body.price !== undefined) {
      if (!Number.isInteger(body.price) || body.price < 0 || body.price > 10_000_000) return null;
      out.price = body.price;
    } else if (!partial) return null;
    if (body.available !== undefined) out.available = body.available ? 1 : 0;
    return out;
  }

  r.post('/menu', (req, res) => {
    const f = menuFields(req.body || {}, false);
    if (!f) return res.status(400).json({ error: 'invalid_item' });
    const { pos } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM menu_items WHERE restaurant_id = ?').get(req.restaurant.id);
    const id = db.prepare(`INSERT INTO menu_items (restaurant_id, category, name, description, price, available, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.restaurant.id, f.category, f.name, f.description || '', f.price, f.available ?? 1, pos).lastInsertRowid;
    res.status(201).json({ id: Number(id) });
  });

  r.patch('/menu/:id', (req, res) => {
    const item = ownMenuItem(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    const f = menuFields(req.body || {}, true);
    if (!f) return res.status(400).json({ error: 'invalid_item' });
    const keys = Object.keys(f);
    if (keys.length) {
      db.prepare(`UPDATE menu_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => f[k]), item.id);
    }
    res.json({ ok: true });
  });

  r.delete('/menu/:id', (req, res) => {
    const item = ownMenuItem(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    db.prepare('UPDATE menu_items SET deleted = 1 WHERE id = ?').run(item.id);
    res.json({ ok: true });
  });

  // ---------- Settings ----------

  r.patch('/settings', (req, res) => {
    const { name, orderingEnabled } = req.body || {};
    if (name !== undefined) {
      const n = String(name).trim();
      if (n.length < 2 || n.length > 60) return res.status(400).json({ error: 'invalid_name' });
      db.prepare('UPDATE restaurants SET name = ? WHERE id = ?').run(n, req.restaurant.id);
    }
    if (orderingEnabled !== undefined) {
      db.prepare('UPDATE restaurants SET ordering_enabled = ? WHERE id = ?').run(orderingEnabled ? 1 : 0, req.restaurant.id);
    }
    res.json({ ok: true });
  });

  r.post('/password', (req, res) => {
    // Shared demo login must keep working for everyone who demos the product.
    if (req.restaurant.username.toLowerCase() === DEMO_USERNAME) return res.status(403).json({ error: 'demo_locked' });
    const { current, next } = req.body || {};
    const row = db.prepare('SELECT password_hash FROM restaurants WHERE id = ?').get(req.restaurant.id);
    if (!verifyPassword(String(current || ''), row.password_hash)) return res.status(403).json({ error: 'wrong_password' });
    if (typeof next !== 'string' || next.length < 8) return res.status(400).json({ error: 'weak_password' });
    db.prepare('UPDATE restaurants SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.restaurant.id);
    res.json({ ok: true });
  });

  // Demo account only: wipe activity and reload the sample scenario before a sales demo.
  r.post('/demo/reset', (req, res) => {
    if (req.restaurant.username.toLowerCase() !== DEMO_USERNAME) return res.status(403).json({ error: 'not_demo' });
    resetDemoActivity(db, req.restaurant.id);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { staffRouter };
