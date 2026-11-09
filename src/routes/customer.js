// Customer API: everything a diner reaches after scanning the table QR.
// A diner must identify (name + phone) before seeing the menu, ordering or paying.
const express = require('express');
const { newToken, tx } = require('../db');
const { METHODS } = require('../payments');
const { currentBill, billSummary, orderWithItems } = require('../bills');
const { POLICY_VERSION } = require('../privacy');

const GUEST_TTL_MS = 12 * 3600e3;
const MAX_TIP_RATIO = 1; // a tip above 100% of the amount is almost certainly a typo
const MAX_PENDING_ORDERS = 5;

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('972')) digits = '0' + digits.slice(3);
  return /^0(5\d|7\d)\d{7}$/.test(digits) ? digits : null;
}

function customerRouter({ db, provider }) {
  const r = express.Router();

  r.param('token', (req, res, next, token) => {
    const table = db.prepare(`
      SELECT t.id, t.label, t.restaurant_id, r.name AS restaurant, r.ordering_enabled
      FROM tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE t.token = ?`).get(token);
    if (!table) return res.status(404).json({ error: 'table_not_found' });
    req.table = table;
    next();
  });

  function requireGuest(req, res, next) {
    const guest = db.prepare('SELECT * FROM guests WHERE token = ? AND table_id = ? AND created_at > ? AND ended_at IS NULL')
      .get(String(req.get('x-guest') || ''), req.table.id, Date.now() - GUEST_TTL_MS);
    if (!guest) return res.status(401).json({ error: 'guest_required' });
    req.guest = guest;
    next();
  }

  // Public: just enough to render the welcome screen.
  r.get('/:token/info', (req, res) => {
    res.json({ restaurant: req.table.restaurant, table: req.table.label, orderingEnabled: !!req.table.ordering_enabled });
  });

  r.post('/:token/join', (req, res) => {
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
    const phone = normalizePhone(req.body?.phone);
    if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'invalid_name' });
    if (!phone) return res.status(400).json({ error: 'invalid_phone' });
    // Informed consent to the privacy policy is required; marketing is a separate, optional opt-in.
    if (req.body?.acceptPrivacy !== true) return res.status(400).json({ error: 'privacy_required' });
    const marketing = req.body?.marketing === true ? 1 : 0;
    const token = newToken(18);
    db.prepare(`INSERT INTO guests (table_id, name, phone, token, created_at, privacy_version, marketing_consent)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.table.id, name, phone, token, Date.now(), POLICY_VERSION, marketing);
    res.status(201).json({ guestToken: token, name });
  });

  r.get('/:token/menu', requireGuest, (req, res) => {
    const items = db.prepare(`
      SELECT id, category, name, description, price, available FROM menu_items
      WHERE restaurant_id = ? AND deleted = 0 ORDER BY position, id`).all(req.table.restaurant_id);
    const categories = [];
    for (const it of items) {
      let cat = categories.find((c) => c.name === it.category);
      if (!cat) categories.push((cat = { name: it.category, items: [] }));
      cat.items.push({ id: it.id, name: it.name, description: it.description, price: it.price, available: !!it.available });
    }
    res.json({ categories });
  });

  r.get('/:token/state', requireGuest, (req, res) => {
    const orders = db.prepare('SELECT * FROM orders WHERE guest_id = ? ORDER BY id DESC LIMIT 20').all(req.guest.id);
    res.json({
      restaurant: req.table.restaurant,
      table: req.table.label,
      orderingEnabled: !!req.table.ordering_enabled,
      guest: { name: req.guest.name },
      bill: billSummary(db, currentBill(db, req.table.id), req.guest.id),
      orders: orders.map((o) => orderWithItems(db, o)),
    });
  });

  r.post('/:token/orders', requireGuest, (req, res) => {
    if (!req.table.ordering_enabled) return res.status(403).json({ error: 'ordering_disabled' });
    const lines = Array.isArray(req.body?.items) ? req.body.items : [];
    const note = String(req.body?.note || '').trim().slice(0, 200);
    if (!lines.length || lines.length > 30) return res.status(400).json({ error: 'invalid_items' });
    const { n: pending } = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE guest_id = ? AND status = 'pending'").get(req.guest.id);
    if (pending >= MAX_PENDING_ORDERS) return res.status(429).json({ error: 'too_many_pending' });

    const getItem = db.prepare('SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ? AND deleted = 0');
    const resolved = [];
    for (const line of lines) {
      const qty = line?.quantity;
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) return res.status(400).json({ error: 'invalid_quantity' });
      const item = getItem.get(Number(line.menuItemId), req.table.restaurant_id);
      if (!item) return res.status(400).json({ error: 'unknown_item' });
      if (!item.available) return res.status(409).json({ error: 'item_unavailable', item: item.name });
      resolved.push({ item, qty });
    }
    const orderId = tx(db, () => {
      const id = db.prepare('INSERT INTO orders (table_id, guest_id, note, created_at) VALUES (?, ?, ?, ?)')
        .run(req.table.id, req.guest.id, note, Date.now()).lastInsertRowid;
      const ins = db.prepare('INSERT INTO order_items (order_id, menu_item_id, name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)');
      for (const { item, qty } of resolved) ins.run(id, item.id, item.name, qty, item.price);
      return id;
    });
    res.status(201).json(orderWithItems(db, db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)));
  });

  r.post('/:token/pay', requireGuest, async (req, res) => {
    const { billId, amount, tip = 0, method } = req.body || {};
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'invalid_amount' });
    if (!Number.isInteger(tip) || tip < 0 || tip > amount * MAX_TIP_RATIO) return res.status(400).json({ error: 'invalid_tip' });
    if (!METHODS.includes(method)) return res.status(400).json({ error: 'invalid_method' });

    const bill = currentBill(db, req.table.id);
    if (!bill || bill.status !== 'open') return res.status(409).json({ error: 'no_open_bill' });
    // The client names the bill it saw, so a payment never lands on a newer bill by accident.
    if (billId !== undefined && billId !== bill.id) return res.status(409).json({ error: 'bill_changed' });
    const before = billSummary(db, bill);
    if (amount > before.remaining) return res.status(409).json({ error: 'amount_exceeds_remaining', remaining: before.remaining });

    const result = await provider.charge({ amount, tip, method, billId: bill.id });

    // Re-check after the async charge in case another diner paid meanwhile.
    const outcome = tx(db, () => {
      const fresh = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id);
      const current = billSummary(db, fresh);
      const insert = (status) => db.prepare(
        'INSERT INTO payments (bill_id, guest_id, amount, tip, method, status, provider_ref) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(bill.id, req.guest.id, amount, tip, method, status, result.ref || null);
      if (result.status === 'approved' && (fresh.status !== 'open' || amount > current.remaining)) {
        insert('declined'); // in production: trigger an automatic refund via the provider
        return 'conflict';
      }
      insert(result.status);
      if (result.status === 'approved' && current.remaining === amount) {
        db.prepare("UPDATE bills SET status = 'paid', closed_at = ? WHERE id = ?").run(new Date().toISOString(), bill.id);
      }
      return result.status;
    });

    const after = billSummary(db, db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id), req.guest.id);
    if (outcome === 'conflict') return res.status(409).json({ error: 'bill_changed_during_payment', bill: after });
    if (outcome !== 'approved') return res.status(402).json({ error: 'payment_declined', reason: result.reason, bill: after });
    res.json({ ok: true, receipt: { ref: result.ref, amount, tip, method }, bill: after });
  });

  return r;
}

module.exports = { customerRouter, normalizePhone, GUEST_TTL_MS };
