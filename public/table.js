// Customer screen, opened from the table QR: /t/<tableToken>
const tableToken = location.pathname.split('/').filter(Boolean)[1] || '';
const storeKey = `guest:${tableToken}`;
const store = {
  get() { try { return localStorage.getItem(storeKey) || ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem(storeKey, v); } catch { /* private mode: token lives in memory only */ } },
  clear() { try { localStorage.removeItem(storeKey); } catch { /* ignore */ } },
};

const state = {
  guestToken: store.get(),
  info: null,
  menu: [],
  data: null,          // last /state response
  cart: new Map(),     // menuItemId -> quantity
  tab: 'menu',
  split: 'all', splitTouched: false, tip: '12', method: 'apple_pay',
  paying: false, lastReceipt: null,
  orderStatus: new Map(),
};

async function api(path, opts = {}) {
  const res = await fetch(`/api/t/${encodeURIComponent(tableToken)}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-guest': state.guestToken },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'guest_required') {
    // Session ended (e.g. staff released the table) → identify again.
    state.guestToken = ''; store.clear(); showJoin();
  }
  return { ok: res.ok, status: res.status, data };
}

function show(view) {
  for (const id of ['joinView', 'appView', 'errorView']) $(id).classList.toggle('hidden', id !== view);
  if (view !== 'appView') { $('cartBar').classList.add('hidden'); $('payBar').classList.add('hidden'); }
}

function showError(title, text) {
  $('errorTitle').textContent = title;
  $('errorText').textContent = text;
  show('errorView');
}

function showJoin() {
  show('joinView');
  setTimeout(() => $('name').focus(), 50);
}

// ---------- Boot ----------

async function boot() {
  if (!tableToken) return showError('קוד שולחן חסר', 'סרקו שוב את הברקוד שעל השולחן.');
  const res = await fetch(`/api/t/${encodeURIComponent(tableToken)}/info`);
  if (!res.ok) return showError('השולחן לא נמצא', 'סרקו שוב את הברקוד שעל השולחן, או פנו לצוות.');
  state.info = await res.json();
  $('restaurant').textContent = state.info.restaurant;
  $('tableLabel').textContent = state.info.table;
  $('logo').textContent = state.info.restaurant.trim().charAt(0) || '☕';
  document.title = `${state.info.restaurant} · ${state.info.table}`;
  $('joinIntro').textContent = state.info.orderingEnabled
    ? 'כדי לראות את התפריט, להזמין ולשלם, נא להזין שם ומספר טלפון.'
    : 'כדי לראות את החשבון ולשלם, נא להזין שם ומספר טלפון.';
  fetch('/api/legal').then((r) => r.json()).then((l) => { $('retentionTxt').textContent = `${l.retentionMonths} חודשים`; }).catch(() => {});
  document.querySelectorAll('.placeName').forEach((el) => { el.textContent = state.info.restaurant; });
  if (state.guestToken && await enterApp()) return;
  showJoin();
}

$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('joinError').classList.add('hidden');
  if (!$('acceptPrivacy').checked) {
    $('joinError').textContent = errorText('privacy_required');
    $('joinError').classList.remove('hidden');
    return;
  }
  const res = await fetch(`/api/t/${encodeURIComponent(tableToken)}/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: $('name').value, phone: $('phone').value,
      acceptPrivacy: $('acceptPrivacy').checked, marketing: $('marketing').checked }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('joinError').textContent = errorText(data.error);
    $('joinError').classList.remove('hidden');
    return;
  }
  state.guestToken = data.guestToken;
  store.set(data.guestToken);
  enterApp();
});

async function enterApp() {
  const [menu, st] = await Promise.all([api('/menu'), api('/state')]);
  if (!menu.ok || !st.ok) return false;
  state.menu = menu.data.categories;
  show('appView');
  applyState(st.data, true); // sets orderingEnabled, which the menu needs to show + buttons
  renderMenu();
  applyMode();
  return true;
}

// ---------- Tabs ----------

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

