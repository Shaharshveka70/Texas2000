// Shared helpers. Money is integer agorot everywhere; convert only for display/input.
const fmt = (agorot) => '₪' + (agorot / 100).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toAgorot = (shekels) => Math.round(Number(shekels) * 100);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function pressOne(container, btn) {
  container.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
}
