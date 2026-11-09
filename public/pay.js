const token = new URLSearchParams(location.search).get('t');
const state = { bill: null, split: 'all', tip: '12', method: 'apple_pay', paying: false };

const ERRORS = {
  amount_exceeds_remaining: 'הסכום גבוה מהיתרה — מישהו אחר בשולחן כבר שילם חלק. עדכנו ונסו שוב.',
  bill_changed_during_payment: 'החשבון עודכן בזמן התשלום. החיוב בוטל, נסו שוב.',
  bill_changed: 'החשבון עודכן. נסו שוב.',
  payment_declined: 'התשלום נדחה. נסו אמצעי תשלום אחר.',
  invalid_tip: 'סכום הטיפ לא תקין.',
  invalid_amount: 'הסכום לא תקין.',
  no_open_bill: 'אין חשבון פתוח לשולחן הזה.',
};

function shareAmount() {
  const b = state.bill;
  if (!b) return 0;
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

function renderTotals() {
  const share = shareAmount();
  const tip = tipAmount(share);
  $('shareAmt').textContent = fmt(share);
  $('tipAmt').textContent = fmt(tip);
  $('payBtn').textContent = `לתשלום ${fmt(share + tip)}`;
  $('payBtn').disabled = state.paying || share <= 0;
}

function renderBill(data) {
  $('restaurant').textContent = data.restaurant;
  $('table').textContent = data.table;
  const b = data.bill;
  state.bill = b && b.status === 'open' ? b : null;
  if (!b) {
    $('status').textContent = 'עדיין אין חשבון פתוח לשולחן. אם כבר הזמנתם, בקשו מהצוות לפתוח חשבון.';
    $('billView').classList.add('hidden');
    $('paybar').classList.add('hidden');
    return;
  }
  if (b.status !== 'open') {
    $('status').textContent = 'החשבון שולם במלואו. תודה ולהתראות!';
    $('billView').classList.add('hidden');
    $('paybar').classList.add('hidden');
    return;
  }
  $('status').textContent = '';
  $('items').innerHTML = b.items.map((i) => `
    <div class="row"><span>${esc(i.name)} ${i.quantity > 1 ? `<span class="qty">×${i.quantity}</span>` : ''}</span>
    <span class="money">${fmt(i.quantity * i.unit_price)}</span></div>`).join('');
  $('total').textContent = fmt(b.total);
  const partial = b.paid > 0;
  $('paidRow').classList.toggle('hidden', !partial);
  $('remainingRow').classList.toggle('hidden', !partial);
  $('paid').textContent = fmt(b.paid);
  $('remaining').textContent = fmt(b.remaining);
  $('billView').classList.remove('hidden');
  $('paybar').classList.remove('hidden');
  renderTotals();
}

async function load() {
  if (!token) { $('table').textContent = 'קוד שולחן חסר — סרקו שוב את הברקוד'; return; }
  const res = await fetch(`/api/t/${encodeURIComponent(token)}`);
  if (!res.ok) { $('table').textContent = 'השולחן לא נמצא — סרקו שוב את הברקוד'; return; }
  renderBill(await res.json());
}

function wireChips(id, key, attr, after) {
  const box = $(id);
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    pressOne(box, btn);
    state[key] = btn.dataset[attr];
    after && after();
    renderTotals();
  });
}
wireChips('splitChips', 'split', 'split', () => {
  $('equalBox').classList.toggle('hidden', state.split !== 'equal');
  $('customBox').classList.toggle('hidden', state.split !== 'custom');
});
wireChips('tipChips', 'tip', 'tip', () => $('customTipBox').classList.toggle('hidden', state.tip !== 'custom'));
wireChips('methodChips', 'method', 'method');
['people', 'customAmount', 'customTip'].forEach((id) => $(id).addEventListener('input', renderTotals));

$('payBtn').addEventListener('click', async () => {
  const amount = shareAmount();
  const tip = tipAmount(amount);
  $('error').classList.add('hidden');
  state.paying = true; renderTotals();
  try {
    const res = await fetch(`/api/t/${encodeURIComponent(token)}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billId: state.bill.id, amount, tip, method: state.method }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('error').textContent = ERRORS[data.error] || 'משהו השתבש. נסו שוב.';
      $('error').classList.remove('hidden');
      await load();
      return;
    }
    $('billView').classList.add('hidden');
    $('paybar').classList.add('hidden');
    $('status').textContent = '';
    $('receipt').textContent = `שולם ${fmt(data.receipt.amount + data.receipt.tip)} (כולל טיפ ${fmt(data.receipt.tip)}) · אסמכתא ${data.receipt.ref}`;
    $('doneView').classList.remove('hidden');
    clearInterval(poll);
  } finally {
    state.paying = false; renderTotals();
  }
});

load();
// Keep the bill fresh so diners splitting at the same table see what's left.
const poll = setInterval(() => { if (!state.paying) load(); }, 5000);