// "Payment only" places: no menu or tabs, the diner lands straight on the bill.
function applyMode() {
  const ordering = canOrder();
  document.querySelector('.tabs').classList.toggle('hidden', !ordering);
  if (!ordering) state.cart.clear();
  setTab(ordering ? state.tab : 'bill');
}

function setTab(tab) {
  state.tab = tab;
  $('tabMenu').setAttribute('aria-selected', String(tab === 'menu'));
  $('tabBill').setAttribute('aria-selected', String(tab === 'bill'));
  $('menuPane').classList.toggle('hidden', tab !== 'menu');
  $('billPane').classList.toggle('hidden', tab !== 'bill');
  renderBars();
  window.scrollTo({ top: 0 });
}

// ---------- Menu & cart ----------

function canOrder() { return !!state.data?.orderingEnabled; }

function renderMenu() {
  $('orderingOff').classList.toggle('hidden', canOrder());
  $('catNav').innerHTML = state.menu.map((c, i) => `<button class="chip" data-cat="${i}">${esc(c.name)}</button>`).join('');
  $('menuList').innerHTML = state.menu.map((c, i) => `
    <div class="card" id="cat-${i}" style="scroll-margin-top:60px">
      <h2>${esc(c.name)}</h2>
      ${c.items.map((it) => `
        <div class="menu-item ${it.available ? '' : 'off'}">
          <div class="info">
            <div class="name">${esc(it.name)}</div>
            ${it.description ? `<div class="desc">${esc(it.description)}</div>` : ''}
            <div class="money">${fmt(it.price)}</div>
          </div>
          ${!it.available ? '<span class="badge">אזל</span>' : canOrder() ? `<div class="stepper" data-item="${it.id}">${stepperInner(it.id)}</div>` : ''}
        </div>`).join('')}
    </div>`).join('');
  renderBars();
}

function stepperInner(id) {
  const q = state.cart.get(id) || 0;
  if (!q) return `<button class="icon-btn add" data-act="inc" aria-label="הוספה">+</button>`;
  return `<button class="icon-btn" data-act="dec" aria-label="הפחתה">−</button><b>${q}</b>
    <button class="icon-btn add" data-act="inc" aria-label="הוספה">+</button>`;
}

function menuItem(id) {
  for (const c of state.menu) for (const it of c.items) if (it.id === id) return it;
  return null;
}

function changeQty(id, delta) {
  const q = Math.max(0, Math.min(20, (state.cart.get(id) || 0) + delta));
  if (q) state.cart.set(id, q); else state.cart.delete(id);
  document.querySelectorAll(`.stepper[data-item="${id}"]`).forEach((el) => { el.innerHTML = stepperInner(id); });
  renderBars();
  if (!$('cartSheet').classList.contains('hidden')) renderCart();
}

$('menuList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = Number(b.closest('[data-item]').dataset.item);
  changeQty(id, b.dataset.act === 'inc' ? 1 : -1);
});
$('catNav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (b) $(`cat-${b.dataset.cat}`).scrollIntoView({ behavior: 'smooth' });
});

function cartTotals() {
  let count = 0, total = 0;
  for (const [id, q] of state.cart) { const it = menuItem(id); if (it) { count += q; total += q * it.price; } }
  return { count, total };
}

function renderCart() {
  const lines = [...state.cart].map(([id, q]) => ({ it: menuItem(id), q })).filter((l) => l.it);
  if (!lines.length) { closeCart(); return; }
  $('cartLines').innerHTML = lines.map(({ it, q }) => `
    <div class="row" style="align-items:center">
      <span>${esc(it.name)}<br><span class="money muted small">${fmt(it.price * q)}</span></span>
      <div class="stepper" data-item="${it.id}">${stepperInner(it.id)}</div>
    </div>`).join('');
  $('cartTotal').textContent = fmt(cartTotals().total);
}
$('cartLines').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) changeQty(Number(b.closest('[data-item]').dataset.item), b.dataset.act === 'inc' ? 1 : -1);
});

function openCart() { $('cartError').classList.add('hidden'); renderCart(); $('cartSheet').classList.remove('hidden'); }
function closeCart() { $('cartSheet').classList.add('hidden'); }
$('openCart').addEventListener('click', openCart);
$('closeCart').addEventListener('click', closeCart);
$('cartSheet').addEventListener('click', (e) => { if (e.target.id === 'cartSheet') closeCart(); });

