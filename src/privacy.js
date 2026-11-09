// Privacy: consent version, data retention and data-subject requests (review / erase).
// What this module does must stay in sync with public/privacy.html.

const POLICY_VERSION = '2026-11-09';
const ANON_NAME = 'לקוח/ה';

// Erase personal details of the matching guests. Financial records (orders, payments)
// are kept for bookkeeping, but no longer identify the person.
function anonymize(db, guestIds) {
  if (!guestIds.length) return 0;
  const now = Date.now();
  const g = db.prepare(`UPDATE guests SET name = ?, phone = '', marketing_consent = 0, anonymized_at = ?
    WHERE id = ? AND anonymized_at IS NULL`);
  const notes = db.prepare("UPDATE orders SET note = '' WHERE guest_id = ?");
  let n = 0;
  for (const id of guestIds) {
    n += Number(g.run(ANON_NAME, now, id).changes);
    notes.run(id);
  }
  return n;
}

// Retention: anonymize visits older than `months`.
function purgeExpired(db, months) {
  const cutoff = Date.now() - months * 30.44 * 86400e3;
  const ids = db.prepare('SELECT id FROM guests WHERE created_at < ? AND anonymized_at IS NULL').all(cutoff).map((r) => r.id);
  return anonymize(db, ids);
}

// All visits of a phone number at one restaurant (right to review).
function lookupByPhone(db, restaurantId, phone) {
  return db.prepare(`
    SELECT g.id, g.name, g.phone, g.created_at, g.marketing_consent, t.label AS table_label,
      (SELECT COUNT(*) FROM orders o WHERE o.guest_id = g.id) AS orders,
      (SELECT COALESCE(SUM(p.amount + p.tip), 0) FROM payments p WHERE p.guest_id = g.id AND p.status = 'approved') AS paid
    FROM guests g JOIN tables t ON t.id = g.table_id
    WHERE t.restaurant_id = ? AND g.phone = ? AND g.anonymized_at IS NULL
    ORDER BY g.created_at DESC`).all(restaurantId, phone);
}

// Right to deletion / withdrawing consent for one restaurant's records of a phone number.
function eraseByPhone(db, restaurantId, phone) {
  return anonymize(db, lookupByPhone(db, restaurantId, phone).map((v) => v.id));
}

function startRetentionJob(db, months) {
  const run = () => {
    try {
      const n = purgeExpired(db, months);
      if (n) console.log(`Privacy retention: anonymized ${n} diner record(s) older than ${months} months.`);
    } catch (e) {
      console.error('Privacy retention job failed:', e);
    }
  };
  run();
  return setInterval(run, 24 * 3600e3).unref();
}

module.exports = { POLICY_VERSION, purgeExpired, lookupByPhone, eraseByPhone, startRetentionJob };
