// Staff dashboard: tables, order queue, menu and settings for the logged-in restaurant.
const S = { view: 'tables', overview: null, menu: [], openTableId: null, knownOrders: null };

async function api(path, opts = {}) {
  const res = await fetch('/api/staff' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.method && opts.method !== 'GET' ? JSON.stringify(opts.body || {}) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(errorText(data.error)); throw new Error(data.error); }
  return data;
}

// ---------- Navigation ----------

document.querySelector('.nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});
function setView(view) {
  S.view = view;
  document.querySelectorAll('.nav [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  for (const v of ['tables', 'orders', 'menu', 'settings']) $(`view-${v}`).classList.toggle('hidden', v !== view);
  if (view === 'menu') loadMenu();
  if (view === 'settings') renderSettings();
}

// ---------- Overview polling ----------

async function refresh() {
  const o = await api('/overview');
  S.overview = o;
  $('rName').textContent = o.restaurant.name;
  $('rUser').textContent = o.restaurant.username;
  $('logo').textContent = o.restaurant.name.trim().charAt(0) || 'T';
  document.title = `${o.pendingOrders.length ? `(${o.pendingOrders.length}) ` : ''}${o.restaurant.name} · ניהול`;
  $('demoBar').classList.toggle('hidden', !o.restaurant.isDemo);
  $('rMode').textContent = o.restaurant.orderingEnabled ? 'הזמנה ותשלום' : 'רק תשלום';
  // Payment-only places have no order queue (unless orders are still waiting from before the switch).
  const showOrders = o.restaurant.orderingEnabled || o.pendingOrders.length > 0;
  document.querySelector('.nav [data-view="orders"]').classList.toggle('hidden', !showOrders);
  $('legendPending').classList.toggle('hidden', !showOrders);
  if (!showOrders && S.view === 'orders') setView('tables');

  // Alert on newly arrived orders.
  const ids = new Set(o.pendingOrders.map((x) => x.id));
  if (S.knownOrders) {
    const fresh = o.pendingOrders.filter((x) => !S.knownOrders.has(x.id));
    if (fresh.length) {
      beep();
      toast(`הזמנה חדשה מ${fresh[0].table.label} (${fresh[0].guest.name || 'לקוח'})`);
    }
  }
  S.knownOrders = ids;

  $('ordersCount').textContent = o.pendingOrders.length;
  $('ordersCount').classList.toggle('hidden', !o.pendingOrders.length);
  renderTiles();
  renderOrders();
  if (S.openTableId && !drawerBusy()) openTable(S.openTableId, true);
}

function tileState(t) {
  if (t.pendingOrders) return ['alert', `<span class="badge warn">${t.pendingOrders === 1 ? 'הזמנה ממתינה' : `${t.pendingOrders} הזמנות ממתינות`}</span>`];
  if (t.bill?.status === 'paid') return ['paid', '<span class="badge ok">שולם ✓ לשחרר שולחן</span>'];
  if (t.bill) {
    return ['open', `<span class="money"><b>${fmt(t.bill.remaining)}</b> <span class="muted small">נותר</span></span>
      ${t.bill.paid ? `<span class="muted small">שולם ${fmt(t.bill.paid)}</span>` : ''}`];
  }
  if (t.guests) return ['seated', '<span class="muted small">מעיינים בתפריט</span>'];
  return ['', '<span class="muted small">פנוי</span>'];
}

function renderTiles() {
  $('tiles').innerHTML = S.overview.tables.map((t) => {
    const [cls, body] = tileState(t);
    return `<button class="tile ${cls}" data-table="${t.id}">
      <div class="row" style="padding:0"><span class="num">${esc(t.label)}</span>
        ${t.guests ? `<span class="muted small" title="סועדים מחוברים">👤 ${t.guests}</span>` : ''}</div>
      ${body}</button>`;
  }).join('');
}
$('tiles').addEventListener('click', (e) => {
  const b = e.target.closest('[data-table]');
  if (b) openTable(Number(b.dataset.table));
});

function orderCard(o, { compact = false } = {}) {
  const total = o.items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  return `<div class="card">
    ${compact ? '' : `<div class="row"><h2 style="margin:0">${esc(o.table.label)}</h2><span class="muted small">${timeAgo(o.created_at)}</span></div>
    <div class="muted small" style="margin-bottom:8px">${esc(o.guest.name || '')}${o.guest.phone ? ` · <a href="tel:${esc(o.guest.phone)}" dir="ltr">${esc(o.guest.phone)}</a>` : ''}</div>`}
    ${o.items.map((i) => `<div class="row"><span><b>${i.quantity}×</b> ${esc(i.name)}</span><span class="money muted">${fmt(i.quantity * i.unit_price)}</span></div>`).join('')}
    ${o.note ? `<div class="badge warn" style="margin:6px 0;white-space:normal">📝 ${esc(o.note)}</div>` : ''}
    <div class="row total"><span>סה״כ</span><span class="money">${fmt(total)}</span></div>
    <div class="inline" style="margin-top:10px">
      <button class="btn small" data-approve="${o.id}">✓ אישור</button>
      <button class="btn small danger" data-reject="${o.id}">דחייה</button>
    </div></div>`;
}

function renderOrders() {
  const list = S.overview.pendingOrders;
  $('orders').innerHTML = list.map((o) => orderCard(o)).join('');
  $('noOrders').classList.toggle('hidden', list.length > 0);
}

async function decide(e) {
  const a = e.target.closest('[data-approve]');
  const r = e.target.closest('[data-reject]');
  if (!a && !r) return;
  if (r && !confirm('לדחות את ההזמנה? הלקוח יקבל הודעה שההזמנה לא אושרה.')) return;
  await api(`/orders/${(a || r).dataset.approve || (a || r).dataset.reject}/${a ? 'approve' : 'reject'}`, { method: 'POST' });
  toast(a ? 'ההזמנה אושרה ונוספה לחשבון' : 'ההזמנה נדחתה');
  refresh();
}
$('orders').addEventListener('click', decide);

// ---------- Table drawer ----------

function drawerBusy() {
  const el = document.activeElement;
  return el && $('drawer').contains(el) && el.matches('input, select, textarea');
}

async function openTable(id, silent = false) {
  S.openTableId = id;
  if (!S.menu.length) S.menu = await api('/menu');
  const d = await api(`/tables/${id}`);
  const b = d.bill;
  const pending = d.orders.filter((o) => o.status === 'pending');
  const menuOptions = groupMenu(S.menu.filter((m) => m.available)).map(([cat, items]) =>
    `<optgroup label="${esc(cat)}">${items.map((m) => `<option value="${m.id}">${esc(m.name)} · ${fmt(m.price)}</option>`).join('')}</optgroup>`).join('');

  $('drawerBody').innerHTML = `
    <div class="row" style="align-items:center;margin-bottom:12px">
      <h1 id="dTitle">${esc(d.table.label)}</h1>
      <button class="icon-btn" data-close aria-label="סגירה">✕</button>
    </div>
    <div class="inline" style="margin-bottom:14px">
      <a class="btn small secondary" href="/t/${d.table.token}" target="_blank">📱 מסך הלקוח</a>
      <a class="btn small secondary" href="/qr/${d.table.token}.png" target="_blank">ברקוד</a>
    </div>

    ${pending.length ? `<h2>ממתינות לאישור</h2>${pending.map((o) => orderCard({ ...o, table: d.table }, { compact: true })
      .replace('<div class="card">', `<div class="card" style="border-inline-start:5px solid var(--warn)"><div class="muted small" style="margin-bottom:6px">${esc(o.guest.name || '')} · ${timeAgo(o.created_at)}</div>`)).join('')}` : ''}

    <div class="card">
      <h2>סועדים בשולחן</h2>
      ${d.guests.length ? d.guests.map((g) => `<div class="row"><span>${esc(g.name)}
        ${g.marketing_consent ? '<span class="badge ok" title="הסכים/ה לקבל הודעות שיווקיות">מאשר/ת דיוור</span>' : ''}</span>
        ${g.phone ? `<a href="tel:${esc(g.phone)}" dir="ltr" class="small">${esc(g.phone)}</a>` : '<span class="muted small">בלי פרטים</span>'}</div>`).join('')
        : '<div class="muted">אף אחד לא סרק עדיין</div>'}
    </div>

    <div class="card">
      <div class="row"><h2 style="margin:0">חשבון</h2>${b ? (b.status === 'paid' ? '<span class="badge solid">שולם במלואו</span>'
        : b.paid ? '<span class="badge ok">שולם חלקית</span>' : '<span class="badge">פתוח</span>') : ''}</div>
      ${b && b.items.length ? `
        <div style="margin-top:8px">${b.items.map((i) => `
          <div class="row" style="align-items:center"><span>${esc(i.name)} <span class="qty">×${i.quantity}</span>
            ${i.guest_name ? `<span class="who">· ${esc(i.guest_name)}</span>` : '<span class="who">· צוות</span>'}</span>
          <span style="display:flex;gap:6px;align-items:center"><span class="money">${fmt(i.quantity * i.unit_price)}</span>
          ${b.status === 'open' ? `<button class="icon-btn" title="הסרה" data-del="${i.id}">✕</button>` : ''}</span></div>`).join('')}</div>
        <div class="row total"><span>סה״כ</span><span class="money">${fmt(b.total)}</span></div>
        <div class="row muted"><span>שולם</span><span class="money">${fmt(b.paid)}</span></div>
        <div class="row"><b>יתרה</b><b class="money">${fmt(b.remaining)}</b></div>
        ${b.payments.length ? `<h3 style="margin-top:12px">תשלומים</h3>${b.payments.map((p) => `
          <div class="row muted small"><span>${esc(p.guest_name || '')} · ${METHOD_NAMES[p.method] || p.method}</span>
          <span class="money">${fmt(p.amount)} + טיפ ${fmt(p.tip)}</span></div>`).join('')}
          <div class="row small"><b>סה״כ טיפים</b><b class="money">${fmt(b.tips)}</b></div>` : ''}`
        : '<div class="muted" style="margin-top:6px">אין פריטים בחשבון</div>'}
    </div>

    <div class="card">
      <h2>הוספת פריט לחשבון</h2>
      <div class="inline">
        <select id="dItem">${menuOptions}</select>
        <input id="dQty" type="number" min="1" max="50" value="1" style="max-width:70px" aria-label="כמות">
        <button class="btn small shrink" data-add-menu>הוספה</button>
      </div>
      <details style="margin-top:10px"><summary class="muted small">פריט שלא בתפריט</summary>
        <div class="inline" style="margin-top:8px">
          <input id="dFreeName" placeholder="שם הפריט">
          <input id="dFreePrice" type="number" min="0" step="0.5" placeholder="₪" style="max-width:80px">
          <button class="btn small shrink" data-add-free>הוספה</button>
        </div></details>
    </div>

    ${b ? `<button class="btn ${b.status === 'paid' ? '' : 'secondary'}" data-close-bill="${b.id}" data-paid="${b.status === 'paid'}">
      ${b.status === 'paid' ? 'שחרור השולחן ללקוחות הבאים' : 'סגירת חשבון ידנית (שולם במזומן / בקופה)'}</button>`
      : d.guests.length ? '<button class="btn secondary" data-release>שחרור השולחן (הסועדים עזבו)</button>' : ''}
  `;
  if (!silent || $('drawer').classList.contains('hidden')) $('drawer').classList.remove('hidden');
}

function groupMenu(items) {
  const m = new Map();
  for (const it of items) { if (!m.has(it.category)) m.set(it.category, []); m.get(it.category).push(it); }
  return [...m];
}

function closeDrawer() { $('drawer').classList.add('hidden'); S.openTableId = null; }
$('drawer').addEventListener('click', async (e) => {
  if (e.target.id === 'drawer' || e.target.closest('[data-close]')) return closeDrawer();
  const id = S.openTableId;
  const t = e.target;
  if (t.closest('[data-approve], [data-reject]')) return decide(e);
  if (t.closest('[data-del]')) {
    await api(`/items/${t.closest('[data-del]').dataset.del}`, { method: 'DELETE' });
  } else if (t.closest('[data-add-menu]')) {
    await api(`/tables/${id}/items`, { method: 'POST', body: { menuItemId: Number($('dItem').value), quantity: parseInt($('dQty').value, 10) || 1 } });
    toast('נוסף לחשבון');
  } else if (t.closest('[data-add-free]')) {
    const name = $('dFreeName').value.trim();
    if (!name || $('dFreePrice').value === '') return;
    await api(`/tables/${id}/items`, { method: 'POST', body: { name, unitPrice: toAgorot($('dFreePrice').value), quantity: 1 } });
    toast('נוסף לחשבון');
  } else if (t.closest('[data-close-bill]')) {
    const btn = t.closest('[data-close-bill]');
    if (btn.dataset.paid !== 'true' && !confirm('לסגור את החשבון בלי תשלום באפליקציה? (למשל אם שילמו במזומן)')) return;
    await api(`/bills/${btn.dataset.closeBill}/close`, { method: 'POST' });
    toast('השולחן שוחרר');
    closeDrawer();
  } else if (t.closest('[data-release]')) {
    await api(`/tables/${id}/release`, { method: 'POST' });
    toast('השולחן שוחרר');
    closeDrawer();
  } else return;
  refresh();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.openTableId) closeDrawer(); });

// ---------- Menu management ----------

async function loadMenu() {
  S.menu = await api('/menu');
  const groups = groupMenu(S.menu);
  $('cats').innerHTML = groups.map(([c]) => `<option value="${esc(c)}">`).join('');
  $('menuAdmin').innerHTML = groups.map(([cat, items]) => `
    <div class="card"><h2>${esc(cat)}</h2>
      ${items.map((m) => `<div class="menu-admin-row" data-mid="${m.id}">
        <div class="info"><b>${esc(m.name)}</b>${m.description ? `<div class="muted small">${esc(m.description)}</div>` : ''}</div>
        <span class="money">${fmt(m.price)}</span>
        <label class="switch small"><input type="checkbox" data-avail ${m.available ? 'checked' : ''}> ${m.available ? 'זמין' : 'אזל'}</label>
        <button class="btn small secondary" data-edit>עריכה</button>
        <button class="icon-btn" data-remove title="מחיקה">🗑</button>
      </div>`).join('')}
    </div>`).join('') || '<div class="card muted">התפריט ריק. הוסיפו את הפריט הראשון למעלה.</div>';
}

$('menuForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/menu', { method: 'POST', body: { category: $('mCat').value, name: $('mName').value,
    description: $('mDesc').value, price: toAgorot($('mPrice').value) } });
  $('mName').value = ''; $('mDesc').value = ''; $('mPrice').value = '';
  $('mName').focus();
  toast('הפריט נוסף לתפריט');
  loadMenu();
});