$('sendOrder').addEventListener('click', async () => {
  const items = [...state.cart].map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
  $('sendOrder').disabled = true;
  try {
    const r = await api('/orders', { method: 'POST', body: { items, note: $('note').value } });
    if (!r.ok) {
      $('cartError').textContent = errorText(r.data.error) + (r.data.item ? ` (${r.data.item})` : '');
      $('cartError').classList.remove('hidden');
      return;
    }
    state.cart.clear();
    state.lastReceipt = null;
    $('note').value = '';
    closeCart();
    renderMenu();
    toast('ההזמנה נשלחה לצוות ✓ נעדכן כשהיא תאושר');
    await refresh();
    setTab('bill');
  } finally {
    $('sendOrder').disabled = false;
  }
});

// ---------- Bill & payment ----------

function applyState(data, first = false) {
  const prevOrdering = state.data?.orderingEnabled;
  state.data = data;
  if (!first && prevOrdering !== data.orderingEnabled) { renderMenu(); applyMode(); }

  // Notify when staff decide on an order.
  for (const o of data.orders) {
    const prev = state.orderStatus.get(o.id);
    if (!first && prev === 'pending' && o.status === 'approved') toast('ההזמנה שלכם אושרה ונמצאת בהכנה 🎉');
    if (!first && prev === 'pending' && o.status === 'rejected') toast('ההזמנה לא אושרה. פנו לצוות לפרטים.');
    state.orderStatus.set(o.id, o.status);
  }
  $('guestName').textContent = data.guest.name;
  renderOrders();
  renderBill();
}

