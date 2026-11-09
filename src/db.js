// SQLite storage, using Node's built-in driver (no native build step).
// All money is stored as integer agorot (1 ₪ = 100 agorot) to avoid float errors.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 3;

function newToken(bytes = 9) {
  return crypto.randomBytes(bytes).toString('base64url');
}

const SCHEMA = `
  CREATE TABLE restaurants (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    ordering_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE staff_sessions (
    token TEXT PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE tables (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    label TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    UNIQUE (restaurant_id, number)
  );
  CREATE TABLE menu_items (
    id INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL CHECK (price >= 0),
    available INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0
  );
  -- A diner who scanned a table QR and identified themselves (name + phone).
  CREATE TABLE guests (
    id INTEGER PRIMARY KEY,
    table_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    ended_at INTEGER, -- set when staff release the table, so the next party starts fresh
    privacy_version TEXT,                          -- privacy policy version the diner accepted
    marketing_consent INTEGER NOT NULL DEFAULT 0,  -- separate opt-in for marketing messages
    anonymized_at INTEGER                          -- personal details erased (retention / request)
  );
  CREATE INDEX idx_guests_phone ON guests(phone);
  CREATE TABLE bills (
    id INTEGER PRIMARY KEY,
    table_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','closed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
  );
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    table_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER REFERENCES menu_items(id),
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
  );
  CREATE TABLE bill_items (
    id INTEGER PRIMARY KEY,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
    order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
  );
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    tip INTEGER NOT NULL DEFAULT 0 CHECK (tip >= 0),
    method TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('approved','declined')),
    provider_ref TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_tables_restaurant ON tables(restaurant_id);
  CREATE INDEX idx_bills_table ON bills(table_id, status);
  CREATE INDEX idx_orders_table ON orders(table_id, status);
  CREATE INDEX idx_menu_restaurant ON menu_items(restaurant_id);
  CREATE INDEX idx_guests_table ON guests(table_id);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  let { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version === 2) {
    // v2 → v3: privacy consent and anonymization fields on guests.
    db.exec(`
      ALTER TABLE guests ADD COLUMN privacy_version TEXT;
      ALTER TABLE guests ADD COLUMN marketing_consent INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE guests ADD COLUMN anonymized_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_guests_phone ON guests(phone);
      PRAGMA user_version = 3;`);
    version = 3;
  }
  if (version !== SCHEMA_VERSION) {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    if (existing.length) {
      // Pre-release: no production data exists yet, so an outdated dev database is rebuilt.
      console.warn(`Database schema v${version} is outdated; rebuilding as v${SCHEMA_VERSION}.`);
      db.exec('PRAGMA foreign_keys = OFF;');
      for (const { name } of existing) db.exec(`DROP TABLE IF EXISTS "${name}"`);
      db.exec('PRAGMA foreign_keys = ON;');
    }
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

// Run fn inside a single write transaction.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Create `count` tables numbered after the restaurant's current highest number.
function addTables(db, restaurantId, count) {
  const { max } = db.prepare('SELECT COALESCE(MAX(number), 0) AS max FROM tables WHERE restaurant_id = ?').get(restaurantId);
  const insert = db.prepare('INSERT INTO tables (restaurant_id, number, label, token) VALUES (?, ?, ?, ?)');
  for (let n = max + 1; n <= max + count; n++) insert.run(restaurantId, n, `שולחן ${n}`, newToken());
}

module.exports = { openDb, newToken, tx, addTables };
