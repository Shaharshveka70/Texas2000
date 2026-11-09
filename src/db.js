// SQLite storage, using Node's built-in driver (no native build step).
// All money is stored as integer agorot (1 ₪ = 100 agorot) to avoid float errors.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function newToken() {
  return crypto.randomBytes(9).toString('base64url');
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS restaurants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
      label TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY,
      table_id INTEGER NOT NULL REFERENCES tables(id),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS bill_items (
      id INTEGER PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES bills(id),
      amount INTEGER NOT NULL CHECK (amount > 0),
      tip INTEGER NOT NULL DEFAULT 0 CHECK (tip >= 0),
      method TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('approved','declined')),
      provider_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedDemo(db) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM restaurants').get();
  if (existing.n > 0) return;
  const r = db.prepare('INSERT INTO restaurants (name) VALUES (?)').run('Texas Café');
  const addTable = db.prepare('INSERT INTO tables (restaurant_id, label, token) VALUES (?, ?, ?)');
  const tableIds = [];
  for (let i = 1; i <= 6; i++) {
    tableIds.push(addTable.run(r.lastInsertRowid, `שולחן ${i}`, newToken()).lastInsertRowid);
  }
  const bill = db.prepare('INSERT INTO bills (table_id) VALUES (?)').run(tableIds[0]);
  const addItem = db.prepare('INSERT INTO bill_items (bill_id, name, quantity, unit_price) VALUES (?, ?, ?, ?)');
  addItem.run(bill.lastInsertRowid, 'שקשוקה', 2, 5800);
  addItem.run(bill.lastInsertRowid, 'סלט ירקות', 1, 4200);
  addItem.run(bill.lastInsertRowid, 'קפוצ׳ינו', 2, 1600);
  addItem.run(bill.lastInsertRowid, 'לימונדה', 1, 1400);
}

module.exports = { openDb, seedDemo, newToken };
