// Bill helpers shared by the customer and staff routes.
const { tx } = require('./db');

// A table's current bill: open, or fully paid but not yet released by staff.
function currentBill(db, tableId) {
  return db.prepare(
    "SELECT * FROM bills WHERE table_id = ? AND status IN ('open','paid') ORDER BY id DESC LIMIT 1").get(tableId) || null;
}

function billSummary(db, bill, guestId = null) {
  if (!bill) return null;
  const items = db.prepare(`
    SELECT bi.id, bi.name, bi.quantity, bi.unit_price, bi.guest_id, g.name AS guest_name
    FROM bill_items bi LEFT JOIN guests g ON g.id = bi.guest_id
    WHERE bi.bill_id = ? ORDER BY bi.id`).all(bill.id);
  const payments = db.prepare(`
    SELECT p.id, p.amount, p.tip, p.method, p.created_at, p.guest_id, g.name AS guest_name
    FROM payments p LEFT JOIN guests g ON g.id = p.guest_id
    WHERE p.bill_id = ? AND p.status = 'approved' ORDER BY p.id`).all(bill.id);
  const total = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const remaining = Math.max(0, total - paid);
  const summary = {
    id: bill.id,
    status: bill.status,
    items: items.map((i) => ({ ...i, mine: guestId != null && i.guest_id === guestId })),
    payments: payments.map((p) => ({ ...p, mine: guestId != null && p.guest_id === guestId })),
    total,
    paid,
    tips: payments.reduce((s, p) => s + p.tip, 0),
    remaining,
  };
  if (guestId != null) {
    const myItems = items.filter((i) => i.guest_id === guestId).reduce((s, i) => s + i.quantity * i.unit_price, 0);
    const myPaid = payments.filter((p) => p.guest_id === guestId).reduce((s, p) => s + p.amount, 0);
    summary.myItems = myItems;
    summary.myPaid = myPaid;
    summary.myDue = Math.min(remaining, Math.max(0, myItems - myPaid));
  }
  return summary;
}

// Returns an open bill for the table, reopening a paid-but-unreleased one or creating a new one.
// Must be called inside a transaction.
function ensureOpenBill(db, tableId) {
  const bill = currentBill(db, tableId);
  if (bill?.status === 'open') return bill.id;
  if (bill?.status === 'paid') {
    db.prepare("UPDATE bills SET status = 'open', closed_at = NULL WHERE id = ?").run(bill.id);
    return bill.id;
  }
  return Number(db.prepare('INSERT INTO bills (table_id) VALUES (?)').run(tableId).lastInsertRowid);
}

function addBillItem(db, billId, { name, quantity, unitPrice, guestId = null, orderId = null }) {
  db.prepare('INSERT INTO bill_items (bill_id, guest_id, order_id, name, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?)')
    .run(billId, guestId, orderId, name, quantity, unitPrice);
}

function approveOrder(db, orderId) {
  return tx(db, () => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ? AND status = 'pending'").get(orderId);
    if (!order) return null;
    const billId = ensureOpenBill(db, order.table_id);
    for (const it of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id)) {
      addBillItem(db, billId, { name: it.name, quantity: it.quantity, unitPrice: it.unit_price, guestId: order.guest_id, orderId: order.id });
    }
    db.prepare("UPDATE orders SET status = 'approved', decided_at = ? WHERE id = ?").run(Date.now(), order.id);
    return billId;
  });
}

function orderWithItems(db, order) {
  return {
    id: order.id,
    status: order.status,
    note: order.note,
    created_at: order.created_at,
    decided_at: order.decided_at,
    items: db.prepare('SELECT name, quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY id').all(order.id),
  };
}

module.exports = { currentBill, billSummary, ensureOpenBill, addBillItem, approveOrder, orderWithItems };