$('menuAdmin').addEventListener('change', async (e) => {
  if (!e.target.matches('[data-avail]')) return;
  const id = e.target.closest('[data-mid]').dataset.mid;
  await api(`/menu/${id}`, { method: 'PATCH', body: { available: e.target.checked } });
  loadMenu();
});

$('menuAdmin').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-mid]');
  if (!row) return;
  const item = S.menu.find((m) => m.id === Number(row.dataset.mid));
  if (e.target.closest('[data-remove]')) {
    if (!confirm(`למחוק את "${item.name}" מהתפריט?`)) return;
    await api(`/menu/${item.id}`, { method: 'DELETE' });
    loadMenu();
  }
  if (e.target.closest('[data-edit]')) {
    const name = prompt('שם הפריט', item.name);
    if (name === null) return;
    const price = prompt('מחיר ב־₪', item.price / 100);
    if (price === null) return;
    const description = prompt('תיאור', item.description);
    if (description === null) return;
    await api(`/menu/${item.id}`, { method: 'PATCH', body: { name, description, price: toAgorot(price) } });
    loadMenu();
  }
});

// ---------- Settings ----------

function renderSettings() {
  const o = S.overview;
  if (!o) return;
  $('setName').value = o.restaurant.name;
  $(o.restaurant.orderingEnabled ? 'modeOrder' : 'modePay').checked = true;
  $('modeDemoHint').classList.toggle('hidden', !o.restaurant.isDemo);
  $(o.restaurant.requireContact ? 'idContact' : 'idNone').checked = true;
  $('tablesInfo').textContent = `כרגע יש ${o.tables.length} שולחנות, לכל אחד ברקוד משלו.`;
}
$('saveName').addEventListener('click', async () => {
  await api('/settings', { method: 'PATCH', body: { name: $('setName').value } });
  toast('נשמר'); refresh();
});
$('idModes').addEventListener('change', async (e) => {
  const requireContact = e.target.value === 'contact';
  await api('/settings', { method: 'PATCH', body: { requireContact } });
  toast(requireContact ? 'מעכשיו הלקוחות מזינים שם וטלפון' : 'מעכשיו הלקוחות נכנסים בלי פרטים, רק לפי השולחן');
  refresh();
});

