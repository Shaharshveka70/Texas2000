let pin = sessionStorage.getItem('pin') || '';

async function api(path, opts = {}) {
  const res = await fetch('/api/admin' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-pin': pin, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { showLogin(true); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert('שגיאה: ' + (data.error || res.status)); throw new Error(data.error); }
  return data;
}

function showLogin(failed) {
  $('login').classList.remove('hidden');
  $('dash').classList.add('hidden');
  $('loginError').classList.toggle('hidden', !failed);
}

const METHOD_NAMES = { apple_pay: 'Apple Pay', google_pay: 'Google Pay', bit: 'bit', card: 'אשראי' };

function tableCard(t) {
  const b = t.bill;
  const payLink = `/pay.html?t=${t.token}`;
  let body;
  if (!b) {
    body = `<p class="sub no-print">אין חשבון פתוח</p>
      <button class="btn small no-print" data-act="open" data-id="${t.id}">פתיחת חשבון</button>`;
  } else {
    const badge = b.status === 'paid' ? '<span class="badge paid">שולם במלואו</span>'
      : b.paid > 0 ? '<span class="badge">שולם חלקית</span>' : '<span class="badge">פתוח</span>';
    body = `<div class="no-print">
      ${badge}
      <div style="margin-top:8px">${b.items.map((i) => `
        <div class="row"><span>${esc(i.name)} <span class="qty">×${i.quantity}</span></span>
        <span><span class="money">${fmt(i.quantity * i.unit_price)}</span>
        ${b.status === 'open' ? `<button class="chip" style="padding:2px 8px" title="הסרה" data-act="del" data-id="${i.id}">✕</button>` : ''}</span></div>`).join('')}
      </div>
      <div class="row total"><span>סה״כ</span><span class="money">${fmt(b.total)}</span></div>
      <div class="row muted"><span>שולם</span><span class="money">${fmt(b.paid)}</span></div>
      <div class="row muted"><span>טיפים</span><span class="money">${fmt(b.tips)}</span></div>
      <div class="row"><b>יתרה</b><b class="money">${fmt(b.remaining)}</b></div>
      ${b.payments.map((p) => `<div class="row muted" style="font-size:.85em"><span>${METHOD_NAMES[p.method] || p.method}</span>
        <span class="money">${fmt(p.amount)} + טיפ ${fmt(p.tip)}</span></div>`).join('')}
      ${b.status === 'open' ? `
        <div class="inline" style="margin-top:10px">
          <input placeholder="פריט" data-f="name">
          <input placeholder="₪" type="number" step="0.01" min="0" data-f="price" style="max-width:80px">
          <input type="number" min="1" value="1" data-f="qty" style="max-width:56px" title="כמות">
        </div>
        <p style="margin:8px 0 0"><button class="btn small" data-act="add" data-id="${b.id}">הוספת פריט</button></p>` : ''}
      <p style="margin:8px 0 0"><button class="btn small secondary" data-act="close" data-id="${b.id}"
        data-paid="${b.status === 'paid'}">${b.status === 'paid' ? 'שחרור השולחן' : 'סגירה ידנית (מזומן)'}</button></p>
    </div>`;
  }
  return `<div class="card">
    <div class="row"><h2 style="margin:0">${esc(t.label)}</h2>
      <a class="no-print" href="${payLink}" target="_blank" style="font-size:.85em">מסך הלקוח ↗</a></div>
    <img class="qr" src="/qr/${t.token}.png" alt="ברקוד לתשלום — ${esc(t.label)}">
    <p class="sub" style="text-align:center;margin:0 0 8px">סרקו כדי לשלם ולהשאיר טיפ</p>
    ${body}</div>`;
}

let editing = false;
async function refresh() {
  if (editing) return; // don't wipe what a waiter is typing
  const tables = await api('/tables');
  $('tables').innerHTML = tables.map(tableCard).join('');
}

$('tables').addEventListener('focusin', (e) => { if (e.target.matches('input')) editing = true; });
$('tables').addEventListener('focusout', () => { editing = false; });
$('tables').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === 'open') await api(`/tables/${id}/bill`, { method: 'POST' });
  if (btn.dataset.act === 'del') await api(`/items/${id}`, { method: 'DELETE' });
  if (btn.dataset.act === 'close') {
    if (btn.dataset.paid !== 'true' && !confirm('לסגור את החשבון בלי תשלום באפליקציה?')) return;
    await api(`/bills/${id}/close`, { method: 'POST' });
  }
  if (btn.dataset.act === 'add') {
    const card = btn.closest('.card');
    const f = (k) => card.querySelector(`[data-f="${k}"]`).value;
    if (!f('name').trim() || f('price') === '') return;
    await api(`/bills/${id}/items`, { method: 'POST',
      body: { name: f('name'), unit_price: toAgorot(f('price')), quantity: parseInt(f('qty'), 10) || 1 } });
  }
  editing = false;
  refresh();
});

$('addTable').addEventListener('click', async () => {
  const label = $('newTable').value.trim();
  if (!label) return;
  await api('/tables', { method: 'POST', body: { label } });
  $('newTable').value = '';
  refresh();
});

async function login() {
  pin = $('pin').value;
  try {
    await api('/tables');
    sessionStorage.setItem('pin', pin);
    $('login').classList.add('hidden');
    $('dash').classList.remove('hidden');
    refresh();
  } catch { /* showLogin already handled it */ }
}
$('loginBtn').addEventListener('click', login);
$('pin').addEventListener('keydown', (e) => e.key === 'Enter' && login());
$('logout').addEventListener('click', () => { sessionStorage.removeItem('pin'); pin = ''; showLogin(false); });

if (pin) { $('pin').value = pin; login(); }
setInterval(() => { if (!$('dash').classList.contains('hidden')) refresh(); }, 5000);
