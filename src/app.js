const express = require('express');
const path = require('node:path');
const QRCode = require('qrcode');
const { newToken } = require('./db');
const { METHODS } = require('./payments');

const MAX_TIP_RATIO = 1; // tip may not exceed 100% of the amount paid (guards typos)

function createApp({ db, provider, adminPin, publicUrl }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const q = {
    tableByToken: db.prepare(`
      SELECT t.id, t.label, t.token, r.name AS restaurant
      FROM tables t JOIN restaurants r ON r.id = t.restaurant_id WHERE t.token = ?`),
    tableById: db.prepare('SELECT * FROM tables WHERE id = ?'),
    openBillForTable: db.prepare(
      "SELECT * FROM bills WHERE table_id = ? AND status IN ('open','paid') ORDER BY id DESC LIMIT 1"),
    billById: db.prepare('SELECT * FROM bills WHERE id = ?'),
    items: db.prepare('SELECT id, name, quantity, unit_price FROM bill_items WHERE bill_id = ? ORDER BY id'),
    total: db.prepare('SELECT COALESCE(SUM(quantity * unit_price), 0) AS v FROM bill_items WHERE bill_id = ?'),
    paid: db.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS v, COALESCE(SUM(tip), 0) AS tips, COUNT(*) AS n FROM payments WHERE bill_id = ? AND status = 'approved'"),
    payments: db.prepare(
      "SELECT id, amount, tip, method, created_at FROM payments WHERE bill_id = ? AND status = 'approved' ORDER BY id"),
    insertPayment: db.prepare(
      'INSERT INTO payments (bill_id, amount, tip, method, status, provider_ref) VALUES (?, ?, ?, ?, ?, ?)'),
    setBillStatus: db.prepare('UPDATE bills SET status = ?, closed_at = ? WHERE id = ?'),
  };

  function billSummary(bill) {
    if (!bill) return null;
    const total = q.total.get(bill.id).v;
    const paid = q.paid.get(bill.id);
    return {
      id: bill.id,
      status: bill.status,
      items: q.items.all(bill.id),
      total,
      paid: paid.v,
      tips: paid.tips,
      remaining: Math.max(0, total - paid.v),
      payments: q.payments.all(bill.id),
    };
  }

  function isPositiveInt(n) {
    return Number.isInteger(n) && n > 0;
  }

  // ---------- Customer API (reached by scanning the table QR) ----------

  app.get('/api/t/:token', (req, res) => {
    const table = q.tableByToken.get(req.params.token);
    if (!table) return res.status(404).json({ error: 'table_not_found' });
    const bill = q.openBillForTable.get(table.id);
    res.json({ restaurant: table.restaurant, table: table.label, bill: billSummary(bill) });
  });

  app.post('/api/t/:token/pay', async (req, res) => {
    const table = q.tableByToken.get(req.params.token);
    if (!table) return res.status(404).json({ error: 'table_not_found' });
    const { billId, amount, tip = 0, method } = req.body || {};
    if (!isPositiveInt(amount)) return res.status(400).json({ error: 'invalid_amount' });
    if (!Number.isInteger(tip) || tip < 0 || tip > amount * MAX_TIP_RATIO) {
      return res.status(400).json({ error: 'invalid_tip' });
    }
    if (!METHODS.includes(method)) return res.status(400).json({ error: 'invalid_method' });

    const bill = q.openBillForTable.get(table.id);
    if (!bill || bill.status !== 'open') return res.status(409).json({ error: 'no_open_bill' });
    // The client says which bill it saw, so a payment never lands on a newer bill by accident.
    if (billId !== undefined && billId !== bill.id) return res.status(409).json({ error: 'bill_changed' });

    const before = billSummary(bill);
    if (amount > before.remaining) {
      return res.status(409).json({ error: 'amount_exceeds_remaining', remaining: before.remaining });
    }

    const result = await provider.charge({ amount, tip, method, billId: bill.id });

    // Re-check after the (async) charge in case another diner paid meanwhile.
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = billSummary(q.billById.get(bill.id));
      if (result.status === 'approved' && (current.status !== 'open' || amount > current.remaining)) {
        // In production this would trigger an automatic refund via the provider.
        q.insertPayment.run(bill.id, amount, tip, method, 'declined', result.ref || null);
        db.exec('COMMIT');
        return res.status(409).json({ error: 'bill_changed_during_payment', bill: current });
      }
      q.insertPayment.run(bill.id, amount, tip, method, result.status, result.ref || null);
      if (result.status === 'approved' && current.remaining - amount === 0) {
        q.setBillStatus.run('paid', new Date().toISOString(), bill.id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    const after = billSummary(q.billById.get(bill.id));
    if (result.status !== 'approved') {
      return res.status(402).json({ error: 'payment_declined', reason: result.reason, bill: after });
    }
    res.json({ ok: true, receipt: { ref: result.ref, amount, tip, method }, bill: after });
  });

  // QR image for a table. Public on purpose: it only encodes the public table link.
  app.get('/qr/:token.png', async (req, res) => {
    const table = q.tableByToken.get(req.params.token);
    if (!table) return res.status(404).end();
    const base = publicUrl || `${req.protocol}://${req.get('host')}`;
    const png = await QRCode.toBuffer(`${base}/pay.html?t=${table.token}`, { width: 512, margin: 2 });
    res.type('png').send(png);
  });

  // ---------- Staff API ----------

  const admin = express.Router();
  admin.use((req, res, next) => {
    if (req.get('x-admin-pin') !== adminPin) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  admin.get('/tables', (req, res) => {
    const tables = db.prepare('SELECT id, label, token FROM tables ORDER BY id').all();
    res.json(tables.map((t) => ({ ...t, bill: billSummary(q.openBillForTable.get(t.id)) })));
  });

  admin.post('/tables', (req, res) => {
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label_required' });
    const r = db.prepare('SELECT id FROM restaurants ORDER BY id LIMIT 1').get();
    const info = db.prepare('INSERT INTO tables (restaurant_id, label, token) VALUES (?, ?, ?)')
      .run(r.id, label, newToken());
    res.status(201).json(q.tableById.get(info.lastInsertRowid));
  });

  admin.post('/tables/:id/bill', (req, res) => {
    const table = q.tableById.get(Number(req.params.id));
    if (!table) return res.status(404).json({ error: 'table_not_found' });
    const existing = q.openBillForTable.get(table.id);
    if (existing) return res.status(409).json({ error: 'table_has_bill', bill: billSummary(existing) });
    const info = db.prepare('INSERT INTO bills (table_id) VALUES (?)').run(table.id);
    res.status(201).json(billSummary(q.billById.get(info.lastInsertRowid)));
  });

  admin.post('/bills/:id/items', (req, res) => {
    const bill = q.billById.get(Number(req.params.id));
    if (!bill) return res.status(404).json({ error: 'bill_not_found' });
    if (bill.status !== 'open') return res.status(409).json({ error: 'bill_not_open' });
    const name = String(req.body?.name || '').trim();
    const quantity = req.body?.quantity ?? 1;
    const unitPrice = req.body?.unit_price;
    if (!name || !isPositiveInt(quantity) || !Number.isInteger(unitPrice) || unitPrice < 0) {
      return res.status(400).json({ error: 'invalid_item' });
    }
    db.prepare('INSERT INTO bill_items (bill_id, name, quantity, unit_price) VALUES (?, ?, ?, ?)')
      .run(bill.id, name, quantity, unitPrice);
    res.status(201).json(billSummary(bill));
  });

  admin.delete('/items/:id', (req, res) => {
    const item = db.prepare('SELECT * FROM bill_items WHERE id = ?').get(Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'item_not_found' });
    const bill = q.billById.get(item.bill_id);
    if (bill.status !== 'open') return res.status(409).json({ error: 'bill_not_open' });
    const s = billSummary(bill);
    if (s.total - item.quantity * item.unit_price < s.paid) {
      return res.status(409).json({ error: 'would_go_below_paid' });
    }
    db.prepare('DELETE FROM bill_items WHERE id = ?').run(item.id);
    res.json(billSummary(bill));
  });

  // Free the table (after it's paid, or manually e.g. paid in cash).
  admin.post('/bills/:id/close', (req, res) => {
    const bill = q.billById.get(Number(req.params.id));
    if (!bill) return res.status(404).json({ error: 'bill_not_found' });
    q.setBillStatus.run('closed', new Date().toISOString(), bill.id);
    res.json({ ok: true });
  });

  app.use('/api/admin', admin);

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}

module.exports = { createApp };
