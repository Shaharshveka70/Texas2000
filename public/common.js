// Shared helpers. Money is integer agorot everywhere; convert only for display/input.
const fmt = (agorot) => '₪' + (agorot / 100).toLocaleString('he-IL', {
  minimumFractionDigits: agorot % 100 ? 2 : 0, maximumFractionDigits: 2 });
const toAgorot = (shekels) => Math.round(Number(shekels) * 100);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pressOne(container, btn) {
  container.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
}

function toast(text, ms = 3000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function timeAgo(ms) {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'עכשיו';
  if (mins < 60) return `לפני ${mins} דק׳`;
  const h = Math.floor(mins / 60);
  return h === 1 ? 'לפני שעה' : `לפני ${h} שעות`;
}

const METHOD_NAMES = { apple_pay: 'Apple Pay', google_pay: 'Google Pay', bit: 'bit', card: 'אשראי' };
const ORDER_STATUS = {
  pending: ['ממתינה לאישור', 'warn'],
  approved: ['אושרה', 'ok'],
  rejected: ['לא אושרה', 'bad'],
};

const ERROR_TEXT = {
  invalid_name: 'נא להזין שם (לפחות 2 תווים).',
  invalid_phone: 'מספר הטלפון לא תקין. נא להזין מספר נייד, למשל 050-1234567.',
  amount_exceeds_remaining: 'הסכום גבוה מהיתרה. מישהו אחר בשולחן כבר שילם חלק. עדכנו ונסו שוב.',
  bill_changed_during_payment: 'החשבון עודכן בזמן התשלום. החיוב בוטל, נסו שוב.',
  bill_changed: 'החשבון עודכן. נסו שוב.',
  payment_declined: 'התשלום נדחה. נסו אמצעי תשלום אחר.',
  invalid_tip: 'סכום הטיפ לא תקין.',
  invalid_amount: 'הסכום לא תקין.',
  no_open_bill: 'אין חשבון פתוח לשולחן הזה.',
  item_unavailable: 'אחד הפריטים אזל. הסירו אותו ונסו שוב.',
  ordering_disabled: 'המקום לא מקבל כרגע הזמנות דרך האפליקציה.',
  too_many_pending: 'יש לכם כבר כמה הזמנות שממתינות לאישור. רגע אחד…',
  bad_credentials: 'שם משתמש או סיסמה שגויים.',
  too_many_attempts: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.',
  username_taken: 'שם המשתמש תפוס. בחרו שם אחר.',
  invalid_username: 'שם משתמש: 3–30 תווים באנגלית, ספרות, נקודה, מקף או קו תחתון.',
  weak_password: 'הסיסמה חייבת להכיל לפחות 8 תווים.',
  wrong_password: 'הסיסמה הנוכחית שגויה.',
  demo_locked: 'אי אפשר לשנות את הסיסמה של חשבון הדמו.',
  would_go_below_paid: 'אי אפשר להסיר: כבר שולם יותר מהסכום שיישאר.',
  table_has_bill: 'לשולחן יש חשבון פתוח. סגרו אותו קודם.',
};
const errorText = (code) => ERROR_TEXT[code] || 'משהו השתבש. נסו שוב.';