function renderOrders() {
  const orders = state.data.orders;
  $('myOrdersCard').classList.toggle('hidden', !orders.length);
  $('myOrders').innerHTML = orders.map((o) => {
    const [label, cls] = ORDER_STATUS[o.status];
    return `<div style="padding:8px 0;border-top:1px solid var(--line)">
      <div class="row"><span class="muted small">${timeAgo(o.created_at)}</span><span class="badge ${cls}">${label}</span></div>
      <div>${o.items.map((i) => `${esc(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(' · ')}</div>
      ${o.note ? `<div class="muted small">הערה: ${esc(o.note)}</div>` : ''}
    </div>`;
  }).join('');
  const pending = orders.filter((o) => o.status === 'pending').length;
  $('billCount').textContent = pending === 1 ? 'הזמנה ממתינה' : pending ? `${pending} ממתינות` : '';
  $('billCount').classList.toggle('hidden', !pending);
}

function renderBill() {
  const b = state.data.bill;
  const hasItems = b && b.items.length > 0;
  $('billEmpty').classList.toggle('hidden', hasItems);
  $('billBody').classList.toggle('hidden', !hasItems);
  const settled = b && b.status === 'paid';
  $('payForm').classList.toggle('hidden', !hasItems || settled || b.remaining === 0);
  $('paidView').classList.toggle('hidden', !(settled || state.lastReceipt));
  if (settled && !state.lastReceipt) {
    $('paidTitle').textContent = 'החשבון שולם במלואו';
    $('receipt').textContent = '';
  }
  if (!hasItems) { renderBars(); return; }

  $('billItems').innerHTML = b.items.map((i) => `
    <div class="row"><span>${esc(i.name)} ${i.quantity > 1 ? `<span class="qty">×${i.quantity}</span>` : ''}
      ${i.mine ? '<span class="mine">· שלי</span>' : i.guest_name ? `<span class="who">· ${esc(i.guest_name)}</span>` : ''}</span>
      <span class="money">${fmt(i.quantity * i.unit_price)}</span></div>`).join('');
  $('total').textContent = fmt(b.total);
  const partial = b.paid > 0;
  $('paidRow').classList.toggle('hidden', !partial);
  $('remainingRow').classList.toggle('hidden', !partial);
  $('paid').textContent = fmt(b.paid);
  $('remaining').textContent = fmt(b.remaining);

  // "Only what I ordered" is the natural default for a diner who ordered through the app.
  const mineChip = document.querySelector('[data-split="mine"]');
  mineChip.classList.toggle('hidden', !b.myDue);
  mineChip.textContent = `רק מה שהזמנתי (${fmt(b.myDue || 0)})`;
  if (!state.splitTouched || (state.split === 'mine' && !b.myDue)) {
    selectSplit(b.myDue ? 'mine' : 'all');
  }
  renderBars();
}

function selectSplit(split) {
  state.split = split;
  pressOne($('splitChips'), document.querySelector(`[data-split="${split}"]`));
  $('equalBox').classList.toggle('hidden', split !== 'equal');
  $('customBox').classList.toggle('hidden', split !== 'custom');
}

function shareAmount() {
  const b = state.data?.bill;
  if (!b) return 0;
  if (state.split === 'mine') return b.myDue || 0;
  if (state.split === 'all') return b.remaining;
  if (state.split === 'equal') {
    const n = Math.max(1, Math.min(20, parseInt($('people').value, 10) || 1));
    return Math.min(b.remaining, Math.ceil(b.total / n));
  }
  return Math.min(b.remaining, Math.max(0, toAgorot($('customAmount').value || 0)));
}

function tipAmount(share) {
  if (state.tip === 'custom') return Math.max(0, toAgorot($('customTip').value || 0));
  return Math.round((share * Number(state.tip)) / 100);
}

function renderBars() {
  const inApp = !$('appView').classList.contains('hidden');
  const { count, total } = cartTotals();
  const showCart = inApp && state.tab === 'menu' && count > 0;
  $('cartBar').classList.toggle('hidden', !showCart);
  $('openCart').textContent = `צפייה בהזמנה · ${count} פריטים · ${fmt(total)}`;

  const payable = inApp && state.tab === 'bill' && !$('payForm').classList.contains('hidden');
  $('payBar').classList.toggle('hidden', !payable);
  if (payable) {
    const share = shareAmount();
    const tip = tipAmount(share);
    $('shareAmt').textContent = fmt(share);
    $('tipAmt').textContent = fmt(tip);
    $('payBtn').textContent = `לתשלום ${fmt(share + tip)}`;
    $('payBtn').disabled = state.paying || share <= 0;
  }
}

function wireChips(id, key, attr, after) {
  $(id).addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    pressOne($(id), btn);
    state[key] = btn.dataset[attr];
    after && after();
    renderBars();
  });
}
wireChips('splitChips', 'split', 'split', () => { state.splitTouched = true; selectSplit(state.split); });
wireChips('tipChips', 'tip', 'tip', () => $('customTipBox').classList.toggle('hidden', state.tip !== 'custom'));
wireChips('methodChips', 'method', 'method');
['people', 'customAmount', 'customTip'].forEach((id) => $(id).addEventListener('input', renderBars));

$('payBtn').addEventListener('click', async () => {
  const amount = shareAmount();
  const tip = tipAmount(amount);
  $('payError').classList.add('hidden');
  state.paying = true; renderBars();
  try {
    const r = await api('/pay', { method: 'POST', body: { billId: state.data.bill.id, amount, tip, method: state.method } });
    if (!r.ok) {
      $('payError').textContent = errorText(r.data.error);
      $('payError').classList.remove('hidden');
      await refresh();
      return;
    }
    state.lastReceipt = r.data.receipt;
    $('paidTitle').textContent = 'התשלום התקבל, תודה!';
    $('receipt').textContent = `שולם ${fmt(amount + tip)} (כולל טיפ ${fmt(tip)}) · ${METHOD_NAMES[state.method]} · אסמכתא ${r.data.receipt.ref}`;
    state.splitTouched = false;
    await refresh();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } finally {
    state.paying = false; renderBars();
  }
});

async function refresh() {
  if (!state.guestToken || state.paying) return;
  const r = await api('/state');
  if (r.ok) applyState(r.data);
}

boot();
// Keep the bill and order statuses fresh (other diners pay, staff approve orders).
setInterval(() => { if (!document.hidden) refresh(); }, 4000);