$('orderModes').addEventListener('change', async (e) => {
  const orderingEnabled = e.target.value === 'order';
  await api('/settings', { method: 'PATCH', body: { orderingEnabled } });
  toast(orderingEnabled ? 'עכשיו הלקוחות יכולים גם להזמין' : 'עכשיו הלקוחות רק רואים את החשבון ומשלמים');
  refresh();
});
$('addTables').addEventListener('click', async () => {
  await api('/tables', { method: 'POST', body: { count: parseInt($('addCount').value, 10) || 1 } });
  toast('השולחנות נוספו'); await refresh(); renderSettings();
});
$('changePass').addEventListener('click', async () => {
  await api('/password', { method: 'POST', body: { current: $('curPass').value, next: $('newPass').value } });
  $('curPass').value = ''; $('newPass').value = '';
  toast('הסיסמה עודכנה');
});

async function privacyLookup() {
  const { phone, visits } = await api('/privacy/lookup', { method: 'POST', body: { phone: $('privPhone').value } });
  if (!visits.length) {
    $('privResult').innerHTML = '<div class="muted">אין מידע שמור על המספר הזה.</div>';
    return;
  }
  $('privResult').innerHTML = `
    <div class="muted small" style="margin-bottom:6px">${visits.length === 1 ? 'נמצא ביקור אחד' : `נמצאו ${visits.length} ביקורים`} עבור <span dir="ltr">${esc(phone)}</span>:</div>
    ${visits.map((v) => `<div class="row small"><span>${new Date(v.created_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
      · ${esc(v.table_label)} · ${esc(v.name)}${v.marketing_consent ? ' · מאשר/ת דיוור' : ''}</span>
      <span class="money">${v.orders} הזמנות · ${fmt(v.paid)}</span></div>`).join('')}
    <p style="margin:12px 0 0"><button class="btn small danger" id="privErase" data-phone="${esc(phone)}">מחיקת הפרטים האישיים</button></p>
    <p class="muted small" style="margin:6px 0 0">השם, הטלפון וההערות יימחקו, וכך גם ההסכמה לדיוור. סכומי ההזמנות והתשלומים יישארו לצורכי הנהלת חשבונות, בלי פרטים מזהים.</p>`;
}
$('privLookup').addEventListener('click', privacyLookup);
$('privPhone').addEventListener('keydown', (e) => { if (e.key === 'Enter') privacyLookup(); });
$('privResult').addEventListener('click', async (e) => {
  const b = e.target.closest('#privErase');
  if (!b || !confirm('למחוק לצמיתות את הפרטים האישיים של הלקוח? אי אפשר לבטל את הפעולה.')) return;
  const { erased } = await api('/privacy/erase', { method: 'POST', body: { phone: b.dataset.phone } });
  $('privResult').innerHTML = `<div class="badge ok">הפרטים נמחקו (${erased === 1 ? 'ביקור אחד' : `${erased} ביקורים`}) ✓</div>`;
  refresh();
});

$('demoReset').addEventListener('click', async () => {
  if (!confirm('לאפס את כל ההזמנות, החשבונות והתשלומים בדמו ולחזור לתרחיש ההתחלתי?')) return;
  await api('/demo/reset', { method: 'POST' });
  S.knownOrders = null; S.menu = [];
  closeDrawer();
  toast('נתוני הדמו אופסו');
  refresh();
  if (S.view === 'menu') loadMenu();
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  location.href = '/login';
});

// Short chime for new orders (browsers allow audio only after the user has interacted with the page).
let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch { /* no audio available */ }
}

refresh();
setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 4000);
