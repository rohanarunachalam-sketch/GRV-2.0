'use strict';
// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const lit = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// Customer language, picked on the Account tab and saved on this phone. Admin and delivery always stay in English.
// Tamil and Hindi are written the way people talk, keeping everyday words like bill, delivery, password as they are said.
let LANG = (() => { try { return localStorage.getItem('grv.lang') || 'en'; } catch { return 'en'; } })();
const langOn = () => (S.user && S.user.role === 'customer' ? LANG : 'en');
const tr = (en, ta, hi) => ({ ta, hi }[langOn()] ?? en);
const locale = () => ({ ta: 'ta-IN', hi: 'hi-IN' }[langOn()] || 'en-IN');
const monthLabel = (m) => new Date(m + '-01T00:00').toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
const dayLabel = (d) => new Date(d + 'T00:00').toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
const WEEK = () => tr(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], ['தி', 'செ', 'பு', 'வி', 'வெ', 'ச', 'ஞா'], ['सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि', 'रवि']);
const sessionName = (s) => ({ AM: tr('Morning', 'காலை', 'सुबह'), PM: tr('Evening', 'சாயங்காலம்', 'शाम'), BOTH: tr('Morning & Evening', 'காலை & சாயங்காலம்', 'सुबह और शाम') }[s]);

// ---------- auto update: a new deploy changes the server's X-App-Version; reload at a quiet moment so nobody has to refresh ----------
let appVer = null, updateReady = false;
const typing = () => { const a = document.activeElement; return !!a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && a.value !== ''; };
const reloadIfUpdated = () => { if (updateReady && !typing()) { location.reload(); return true; } return false; };
// customers see the new day by themselves too (date-based greetings, yesterday added to the bill)
let shownDay = today();
const refreshIfNewDay = () => { if (today() === shownDay || typing()) return; shownDay = today(); if (!S.user || S.user.role === 'customer') render(); };
const checkForUpdate = () => api('me').catch(() => {}).then(() => reloadIfUpdated() || refreshIfNewDay());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); }); // back to the app from another app or tab
setInterval(() => { if (document.visibilityState === 'visible') checkForUpdate(); }, 5 * 60 * 1000);

async function api(path, method = 'GET', body) {
  const r = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const ver = r.headers.get('X-App-Version');
  if (ver) { if (!appVer) appVer = ver; else if (ver !== appVer) updateReady = true; }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== 'login' && path !== 'me') { S.user = null; render(); throw new Error('Please sign in'); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
let toastT;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), err ? 4000 : 1800);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- state ----------
const S = { month: localStorage.getItem('grv.month') || today().slice(0, 7), lists: null, user: null };
const monthInput = $('#month');
monthInput.value = S.month;
monthInput.addEventListener('change', () => { if (!monthInput.value) return; S.month = monthInput.value; localStorage.setItem('grv.month', S.month); render(); });
const monthDefaultDate = () => (today().startsWith(S.month) ? today() : S.month + '-01');
const setMonth = (m) => { S.month = monthInput.value = m; localStorage.setItem('grv.month', m); D.data = null; render(); };
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number), d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
// ◀ month ▶ on the page itself, for pages people read month by month
const monthPicker = () => h('div', { class: 'bar monthpick' }, h('button', { onclick: () => setMonth(shiftMonth(S.month, -1)), 'aria-label': 'Previous month' }, '◀'),
  h('input', { type: 'month', value: S.month, onchange: (e) => { if (e.target.value) setMonth(e.target.value); } }),
  h('button', { onclick: () => setMonth(shiftMonth(S.month, 1)), 'aria-label': 'Next month' }, '▶'),
  S.month !== today().slice(0, 7) ? h('button', { class: 'link', onclick: () => setMonth(today().slice(0, 7)) }, 'This month') : null);
// a customer's quantity and price on a date, from their dated changes (same rule as the server's planOn)
const planOn = (c, date) => {
  if (!c.plans || !c.plans.length) return c;
  let p = null;
  for (const r of c.plans) { if (r.from_date <= date) p = r; else break; }
  return p || { am: 0, pm: 0, price: c.plans[0].price, status: 'Inactive' };
};

// A password box with a Show / Hide button so people can check what they typed.
function pwBox(input) {
  const btn = h('button', { type: 'button', class: 'eye', onclick: () => { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; btn.textContent = show ? 'Hide' : 'Show'; } }, 'Show');
  return h('div', { class: 'pwbox' }, input, btn);
}

// ---------- modal form ----------
function openForm({ title, fields, values = {}, onSave, intro, saveLabel = 'Save' }) {
  const dlg = $('#dlg'); dlg.innerHTML = '';
  const inputs = {};
  const form = h('form', { class: 'form', method: 'dialog' }, h('h1', {}, title), intro || null,
    fields.map((f) => {
      let el;
      const v = values[f.key] ?? f.default ?? '';
      if (f.hidden) { inputs[f.key] = { value: v }; return null; }
      if (f.type === 'select') el = h('select', {}, (f.options || []).map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return h('option', { value: val, selected: String(val) === String(v) }, lab); }));
      else if (f.type === 'textarea') { el = h('textarea', { rows: 2 }); el.value = v; }
      else { el = h('input', { type: f.type || 'text', step: f.type === 'number' ? 'any' : null, min: f.type === 'number' ? 0 : null, value: v, required: f.required, placeholder: f.placeholder, autocomplete: 'off' }); }
      inputs[f.key] = el;
      return h('label', {}, f.label, el);
    }),
    h('div', { class: 'acts' }, h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'pri', type: 'submit' }, saveLabel)));
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const data = {}; for (const f of fields) data[f.key] = inputs[f.key].value;
    await onSave(data); dlg.close();
  }));
  dlg.append(form); dlg.showModal();
  const first = Object.values(inputs).find((i) => i.focus); if (first) first.focus();
}

// ---------- generic table ----------
function table(cols, rows, { foot, cls } = {}) {
  return h('div', { class: 'tablewrap' }, h('table', { class: cls },
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'n' : '' }, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.num ? 'n' : '' }, c.render ? c.render(r) : r[c.key] ?? ''))))),
    foot ? h('tfoot', {}, h('tr', {}, cols.map((c, i) => h('td', { class: c.num ? 'n' : '' }, foot[i] ?? '')))) : null));
}
// Name cell for tables with frozen columns: on phones the ID column is hidden and the ID shows under the name instead.
const nameCell = (name, id, ...extra) => h('span', {}, h('span', { class: 'nm' }, name), h('span', { class: 'idsub' }, id), extra);
const pill = (s) => h('span', { class: 'pill ' + String(s).split(' ')[0] }, s);
const actions = (edit, del) => h('span', {}, h('button', { class: 'link', onclick: edit }, 'Edit'), h('button', { class: 'link del', onclick: del }, 'Delete'));
const confirmDel = (what) => confirm(`Delete ${what}? This cannot be undone.`);

// ---------- pages ----------
const pages = {};

pages.dashboard = async (v) => {
  const d = await api('dashboard?month=' + S.month);
  const max = Math.max(1, ...d.daily.map((x) => x.total));
  const alerts = await api('cow-alerts');
  v.append(h('h1', {}, 'Dashboard'), h('p', { class: 'sub' }, monthLabel(S.month)), monthPicker(),
    alerts.length ? h('div', { class: 'card alerts' }, h('h2', { style: 'margin-top:0' }, '🐄 Cow reminders (AI & pregnancy)'), alerts.map((a) => aiAlert(a, () => render()))) : null,
    h('div', { class: 'cards' },
      [['Active Customers', `${d.active} / ${d.customers}`], ['Milk Sold', lit(d.litres) + ' L'], ['Total Sales', inr(d.sales)], ['Payments Collected', inr(d.collected)],
        ['Pending Amount', inr(d.pending), d.pending > 0 ? 'warn' : ''], ['Other Income', inr(d.other_income)], ['Expenses', inr(d.expenses)], ['Net Profit', inr(d.net), d.net >= 0 ? 'good' : 'bad'],
        ['Cow Yield', lit(d.yield_litres) + ' L']].map(([l, val, c]) => h('div', { class: 'card' }, h('div', { class: 'l' }, l), h('div', { class: 'v ' + (c || '') }, val)))),
    todayCard(d.today),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Litres per day'), h('div', { class: 'spark' }, d.daily.map((x) => h('div', { style: `height:${(x.total / max) * 100}%`, title: `${dayLabel(x.date)}: ${lit(x.total)} L` })))),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Highest pending'),
        d.top_pending.length ? h('div', { class: 'bars' }, d.top_pending.map((p) => h('div', { class: 'row' }, h('span', { class: 'name' }, p.name), h('span', { class: 'bar-fill', style: `width:${(p.pending / d.top_pending[0].pending) * 160}px` }), inr(p.pending)))) : h('p', { class: 'mute' }, 'Nothing pending 🎉'))));
};

// Today's milk: what the cows gave vs what went to customers, and what is left over (or short).
function todayCard(t) {
  const diff = Math.round((t.yield - t.sold) * 100) / 100;
  const stat = (l, val, c) => h('div', {}, h('div', { class: 'l' }, l), h('div', { class: 'v ' + (c || '') }, val));
  return h('div', { class: 'card todaymilk' }, h('h2', { style: 'margin-top:0' }, `Today's milk — ${dayLabel(t.date)}`),
    h('div', { class: 'tm-row' }, stat('Total milk yield', lit(t.yield) + ' L'), stat('Total sold', lit(t.sold) + ' L'),
      stat(diff >= 0 ? 'Left over' : 'Short', lit(Math.abs(diff)) + ' L', diff >= 0 ? 'good' : 'bad')),
    !t.yield ? h('p', { class: 'tag' }, 'No cow yield entered for today yet.') : null);
}

// Milk yield vs sold for any days you pick, with a per-day table and an Excel download.
const MS = { from: null, to: null };
function milkSummary() {
  const t = today(), first = (m) => m + '-01', last = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${pad(new Date(y, mo, 0).getDate())}`; };
  const back = (n) => { const d = new Date(t + 'T00:00'); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  if (!MS.from) { MS.from = first(S.month); MS.to = S.month === t.slice(0, 7) ? t : last(S.month); }
  const fromIn = h('input', { type: 'date', value: MS.from, max: t }), toIn = h('input', { type: 'date', value: MS.to, max: t });
  const out = h('div');
  let rows = [];
  const show = guard(async () => {
    if (!fromIn.value || !toIn.value) return;
    MS.from = fromIn.value; MS.to = toIn.value;
    out.innerHTML = ''; out.append(h('p', { class: 'tag' }, 'Loading…'));
    rows = await api(`milk-summary?from=${MS.from}&to=${MS.to}`);
    const sum = (k) => Math.round(rows.reduce((a, r) => a + r[k], 0) * 100) / 100, left = sum('left');
    const stat = (l, val, c) => h('div', {}, h('div', { class: 'l' }, l), h('div', { class: 'v ' + (c || '') }, val));
    out.innerHTML = '';
    out.append(h('div', { class: 'tm-row' }, stat('Total milk yield', lit(sum('yield')) + ' L'), stat('Total sold', lit(sum('sold')) + ' L'),
      stat(left >= 0 ? 'Left over' : 'Short', lit(Math.abs(left)) + ' L', left >= 0 ? 'good' : 'bad'), stat('Approx. amount (sold L × price)', inr(sum('amount'))), stat('Days', rows.length)),
      h('details', { class: 'ms-days' }, h('summary', {}, 'Show each day'), table([{ label: 'Date', render: (r) => dayLabel(r.date) }, { label: 'Yield L', num: 1, render: (r) => lit(r.yield) }, { label: 'Sold L', num: 1, render: (r) => lit(r.sold) },
        { label: 'Left / short', num: 1, render: (r) => h('span', { class: r.left < 0 ? 'bad' : '' }, (r.left < 0 ? '−' : '') + lit(Math.abs(r.left))) }, { label: 'Approx. ₹', num: 1, render: (r) => inr(r.amount) }], rows,
      { foot: ['Total', lit(sum('yield')), lit(sum('sold')), (left < 0 ? '−' : '') + lit(Math.abs(left)), inr(sum('amount'))] })));
  });
  const preset = (a, b) => () => { fromIn.value = a; toIn.value = b; show(); };
  const lm = shiftMonth(t.slice(0, 7), -1);
  const download = guard(async () => {
    if (!rows.length) return toast('Nothing to download', true);
    const sheet = rows.map((r) => ({ Date: r.date, 'Yield AM (L)': r.yield_am, 'Yield PM (L)': r.yield_pm, 'Total yield (L)': r.yield, 'Sold AM (L)': r.sold_am, 'Sold PM (L)': r.sold_pm, 'Total sold (L)': r.sold, 'Left over / short (L)': r.left, 'Approx. amount (₹)': r.amount }));
    const tot = (k) => Math.round(sheet.reduce((a, r) => a + r[k], 0) * 100) / 100;
    sheet.push(Object.fromEntries(Object.keys(sheet[0]).map((k) => [k, k === 'Date' ? 'Total' : tot(k)])));
    const blob = new Blob([makeXlsx({ 'Milk summary': sheet })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `GRV-Milk-${MS.from}-to-${MS.to}.xlsx` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Excel file downloaded');
  });
  const card = h('div', { class: 'card todaymilk' }, h('h2', { style: 'margin-top:0' }, 'Milk summary — yield vs sold'),
    h('div', { class: 'bar' }, h('label', { class: 'ms-l' }, 'From ', fromIn), h('label', { class: 'ms-l' }, 'To ', toIn), h('button', { class: 'pri', onclick: show }, 'Show'), h('button', { onclick: download }, '⬇ Download Excel')),
    h('div', { class: 'bar' }, h('button', { class: 'link', onclick: preset(first(t.slice(0, 7)), t) }, 'This month'), h('button', { class: 'link', onclick: preset(first(lm), last(lm)) }, 'Last month'),
      h('button', { class: 'link', onclick: preset(back(6), t) }, 'Last 7 days'), h('button', { class: 'link', onclick: preset(t, t) }, 'Today')), out);
  show();
  return card;
}

// Money collected (payments received) on the days you pick — total, split by payment mode, and each payment.
const CS = { from: null, to: null };
function collectionSummary() {
  const t = today();
  const back = (n) => { const d = new Date(t + 'T00:00'); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  if (!CS.from) CS.from = CS.to = t;
  const fromIn = h('input', { type: 'date', value: CS.from, max: t }), toIn = h('input', { type: 'date', value: CS.to, max: t });
  const out = h('div');
  const show = guard(async () => {
    if (!fromIn.value || !toIn.value) return;
    CS.from = fromIn.value; CS.to = toIn.value;
    out.innerHTML = ''; out.append(h('p', { class: 'tag' }, 'Loading…'));
    const rows = await api(`collections?from=${CS.from}&to=${CS.to}`);
    const total = rows.reduce((a, r) => a + r.amount, 0), byMode = {};
    for (const r of rows) byMode[r.mode || 'Other'] = (byMode[r.mode || 'Other'] || 0) + r.amount;
    const stat = (l, val, c) => h('div', {}, h('div', { class: 'l' }, l), h('div', { class: 'v ' + (c || '') }, val));
    out.innerHTML = '';
    out.append(h('div', { class: 'tm-row' }, stat(CS.from === CS.to ? `Collected on ${dayLabel(CS.from)}` : 'Total collected', inr(total), 'good'), stat('Payments', rows.length),
      Object.entries(byMode).sort((a, b) => b[1] - a[1]).map(([m, v]) => stat(m, inr(v)))),
      rows.length ? h('details', { class: 'ms-days' }, h('summary', {}, 'Show each payment'), table([{ label: 'Date', render: (r) => dayLabel(r.date) }, { label: 'Customer', render: (r) => r.name || r.customer_id },
        { label: 'For bill', render: (r) => monthLabel(r.bill_month) }, { label: 'Mode', key: 'mode' }, { label: 'Amount', num: 1, render: (r) => inr(r.amount) }], rows,
      { foot: ['Total', '', '', '', inr(total)] })) : h('p', { class: 'tag' }, 'No payments received on these days.'));
  });
  const preset = (a, b) => () => { fromIn.value = a; toIn.value = b; show(); };
  const card = h('div', { class: 'card todaymilk' }, h('h2', { style: 'margin-top:0' }, 'Money collected'),
    h('div', { class: 'bar' }, h('label', { class: 'ms-l' }, 'From ', fromIn), h('label', { class: 'ms-l' }, 'To ', toIn), h('button', { class: 'pri', onclick: show }, 'Show')),
    h('div', { class: 'bar' }, h('button', { class: 'link', onclick: preset(t, t) }, 'Today'), h('button', { class: 'link', onclick: preset(back(1), back(1)) }, 'Yesterday'),
      h('button', { class: 'link', onclick: preset(back(6), t) }, 'Last 7 days'), h('button', { class: 'link', onclick: preset(t.slice(0, 7) + '-01', t) }, 'This month')), out);
  show();
  return card;
}

// One cow reminder: confirmation due, or a 3-monthly pregnancy check-in. "Done" hides a check-in until the next 3-month mark.
function aiAlert(a, after) {
  const text = a.type === 'confirm' ? `${a.cow_name}: AI was ${a.days} days ago (${dayLabel(a.ai_date)}) — please confirm if she is pregnant.`
    : a.milestone === 4 ? `${a.cow_name}: calving is due (expected ${dayLabel(a.due_date)}).`
    : `${a.cow_name}: ${a.milestone * 3} months of pregnancy completed (day ${a.days}). Calving expected ${dayLabel(a.due_date)}.`;
  return h('div', { class: 'aialert' }, h('span', {}, text), a.type === 'confirm'
    ? h('button', { onclick: () => aiDialog({ id: a.cow_id, name: a.cow_name }) }, 'Confirm')
    : h('button', { onclick: guard(async () => { await api(`cow-ai/${a.id}/ack`, 'POST'); toast('Noted'); after(); }) }, 'Done'));
}

// Delivery: day entry + whole-month grid. Blank = default quantity, 0 = no delivery.
const D = { view: innerWidth < 800 ? 'cards' : 'day', date: null, session: 'AM', filter: '', data: null, month: null };
// Phone-friendly cards: one per customer for a date + session, with − / + and Absent. Used by delivery staff and admin.
const R = { session: new Date().getHours() < 14 ? 'AM' : 'PM', date: null, filter: '' };
async function routeView(v) {
  const staff = S.user.role !== 'admin', only = staff && ['AM', 'PM'].includes(S.user.shift) ? S.user.shift : null; // morning-only / evening-only delivery login
  if (only) R.session = only;
  if (staff || !R.date) R.date = (R.date && (!staff || [S.user.today, S.user.yesterday].includes(R.date))) ? R.date : (staff ? S.user.today : monthDefaultDate());
  const data = await api(`route?date=${R.date}&session=${R.session}`);
  const items = data.items;
  const eff = (it) => (it.qty ?? (it.skip ? 0 : it.def)); // a customer's no-milk request counts as 0 unless overridden
  const cardsBox = h('div', { class: 'cards-list' });
  const prog = h('b', {});
  const setQ = guard(async (it, val, card) => {
    val = Math.max(0, Math.round(val * 100) / 100);
    const send = val === (it.skip ? 0 : it.def) ? null : val; // back to the usual/requested quantity clears the override
    await api('delivery', 'PUT', { date: R.date, customer_id: it.id, session: R.session, qty: send });
    it.qty = send; it.unavail = false; paint(it, card);
  });
  const paint = (it, card) => {
    const q = eff(it);
    const skipped = it.skip && it.qty === null, unv = it.unavail && it.qty === 0;
    card.className = 'rcard' + (unv ? ' unavail' : '') + (skipped ? ' skipped' : it.qty === 0 ? ' absent' : it.qty !== null ? ' changed' : '');
    card.querySelector('.qty').textContent = lit(q) + ' L';
    card.querySelector('.def').textContent = skipped ? `✕ Customer asked: no milk (until ${dayLabel(it.skip.to)})${it.skip.note ? ' — ' + it.skip.note : ''}` : it.qty === null ? 'usual quantity' : unv ? '🔴 MILK UNAVAILABLE (usual ' + lit(it.def) + ' L)' : it.qty === 0 ? 'ABSENT (usual ' + lit(it.def) + ' L)' : 'changed (usual ' + lit(it.def) + ' L)';
    const ab = card.querySelector('.abs'); ab.textContent = q === 0 ? 'Undo' : '✕ Absent'; ab.classList.toggle('on', q === 0);
    const um = card.querySelector('.unv'); if (um) { um.textContent = unv ? 'Undo unavailable' : '🔴 Milk Unavailable'; um.classList.toggle('on', !!unv); }
    stats();
  };
  const stats = () => { const done = items.filter((i) => i.qty !== null).length, sk = items.filter((i) => i.skip && i.qty === null).length; prog.textContent = `${lit(items.reduce((a, i) => a + eff(i), 0))} L to deliver · ${items.filter((i) => eff(i) > 0).length} customers · ${done} changed` + (sk ? ` · ✕ ${sk} customer request${sk > 1 ? 's' : ''} (no milk)` : ''); };
  const card = (it) => {
    const c = h('div', { class: 'rcard', 'data-name': (it.name + ' ' + it.id).toLowerCase() },
      h('div', { class: 'rtop' }, h('div', {}, h('div', { class: 'rname' }, it.name), h('div', { class: 'def tag' })), h('div', { class: 'qty' })),
      h('div', { class: 'ract' }, h('button', { class: 'step', onclick: () => setQ(it, eff(it) - 0.25, c) }, '−'), h('button', { class: 'step', onclick: () => setQ(it, eff(it) + 0.25, c) }, '+'),
        h('button', { class: 'abs', onclick: () => setQ(it, eff(it) === 0 ? it.def : 0, c) }), h('button', { class: 'step', title: 'Type exact quantity', onclick: () => { const x = prompt(`${it.name} — quantity in litres`, eff(it)); if (x !== null && x.trim() !== '' && Number(x) >= 0) setQ(it, Number(x), c); } }, 'Edit')),
      h('div', { class: 'ract' }, h('button', { class: 'unv', onclick: guard(async () => { const on = !(it.unavail && it.qty === 0); await api('delivery/unavailable', 'PUT', { date: R.date, customer_id: it.id, session: R.session, on }); it.unavail = on; it.qty = on ? 0 : null; paint(it, c); }) })));
    paint(it, c); return c;
  };
  for (const it of items) cardsBox.append(card(it));
  const search = h('input', { type: 'search', placeholder: 'Search customer…', class: 'grow', value: R.filter, oninput: (e) => { R.filter = e.target.value.toLowerCase(); for (const c of cardsBox.children) c.hidden = !c.dataset.name.includes(R.filter); } });
  const sessionSeg = only ? h('b', { class: 'shift-pill' }, only === 'AM' ? '🌅 Morning' : '🌇 Evening') : h('div', { class: 'seg' }, ['AM', 'PM'].map((s) => h('button', { class: R.session === s ? 'on' : '', onclick: () => { R.session = s; rerender(); } }, s)));
  const rerender = () => { v.innerHTML = ''; routeView(v).catch((e) => v.append(h('p', { class: 'bad' }, e.message))); };
  const dateCtl = staff
    ? h('div', { class: 'seg' }, [[S.user.today, 'Today'], [S.user.yesterday, 'Yesterday']].map(([d, l]) => h('button', { class: R.date === d ? 'on' : '', onclick: () => { R.date = d; rerender(); } }, l)))
    : h('input', { type: 'date', value: R.date, onchange: (e) => { if (e.target.value) { R.date = e.target.value; rerender(); } } });
  v.append(h('h1', {}, 'Deliveries'), h('p', { class: 'sub' }, `${dayLabel(R.date)} · ${R.session === 'AM' ? 'Morning' : 'Evening'}. Customers get their usual quantity unless you change it.`),
    staff ? null : h('div', { class: 'bar' }, viewTabs(() => { v.innerHTML = ''; pages.delivery(v); })),
    R.date === S.user.today || !staff ? runControl(R.session) : null, // admin always sees today's Start / Pause, whatever date the cards show
    h('div', { class: 'bar sticky' }, dateCtl, sessionSeg, search), h('div', { class: 'bar' }, prog), cardsBox);
  if (R.filter) for (const c of cardsBox.children) c.hidden = !c.dataset.name.includes(R.filter);
  if (!items.length) cardsBox.append(h('p', { class: 'mute' }, 'No customers for this session.'));
  stats();
}

// ▶ Start / ⏸ Pause / ✓ Finish for today's round (admin + delivery). Starting is what makes customers see their delivery time.
const dur = (min) => { const hr = Math.floor(min / 60), m = Math.round(min % 60); return hr ? `${hr} hr${m ? ' ' + m + ' min' : ''}` : `${m} min`; };
const clock = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit', hour12: true });
function runControl(session) {
  const box = h('div', { class: 'run-box' });
  const name = session === 'AM' ? 'Morning' : 'Evening';
  const full = (d) => h('div', { class: 'run-full' }, `⏱ Full round: about ${dur(d.minutes)}`, h('span', {}, ` · ${d.stops} houses` + (d.km ? ` · ${d.km} km` : '')));
  const who = (r) => (r.last_by ? ` by ${r.last_by === 'admin' ? 'Admin' : 'Delivery'}` : '');
  // the same round is shared by admin and delivery: re-check every 10 s and when the phone wakes, so a Start / Pause on one login shows on the other
  let timer = null;
  const refresh = (first) => {
    if (!first && !box.isConnected) { clearInterval(timer); document.removeEventListener('visibilitychange', onWake); return; }
    api('run?session=' + session).then(paint, (e) => { if (first) box.textContent = e.message; });
  };
  const onWake = () => { if (document.visibilityState === 'visible') refresh(false); };
  const act = (what, ask) => guard(async () => {
    if (ask && !confirm(ask)) return;
    try { paint(await api('run/' + what, 'POST', { session })); liveKick(); } catch (e) { refresh(false); throw e; } // someone on the other login may have pressed first
    toast({ start: 'Delivery started — customers can now see their time', pause: 'Paused — customers’ times will move later', resume: 'Resumed — times updated', end: 'Delivery finished' }[what]); });
  let last = '';
  const paint = (d) => {
    const key = JSON.stringify(d); if (key === last) return; last = key; // only redraw when something changed
    box.innerHTML = '';
    box.append(h('div', { class: 'step-no' }, `Today · ${name}`));
    const r = d.run, warn = !d.farm ? '⚠ Start location not marked — customers won’t see a time. Mark it on the Locations page.'
      : d.marked < d.stops ? `⚠ ${d.stops - d.marked} of ${d.stops} houses not marked yet — those customers won’t see a time.` : null;
    if (!r || r.ended) {
      box.className = 'run-box';
      box.append(h('div', { class: 'run-state' }, r ? `✓ ${name} delivery finished at ${clock(r.ended)}${who(r)}` : `${name} delivery not started`),
        full(d),
        h('button', { class: 'pri run-big', onclick: act('start', r ? `Start the ${name.toLowerCase()} delivery again?` : null) }, `▶ Start ${name} delivery`));
    } else if (r.paused_at) {
      box.className = 'run-box paused';
      box.append(h('div', { class: 'run-state' }, `⏸ Paused since ${clock(r.paused_at)}${who(r)}`), full(d), h('div', { class: 'tag' }, 'Customers are not told about the pause — their time just moves 1 minute later for every minute you are paused.'),
        h('div', { class: 'ract' }, h('button', { class: 'pri run-big', onclick: act('resume') }, '▶ Resume'), h('button', { onclick: act('end', `Finish the ${name.toLowerCase()} delivery?`) }, '✓ Finish')));
    } else {
      box.className = 'run-box on';
      box.append(h('div', { class: 'run-state' }, `🟢 ${name} delivery ${r.paused_ms ? 'running' : 'started'} — since ${clock(r.started)}${who(r)}`),
        full(d), h('div', { class: 'tag' }, (d.finish_at ? `Expected to finish around ${clock(d.finish_at)}` : '') + (r.paused_ms ? ` · paused ${Math.round(r.paused_ms / 60000)} min so far` : '')),
        h('div', { class: 'ract' }, h('button', { class: 'run-big', onclick: act('pause') }, '⏸ Pause'), h('button', { onclick: act('end', `Finish the ${name.toLowerCase()} delivery? Customers stop seeing a time.`) }, '✓ Finish')));
    }
    if (warn) box.append(h('div', { class: 'tag bad', style: 'margin-top:8px' }, warn));
  };
  refresh(true); timer = setInterval(() => refresh(false), 10000); document.addEventListener('visibilitychange', onWake);
  return box;
}

// Cards / Table / Month grid switch for admin, shown on every delivery view.
const viewTabs = (reRender) => h('div', { class: 'seg' }, ['cards', 'day', 'month'].map((k) => h('button', { class: D.view === k ? 'on' : '', onclick: () => { D.view = k; reRender(); } }, { cards: 'Cards', day: 'Table', month: 'Month grid' }[k])));

pages.delivery = async (v) => {
  if (S.user.role !== 'admin' || D.view === 'cards') return routeView(v);
  if (D.month !== S.month || !D.data) { D.data = await api('delivery?month=' + S.month); D.month = S.month; D.ov = new Map(D.data.entries.map((e) => [`${e.c}|${e.d}|${e.s}`, e.q])); D.skips = new Set(D.data.skips.map((e) => `${e.c}|${e.d}|${e.s}`)); }
  if (!D.date || !D.date.startsWith(S.month)) D.date = monthDefaultDate();
  const dayStr = (n) => `${S.month}-${pad(n)}`;
  const defQ = (c, s, date = D.date) => { const p = planOn(c, date); return p.status === 'Active' ? (s === 'AM' ? p.am : p.pm) : 0; };
  const baseQ = (c, date, s) => (D.skips.has(`${c.id}|${date}|${s}`) ? 0 : defQ(c, s, date)); // customer "no milk" request = 0
  const save = guard(async (c, date, s, input) => {
    const raw = input.value.trim(); const k = `${c.id}|${date}|${s}`;
    if (raw !== '' && !(Number(raw) >= 0)) { toast('Enter a number ≥ 0', true); input.value = D.ov.has(k) ? D.ov.get(k) : ''; return; }
    await api('delivery', 'PUT', { date, customer_id: c.id, session: s, qty: raw === '' ? null : Number(raw) });
    if (raw === '') D.ov.delete(k); else D.ov.set(k, Number(raw));
    paint(input, c, date, s); refreshTotals();
  });
  const paint = (input, c, date, s) => { const k = `${c.id}|${date}|${s}`; input.classList.toggle('set', D.ov.has(k)); input.classList.toggle('zero', D.ov.get(k) === 0); };
  const qInput = (c, date, s) => {
    const k = `${c.id}|${date}|${s}`; const dq = baseQ(c, date, s);
    const i = h('input', { class: 'q', type: 'number', step: 'any', min: 0, inputmode: 'decimal', placeholder: lit(dq), value: D.ov.has(k) ? D.ov.get(k) : '', title: `${c.name} ${s} — default ${lit(dq)}` });
    i.addEventListener('change', () => save(c, date, s, i)); paint(i, c, date, s); return i;
  };
  const eff = (c, date, s) => { const k = `${c.id}|${date}|${s}`; return D.ov.has(k) ? D.ov.get(k) : baseQ(c, date, s); };
  let totalEl;
  const refreshTotals = () => {
    if (!totalEl) return;
    if (D.view === 'day') { let a = 0, p = 0; for (const c of D.data.customers) { a += eff(c, D.date, 'AM'); p += eff(c, D.date, 'PM'); } totalEl.textContent = `AM ${lit(a)} L · PM ${lit(p)} L · Total ${lit(a + p)} L`; }
    else { let t = 0; for (const c of D.data.customers) for (let n = 1; n <= D.data.days; n++) t += eff(c, dayStr(n), D.session); totalEl.textContent = `${D.session} total for month: ${lit(t)} L`; }
  };
  const match = (c) => !D.filter || (c.name + c.id).toLowerCase().includes(D.filter.toLowerCase());
  const reRender = () => { v.innerHTML = ''; pages.delivery(v); };

  const tabs = viewTabs(reRender);
  const search = h('input', { type: 'search', placeholder: 'Search customer…', value: D.filter, oninput: (e) => { D.filter = e.target.value; clearTimeout(search._t); search._t = setTimeout(() => { reRender(); const s = $('input[type=search]'); s.focus(); s.setSelectionRange(99, 99); }, 200); } });
  totalEl = h('b', {});
  const bar = h('div', { class: 'bar' }, tabs);

  let body;
  if (D.view === 'day') {
    const dateIn = h('input', { type: 'date', value: D.date, min: dayStr(1), max: dayStr(D.data.days), onchange: (e) => { if (e.target.value.startsWith(S.month)) { D.date = e.target.value; reRender(); } } });
    const step = (n) => () => { const d = new Date(D.date + 'T00:00'); d.setDate(d.getDate() + n); const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; if (s.startsWith(S.month)) { D.date = s; reRender(); } };
    bar.append(h('button', { onclick: step(-1) }, '◀'), dateIn, h('button', { onclick: step(1) }, '▶'), h('span', { class: 'tag' }, dayLabel(D.date)), search, h('span', { class: 'grow' }), totalEl,
      h('button', { onclick: guard(async () => { if (!confirm(`Reset all entries on ${D.date} back to defaults?`)) return; await api('delivery/reset-day', 'POST', { date: D.date }); D.data = null; reRender(); }) }, 'Reset day'));
    const rows = D.data.customers.filter(match);
    body = h('div', { class: 'tablewrap' }, h('table', { class: 'freeze2' }, h('thead', {}, h('tr', {}, ['ID', 'Customer', 'AM default', 'AM actual', 'PM default', 'PM actual', 'Litres', 'Amount', ''].map((t, i) => h('th', { class: i > 1 && i < 8 ? 'n' : '' }, t)))),
      h('tbody', {}, rows.map((c) => {
        const tl = h('td', { class: 'n' }), am = h('td', { class: 'n' });
        const upd = () => { const t = eff(c, D.date, 'AM') + eff(c, D.date, 'PM'); tl.textContent = lit(t); am.textContent = inr(t * planOn(c, D.date).price); };
        const a = qInput(c, D.date, 'AM'), p = qInput(c, D.date, 'PM');
        a.addEventListener('change', upd); p.addEventListener('change', upd); upd();
        // Absent toggle: marks every session this customer normally takes as 0; click again to undo.
        const sess = [['AM', a], ['PM', p]].filter(([s]) => defQ(c, s) > 0);
        const isAbsent = () => sess.length > 0 && sess.every(([, i]) => i.value === '0');
        const btn = h('button', { class: 'link' });
        const label = () => { btn.textContent = isAbsent() ? '↩ Undo absent' : '✕ Absent'; btn.className = 'link' + (isAbsent() ? '' : ' del'); };
        btn.addEventListener('click', async () => {
          const abs = isAbsent();
          for (const [, i] of sess) i.value = abs ? '' : '0';
          await Promise.all(sess.map(([, i]) => i.dispatchEvent(new Event('change'))));
          label();
        });
        if (!sess.length) btn.disabled = true;
        a.addEventListener('change', label); p.addEventListener('change', label); label();
        return h('tr', {}, h('td', {}, c.id), h('td', {}, nameCell(c.name, c.id, c.status === 'Inactive' ? h('span', { class: 'tag' }, ' (inactive)') : '')), h('td', { class: 'n mute' }, lit(defQ(c, 'AM'))), h('td', { class: 'n' }, a), h('td', { class: 'n mute' }, lit(defQ(c, 'PM'))), h('td', { class: 'n' }, p), tl, am, h('td', {}, btn));
      }))));
  } else {
    bar.append(h('div', { class: 'seg' }, ['AM', 'PM'].map((s) => h('button', { class: D.session === s ? 'on' : '', onclick: () => { D.session = s; reRender(); } }, s))), search, h('span', { class: 'grow' }), totalEl);
    const days = Array.from({ length: D.data.days }, (_, i) => i + 1);
    const rows = D.data.customers.filter(match);
    body = h('div', { class: 'tablewrap' }, h('table', { class: 'freeze1' }, h('thead', {}, h('tr', {}, h('th', {}, 'Customer'), h('th', { class: 'n' }, 'Default'), days.map((n) => h('th', { class: 'n' }, n)), h('th', { class: 'n' }, 'Total'))),
      h('tbody', {}, rows.map((c) => {
        const tot = h('td', { class: 'n' });
        const upd = () => { let t = 0; for (const n of days) t += eff(c, dayStr(n), D.session); tot.textContent = lit(t); };
        upd();
        return h('tr', {}, h('td', {}, nameCell(c.name, c.id)), h('td', { class: 'n mute' }, lit(defQ(c, D.session, dayStr(D.data.days)))),
          days.map((n) => { const i = qInput(c, dayStr(n), D.session); i.addEventListener('change', upd); return h('td', { class: 'gridcell' }, i); }), tot);
      }))));
  }
  v.append(h('h1', {}, 'Delivery'), h('p', { class: 'sub' }, 'Leave a box blank to use the default quantity. Enter 0 for no delivery. Yellow boxes are changes from default.'),
    h('div', { class: 'run-pair' }, runControl('AM'), runControl('PM')), bar, body);
  refreshTotals();
};

pages.bills = async (v) => {
  const rows = await api('bills?month=' + S.month);
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  let filter = '';
  const holder = h('div');
  const draw = () => {
    holder.innerHTML = '';
    const rs = rows.filter((r) => !filter || (r.name + r.id).toLowerCase().includes(filter.toLowerCase()));
    holder.append(table([
      { label: 'ID', key: 'id' }, { label: 'Customer', render: (r) => nameCell(r.name, r.id, r.bill_name ? h('div', { class: 'tag' }, 'Bill name: ' + r.bill_name) : null) }, { label: 'Phone', key: 'phone' }, { label: 'AM L', num: 1, render: (r) => lit(r.am) }, { label: 'PM L', num: 1, render: (r) => lit(r.pm) },
      { label: 'Total L', num: 1, render: (r) => lit(r.total) }, { label: 'Price/L', num: 1, render: (r) => lit(r.price) }, { label: 'Milk', num: 1, render: (r) => inr(r.milk_amount) }, { label: 'Extras', num: 1, render: (r) => (r.extras_amount ? inr(r.extras_amount) : '–') }, { label: 'Bill', num: 1, render: (r) => inr(r.amount) },
      { label: 'Paid', num: 1, render: (r) => inr(r.paid) }, { label: 'Pending', num: 1, render: (r) => h('span', { class: r.pending > 0 ? 'bad' : '' }, inr(r.pending)) }, { label: 'Status', render: (r) => pill(r.pay_status) },
      { label: '', render: (r) => h('span', {}, h('a', { href: `#/bill/${r.id}` }, h('button', { class: 'link' }, 'Bill')), h('button', { class: 'link', onclick: () => payFor(r) }, 'Payment')) },
    ], rs, { cls: 'freeze2', foot: ['', 'Total', '', lit(sum('am')), lit(sum('pm')), lit(sum('total')), '', inr(sum('milk_amount')), inr(sum('extras_amount')), inr(sum('amount')), inr(sum('paid')), inr(sum('pending')), '', ''] }));
  };
  // Payment dialog: shows what the customer bought and owes; the amount is pre-filled with the pending balance but can be changed.
  const payFor = guard(async (r) => {
    const paidBox = h('div'); // filled in a moment after the dialog is already on screen
    const line = (l, val, cls = '') => h('div', { class: 'payrow ' + cls }, h('span', {}, l), h('b', {}, val));
    const intro = h('div', { class: 'payinfo' }, h('div', { class: 'tag' }, `${r.id} · ${monthLabel(S.month)}`),
      line('Total milk bought', lit(r.total) + ' L'), r.extras_amount ? line('Milk amount', inr(r.milk_amount)) : null, r.extras_amount ? line('Extras delivered (egg, curd...)', inr(r.extras_amount)) : null, line('Bill amount', inr(r.amount)), line('Already paid', inr(r.paid)), line('Pending', inr(Math.max(r.pending, 0)), 'big'),
      paidBox);
    openForm({ title: `Payment — ${r.name}`, intro, saveLabel: 'OK', fields: [
      { key: 'date', label: 'Date', type: 'date', default: monthDefaultDate(), required: true },
      { key: 'customer_id', hidden: true, default: r.id }, { key: 'bill_month', hidden: true, default: S.month },
      { key: 'amount', label: 'Amount received (₹) — filled with the full pending amount; change it if they pay a different amount', type: 'number', default: Math.max(r.pending, 0) || '', placeholder: 'Type the amount', required: true },
      { key: 'mode', label: 'Payment mode', type: 'select', options: S.lists.modes }, { key: 'remarks', label: 'Remarks', type: 'text' }],
    onSave: async (d) => { await api('payments', 'POST', d); toast('Payment saved'); render(); } });
    api('payments?month=' + S.month).then((all) => { const paid = all.filter((p) => p.customer_id === r.id); if (paid.length) paidBox.append(h('div', { class: 'paid-list' }, h('div', { class: 'tag' }, 'Payments received'), paid.map((p) => h('div', { class: 'payrow' }, h('span', {}, `${p.date}${p.mode ? ' · ' + p.mode : ''}`),
        h('span', {}, h('b', {}, inr(p.amount)), h('button', { type: 'button', class: 'link del', onclick: guard(async () => { if (!confirm(`Delete this ${inr(p.amount)} payment?`)) return; await api('payments/' + p.id, 'DELETE'); toast('Payment deleted'); $('#dlg').close(); render(); }) }, 'Delete')))))); }).catch(() => {});
  });
  v.append(h('h1', {}, 'Monthly Bills'), h('p', { class: 'sub' }, `${monthLabel(S.month)} — built from actual daily AM/PM quantities.`),
    h('div', { class: 'bar' }, h('input', { type: 'search', placeholder: 'Search customer…', oninput: (e) => { filter = e.target.value; draw(); } }), h('span', { class: 'grow' }),
      h('a', { href: '#/bill/all' }, h('button', {}, 'All bills')), h('a', { href: 'api/bills.csv?month=' + S.month }, h('button', {}, 'Download CSV')), h('button', { onclick: () => print() }, 'Print')), holder);
  draw();
};

// Printable invoice for one customer (#/bill/GRV001) or every customer, one per page (#/bill/all).
function invoice(b) {
  const half = Math.ceil(b.days.length / 2);
  const dayTable = (days) => h('table', { class: 'inv-days' }, h('thead', {}, h('tr', {}, ['Date', 'AM', 'PM', 'Litres'].map((t, i) => h('th', { class: i ? 'n' : '' }, t)))),
    h('tbody', {}, days.map((d) => h('tr', { class: d.am + d.pm === 0 ? 'zero' : '' }, h('td', {}, dayLabel(d.date).replace(/^\w+, /, '')), h('td', { class: 'n' }, d.am ? lit(d.am) : '–'), h('td', { class: 'n' }, d.pm ? lit(d.pm) : '–'), h('td', { class: 'n' }, lit(d.am + d.pm))))));
  const row = (l, val, cls = '') => h('tr', { class: cls }, h('td', {}, l), h('td', { class: 'n' }, val));
  return h('section', { class: 'invoice' },
    h('div', { class: 'inv-head' }, h('img', { src: 'logo.png', alt: 'GRV Dairy' }), h('div', { class: 'inv-title' }, h('h1', {}, 'MILK BILL'), h('div', {}, 'Bill no: ', h('b', {}, b.bill_no)), h('div', {}, 'Month: ', h('b', {}, monthLabel(b.month))), h('div', {}, 'Date: ', h('b', {}, new Date().toLocaleDateString('en-IN'))))),
    h('div', { class: 'inv-to' }, h('div', { class: 'tag' }, 'Bill to'), h('b', { style: 'font-size:18px' }, b.bill_name || b.name), h('div', {}, b.id + (b.phone ? ' · ' + b.phone : ''))),
    h('div', { class: 'inv-cols' }, dayTable(b.days.slice(0, half)), dayTable(b.days.slice(half))),
    h('table', { class: 'inv-sum' }, h('tbody', {}, row('Morning (AM) litres', lit(b.am) + ' L'), row('Evening (PM) litres', lit(b.pm) + ' L'), row('Total litres', lit(b.total) + ' L', 'b'), row('Rate per litre', inr(b.price)), b.extras.length ? row('Milk amount', inr(b.milk_amount)) : null,
      ...b.extras.map((x) => row(`${x.product || 'Item'} — ${qtyText(x.qty, x.unit)} × ${inr(x.price)} (${new Date(x.date + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})`, inr(x.qty * x.price))),
      ...b.payments.map((p) => row(`Paid on ${new Date(p.date + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}${p.mode ? ' (' + p.mode + ')' : ''}`, inr(p.amount), 'paid')),
      b.payments.length ? row(b.pending > 0 ? 'Balance due' : 'Balance', b.pending > 0 ? inr(b.pending) : 'Paid in full', 'bal') : null,
      row('Total amount', inr(b.amount), 'total'))),
    h('div', { class: 'inv-foot' }, 'Thank you for your business! — GRV Dairy Products'));
}
const waLink = (b) => {
  let ph = (b.phone || '').replace(/\D/g, ''); if (ph.length === 10) ph = '91' + ph;
  const t = `GRV Dairy — ${monthLabel(b.month)} milk bill\n${b.bill_name || b.name}\n${lit(b.total)} L × ${inr(b.price)} = ${inr(b.milk_amount)}\n` + (b.extras_amount ? `Extras: ${inr(b.extras_amount)}\nTotal: ${inr(b.amount)}\n` : '') + (b.paid ? `Paid: ${inr(b.paid)}\n` : '') + (b.pending > 0 ? `Amount due: ${inr(b.pending)}` : 'No balance due. Thank you!');
  return `https://wa.me/${ph}?text=${encodeURIComponent(t)}`;
};
pages.bill = async (v, arg) => {
  const all = !arg || arg === 'all';
  const list = await api(`bill?month=${S.month}` + (all ? '' : '&id=' + encodeURIComponent(arg)));
  v.append(h('div', { class: 'bar' }, h('a', { href: '#/bills' }, h('button', {}, '← Bills')), h('button', { class: 'pri', onclick: () => print() }, 'Print / Save PDF'),
    !all ? h('a', { href: waLink(list[0]), target: '_blank', rel: 'noopener' }, h('button', {}, 'WhatsApp')) : null,
    h('span', { class: 'tag' }, all ? `${list.length} bills for ${monthLabel(S.month)}` : '')));
  if (!list.length) v.append(h('p', { class: 'mute' }, 'No bills for this month.'));
  for (const b of list) v.append(invoice(b));
};

// ---- CRUD pages
let customersCache = null;
const loadCustomers = async () => (customersCache = await api('customers'));
const custName = (id) => (customersCache.find((c) => c.id === id) || {}).name || id;


function crud({ title, sub, resource, cols, fields, monthly = true, total, master, idKey = 'id', extraBar, rowExtra, pick, cls }) {
  return async (v) => {
    S.lists = await api('lists'); await loadCustomers();
    const load = () => api(resource + (monthly ? '?month=' + S.month : ''));
    let rows = await load(), filter = '', picked = '';
    const holder = h('div');
    const F = typeof fields === 'function' ? fields : () => fields;
    const edit = (r) => openForm({ title: (r ? 'Edit ' : 'Add ') + title, fields: F(), values: r || {}, onSave: async (d) => { await api(r ? `${resource}/${r[idKey]}` : resource, r ? 'PUT' : 'POST', d); toast('Saved'); render(); } });
    const draw = () => {
      holder.innerHTML = '';
      const rs = rows.filter((r) => !picked || r[pick.key] === picked).filter((r) => !filter || JSON.stringify(Object.values(r)).toLowerCase().includes(filter.toLowerCase()) || (r.customer_id && custName(r.customer_id).toLowerCase().includes(filter.toLowerCase())));
      const c = [...cols, { label: '', render: (r) => h('span', {}, rowExtra ? rowExtra(r) : null, actions(() => edit(r), guard(async () => { if (!confirmDel(master ? r.name : 'this entry')) return; await api(`${resource}/${r[idKey]}`, 'DELETE'); toast('Deleted'); render(); }))) }];
      holder.append(table(c, rs, { cls, foot: total ? total(rs, c.length) : undefined }));
    };
    v.append(h('h1', {}, /s$|Income|Yield/.test(title) ? (title === 'Income' ? 'Income' : title) : title + 's'), h('p', { class: 'sub' }, sub + (monthly ? ` Showing ${monthLabel(S.month)}.` : '')),
      h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: () => edit() }, '+ Add'), h('input', { type: 'search', placeholder: 'Search…', oninput: (e) => { filter = e.target.value; draw(); } }),
        pick ? h('select', { 'aria-label': pick.label, onchange: (e) => { picked = e.target.value; draw(); } }, h('option', { value: '' }, 'All ' + pick.label.toLowerCase()), pick.options.map((o) => h('option', { value: o }, o))) : null, h('span', { class: 'grow' }), extraBar ? extraBar() : null), holder);
    draw();
  };
}
const sumRow = (len, idx, val) => Array.from({ length: len }, (_, i) => (i === idx ? val : i === 0 ? 'Total' : ''));

pages.customers = crud({ title: 'Customer', sub: 'Master list — AM/PM defaults and price used for daily delivery and billing.', resource: 'customers', monthly: false, master: true, cls: 'freeze2',
  fields: () => [{ key: 'name', label: 'Nickname (only you see this)', required: true }, { key: 'bill_name', label: "Name on bill (the customer's own — they can also set it)" }, { key: 'phone', label: 'Phone' }, { key: 'am', label: 'AM default qty (L)', type: 'number', default: 0 }, { key: 'pm', label: 'PM default qty (L)', type: 'number', default: 0 },
    { key: 'price', label: 'Price per L (₹)', type: 'number', default: 55 }, { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] },
    { key: 'from_date', label: 'From date — new customer: the day milk starts. Edit: the day the new quantity / price / status starts (earlier days stay as they were). Leave empty to change every date, past ones too.', type: 'date', default: today() }],
  cols: [{ label: 'ID', key: 'id' }, { label: 'Nickname', render: (r) => nameCell(r.name, r.id) }, { label: 'Name on bill', render: (r) => r.bill_name || h('span', { class: 'mute' }, '—') }, { label: 'Phone', key: 'phone' }, { label: 'AM (L)', num: 1, render: (r) => lit(r.am) }, { label: 'PM (L)', num: 1, render: (r) => lit(r.pm) },
    { label: 'Total (L)', num: 1, render: (r) => lit(r.am + r.pm) }, { label: 'Price/L', num: 1, render: (r) => inr(r.price) }, { label: 'Status', render: (r) => pill(r.status) },
    { label: 'From', render: (r) => { // when the current quantity started, and any change dated later
      const t = today(), cur = (r.plans || []).filter((p) => p.from_date <= t && p.from_date > '0000-01-01').pop(), next = (r.plans || []).filter((p) => p.from_date > t);
      return h('span', {}, cur ? dayLabel(cur.from_date) : h('span', { class: 'mute' }, '—'),
        next.map((p) => h('div', { class: 'tag' }, `From ${dayLabel(p.from_date)}: ${p.status === 'Active' ? `AM ${lit(p.am)} · PM ${lit(p.pm)} · ${inr(p.price)}` : 'Inactive'}`)));
    } }],
  total: (rs, n) => sumRow(n, 6, lit(rs.reduce((a, r) => a + r.am + r.pm, 0))),
  rowExtra: (r) => h('span', {}, h('button', { class: 'link', onclick: () => customerHistory(r) }, 'History'), h('button', { class: 'link', onclick: () => customerLogin(r) }, 'Login')),
  extraBar: () => h('button', { onclick: () => dayChanges() }, '📅 Day changes'),
});

// Who gets a different quantity from their usual on one day (admin / delivery edits, accepted requests, no-milk pauses, milk unavailable)
async function dayChanges() {
  const dlg = $('#dlg');
  let date = today(), session = 'BOTH';
  const out = h('div');
  const sign = (n) => (n > 0 ? '+' : '−') + lit(Math.abs(n)) + ' L';
  const draw = guard(async () => {
    const d = await api(`day-changes?date=${date}&session=${session}`);
    const more = d.items.filter((i) => i.diff > 0).reduce((a, i) => a + i.diff, 0), less = d.items.filter((i) => i.diff < 0).reduce((a, i) => a + i.diff, 0);
    out.innerHTML = '';
    out.append(d.items.length ? h('div', {},
      h('p', { class: 'tag' }, `${d.items.length} change${d.items.length > 1 ? 's' : ''} on ${dayLabel(date)}` + (more ? ` · ${sign(more)} extra` : '') + (less ? ` · ${sign(less)} less` : '')),
      table([{ label: 'Customer', render: (r) => nameCell(r.name, r.id) }, { label: 'Session', render: (r) => (r.session === 'AM' ? 'Morning' : 'Evening') },
        { label: 'Usual', num: 1, render: (r) => lit(r.usual) + ' L' }, { label: 'That day', num: 1, render: (r) => h('b', {}, lit(r.qty) + ' L') },
        { label: 'Change', num: 1, render: (r) => h('span', { style: `color:${r.diff > 0 ? '#15803d' : '#b91c1c'};font-weight:600` }, sign(r.diff)) },
        { label: 'Why', render: (r) => h('span', {}, r.why, r.note ? h('div', { class: 'tag' }, r.note) : null) }], d.items))
      : h('p', { class: 'mute' }, `No changes on ${dayLabel(date)} — everyone gets their usual milk.`));
  });
  dlg.innerHTML = '';
  dlg.append(h('div', { class: 'form' }, h('h1', {}, 'Day changes'), h('p', { class: 'sub' }, 'Customers whose milk on this day is different from their usual quantity.'),
    h('div', { class: 'bar' }, h('input', { type: 'date', value: date, onchange: (e) => { if (e.target.value) { date = e.target.value; draw(); } } }),
      h('select', { 'aria-label': 'Session', onchange: (e) => { session = e.target.value; draw(); } }, [['BOTH', 'Both'], ['AM', 'Morning'], ['PM', 'Evening']].map(([v, t]) => h('option', { value: v }, t)))),
    out, h('div', { class: 'acts' }, h('button', { type: 'button', onclick: () => dlg.close() }, 'Close'))));
  await draw(); dlg.showModal();
}

// A customer's quantity / price changes, oldest first, with Delete to undo a wrong one.
async function customerHistory(c) {
  const dlg = $('#dlg');
  const draw = async () => {
    const plans = ((await api('customers')).find((x) => x.id === c.id) || {}).plans || [];
    const t = today(), cur = plans.filter((p) => p.from_date <= t).pop();
    const what = (p) => (p.status === 'Active' ? `AM ${lit(p.am)} L · PM ${lit(p.pm)} L · ${inr(p.price)}/L` : 'Inactive (no milk)');
    const when = (p) => (p.from_date === '0000-01-01' ? 'From the start' : 'From ' + new Date(p.from_date + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }));
    dlg.innerHTML = '';
    dlg.append(h('div', { class: 'form' }, h('h1', {}, `History — ${c.name}`),
      plans.length ? h('p', { class: 'tag' }, 'Each line applies from its date until the next one. Delete a wrong change and the one before it carries on.')
        : h('p', { class: 'mute' }, `No dated changes yet. ${what(c)} applies to every date. Use Edit with a From date to record a change.`),
      plans.length ? table([{ label: 'When', render: (p) => h('b', {}, when(p)) }, { label: 'Quantity & price', render: what },
        { label: '', render: (p) => p === cur ? pill('Now') : p.from_date > t ? pill('Upcoming') : '' },
        { label: '', render: (p) => (p.from_date === '0000-01-01' ? '' : h('button', { type: 'button', class: 'link del', onclick: guard(async () => {
          if (!confirm(`Delete the change ${when(p).toLowerCase()}? Bills from that date will use the quantity before it.`)) return;
          await api(`customers/${encodeURIComponent(c.id)}/plans/${p.from_date}`, 'DELETE'); toast('Change deleted'); await draw();
        }) }, 'Delete')) }], plans) : null,
      h('div', { class: 'acts' }, h('button', { type: 'button', onclick: () => { dlg.close(); render(); } }, 'Close'))));
  };
  await draw(); dlg.showModal();
}

pages.income = crud({ title: 'Income', sub: 'Non-bill income such as curd, ghee or egg sales.', resource: 'income',
  fields: () => [{ key: 'date', label: 'Date', type: 'date', default: monthDefaultDate(), required: true }, { key: 'type', label: 'Income type', type: 'select', options: S.lists.income_types }, { key: 'source', label: 'Customer / source' },
    { key: 'description', label: 'Description' }, { key: 'amount', label: 'Amount (₹)', type: 'number', required: true }, { key: 'mode', label: 'Payment mode', type: 'select', options: S.lists.modes }, { key: 'remarks', label: 'Remarks' }],
  cols: [{ label: 'Date', key: 'date' }, { label: 'Type', key: 'type' }, { label: 'Source', key: 'source' }, { label: 'Description', key: 'description' }, { label: 'Amount', num: 1, render: (r) => inr(r.amount) }, { label: 'Mode', key: 'mode' }, { label: 'Remarks', key: 'remarks' }],
  total: (rs, n) => sumRow(n, 4, inr(rs.reduce((a, r) => a + r.amount, 0))) });

pages.expenses = crud({ title: 'Expense', sub: 'Feed, medicine, labour and other costs.', resource: 'expenses',
  fields: () => [{ key: 'date', label: 'Date', type: 'date', default: monthDefaultDate(), required: true }, { key: 'category', label: 'Category', type: 'select', options: S.lists.expense_categories }, { key: 'description', label: 'Description' },
    { key: 'amount', label: 'Amount (₹)', type: 'number', required: true }, { key: 'mode', label: 'Payment mode', type: 'select', options: S.lists.modes }, { key: 'paid_by', label: 'Paid by' }, { key: 'remarks', label: 'Remarks' }],
  cols: [{ label: 'Date', key: 'date' }, { label: 'Category', key: 'category' }, { label: 'Description', key: 'description' }, { label: 'Amount', num: 1, render: (r) => inr(r.amount) }, { label: 'Mode', key: 'mode' }, { label: 'Paid by', key: 'paid_by' }, { label: 'Remarks', key: 'remarks' }],
  total: (rs, n) => sumRow(n, 3, inr(rs.reduce((a, r) => a + r.amount, 0))) });

const cowCalving = new Map(); // cow id -> expected calving date, from the newest pregnant AI record
const cowsPage = crud({ title: 'Cow', sub: 'Cow master list.', resource: 'cows', monthly: false, master: true, cls: 'freeze2', pick: { key: 'lactation', label: 'Lactation', options: ['Lactating', 'Dry', 'Heifer', 'Calf'] },
  fields: () => [{ key: 'name', label: 'Name / number', required: true }, { key: 'breed', label: 'Breed' }, { key: 'lactation', label: 'Lactation status', type: 'select', options: ['', 'Lactating', 'Dry', 'Heifer', 'Calf'] },
    { key: 'calving_date', label: 'Calving date', type: 'date' }, { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Sold', 'Deceased'] }, { key: 'notes', label: 'Notes', type: 'textarea' }],
  cols: [{ label: 'ID', key: 'id' }, { label: 'Name', render: (r) => nameCell(r.name, r.id) }, { label: 'Breed', key: 'breed' }, { label: 'Lactation', key: 'lactation' }, { label: 'Last calving', key: 'calving_date' }, { label: 'Expected calving', render: (r) => (cowCalving.has(r.id) ? h('b', {}, dayLabel(cowCalving.get(r.id))) : h('span', { class: 'mute' }, '–')) }, { label: 'Status', key: 'status' }, { label: 'Notes', key: 'notes' }],
  rowExtra: (r) => h('button', { class: 'link', onclick: () => aiDialog(r) }, 'AI') });
pages.cows = async (v) => {
  cowCalving.clear();
  for (const r of (await api('cow-ai')).reverse()) if (r.result === 'Pregnant') cowCalving.set(r.cow_id, r.due_date); // oldest first, so the newest pregnant record wins
  return cowsPage(v);
};

// AI (artificial insemination) for one cow: record the AI date, later the confirmation, and see the pregnancy progress.
async function aiDialog(cow) {
  const dlg = $('#dlg');
  const fmt = (d) => (d ? new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
  const draw = async () => {
    const recs = await api('cow-ai?cow_id=' + cow.id);
    dlg.innerHTML = '';
    const ad = h('input', { type: 'date', value: today(), max: today() });
    const add = guard(async () => { await api('cow-ai', 'POST', { cow_id: cow.id, ai_date: ad.value }); toast('AI recorded'); await draw(); });
    const card = (r) => {
      const cd = h('input', { type: 'date', value: r.confirm_date || today(), min: r.ai_date });
      const rs = h('select', {}, ['Pregnant', 'Not pregnant'].map((o) => h('option', { value: o, selected: o === r.result }, o)));
      const conf = guard(async () => { await api('cow-ai/' + r.id, 'PUT', { result: rs.value, confirm_date: cd.value }); toast('Saved'); await draw(); });
      const status = r.result === 'Pregnant' ? `Pregnant — ${Math.floor(r.days / 30.4)} months (day ${r.days}), calving due ${fmt(r.due_date)}`
        : r.result === 'Not pregnant' ? `Not pregnant (checked ${fmt(r.confirm_date)})` : `Waiting for confirmation (check from ${fmt(r.confirm_from)}) — day ${r.days}`;
      return h('div', { class: 'aicard' }, h('div', {}, h('b', {}, 'AI on ' + fmt(r.ai_date)), ' ', pill(r.result)), h('div', { class: 'tag' }, status),
        r.result !== 'Not pregnant' ? h('div', { class: 'airow' }, r.result === 'Pending' ? 'Confirmation:' : 'Change:', cd, rs, h('button', { type: 'button', onclick: conf }, 'Save')) : null,
        h('div', { class: 'airow' }, r.result !== 'Pending' ? h('button', { type: 'button', class: 'link', onclick: guard(async () => { await api('cow-ai/' + r.id, 'PUT', { result: 'Pending' }); await draw(); }) }, 'Mark as not confirmed') : null,
          h('button', { type: 'button', class: 'link del', onclick: guard(async () => { if (!confirmDel('this AI record')) return; await api('cow-ai/' + r.id, 'DELETE'); await draw(); }) }, 'Delete')));
    };
    dlg.append(h('div', { class: 'form' }, h('h1', {}, `AI — ${cow.name}`),
      h('label', {}, 'New AI date', h('div', { class: 'airow' }, ad, h('button', { type: 'button', class: 'pri', onclick: add }, 'Record AI'))),
      recs.length ? recs.map(card) : h('p', { class: 'mute' }, 'No AI recorded yet.'),
      h('div', { class: 'acts' }, h('button', { type: 'button', onclick: () => { dlg.close(); render(); } }, 'Close'))));
  };
  await draw(); dlg.showModal();
}

// Cow yield as a grid: dates across the top, one row per cow (AM and PM boxes per day). Type straight into a cell; it saves when you leave it.
pages.yield = async (v) => {
  const [cows, rows] = await Promise.all([api('cows'), api('cow_yield?month=' + S.month)]);
  const [yy, mm] = S.month.split('-').map(Number), n = new Date(yy, mm, 0).getDate();
  const dayStr = (d) => `${S.month}-${pad(d)}`;
  const data = new Map(rows.map((r) => [`${r.cow_id}|${r.date}`, { am: r.am, pm: r.pm }]));
  const shown = cows.filter((c) => c.status === 'Active' && c.lactation === 'Lactating'); // dry cows, heifers and calves give no milk
  v.append(h('h1', {}, 'Cow Yield'), h('p', { class: 'sub' }, `${monthLabel(S.month)} — litres per lactating cow per day (AM on top, PM below). Leave a cell empty if there was no milking. Dry cows are hidden.`));
  if (!shown.length) return v.append(h('p', { class: 'mute' }, cows.length ? 'No lactating cows. Set a cow’s lactation status to Lactating on the Cows page.' : 'No cows yet. '), h('a', { href: '#/cows' }, h('button', { class: 'pri' }, cows.length ? 'Manage cows' : 'Add cows')));
  v.append(h('div', { class: 'bar' }, h('a', { href: '#/cows' }, h('button', {}, 'Manage cows')), h('span', { class: 'grow' })));

  const num = (x) => Number(x) || 0;
  const dayAm = {}, dayPm = {}, dayTot = {}, cowAm = {}, cowPm = {}, cowTot = {};
  const get = (c, d) => data.get(`${c.id}|${dayStr(d)}`);
  const show = (el, x) => { el.textContent = x ? lit(x) : '–'; };
  const refresh = (d) => {
    let am = 0, pm = 0;
    for (const c of shown) { const r = get(c, d); if (r) { am += r.am; pm += r.pm; } }
    show(dayAm[d], am); show(dayPm[d], pm); show(dayTot[d], am + pm);
    let aAll = 0, pAll = 0;
    for (const c of shown) {
      let a = 0, p = 0;
      for (let k = 1; k <= n; k++) { const r = get(c, k); if (r) { a += r.am; p += r.pm; } }
      show(cowAm[c.id], a); show(cowPm[c.id], p); cowTot[c.id].textContent = lit(a + p); aAll += a; pAll += p;
    }
    show(cowAm.all, aAll); show(cowPm.all, pAll); cowTot.all.textContent = lit(aAll + pAll);
  };
  const cell = (c, d) => {
    const key = `${c.id}|${dayStr(d)}`, r = data.get(key);
    const mk = (which) => h('input', { class: 'q', type: 'number', step: 'any', min: 0, inputmode: 'decimal', placeholder: which.toUpperCase(), 'aria-label': `${c.name} ${which} ${dayStr(d)}`, value: r && r[which] ? r[which] : '' });
    const a = mk('am'), p = mk('pm');
    const save = guard(async () => {
      if ((a.value !== '' && !(Number(a.value) >= 0)) || (p.value !== '' && !(Number(p.value) >= 0))) { toast('Enter a number ≥ 0', true); return; }
      await api('yield-cell', 'PUT', { date: dayStr(d), cow_id: c.id, am: a.value, pm: p.value });
      if (a.value === '' && p.value === '') data.delete(key); else data.set(key, { am: num(a.value), pm: num(p.value) });
      refresh(d);
    });
    a.addEventListener('change', save); p.addEventListener('change', save);
    return h('td', { class: 'gridcell' }, a, p);
  };
  const t = today(), days = Array.from({ length: n }, (_, i) => i + 1);
  const dayHead = (d) => h('th', { class: 'n ycol' + (dayStr(d) === t ? ' today' : ''), title: dayLabel(dayStr(d)) }, h('div', {}, pad(d)), h('div', { class: 'wd' }, new Date(dayStr(d) + 'T00:00').toLocaleDateString('en-IN', { weekday: 'short' })));
  const body = shown.map((c) => { cowAm[c.id] = h('td', { class: 'n' }); cowPm[c.id] = h('td', { class: 'n' }); cowTot[c.id] = h('td', { class: 'n' }); return h('tr', {}, h('td', { class: 'stick', title: c.breed || '' }, c.name), days.map((d) => cell(c, d)), cowAm[c.id], cowPm[c.id], cowTot[c.id]); });
  cowAm.all = h('td', { class: 'n' }); cowPm.all = h('td', { class: 'n' }); cowTot.all = h('td', { class: 'n' });
  const footRow = (label, store, a, p, t) => h('tr', {}, h('td', { class: 'stick' }, label), days.map((d) => (store[d] = h('td', { class: 'n' }))), a, p, t);
  const blank = () => h('td', { class: 'n' });
  v.append(h('div', { class: 'tablewrap' }, h('table', { class: 'ygrid' },
    h('thead', {}, h('tr', {}, h('th', { class: 'stick' }, 'Cow'), days.map(dayHead), h('th', { class: 'n' }, 'AM total'), h('th', { class: 'n' }, 'PM total'), h('th', { class: 'n' }, 'Cow total'))),
    h('tbody', {}, body),
    h('tfoot', {}, footRow('AM total', dayAm, cowAm.all, blank(), blank()), footRow('PM total', dayPm, blank(), cowPm.all, blank()), footRow('Day total', dayTot, blank(), blank(), cowTot.all)))));
  for (const d of days) refresh(d);
  const todayCol = $('th.today'); if (todayCol) todayCol.scrollIntoView({ inline: 'center', block: 'nearest' });
};

pages.daily = async (v) => {
  const rows = await api('daily?month=' + S.month);
  v.append(h('h1', {}, 'Daily Summary'), h('p', { class: 'sub' }, `${monthLabel(S.month)} — litres, deliveries and estimated sales per day.`),
    collectionSummary(), milkSummary(), h('h2', {}, `Deliveries — ${monthLabel(S.month)}`),
    table([{ label: 'Date', render: (r) => dayLabel(r.date) }, { label: 'AM L', num: 1, render: (r) => lit(r.am) }, { label: 'PM L', num: 1, render: (r) => lit(r.pm) }, { label: 'Total L', num: 1, render: (r) => lit(r.total) },
      { label: 'Deliveries', num: 1, key: 'served' }, { label: 'Absent entries', num: 1, key: 'absent' }, { label: 'Est. sales', num: 1, render: (r) => inr(r.sales) }], rows,
      { foot: ['Total', lit(rows.reduce((a, r) => a + r.am, 0)), lit(rows.reduce((a, r) => a + r.pm, 0)), lit(rows.reduce((a, r) => a + r.total, 0)), '', rows.reduce((a, r) => a + r.absent, 0), inr(rows.reduce((a, r) => a + r.sales, 0))] }));
};

pages.pnl = async (v) => {
  const p = await api('pnl?month=' + S.month);
  const line = (l, val, cls) => h('tr', {}, h('td', {}, l), h('td', { class: 'n ' + (cls || '') }, inr(val)));
  const breakdown = (rows, key) => rows.length ? h('div', { class: 'bars' }, rows.map((r) => h('div', { class: 'row' }, h('span', { class: 'name' }, r[key]), h('span', { class: 'bar-fill', style: `width:${(r.t / rows[0].t) * 160}px` }), inr(r.t)))) : h('p', { class: 'mute' }, 'No entries.');
  v.append(h('h1', {}, 'Profit & Loss'), h('p', { class: 'sub' }, `${monthLabel(S.month)} — sales are billed amounts (not collections).`),
    h('div', { class: 'grid2' }, h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, line('Customer milk sales', p.sales), line('Other income', p.other_income), line('Total income', p.total_income), line('Total expenses', p.expenses), line('Net profit', p.net, p.net >= 0 ? 'good' : 'bad')))),
      h('div', {}, h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Expenses by category'), breakdown(p.by_category, 'category')), h('div', { class: 'card', style: 'margin-top:12px' }, h('h2', { style: 'margin-top:0' }, 'Other income by type'), breakdown(p.by_type, 'type')))));
};

let navSaveT;
function navOrderEditor() {
  const list = h('div', {});
  const setOrder = (order) => {
    S.user.nav_order = order; paint();
    const nav = $('#nav');
    for (const [k] of navInOrder()) { const a = nav.querySelector(`a[href="#/${k}"]`); if (a) nav.append(a); } // moved, not rebuilt, so the red count bubbles stay
    clearTimeout(navSaveT); navSaveT = setTimeout(guard(() => api('nav-order', 'PUT', { order })), 400); // a few quick taps save once
  };
  const move = (from, to) => { const order = navInOrder().map(([k]) => k); order.splice(to, 0, order.splice(from, 1)[0]); setOrder(order); };
  const paint = () => list.replaceChildren(...navInOrder().map(([, l], i, items) => h('div', { class: 'navorder' }, h('span', { class: 'grow' }, l),
    h('button', { class: 'link', disabled: i === 0, 'aria-label': `Move ${l} to the top`, onclick: () => move(i, 0) }, 'Top'),
    h('button', { disabled: i === 0, 'aria-label': `Move ${l} up`, onclick: () => move(i, i - 1) }, '▲'),
    h('button', { disabled: i === items.length - 1, 'aria-label': `Move ${l} down`, onclick: () => move(i, i + 1) }, '▼'))));
  paint();
  return h('div', { class: 'card' }, list, h('div', { class: 'bar', style: 'margin:12px 0 0' }, h('button', { onclick: () => { setOrder([]); toast('Menu reset to default'); } }, 'Reset to default')));
}

pages.settings = async (v) => {
  const L = await api('lists');
  const areas = {};
  const mk = (k, label) => { areas[k] = h('textarea', { rows: 10 }); areas[k].value = L[k].join('\n'); return h('label', { class: 'card', style: 'display:block' }, h('b', {}, label), h('div', { class: 'tag' }, 'One per line'), areas[k]); };
  v.append(h('h1', {}, 'Settings'), h('h2', {}, 'Rearrange menu'), h('p', { class: 'sub' }, 'Sets the order of the bottom bar on phones and the side menu on computers. Saved to the admin account, so it follows you to other devices.'), navOrderEditor(),
    h('h2', {}, 'Dropdown lists'), h('p', { class: 'sub' }, 'Dropdown lists used in Payments, Income and Expenses. Data is stored in app/data/grv.db.'),
    h('div', { class: 'grid2' }, mk('modes', 'Payment modes'), mk('expense_categories', 'Expense categories'), mk('income_types', 'Income types')),
    h('div', { class: 'bar', style: 'margin-top:12px' }, h('button', { class: 'pri', onclick: guard(async () => {
      const body = {}; for (const k in areas) body[k] = areas[k].value.split('\n'); await api('lists', 'PUT', body); toast('Settings saved');
    }) }, 'Save')));
  for (const a of Object.values(areas)) a.style.cssText = 'display:block;width:100%;margin-top:6px';
  const pwBox = (role, label) => {
    const i = h('input', { type: 'text', placeholder: 'New password (min 6 characters)', autocomplete: 'off' });
    return h('div', { class: 'bar' }, h('b', { style: 'width:170px' }, label), i, h('button', { onclick: guard(async () => { await api('password', 'PUT', { role, password: i.value }); i.value = ''; toast(label + ' password saved'); render(); }) }, 'Save'));
  };
  const logins = await api('logins');
  const st = (k) => h('span', { class: 'tag ' + (logins[k] ? 'good' : 'bad'), style: 'width:100%' }, logins[k] ? '✓ set' : '⚠ not set yet — this login cannot sign in');
  v.append(h('h2', {}, 'Logins'), h('p', { class: 'sub' }, 'Delivery staff choose Morning, Evening or Both when they sign in, and each has its own password. A Morning login sees only morning customers, notices and route; Evening only evening. Delivery logins only see today\'s and yesterday\'s list — no prices, bills or reports. Changing a password signs that login out on other phones.'),
    h('div', { class: 'card' }, pwBox('delivery_am', '🌅 Morning delivery'), st('delivery_am'), pwBox('delivery_pm', '🌇 Evening delivery'), st('delivery_pm'), pwBox('delivery', '🌅🌇 Both (delivery)'), pwBox('admin', 'Admin')),
    h('h2', {}, 'Download data'), h('p', { class: 'sub' }, 'All customers, deliveries, payments, income, expenses, cows, cow yield, AI records and pauses in one Excel (.xlsx) file, one sheet per table. Passwords are not included.'),
    h('div', { class: 'card' }, h('button', { class: 'pri', onclick: guard(downloadExcel) }, 'Download all data (.xlsx)')));
};


// ---------- extra items: egg, ghee, curd... (admin) ----------
const UNITS = ['Nos', 'Litre', 'Kg', 'Packet', 'Dozen'];
const qtyText = (n, unit) => `${lit(n)} ${unit === 'Nos' ? '' : unit || ''}`.trim();
pages.extras = async (v) => {
  await loadCustomers();
  const [items, orders] = await Promise.all([api('products'), api('product-orders')]);
  let show = 'Booked';
  const editItem = (p) => openForm({ title: p ? 'Edit item' : 'Add item', saveLabel: 'Save',
    intro: h('p', { class: 'tag' }, 'Total quantity is everything you have put up for booking. Customers see what is left after bookings.'),
    fields: [{ key: 'name', label: 'Item (e.g. Egg, Ghee, Curd)', required: true }, { key: 'unit', label: 'Sold in', type: 'select', options: UNITS },
      { key: 'price', label: 'Price per unit (₹)', type: 'number', required: true }, { key: 'stock', label: 'Total quantity available', type: 'number', required: true },
      ...(p ? [{ key: 'active', label: 'Show to customers', type: 'select', options: [['1', 'Yes'], ['0', 'Hidden']] }] : [])],
    values: p ? { ...p, active: p.active ? '1' : '0' } : { unit: 'Nos' },
    onSave: async (d) => { await api(p ? 'products/' + p.id : 'products', p ? 'PUT' : 'POST', d); toast('Saved'); render(); } });
  const bookFor = () => {
    const live = items.filter((i) => i.active);
    if (!live.length) return toast('Add an item first', true);
    openForm({ title: 'Book for a customer', saveLabel: 'Book', intro: h('p', { class: 'tag' }, 'For orders that come by phone call.'),
      fields: [{ key: 'customer_id', label: 'Customer', type: 'select', options: customersCache.map((c) => [c.id, `${c.id} — ${c.name}`]) },
        { key: 'product_id', label: 'Item', type: 'select', options: live.map((i) => [i.id, `${i.name} (${qtyText(i.left_qty, i.unit)} left)`]) },
        { key: 'qty', label: 'Quantity', type: 'number', required: true }, { key: 'note', label: 'Note' }],
      onSave: async (d) => { await api('product-orders', 'POST', d); toast('Booked'); render(); } });
  };
  const itemTable = items.length ? table([{ label: 'Item', render: (p) => h('span', {}, h('b', {}, p.name), p.active ? '' : h('span', { class: 'tag' }, '  (hidden)')) }, { label: 'Price', num: 1, render: (p) => inr(p.price) + ' / ' + p.unit },
    { label: 'Total', num: 1, render: (p) => qtyText(p.stock, p.unit) }, { label: 'Booked', num: 1, render: (p) => qtyText(p.booked, p.unit) }, { label: 'Left', num: 1, render: (p) => h('b', { class: p.left_qty ? '' : 'bad' }, qtyText(p.left_qty, p.unit)) },
    { label: '', render: (p) => actions(() => editItem(p), guard(async () => { if (!confirmDel(p.name)) return; await api('products/' + p.id, 'DELETE'); toast('Deleted'); render(); })) }], items)
    : h('p', { class: 'mute' }, 'No items yet. Click + Add item to add egg, ghee, curd and so on.');
  const holder = h('div');
  const draw = () => {
    holder.innerHTML = '';
    const rs = orders.filter((o) => show === 'All' || o.status === show);
    holder.append(rs.length ? table([{ label: 'Date', key: 'date' }, { label: 'Customer', render: (o) => `${o.customer_id} — ${o.customer || ''}` }, { label: 'Item', render: (o) => o.product || '(deleted)' },
      { label: 'Qty', num: 1, render: (o) => qtyText(o.qty, o.unit) }, { label: 'Amount', num: 1, render: (o) => inr(o.qty * o.price) }, { label: 'By', render: (o) => (o.created_by === 'admin' ? 'Admin' : 'Customer') },
      { label: 'Status', render: (o) => pill(o.status) },
      { label: '', render: (o) => h('span', {}, o.status === 'Booked' ? h('button', { class: 'link', onclick: guard(async () => { await api('product-orders/' + o.id, 'PUT', { status: 'Delivered' }); toast('Marked delivered'); render(); }) }, 'Delivered') : null,
        o.status !== 'Cancelled' ? h('button', { class: 'link del', onclick: guard(async () => { if (!confirm('Cancel this booking? The quantity goes back to available.')) return; await api('product-orders/' + o.id, 'PUT', { status: 'Cancelled' }); toast('Cancelled'); render(); }) }, 'Cancel')
          : h('button', { class: 'link', onclick: guard(async () => { await api('product-orders/' + o.id, 'PUT', { status: 'Booked' }); toast('Reopened'); render(); }) }, 'Reopen')) }], rs) : h('p', { class: 'mute' }, 'Nothing here.'));
  };
  const filt = h('select', { onchange: (e) => { show = e.target.value; draw(); } }, ['Booked', 'Delivered', 'Cancelled', 'All'].map((o) => h('option', { value: o }, o === 'All' ? 'All bookings' : o)));
  v.append(h('h1', {}, 'Extra Items'), h('p', { class: 'sub' }, 'Egg, ghee, curd and other items. Customers see what is left and book from their own login; you can also book for them when they call.'),
    h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: () => editItem() }, '+ Add item'), h('button', { onclick: bookFor }, 'Book for a customer')), itemTable,
    h('h2', {}, 'Bookings'), h('div', { class: 'bar' }, h('label', { class: 'tag' }, 'Show ', filt)), holder);
  draw();
};

// ---------- Excel download (a minimal .xlsx writer, no library needed) ----------
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) { // files: [[name, string]] -> Uint8Array of an uncompressed zip
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const u16 = (n) => [n & 255, (n >>> 8) & 255], u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  for (const [name, text] of files) {
    const nm = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const common = [...u16(20), ...u16(0x800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nm.length), ...u16(0)];
    parts.push(new Uint8Array([0x50, 0x4B, 3, 4, ...common]), nm, data);
    central.push(new Uint8Array([0x50, 0x4B, 1, 2, ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nm);
    off += 30 + nm.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array([0x50, 0x4B, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), 0, 0]);
  const chunks = [...parts, ...central, end], out = new Uint8Array(chunks.reduce((a, b) => a + b.length, 0)); let p = 0;
  for (const b of chunks) { out.set(b, p); p += b.length; }
  return out;
}
function makeXlsx(sheets) { // sheets: { name: [row objects] }
  const esc = (x) => String(x).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const col = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  const names = Object.keys(sheets);
  const sheetXml = (rows) => {
    const keys = rows.length ? Object.keys(rows[0]) : [];
    const cellOf = (v, r, c, head) => { const ref = col(c) + r; if (v === null || v === undefined || v === '') return ''; return typeof v === 'number' && isFinite(v) && !head ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}"${head ? ' s="1"' : ''} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`; };
    const body = [keys.map((k, c) => cellOf(k, 1, c, true)).join('')].concat(rows.map((row, i) => keys.map((k, c) => cellOf(row[k], i + 2, c)).join('')));
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${Math.max(keys.length, 1)}" width="16" customWidth="1"/></cols><sheetData>${body.map((r, i) => `<row r="${i + 1}">${r}</row>`).join('')}</sheetData></worksheet>`;
  };
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipStore([
    ['[Content_Types].xml', X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
    ['_rels/.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', X + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', X + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'],
    ...names.map((n, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheets[n])]),
  ]);
}
async function downloadExcel() {
  const data = await api('export');
  const blob = new Blob([makeXlsx(data)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `GRV-Dairy-${today()}.xlsx` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Excel file downloaded');
}

// ---------- admin: customer login help ----------
async function customerLogin(c) {
  const info = await api(`customers/${c.id}/login`);
  const dlg = $('#dlg'); dlg.innerHTML = '';
  const np = h('input', { type: 'text', placeholder: 'New password (min 4 characters)', autocomplete: 'off' });
  const done = guard(async (body, msg) => { await api(`customers/${c.id}/password`, 'PUT', body); toast(msg); dlg.close(); });
  dlg.append(h('div', { class: 'form' }, h('h1', {}, `Login — ${c.name}`),
    h('p', {}, h('b', {}, 'Customer ID: '), c.id),
    info.custom
      ? h('p', {}, 'This customer has set their own password. For security it cannot be shown — reset it to their phone number, or set a new one.')
      : info.password ? h('p', {}, h('b', {}, 'Password: '), info.password, h('span', { class: 'tag' }, '  (their phone number)')) : h('p', { class: 'bad' }, 'No phone number saved, so this customer cannot log in yet. Add a phone number (at least 6 digits) first.'),
    h('label', {}, 'Set a new password', np),
    h('div', { class: 'acts' }, h('button', { type: 'button', onclick: () => dlg.close() }, 'Close'),
      h('button', { type: 'button', onclick: () => done({}, 'Reset to phone number') }, 'Reset to phone number'),
      h('button', { type: 'button', class: 'pri', onclick: () => np.value ? done({ password: np.value }, 'Password set') : toast('Type a new password first', true) }, 'Set password'))));
  dlg.showModal();
}

// ---------- notices (admin + delivery): customer "no milk" requests ----------
pages.notices = async (v) => {
  const d = await api('notices');
  const admin = S.user.role === 'admin';
  const sess = (s) => ({ AM: 'Morning', PM: 'Evening', BOTH: 'Morning & Evening' }[s]);
  const span = (k) => (k.from === k.to ? dayLabel(k.from) : `${dayLabel(k.from)} → ${dayLabel(k.to)}`);
  const now = d.items.filter((k) => k.from <= d.today), later = d.items.filter((k) => k.from > d.today);
  const card = (k) => {
    const len = Math.round((new Date(k.to) - new Date(k.from)) / 864e5) + 1, dayNo = Math.round((new Date(d.today) - new Date(k.from)) / 864e5) + 1;
    return h('div', { class: 'rcard skipped' }, h('div', { class: 'rtop' }, h('div', {}, h('div', { class: 'rname' }, k.name), h('div', { class: 'tag' }, `${k.customer_id} · ${sess(k.session)}`)),
      h('div', { class: 'qty', style: 'font-size:15px;text-align:right' }, k.from <= d.today ? `Day ${dayNo} of ${len}` : 'Starts ' + dayLabel(k.from))),
      h('div', { style: 'margin-top:6px' }, '📅 ', span(k), k.note ? h('div', { class: 'tag' }, '“' + k.note + '”') : null, h('div', { class: 'tag' }, k.created_by === 'customer' ? 'Asked by customer' : 'Added by admin')),
      admin ? h('div', { class: 'ract' }, h('button', { class: 'abs', onclick: guard(async () => { if (!confirm(k.from <= d.today ? 'End this request from today? (Past days stay as they were.)' : 'Cancel this request?')) return; await api('skips/' + k.id, 'DELETE'); toast('Done'); render(); }) }, k.from <= d.today ? 'End from today' : 'Cancel request')) : null);
  };
  const section = (title, items, empty) => h('div', {}, h('h2', {}, title), items.length ? h('div', { class: 'cards-list' }, items.map(card)) : h('p', { class: 'mute' }, empty));
  // more / less milk asks from customers: accepting sets that day's quantity, so the delivery list and both bills follow it
  const decide = (r, status) => guard(async () => {
    if (status === 'Rejected' && !confirm(`Reject ${r.name}'s request?`)) return;
    await api('qty-requests/' + r.id, 'PUT', { status }); toast(status === 'Accepted' ? 'Accepted — quantity updated' : 'Rejected'); render();
  });
  const reqCard = (r) => h('div', { class: 'rcard change' }, h('div', { class: 'chg-tag' }, '🥛 Change milk'), h('div', { class: 'rtop' }, h('div', {}, h('div', { class: 'rname' }, r.name), h('div', { class: 'tag' }, `${r.customer_id} · ${sess(r.session)}`)),
      h('div', { class: 'qty', style: 'font-size:15px;text-align:right' }, `${lit(r.usual)} → ${lit(r.qty)} L`, h('div', { class: 'tag ' + (r.qty > r.usual ? 'good' : 'bad') }, r.qty > r.usual ? `${lit(r.qty - r.usual)} L more` : r.qty < r.usual ? `${lit(r.usual - r.qty)} L less` : 'same as usual'))),
    h('div', { style: 'margin-top:6px' }, '📅 ', dayLabel(r.date), r.note ? h('div', { class: 'tag' }, '“' + r.note + '”') : null),
    h('div', { class: 'ract' }, h('button', { class: 'pri', onclick: decide(r, 'Accepted') }, 'Accept'), h('button', { class: 'abs', onclick: decide(r, 'Rejected') }, 'Reject')));
  v.append(h('h1', {}, 'Notices'), h('p', { class: 'sub' }, 'Customers who asked for no milk. A request stays here for every day it covers — and the delivery list and bills follow it automatically.'),
    admin ? h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: () => addSkip() }, '+ Add request (phone call)')) : null,
    admin && d.requests.length ? h('div', {}, h('h2', { class: 'chg-head' }, `🥛 Change milk requests (${d.requests.length})`), h('div', { class: 'cards-list' }, d.requests.map(reqCard))) : null,
    section(`✕ Don't deliver today (${d.today.split('-').reverse().join('/')})`, now, 'No customer has asked to skip today.'),
    section('Coming up', later, 'Nothing scheduled.'));
  async function addSkip() {
    const customers = await api('customers');
    openForm({ title: 'Add no-milk request', fields: [
      { key: 'customer_id', label: 'Customer', type: 'select', options: customers.map((c) => [c.id, `${c.id} — ${c.name}`]) },
      { key: 'from', label: 'From', type: 'date', default: d.tomorrow, required: true }, { key: 'to', label: 'To (last day)', type: 'date', default: d.tomorrow, required: true },
      { key: 'session', label: 'Which delivery', type: 'select', options: [['AM', 'Morning'], ['PM', 'Evening'], ['BOTH', 'Morning & Evening']] }, { key: 'note', label: 'Note' }],
    onSave: async (x) => { await api('skips', 'POST', x); toast('Saved'); render(); } });
  }
};

// ---------- Location Tracker (admin): mark each house with the phone's GPS, then set the delivery order ----------
// GPS problems get a big pop-up that says exactly what to do (GPS off, permission blocked, plain http link)
function gpsHelp(kind, retry) {
  const msg = {
    off: ['📡 Turn on GPS', 'Your phone’s Location (GPS) is off. Pull down the top bar of your phone, tap “Location” to turn it on, then tap Try again.', 'போனின் Location (GPS) ஆஃப்ல இருக்கு. மேல இருந்து கீழே இழுத்து “Location” ஆன் பண்ணுங்க.'],
    denied: ['🔒 Allow location', 'This site is not allowed to use your location. Tap the 🔒 lock next to the web address → Permissions → Location → Allow. Then tap Try again.', 'இந்த site-க்கு Location அனுமதி இல்லை. Address bar-ல 🔒 தட்டி Location → Allow பண்ணுங்க.'],
    slow: ['⏳ GPS signal is weak', 'Could not get your position. Check that GPS is on, step outside or near a window, and tap Try again.', 'GPS சிக்னல் கிடைக்கலை. GPS ஆன்ல இருக்கான்னு பாருங்க, வெளியே வந்து மீண்டும் முயற்சி பண்ணுங்க.'],
    http: ['🔐 Use the secure link', 'Phones only share GPS with secure (https) links. Open the app from its https:// web link (not the Wi-Fi number link) to mark locations.', 'GPS-க்கு https:// link-ல app-ஐ திறக்கணும்.'],
    none: ['📵 No GPS', 'This device or browser cannot share its location. Use a phone with Chrome.', 'இந்த போன்/browser-ல Location வசதி இல்லை.'],
  }[kind];
  const dlg = $('#dlg'); dlg.innerHTML = '';
  dlg.append(h('form', { class: 'form gps-help', method: 'dialog' }, h('h1', {}, msg[0]), h('p', {}, msg[1]), h('p', { lang: 'ta', class: 'tag' }, msg[2]),
    h('div', { class: 'acts' }, h('button', { type: 'submit' }, 'Close'), retry && kind !== 'http' && kind !== 'none' ? h('button', { class: 'pri', type: 'button', onclick: () => { dlg.close(); retry(); } }, 'Try again') : null)));
  dlg.showModal();
}
// watch the GPS for a few seconds and keep the most accurate fix (stops early once it is within 15 m)
function getGps(onProgress) {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) return reject({ kind: 'http' });
    if (!navigator.geolocation) return reject({ kind: 'none' });
    let best = null, done = false;
    const finish = (err) => { if (done) return; done = true; navigator.geolocation.clearWatch(id); clearTimeout(tm); best ? resolve(best) : reject(err || { kind: 'slow' }); };
    const id = navigator.geolocation.watchPosition((p) => {
      const fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      if (!best || fix.acc < best.acc) { best = fix; onProgress && onProgress(fix); }
      if (fix.acc <= 15) finish();
    }, (e) => finish({ kind: e.code === 1 ? 'denied' : e.code === 2 ? 'off' : 'slow' }), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    const tm = setTimeout(() => finish(), 12000);
  });
}
const kmBetween = (a, b) => { // straight-line distance in km
  const R = 6371, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const distText = (km) => (km < 1 ? Math.round(km * 1000 / 10) * 10 + ' m' : km.toFixed(1) + ' km');
// shortest-path guess: nearest house next from the farm, then untangle crossing legs (2-opt)
function autoOrder(stops, farm) {
  const left = [...stops], path = [];
  let at = farm || left[0];
  while (left.length) { let bi = 0; for (let i = 1; i < left.length; i++) if (kmBetween(at, left[i]) < kmBetween(at, left[bi])) bi = i; at = left.splice(bi, 1)[0]; path.push(at); }
  const pt = (i) => (i < 0 ? farm : path[i]);
  for (let pass = 0, better = true; better && pass < 50; pass++) {
    better = false;
    for (let i = farm ? 0 : 1; i < path.length - 1; i++) for (let j = i + 1; j < path.length; j++) {
      const a = pt(i - 1), b = path[i], c = path[j], d = path[j + 1];
      if (!a) continue;
      const before = kmBetween(a, b) + (d ? kmBetween(c, d) : 0), after = kmBetween(a, c) + (d ? kmBetween(b, d) : 0);
      if (after < before - 1e-6) { path.splice(i, j - i + 1, ...path.slice(i, j + 1).reverse()); better = true; }
    }
  }
  return path;
}
const L = { session: new Date().getHours() < 14 ? 'AM' : 'PM', filter: '', edit: false };
pages.locations = async (v) => {
  const d = await api('locations'), farm = d.farm, admin = S.user.role === 'admin'; // delivery staff: mark new houses only; order and changes stay with the admin
  if (!admin) L.edit = false;
  const only = !admin && ['AM', 'PM'].includes(S.user.shift) ? S.user.shift : null;
  if (only) L.session = only;
  const byId = new Map(d.customers.map((c) => [c.id, c]));
  const has = (c) => c && c.lat != null;
  const inSession = (c) => c.status === 'Active' && (L.session === 'AM' ? c.am : c.pm) > 0;
  // saved order first, then anyone new for this session (by ID)
  let order = d.order[L.session].filter((id) => byId.has(id) && inSession(byId.get(id)));
  for (const c of d.customers) if (inSession(c) && !order.includes(c.id)) order.push(c.id);
  let saveT = null;
  const prev = (d.prev || {})[L.session]; // order from before the last ⚡ Auto order, if it can still be put back
  const save = () => { clearTimeout(saveT); saveT = setTimeout(guard(async () => { await api('locations/order', 'PUT', { session: L.session, ids: order }); toast('Order saved'); }), 700); };

  const mark = (what, label) => guard(async () => {
    const dlg = $('#dlg'); dlg.innerHTML = '';
    const st = h('p', { class: 'gps-acc' }, 'Getting GPS…');
    dlg.append(h('form', { class: 'form gps-help', method: 'dialog' }, h('h1', {}, '📍 ' + label), h('p', { class: 'tag' }, 'Stand at the gate / door. Hold the phone still for a few seconds.'), st));
    dlg.showModal();
    let fix;
    try { fix = await getGps((f) => { st.textContent = `Accuracy: ±${Math.round(f.acc)} m` + (f.acc <= 15 ? ' ✓' : ' … improving'); }); }
    catch (e) { dlg.close(); return gpsHelp(e.kind || 'slow', mark(what, label)); }
    dlg.close();
    if (fix.acc > 100 && !confirm(`GPS is only accurate to ±${Math.round(fix.acc)} m. Save anyway? (Tap Cancel, go outside and try again for a better mark.)`)) return;
    await api('locations/' + what, 'PUT', fix);
    toast(`Location saved (±${Math.round(fix.acc)} m)`); render();
  });

  const listBox = h('div', { class: 'cards-list loc-list' }), info = h('p', { class: 'tag' });
  // drag and drop: hold the ⠿ handle and slide the card up or down (mouse or finger); the list scrolls at the screen edges
  function dragStart(e) {
    const card = e.currentTarget.closest('.loc-card'); if (!card || e.button > 0) return;
    e.preventDefault();
    const handle = e.currentTarget; handle.setPointerCapture(e.pointerId);
    const startY = e.pageY, top0 = card.offsetTop; let lastY = e.clientY, scrollT = null;
    card.classList.add('dragging');
    const follow = () => {
      card.style.transform = `translateY(${lastY + scrollY - startY - (card.offsetTop - top0)}px)`;
      const mid = card.getBoundingClientRect().top + card.offsetHeight / 2;
      let p = card.previousElementSibling, n = card.nextElementSibling;
      while (p && mid < p.getBoundingClientRect().top + p.offsetHeight / 2) { listBox.insertBefore(card, p); p = card.previousElementSibling; }
      while (n && mid > n.getBoundingClientRect().top + n.offsetHeight / 2) { listBox.insertBefore(n, card); n = card.nextElementSibling; }
      card.style.transform = `translateY(${lastY + scrollY - startY - (card.offsetTop - top0)}px)`;
    };
    const edge = () => { const k = lastY < 90 ? -12 : lastY > innerHeight - 90 ? 12 : 0; if (k) { scrollBy(0, k); follow(); } };
    const moveH = (ev) => { lastY = ev.clientY; follow(); };
    const upH = () => {
      handle.removeEventListener('pointermove', moveH); handle.removeEventListener('pointerup', upH); handle.removeEventListener('pointercancel', upH); clearInterval(scrollT);
      card.classList.remove('dragging'); card.style.transform = '';
      const ids = [...listBox.querySelectorAll('.loc-card')].map((x) => x.dataset.id);
      if (ids.join() !== order.join()) { order = ids; save(); }
      draw();
    };
    handle.addEventListener('pointermove', moveH); handle.addEventListener('pointerup', upH); handle.addEventListener('pointercancel', upH);
    scrollT = setInterval(edge, 16);
  }
  const draw = () => {
    listBox.innerHTML = '';
    const q = L.filter.trim().toLowerCase(), filtering = !!q;
    let prev = d.farm, total = 0, missing = 0;
    order.forEach((id, i) => {
      const c = byId.get(id); if (!has(c)) missing++;
      const leg = has(c) && prev ? kmBetween(prev, c) : null, from = prev && prev === d.farm ? 'farm' : 'previous';
      if (leg != null) total += leg;
      if (has(c)) prev = c;
      if (filtering && !(c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))) return;
      const move = (to) => { if (to < 0 || to >= order.length || to === i) return; order.splice(to, 0, ...order.splice(i, 1)); draw(); save(); };
      listBox.append(h('div', { class: 'rcard loc-card' + (has(c) ? '' : ' nomark'), 'data-id': c.id },
        h('div', { class: 'rtop' },
          filtering ? null : h('div', { class: 'drag-h', title: 'Hold and drag to move', 'aria-hidden': 'true', onpointerdown: dragStart }, '⠿'),
          h('button', { class: 'loc-no', title: 'Move to position…', disabled: filtering, onclick: () => { const n = Number(prompt(`Move ${c.name} to which position? (1–${order.length})`, i + 1)); if (n >= 1) move(Math.min(n, order.length) - 1); } }, i + 1),
          h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'rname' }, c.name), h('div', { class: 'tag' }, c.id + ' · ' + lit(L.session === 'AM' ? c.am : c.pm) + ' L'),
            h('div', { class: 'tag ' + (has(c) ? 'good' : 'bad') }, has(c) ? `📍 Marked${c.acc != null ? ' ±' + c.acc + ' m' : ''}` + (leg != null ? ` · ${distText(leg)} from ${from}` : '') : '⚠ Location not marked')),
          h('div', { class: 'loc-move' }, h('button', { 'aria-label': 'Move up', disabled: filtering || i === 0, onclick: () => move(i - 1) }, '↑'), h('button', { 'aria-label': 'Move down', disabled: filtering || i === order.length - 1, onclick: () => move(i + 1) }, '↓'))),
        h('div', { class: 'ract' },
          // one-time setup: a saved house is locked; Re-mark / Clear only show in "Change saved locations" mode
          !has(c) ? h('button', { class: 'pri', disabled: !farm, onclick: () => mark(c.id, c.name)() }, farm ? '📍 Mark location here' : '🔒 Mark your start location first')
            : L.edit ? h('button', { onclick: () => { if (confirm(`Replace ${c.name}'s saved location with where you are standing now?`)) mark(c.id, c.name)(); } }, '📍 Re-mark') : null,
          has(c) ? h('a', { class: 'btn', href: `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`, target: '_blank', rel: 'noopener' }, '🧭 Directions') : null,
          has(c) && L.edit ? h('button', { class: 'abs', onclick: guard(async () => { if (!confirm(`Remove ${c.name}'s location?`)) return; await api('locations/' + c.id, 'DELETE'); toast('Removed'); render(); }) }, 'Clear') : null)));
    });
    if (!listBox.children.length) listBox.append(h('p', { class: 'mute' }, order.length ? 'No customer matches.' : 'No customers get milk in this session.'));
    info.textContent = `${order.length} stops` + (total ? ` · about ${distText(total)} in total` : '');
  };
  // setup progress across all active customers (both sessions): a one-time job, done once every house is saved
  const active = d.customers.filter((c) => c.status === 'Active' && (c.am > 0 || c.pm > 0)), doneN = active.filter(has).length;
  const allDone = farm && doneN === active.length;

  const sessSeg = only ? h('b', { class: 'shift-pill' }, only === 'AM' ? '🌅 Morning' : '🌇 Evening') : h('div', { class: 'seg' }, [['AM', '🌅 Morning'], ['PM', '🌇 Evening']].map(([k, l]) => h('button', { class: L.session === k ? 'on' : '', onclick: () => { L.session = k; render(); } }, l)));
  const search = h('input', { type: 'search', placeholder: 'Find customer (name or ID)', value: L.filter, oninput: (e) => { L.filter = e.target.value; draw(); } });
  v.append(h('div', { class: 'loc-head' }, h('h1', {}, admin ? 'Location Tracker' : 'Locations'),
      h('button', { class: 'pri map-btn', onclick: guard(() => openMap({ d, order, session: L.session })) }, h('span', { 'aria-hidden': 'true' }, '🗺️'), ' Map')),
    h('p', { class: 'sub' }, 'One-time setup. Step 1: mark the place where delivery starts. Step 2: go to each customer’s house and mark it. The saved locations are used for the delivery order and for the time customers see. Tap 🗺️ Map to see every house and the live cart during a delivery — customers never see the live location.'),
    h('div', { id: 'gps-banner' }),
    allDone ? h('div', { class: 'loc-done' }, '✅ Setup complete — all locations are saved. ', admin ? h('button', { class: 'link', onclick: () => { L.edit = !L.edit; render(); } }, L.edit ? '🔒 Done changing' : '✏️ Change saved locations') : null)
      : farm && admin ? h('div', { class: 'bar' }, h('button', { class: 'link', onclick: () => { L.edit = !L.edit; render(); } }, L.edit ? '🔒 Done changing' : '✏️ Change saved locations')) : null,
    h('div', { class: 'rcard loc-farm' + (farm ? '' : ' step-now') }, h('div', { class: 'step-no' }, 'Step 1'), h('div', { class: 'rname' }, '🏠 Start location (farm — where delivery starts)'),
      h('div', { class: 'tag ' + (farm ? 'good' : 'bad') }, farm ? `✓ Saved${farm.acc != null ? ' ±' + farm.acc + ' m' : ''}` : '⚠ Not marked yet — stand at the farm and tap the button'),
      !farm || L.edit ? h('div', { class: 'ract' }, h('button', { class: farm ? '' : 'pri', onclick: () => { if (farm && !confirm('Replace the start location with where you are standing now?')) return; mark('farm', 'Start location')(); } }, farm ? '📍 Re-mark start location' : '📍 Mark my start location here')) : null),
    h('div', { class: 'step-no', style: 'margin-top:4px' }, `Step 2 · Customer houses — ${doneN} of ${active.length} saved`),
    h('div', { class: 'loc-prog' }, h('div', { style: `width:${active.length ? Math.round(doneN / active.length * 100) : 0}%` })),
    !admin ? h('p', { class: 'tag' }, 'You can mark houses that are not saved yet, and change the order. To change a saved house, ask the admin.') : null,
    h('div', { class: 'bar' }, sessSeg,
      h('button', { class: 'pri', onclick: () => {
        const marked = order.filter((id) => has(byId.get(id)));
        if (marked.length < 2) return toast('Mark at least 2 customer locations first', true);
        if (!confirm(`Put the ${marked.length} marked customers in the shortest order${farm ? ' from the farm' : ''}? Unmarked customers stay at the end. You can still move anyone after.`)) return;
        const before = [...order];
        clearTimeout(saveT); // this save carries the order from before, so it can be put back
        order = [...autoOrder(marked.map((id) => byId.get(id)), farm).map((c) => c.id), ...order.filter((id) => !has(byId.get(id)))];
        guard(async () => { await api('locations/order', 'PUT', { session: L.session, ids: order, auto: true, prev: before }); toast('Auto order saved — tap “Go back to old order” to undo'); render(); })();
      } }, '⚡ Auto order (shortest path)'),
      prev ? h('button', { onclick: guard(async () => {
        if (!confirm('Go back to the order from before auto order? Any changes made after auto order will be lost.')) return;
        clearTimeout(saveT);
        await api('locations/undo-auto-order', 'PUT', { session: L.session }); toast('Old order is back'); render();
      }) }, '↩ Go back to old order') : null),
    prev ? h('p', { class: 'tag' }, `Auto order was used ${new Date(prev.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} by ${prev.by}. You can go back to the order from before it.`) : null,
    h('div', { class: 'bar' }, search), info, listBox);
  draw();
  // first visit: ask for the start location before anything else
  if (!farm) {
    const dlg = $('#dlg'); dlg.innerHTML = '';
    dlg.append(h('form', { class: 'form gps-help', method: 'dialog' }, h('h1', {}, '🏠 First, mark your start location'),
      h('p', {}, 'Stand at the farm (where delivery starts) and tap “Mark now”. This is done only once — after that, go to each customer’s house and mark it.'),
      h('p', { lang: 'ta', class: 'tag' }, 'முதலில் பண்ணையில் (டெலிவரி தொடங்கும் இடம்) நின்று “Mark now” தட்டுங்க. இது ஒரே ஒரு முறை தான்.'),
      h('div', { class: 'acts' }, h('button', { type: 'submit' }, 'Later'), h('button', { class: 'pri', type: 'button', onclick: () => { dlg.close(); mark('farm', 'Start location')(); } }, '📍 Mark now'))));
    dlg.showModal();
  }
  // GPS check on opening: warn straight away if location is blocked or the GPS is off
  const banner = $('#gps-banner');
  const warn = (kind) => { banner.innerHTML = ''; banner.append(h('div', { class: 'gps-warn' }, h('b', {}, { off: '📡 GPS is off — turn on Location on your phone', denied: '🔒 Location is blocked for this site', http: '🔐 Open the https:// link to use GPS', none: '📵 This browser has no GPS', slow: '⏳ GPS signal is weak' }[kind]),
    h('button', { onclick: () => gpsHelp(kind, check) }, 'How to fix'))); };
  const check = () => {
    if (!window.isSecureContext) return warn('http');
    if (!navigator.geolocation) return warn('none');
    const probe = () => navigator.geolocation.getCurrentPosition(() => { banner.innerHTML = ''; }, (e) => warn(e.code === 1 ? 'denied' : e.code === 2 ? 'off' : 'slow'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    if (navigator.permissions) navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'denied') warn('denied'); else if (p.state === 'granted') probe(); }, () => {}); // 'prompt': ask only when they tap Mark
  };
  check();
};

// ---------- Live map (admin + delivery only — customers never see anyone's live position) ----------
// Sharing: while a round is running (started, not paused, not finished), this phone sends its GPS every ~10 s.
// Delivery logins share by default; the admin turns it on from the map only when they go out delivering.
const LIVE = { watch: null, lastSent: 0, lastFix: null, recheck: null, wake: null, busy: false };
const shareOn = () => { let v = null; try { v = localStorage.getItem('grv.shareLive'); } catch {} return v == null ? S.user && S.user.role === 'delivery' : v === '1'; };
const setShare = (on) => { try { localStorage.setItem('grv.shareLive', on ? '1' : '0'); } catch {} if (on) liveKick(); else { liveStopGps(); clearTimeout(LIVE.recheck); api('live', 'DELETE').catch(() => {}); } };
const bearing = (a, b) => { const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r), x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r); return (Math.atan2(y, x) / r + 360) % 360; };
function liveStopGps() {
  if (LIVE.watch != null) navigator.geolocation.clearWatch(LIVE.watch); LIVE.watch = null;
  if (LIVE.wake) { LIVE.wake.release().catch(() => {}); LIVE.wake = null; }
}
const keepAwake = () => { if (LIVE.watch != null && !LIVE.wake && navigator.wakeLock && document.visibilityState === 'visible') navigator.wakeLock.request('screen').then((w) => { LIVE.wake = w; w.addEventListener('release', () => { if (LIVE.wake === w) LIVE.wake = null; }); }, () => {}); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); liveKick(); } });
function liveStartGps() {
  if (LIVE.watch != null) return;
  LIVE.watch = navigator.geolocation.watchPosition((p) => {
    const fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, heading: p.coords.heading };
    const now = Date.now(), prev = LIVE.lastFix;
    const moved = prev ? kmBetween(prev, fix) * 1000 : Infinity;
    if (now - LIVE.lastSent < 4000 || (now - LIVE.lastSent < 10000 && moved < 25) || LIVE.busy) return; // ~every 10 s, sooner when moving fast
    if (fix.heading == null || Number.isNaN(fix.heading)) fix.heading = prev && moved > 8 ? bearing(prev, fix) : prev ? prev.heading : null;
    LIVE.busy = true; LIVE.lastSent = now;
    api('live', 'PUT', fix).then((r) => { LIVE.lastFix = fix; if (!r.ok) { liveStopGps(); liveLater(); } }, () => {}).finally(() => { LIVE.busy = false; });
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  keepAwake();
}
const liveLater = () => { clearTimeout(LIVE.recheck); LIVE.recheck = setTimeout(liveKick, 30000); };
// is one of my rounds running? then start the GPS; otherwise look again in 30 s
function liveKick() {
  clearTimeout(LIVE.recheck);
  if (!S.user || !['admin', 'delivery'].includes(S.user.role) || !shareOn() || !window.isSecureContext || !navigator.geolocation) return liveStopGps();
  api('live').then((d) => {
    const mine = Object.entries(d.runs).some(([s, st]) => st === 'running' && (S.user.role === 'admin' || !S.user.shift || S.user.shift === 'BOTH' || S.user.shift === s));
    if (mine) liveStartGps(); else liveStopGps();
    liveLater();
  }, liveLater);
}

let leafletP = null;
const loadLeaflet = () => leafletP || (leafletP = new Promise((ok, fail) => {
  const base = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
  document.head.append(h('link', { rel: 'stylesheet', href: base + 'leaflet.min.css' }));
  const s = h('script', { src: base + 'leaflet.min.js' });
  s.onload = () => ok(window.L); s.onerror = () => { leafletP = null; s.remove(); fail(new Error('Map could not load — check the internet connection')); };
  document.head.append(s);
}));
// the maattu vandi (bullock cart) map marker, facing right; flipped to face left when going west
const CART_SVG = `<svg viewBox="0 0 66 42" width="66" height="42" aria-hidden="true">
  <rect x="3" y="15" width="27" height="9" rx="2" fill="#b0652f" stroke="#5b2e12" stroke-width="1.3"/>
  <rect x="6" y="6" width="7.5" height="10" rx="2.2" fill="#e3e7ea" stroke="#6b7680"/><rect x="15.5" y="6" width="7.5" height="10" rx="2.2" fill="#e3e7ea" stroke="#6b7680"/>
  <rect x="7.8" y="4" width="4" height="2.4" rx="1" fill="#9aa4ad"/><rect x="17.3" y="4" width="4" height="2.4" rx="1" fill="#9aa4ad"/>
  <line x1="29" y1="20" x2="45" y2="17.5" stroke="#5b2e12" stroke-width="2.2" stroke-linecap="round"/>
  <g class="cm-wheel"><circle cx="16" cy="30" r="9.5" fill="#fff8" stroke="#5b2e12" stroke-width="2.6"/><path d="M16 20.5v19M6.5 30h19M9.3 23.3l13.4 13.4M22.7 23.3 9.3 36.7" stroke="#5b2e12" stroke-width="1.3"/><circle cx="16" cy="30" r="2.2" fill="#5b2e12"/></g>
  <g class="cm-ox"><path d="M42 26v11M45.5 26.5v10.5M53.5 26.5v10.5M57 26v11" stroke="#6b5a45" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M40 21q-3 4-2 9" stroke="#6b5a45" stroke-width="1.4" fill="none"/>
  <ellipse class="ox-b" cx="49.5" cy="21" rx="10" ry="6.6" fill="#f4f0e6" stroke="#6b5a45" stroke-width="1.3"/><path class="ox-b" d="M43 15.5q3.5-5.5 7.5-1" fill="#f4f0e6" stroke="#6b5a45" stroke-width="1.3"/>
  <ellipse class="ox-b" cx="61" cy="17.5" rx="4.2" ry="3.6" fill="#f4f0e6" stroke="#6b5a45" stroke-width="1.3"/><circle cx="62" cy="16.7" r=".9" fill="#222"/>
  <path d="M59 14.6q-1.8-4.8 1.4-7.4M62.4 14.4q2.3-4.6-.2-7.6" stroke="#c0392b" stroke-width="1.8" fill="none" stroke-linecap="round"/></g></svg>`;
// Google / OSRM encoded polyline → [[lat, lng], …]
function decodePolyline(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, v = 0;
      do { b = str.charCodeAt(i++) - 63; v |= (b & 31) << shift; shift += 5; } while (b >= 32);
      const d = v & 1 ? ~(v >> 1) : v >> 1;
      if (k) lng += d; else lat += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
const agoText = (ms) => (ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + ' s ago' : Math.round(ms / 60000) + ' min ago');

// full-screen map: every marked house with its name, the farm, the delivery order line, and the live cart(s)
async function openMap({ d, order, session }) {
  let Lf; try { Lf = await loadLeaflet(); } catch (e) { return toast(e.message, true); }
  const byId = new Map(d.customers.map((c) => [c.id, c]));
  const has = (c) => c && c.lat != null;
  const pos = new Map(order.map((id, i) => [id, i + 1]));
  const status = h('div', { class: 'map-status' }, 'Looking for the delivery…');
  const shareBtn = h('button', { class: 'map-share' });
  const paintShare = () => {
    const on = shareOn(), ok = window.isSecureContext && !!navigator.geolocation;
    shareBtn.className = 'map-share' + (on && ok ? ' on' : '');
    shareBtn.textContent = !ok ? '📵 Live sharing needs the https link' : on ? '📡 Sharing my location: ON' : '📡 I’m delivering — share my location';
    shareBtn.disabled = !ok;
  };
  shareBtn.onclick = () => { const on = !shareOn(); if (!on && !confirm('Stop sharing your live location?')) return; setShare(on); paintShare(); toast(on ? 'Your live location shows while a round is running (keep the app open)' : 'Stopped sharing'); };
  paintShare();
  const box = h('div', { class: 'map-box' }), kmPill = h('span', { class: 'map-km', hidden: true });
  const recInfo = h('div', { class: 'map-rec', hidden: true }), recBtn = h('button', { class: 'map-recbtn' }); // admin's Record route (wired up further down)
  const undoBtn = h('button', {}, '↶ Undo to last house'), clearBtn = h('button', {}, '🗑 Clear & start again');
  const recTools = h('div', { class: 'map-acts rec-tools', hidden: true }, undoBtn, clearBtn);
  const rec = { watch: null, pts: [], t0: 0, line: null, wake: null, timer: null, piece: null, waitFor: null }; // piece: the house when recording only the piece to it; waitFor: after Undo, the house to go back to
  const close = (e) => {
    if (rec.watch != null && !(e && e.type === 'hashchange') && !confirm('Recording is on. Close the map and pause it? Your ride so far is kept — tap Record route again to continue.')) return;
    if (rec.watch != null) { stopGps(); saveDraft(); }
    clearInterval(poll); removeEventListener('hashchange', close); map.remove(); ov.remove(); document.body.classList.remove('map-open'); };
  let follow = null;
  const ov = h('div', { class: 'map-ov', role: 'dialog', 'aria-label': 'Delivery map' },
    h('div', { class: 'map-top' }, h('b', {}, '🗺️ Map'), h('span', { class: 'shift-pill' }, session === 'AM' ? '🌅 Morning' : '🌇 Evening'), kmPill, h('span', { class: 'grow' }),
      h('button', { class: 'map-x', 'aria-label': 'Close map', onclick: () => close() }, '✕')),
    box, status, S.user.role === 'admin' ? recInfo : null, S.user.role === 'admin' ? recTools : null,
    h('div', { class: 'map-acts' },
      h('button', { onclick: () => fitAll() }, '⤢ Show all'),
      h('button', { onclick: () => { const k = [...carts.keys()][0]; if (!k) return toast('No one is delivering right now', true); follow = k; map.setView(carts.get(k).m.getLatLng(), Math.max(map.getZoom(), 17)); toast('Following the cart — move the map to stop'); } }, '🐂 Follow cart'),
      h('button', { onclick: () => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => { const ll = [p.coords.latitude, p.coords.longitude]; meDot.setLatLng(ll).addTo(map); map.setView(ll, Math.max(map.getZoom(), 17)); }, (e) => gpsHelp(e.code === 1 ? 'denied' : e.code === 2 ? 'off' : 'slow'), { enableHighAccuracy: true, timeout: 15000 }) : gpsHelp('none') }, '📍 Me')),
    S.user.role === 'admin' ? recBtn : null, shareBtn);
  document.body.append(ov); document.body.classList.add('map-open');
  addEventListener('hashchange', close);

  const map = Lf.map(box, { zoomControl: true, attributionControl: true });
  // map style: Default (street map) or Satellite (Esri photo map with road and place names on top) — both free, no key; the choice is kept on this phone
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const styles = {
    def: [Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' })],
    sat: [Lf.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
      Lf.tileLayer(ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 }),
      Lf.tileLayer(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 })],
  };
  let style = 'def'; try { if (localStorage.getItem('grv.mapStyle') === 'sat') style = 'sat'; } catch {}
  const styleBtns = h('div', { class: 'map-style seg' }, [['def', '🗺️ Default'], ['sat', '🛰️ Satellite']].map(([k, l]) => h('button', { 'data-k': k, onclick: () => setStyle(k) }, l)));
  const setStyle = (k) => {
    for (const ly of styles[style]) map.removeLayer(ly);
    style = k; for (const ly of styles[k]) ly.addTo(map);
    box.classList.toggle('sat', k === 'sat');
    for (const b of styleBtns.children) b.classList.toggle('on', b.dataset.k === k);
    try { localStorage.setItem('grv.mapStyle', k); } catch {}
  };
  setStyle(style);
  Lf.DomEvent.disableClickPropagation(styleBtns); box.append(styleBtns);
  map.on('dragstart', () => { follow = null; });
  map.createPane('carts').style.zIndex = 700; // the cart sits above the house name labels
  const labelsBy = () => box.classList.toggle('far', map.getZoom() < 15); // names only when zoomed in enough to read them
  map.on('zoomend', labelsBy);
  const meDot = Lf.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 });
  const pts = [];
  if (d.farm) { const m = Lf.marker([d.farm.lat, d.farm.lng], { icon: Lf.divIcon({ className: '', html: '<div class="hm farm">🏠</div>', iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 500 }).addTo(map); m.bindTooltip('Farm (start)', { permanent: true, direction: 'top', offset: [0, -16], className: 'hm-lbl farm' }); pts.push([d.farm.lat, d.farm.lng]); }
  const line = d.farm ? [[d.farm.lat, d.farm.lng]] : [];
  for (const c of d.customers) {
    if (!has(c)) continue;
    const n = pos.get(c.id), qty = session === 'AM' ? c.am : c.pm;
    const m = Lf.marker([c.lat, c.lng], { icon: Lf.divIcon({ className: '', html: `<div class="hm${n ? '' : ' off'}">${n || ''}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: n ? 100 : 0 }).addTo(map);
    m.bindTooltip(c.name, { permanent: true, direction: 'top', offset: [0, -12], className: 'hm-lbl' + (n ? '' : ' off') });
    const pop = h('div', { class: 'hm-pop' }, h('b', {}, c.name), h('div', { class: 'tag' }, `${c.id}` + (n ? ` · stop ${n} · ${lit(qty)} L` : ' · no milk this session')),
      h('a', { class: 'btn', href: `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`, target: '_blank', rel: 'noopener' }, '🧭 Directions'));
    const pieceSlot = h('div');
    pop.append(pieceSlot);
    m.bindPopup(pop, { autoPanPaddingTopLeft: [12, 64], autoPanPaddingBottomRight: [12, 60] }); // keep the pop-up clear of the map buttons
    m.on('popupopen', () => { pieceSlot.replaceChildren(...[pieceInfo(c)].filter(Boolean)); m.getPopup().update(); }); // re-fit, so the taller pop-up is panned into view
    pts.push([c.lat, c.lng]);
  }
  for (const id of order) { const c = byId.get(id); if (has(c)) line.push([c.lat, c.lng]); }
  // straight dashed line first, then the real road route (OSRM) replaces it once it arrives; if it can't be had, the dashed line stays
  // two route lines: 'road' (road map, OSRM; straight dashed line until it loads) and 'learned' (the admin's recorded ride). A switch picks one; kept on this phone.
  const roadLy = Lf.layerGroup(), learnLy = Lf.layerGroup(), routeKm = { road: null, learned: null };
  const casing = (ll, color, ly) => { Lf.polyline(ll, { color: '#fff', weight: 8, opacity: .9 }).addTo(ly); Lf.polyline(ll, { color, weight: 5, opacity: .9 }).addTo(ly); }; // white edge shows on the satellite photo too
  if (line.length > 1) Lf.polyline(line, { color: '#1c7a44', weight: 3, opacity: .55, dashArray: '6 8' }).addTo(roadLy);
  let mode = 'learned'; try { if (localStorage.getItem('grv.routeMode') === 'road') mode = 'road'; } catch {}
  const routeBtns = h('div', { class: 'map-route seg', hidden: true }, [['learned', '✋ Learned'], ['road', '🛣️ Road map']].map(([k, l]) => h('button', { 'data-k': k, onclick: () => { try { localStorage.setItem('grv.routeMode', k); } catch {} setMode(k); } }, l)));
  Lf.DomEvent.disableClickPropagation(routeBtns); box.append(routeBtns);
  // once a route is recorded only the blue line shows (the green road-map line would only confuse); while recording the whole route, only the red line shows
  const setMode = () => {
    const k = learnLy.getLayers().length ? 'learned' : 'road', recording = rec.watch != null;
    routeBtns.hidden = true;
    map.removeLayer(roadLy); map.removeLayer(learnLy);
    if (!(recording && !rec.piece)) (k === 'road' ? roadLy : learnLy).addTo(map);
    for (const b of routeBtns.children) b.classList.toggle('on', b.dataset.k === k);
    const km = routeKm[k]; kmPill.hidden = km == null; kmPill.textContent = `${k === 'road' ? '🛣️' : '✋'} ${km} km`; kmPill.title = k === 'road' ? 'Distance by road map' : 'Distance of the recorded ride';
  };
  let learned = null; // latest recorded route: { pts, km, pieces, status: { 'lat,lng': 'on' | 'rode' | 'road' | 'straight' } }
  const drawLearned = (l) => {
    learned = l; learnLy.clearLayers();
    if (!l || !l.pts || l.pts.length < 2) { routeKm.learned = null; return; }
    casing(l.pts, '#1d4ed8', learnLy); routeKm.learned = l.km;
    for (const pc of l.pieces || []) { // side pieces to houses off the ride: ridden = solid, joined by road map = dashed
      if (pc.kind === 'rode') casing(pc.pts, '#1d4ed8', learnLy);
      else { Lf.polyline(pc.pts, { color: '#fff', weight: 7, opacity: .8 }).addTo(learnLy); Lf.polyline(pc.pts, { color: '#1d4ed8', weight: 4, opacity: .9, dashArray: '7 8' }).addTo(learnLy); }
    }
  };
  const reloadLearned = () => api('learned?session=' + session).then((l) => { if (!box.isConnected) return; drawLearned(l); setMode(mode); }, () => {});
  const keyOf = (c) => `${(+c.lat).toFixed(6)},${(+c.lng).toFixed(6)}`;
  // inside a house's pop-up: where it stands on the recorded route, and (admin) Record this piece
  const pieceInfo = (c) => {
    const st = learned && learned.status ? learned.status[keyOf(c)] : null;
    if (!learned) return null;
    const txt = { on: '✋ On the recorded route', rode: '✋ Joined by a recorded piece', road: '┄ Joined to the route by the road map (dashed)', straight: '┄ Joined by a straight line (road map not available)' }[st] || '… Joining to the route — open the map again in a moment';
    return h('div', { class: 'hm-piece' }, h('div', { class: 'tag' }, txt),
      S.user.role === 'admin' && st && st !== 'on' && rec.watch == null ? h('button', { class: 'map-recbtn', onclick: () => { map.closePopup(); startRec(false, c); } }, st === 'rode' ? '🔴 Record this piece again' : '🔴 Record this piece') : null);
  };
  setMode(mode);
  if (line.length > 1) api('road', 'POST', { session, ids: order }).then((r) => {
    if (!r.ok || !r.poly.length || !box.isConnected) { if (!r.ok) toast('Road route could not load — showing straight lines', true); return; }
    roadLy.clearLayers(); casing(r.poly.map(decodePolyline), '#1c7a44', roadLy); routeKm.road = r.km; setMode(mode);
  }, () => {});
  reloadLearned();

  // 🔴 Record route (admin only): ride the round once with the phone; the ride becomes the 'learned' route.
  // The ride so far is kept on the phone, so a reload or a closed map can continue it.
  const draftKey = 'grv.recDraft.' + session;
  const recKm = () => { let k = 0; for (let i = 1; i < rec.pts.length; i++) k += kmBetween({ lat: rec.pts[i - 1][0], lng: rec.pts[i - 1][1] }, { lat: rec.pts[i][0], lng: rec.pts[i][1] }); return k; };
  const saveDraft = () => { if (rec.piece) return; try { localStorage.setItem(draftKey, JSON.stringify({ pts: rec.pts, t0: rec.t0 })); } catch {} };
  const dropDraft = () => { if (!rec.piece) try { localStorage.removeItem(draftKey); } catch {} if (rec.line) rec.line.remove(); rec.line = null; rec.pts = []; rec.piece = null; paintRec(); };
  const paintRec = () => {
    const on = rec.watch != null;
    setMode();
    recBtn.textContent = on ? (rec.piece ? '⏹ Stop & save piece' : '⏹ Stop & save route') : '🔴 Record route (ride the round once)'; recBtn.classList.toggle('on', on);
    recInfo.hidden = !on; recTools.hidden = !on; recInfo.classList.toggle('wait', !!rec.waitFor);
    const weak = rec.weak ? ' ⏳ Weak GPS — waiting for signal…' : '';
    if (on && rec.waitFor) recInfo.replaceChildren(h('div', {}, `⏸ Go back to ${rec.waitFor.name} — recording carries on from there when you reach it.${weak}`),
      h('button', { class: 'link', onclick: () => { rec.waitFor = null; paintRec(); toast('Recording from here'); } }, '▶ Continue from where I am now'));
    else if (on) recInfo.textContent = (rec.piece ? `🔴 Piece to ${rec.piece.name}` : '🔴 Recording') + ` · ${distText(recKm())} · ${dur((Date.now() - rec.t0) / 60000)}` + (weak || ' — keep the app open');
  };
  const stopGps = () => {
    if (rec.watch != null) navigator.geolocation.clearWatch(rec.watch); rec.watch = null; clearInterval(rec.timer); clearTimeout(rec.retry); rec.weak = false;
    if (rec.wake) { rec.wake.release().catch(() => {}); rec.wake = null; }
  };
  const startRec = (resume, house) => {
    if (!window.isSecureContext) return gpsHelp('http'); if (!navigator.geolocation) return gpsHelp('none');
    if (!resume) rec.waitFor = null;
    if (house) { rec.piece = house; rec.pts = []; rec.t0 = Date.now(); }
    else if (!resume) {
      rec.piece = null;
      let draft = null; try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null'); } catch {}
      rec.pts = draft && draft.pts && draft.pts.length > 1 ? draft.pts : [];
      if (rec.pts.length && confirm(`Continue the ride you recorded earlier (${distText(recKm())})? Cancel starts a new recording.`)) rec.t0 = draft.t0 || Date.now();
      else { rec.pts = []; rec.t0 = Date.now(); }
    }
    if (rec.line) rec.line.remove();
    rec.line = Lf.polyline(rec.pts, { color: '#dc2626', weight: 5, opacity: .9 }).addTo(map);
    const onFix = (p) => {
      rec.weak = false;
      if (p.coords.accuracy > 35) return; // a weak fix would draw zig-zags
      const pt = [+p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6)], last = rec.pts[rec.pts.length - 1];
      if (rec.waitFor) { // after Undo: nothing is drawn until you are back at that house
        if (kmBetween(rec.waitFor, { lat: pt[0], lng: pt[1] }) > LEARN_NEAR) return;
        toast(`Back at ${rec.waitFor.name} — recording again`); rec.waitFor = null; paintRec();
      }
      if (last && kmBetween({ lat: last[0], lng: last[1] }, { lat: pt[0], lng: pt[1] }) < 0.008) return; // keep a point every ~8 m
      rec.pts.push(pt); rec.line.addLatLng(pt); if (rec.pts.length % 5 === 0) saveDraft(); paintRec();
    };
    // a weak signal for a moment (trees, narrow lanes) must not end the ride — only a blocked permission stops it; the GPS is restarted, as some phones stop sending after an error
    const onErr = (e) => {
      if (e.code === 1) { stopGps(); saveDraft(); paintRec(); return gpsHelp('denied'); }
      rec.weak = true; paintRec();
      clearTimeout(rec.retry); rec.retry = setTimeout(() => { if (rec.watch == null) return; navigator.geolocation.clearWatch(rec.watch); rec.watch = navigator.geolocation.watchPosition(onFix, onErr, gpsOpts); }, 3000);
    };
    const gpsOpts = { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 };
    rec.watch = navigator.geolocation.watchPosition(onFix, onErr, gpsOpts);
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then((w) => { rec.wake = w; }, () => {});
    rec.timer = setInterval(paintRec, 15000);
    paintRec(); if (!resume) toast(rec.piece ? `Start on the blue route, ride to ${rec.piece.name}’s gate, then tap Stop` : 'Recording — ride the round in your usual order');
  };
  const stopRec = () => {
    stopGps(); saveDraft(); paintRec();
    const km = recKm(), min = (Date.now() - rec.t0) / 60000;
    const dlg = $('#dlg'); dlg.innerHTML = '';
    const save = guard(async () => {
      const r = await api('learned', 'PUT', { session, pts: rec.pts, minutes: min });
      dlg.close();
      const pts = rec.pts; dropDraft();
      drawLearned({ pts, km: r.km }); try { localStorage.setItem('grv.routeMode', 'learned'); } catch {} setMode('learned');
      toast(`Route saved — ${r.km} km, passes ${r.passed} marked places`);
    });
    const keep = h('button', { type: 'button', onclick: () => { dlg.close(); startRec(true); } }, 'Keep recording');
    const discard = h('button', { type: 'button', onclick: () => { if (!confirm('Throw away this recording?')) return; dlg.close(); dropDraft(); } }, 'Discard');
    if (rec.piece) { // just the piece from the blue route to one house
      const house = rec.piece;
      const savePiece = guard(async () => {
        const r = await api('learned/piece', 'PUT', { session, cid: house.id, pts: rec.pts });
        dlg.close(); dropDraft(); await reloadLearned(); setMode('learned');
        toast(`Piece to ${house.name} saved — ${distText(r.km)}` + (r.sessions > 1 ? ' (morning and evening routes)' : ''));
      });
      dlg.append(h('form', { class: 'form gps-help', method: 'dialog' }, h('h1', {}, rec.pts.length < 2 ? 'Recording too short' : `✋ Save the piece to ${house.name}?`),
        h('p', {}, rec.pts.length < 2 ? 'Start on the blue route and ride to the house gate, then tap Stop.' : `${distText(km)} · ${dur(min)}. It replaces the dashed line to this house.`),
        h('div', { class: 'acts' }, discard, keep, rec.pts.length < 2 ? null : h('button', { class: 'pri', type: 'button', onclick: savePiece }, '✓ Save piece'))));
    } else if (rec.pts.length < 10 || km < 0.1) dlg.append(h('form', { class: 'form gps-help', method: 'dialog' }, h('h1', {}, 'Recording too short'), h('p', {}, 'Ride the whole round with the app open, then tap Stop & save.'), h('div', { class: 'acts' }, discard, keep)));
    else dlg.append(h('form', { class: 'form gps-help', method: 'dialog' }, h('h1', {}, '✋ Save this route?'),
      h('p', {}, `${distText(km)} · ${dur(min)}. It becomes the ${session === 'AM' ? 'morning' : 'evening'} route on the map for admin and delivery, and its distances are used for customers’ times.` + (routeKm.learned != null ? ' It replaces the route recorded before.' : '')),
      h('div', { class: 'acts' }, discard, keep, h('button', { class: 'pri', type: 'button', onclick: save }, '✓ Save route'))));
    dlg.showModal();
  };
  // ↶ Undo: rub the red line out back to the last house the ride passed (again = one house further back), then carry on from that house
  const LEARN_NEAR = 0.08; // same 80 m the server uses to count a house as passed
  const places = () => [d.farm ? { lat: d.farm.lat, lng: d.farm.lng, name: 'the farm' } : null, ...d.customers.filter(has).map((c) => ({ lat: c.lat, lng: c.lng, name: c.name }))].filter(Boolean);
  const clearRec = () => {
    if (!confirm(rec.piece ? 'Erase this piece and start again from where you are now?' : 'Erase the whole recording and start again from where you are now?')) return;
    rec.pts = []; rec.waitFor = null; rec.t0 = Date.now(); if (rec.line) rec.line.setLatLngs([]); saveDraft(); paintRec(); toast('Cleared — recording again from here');
  };
  undoBtn.onclick = () => {
    if (rec.piece || rec.pts.length < 2) return clearRec();
    const end = rec.waitFor ? rec.pts.length - 1 : rec.pts.length - 2; // waiting at a house already: go one house further back
    let best = null;
    for (const pl of places()) { // where the ride came closest to each place, if within 80 m; the latest one before the end wins
      let bi = -1, bd = LEARN_NEAR;
      for (let i = 0; i < end; i++) { const dd = kmBetween(pl, { lat: rec.pts[i][0], lng: rec.pts[i][1] }); if (dd < bd) { bd = dd; bi = i; } }
      if (bi >= 0 && (!best || bi > best.i)) best = { i: bi, pl };
    }
    if (!best) return clearRec(); // not past any house yet
    if (!confirm(`Erase the red line back to ${best.pl.name}?`)) return;
    rec.pts = rec.pts.slice(0, best.i + 1); rec.line.setLatLngs(rec.pts);
    rec.waitFor = best.pl; saveDraft(); paintRec();
    toast(`Erased back to ${best.pl.name} — go there to carry on`);
  };
  clearBtn.onclick = clearRec;
  recBtn.onclick = () => (rec.watch != null ? stopRec() : startRec());
  paintRec();
  const fitAll = () => { const all = [...pts, ...[...carts.values()].map((x) => x.m.getLatLng())]; if (all.length > 1) map.fitBounds(all, { padding: [40, 40], maxZoom: 17 }); else if (all.length) map.setView(all[0], 16); else map.setView([11.0, 78.5], 7); };
  // live carts: glide smoothly to each new position (like food-delivery apps) instead of jumping
  const carts = new Map();
  const glide = (x, to) => {
    const from = x.m.getLatLng(), t0 = performance.now(), dur = 1500;
    cancelAnimationFrame(x.raf);
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = k * (2 - k); x.m.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]); if (follow === x.key) map.panTo(x.m.getLatLng(), { animate: false }); if (k < 1) x.raf = requestAnimationFrame(step); };
    x.raf = requestAnimationFrame(step);
  };
  // delivery: green frame, white ox · admin: orange frame, brown ox and a 👑
  const cartHtml = (p, d0) => { const adm = p.key.startsWith('live_admin'); return `<div class="cm${adm ? ' admin' : ''}${p.heading != null && p.heading > 180 ? ' west' : ''}"><div class="cm-pulse"></div><div class="cm-body">${CART_SVG}</div><div class="cm-lbl">${adm ? '👑 ' : ''}${p.key === d0.me ? 'You' : p.who} · ${agoText(d0.now - p.at)}</div></div>`; };
  let firstFit = true;
  const refresh = () => api('live').then((r) => {
    const seen = new Set();
    for (const p of r.people) {
      seen.add(p.key);
      let x = carts.get(p.key);
      const icon = Lf.divIcon({ className: '', html: cartHtml(p, r), iconSize: [80, 56], iconAnchor: [40, 65] });
      if (!x) { x = { key: p.key, m: Lf.marker([p.lat, p.lng], { icon, pane: 'carts' }).addTo(map), raf: 0 }; carts.set(p.key, x); }
      else { x.m.setIcon(icon); const ll = x.m.getLatLng(); if (ll.lat !== p.lat || ll.lng !== p.lng) glide(x, [p.lat, p.lng]); }
    }
    for (const [k, x] of carts) if (!seen.has(k)) { cancelAnimationFrame(x.raf); x.m.remove(); carts.delete(k); }
    const st = r.runs[session], name = session === 'AM' ? 'Morning' : 'Evening';
    status.className = 'map-status' + (r.people.length ? ' on' : '');
    status.textContent = r.people.length ? `🟢 ${r.people.map((p) => (p.key === r.me ? 'You' : p.who) + ' — seen ' + agoText(r.now - p.at)).join(' · ')}`
      : st === 'running' ? `🟢 ${name} delivery is running — waiting for the delivery phone’s GPS (its app must be open with sharing on)`
        : st === 'paused' ? `⏸ ${name} delivery is paused — the cart shows again when it resumes`
          : st === 'finished' ? `✓ ${name} delivery finished` : `${name} delivery not started — the cart shows here once it starts`;
    if (firstFit && r.people.length) { firstFit = false; fitAll(); }
  }, () => { status.textContent = '⚠ Could not get the live position — check the internet'; });
  fitAll(); labelsBy(); refresh();
  const poll = setInterval(refresh, 5000);
  setTimeout(() => map.invalidateSize(), 50);
}

// ---------- customer portal ----------
// "Your milk will arrive between 6:00 and 6:15 PM" — shown once today's delivery is started; checks again every 30 s
let etaTimer = null;
// an uncle driving a maattu vandi (bullock cart) loaded with milk cans along the road: wheels turn, the ox walks, the road slides by
function cartScene() {
  const el = h('div', { class: 'cart-scene', 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 320 110" preserveAspectRatio="xMidYMax slice">
    <g class="cs-hills"><path d="M0 78 q40 -26 80 -6 q40 -24 90 -4 q50 -22 90 -2 q30 -12 60 -4 v18 h-320z" fill="#bfe3c9"/></g>
    <g class="cs-sun"><circle cx="34" cy="22" r="11" fill="#ffd66b"/></g>
    <rect x="0" y="88" width="320" height="22" fill="#d9c7a3"/>
    <g class="cs-road"><path d="M0 98 h22 M44 98 h22 M88 98 h22 M132 98 h22 M176 98 h22 M220 98 h22 M264 98 h22 M308 98 h22 M352 98 h22" stroke="#fff6e0" stroke-width="3" stroke-linecap="round"/></g>
    <g class="cs-rig">
      <g class="cs-bob">
        <!-- cart: bed, side rails, pole to the yoke -->
        <path d="M150 64 L214 58" stroke="#7a4a22" stroke-width="4" stroke-linecap="round"/>
        <rect x="58" y="58" width="96" height="9" rx="2" fill="#a0612e"/>
        <path d="M60 58 v-10 M152 58 v-10 M60 48 h92" stroke="#7a4a22" stroke-width="3" stroke-linecap="round"/>
        <!-- milk cans -->
        <g fill="#cfd8dc" stroke="#78909c" stroke-width="1.5">
          <path d="M68 58 v-20 q0 -5 5 -6 h8 q5 1 5 6 v20z"/><rect x="72" y="27" width="10" height="6" rx="1.5"/>
          <path d="M90 58 v-20 q0 -5 5 -6 h8 q5 1 5 6 v20z"/><rect x="94" y="27" width="10" height="6" rx="1.5"/>
        </g>
        <path d="M68 44 h18 M90 44 h18" stroke="#90a4ae" stroke-width="1.5"/>
        <!-- uncle: veshti, white shirt, orange turban, big moustache, holding the reins -->
        <path d="M122 58 q2 -12 12 -12 q10 0 12 12z" fill="#fafafa" stroke="#cfcfcf"/>
        <path d="M126 46 q1 -16 10 -16 q9 0 10 16z" fill="#ffffff" stroke="#d8d8d8"/>
        <circle cx="136" cy="22" r="8" fill="#a8693f"/>
        <path d="M127 18 q9 -10 18 0 q-2 -5 -9 -5 q-7 0 -9 5z" fill="#f08a24"/><path d="M127 18 h18" stroke="#d56f12" stroke-width="2"/>
        <path d="M131 26 q5 3 10 0" stroke="#2b1a10" stroke-width="2.4" fill="none" stroke-linecap="round"/>
        <circle cx="139" cy="21" r="1.1" fill="#2b1a10"/>
        <path d="M144 38 q14 2 26 -4" stroke="#a8693f" stroke-width="3.2" fill="none" stroke-linecap="round"/>
        <path d="M170 34 Q195 30 232 38" stroke="#5d3a1a" stroke-width="1.2" fill="none"/>
      </g>
      <!-- wheel -->
      <g class="cs-wheel" style="transform-origin:96px 72px">
        <circle cx="96" cy="72" r="17" fill="none" stroke="#6b3f1d" stroke-width="4"/>
        <path d="M96 55 v34 M79 72 h34 M84 60 l24 24 M108 60 l-24 24" stroke="#6b3f1d" stroke-width="2.4"/>
        <circle cx="96" cy="72" r="3.5" fill="#6b3f1d"/>
      </g>
      <!-- ox: legs walk, head nods, tail swings -->
      <g class="cs-ox">
        <g class="cs-leg l1" style="transform-origin:204px 60px"><path d="M204 60 v26" stroke="#e7e1d6" stroke-width="5" stroke-linecap="round"/><path d="M204 86 h3" stroke="#3a2a20" stroke-width="5" stroke-linecap="round"/></g>
        <g class="cs-leg l2" style="transform-origin:214px 60px"><path d="M214 60 v26" stroke="#f5f1ea" stroke-width="5" stroke-linecap="round"/><path d="M214 86 h3" stroke="#3a2a20" stroke-width="5" stroke-linecap="round"/></g>
        <g class="cs-leg l2" style="transform-origin:244px 60px"><path d="M244 60 v26" stroke="#e7e1d6" stroke-width="5" stroke-linecap="round"/><path d="M244 86 h3" stroke="#3a2a20" stroke-width="5" stroke-linecap="round"/></g>
        <g class="cs-leg l1" style="transform-origin:254px 60px"><path d="M254 60 v26" stroke="#f5f1ea" stroke-width="5" stroke-linecap="round"/><path d="M254 86 h3" stroke="#3a2a20" stroke-width="5" stroke-linecap="round"/></g>
        <path class="cs-tail" style="transform-origin:198px 50px" d="M198 50 q-8 8 -6 22" stroke="#d9d2c5" stroke-width="2.5" fill="none" stroke-linecap="round"/>
        <ellipse cx="228" cy="52" rx="32" ry="15" fill="#f5f1ea" stroke="#d9d2c5" stroke-width="1.5"/>
        <path d="M236 38 q6 -8 12 0" fill="#f5f1ea" stroke="#d9d2c5" stroke-width="1.5"/>
        <path d="M212 40 L218 66" stroke="#7a4a22" stroke-width="3" stroke-linecap="round"/>
        <g class="cs-head" style="transform-origin:256px 46px">
          <path d="M254 44 q10 -6 18 2 q6 8 4 16 q-6 4 -12 0 q-8 -6 -10 -18z" fill="#f5f1ea" stroke="#d9d2c5" stroke-width="1.5"/>
          <path d="M260 40 q-4 -10 -10 -12 M268 41 q4 -10 11 -11" stroke="#c9a86a" stroke-width="3.2" fill="none" stroke-linecap="round"/>
          <path d="M260 40 q-4 -10 -10 -12 M268 41 q4 -10 11 -11" stroke="#e85d75" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-dasharray="3 9"/>
          <circle cx="268" cy="50" r="1.4" fill="#2b1a10"/>
          <ellipse cx="272" cy="60" rx="5" ry="3.5" fill="#e9b7a9"/>
          <circle cx="262" cy="58" r="2.4" fill="#f2c230" stroke="#c99a1e" stroke-width=".8"/>
        </g>
      </g>
    </g>
  </svg>`;
  return el;
}
function etaCard() {
  const box = h('div', { class: 'eta-card', hidden: true });
  clearInterval(etaTimer);
  const load = (first) => {
    if (!first && !box.isConnected) { clearInterval(etaTimer); return; } // the page moved on
    api('portal/eta').then((e) => {
      box.innerHTML = '';
      if (e.state === 'none') { box.hidden = true; return; }
      const when = sessionName(e.session), win = `${clock(e.from)} – ${clock(e.to)}`;
      box.hidden = false; box.className = 'eta-card ' + e.state;
      if (e.state === 'finished') box.append(h('div', { class: 'eta-l' }, tr(`✓ Today’s ${when.toLowerCase()} delivery is finished`, `✓ இன்னைக்கு ${when} டெலிவரி முடிஞ்சது`, `✓ आज की ${when} की डिलीवरी हो गई`)), h('div', { class: 'tag' }, tr('Thank you! 🥛', 'நன்றி! 🥛', 'शुक्रिया! 🥛')));
      else box.append(cartScene(), h('div', { class: 'eta-l' }, tr(`Your ${when.toLowerCase()} milk will arrive between`, `உங்க ${when} பால் இந்த நேரத்துக்குள்ள வந்துடும்`, `आपका ${when} का दूध इस समय के बीच आएगा`)), h('div', { class: 'eta-t' }, win),
        langOn() === 'en' ? h('div', { class: 'tag', lang: 'ta' }, `உங்க பால் ${win} க்குள் வரும்`) : null, h('div', { class: 'tag' }, tr('Approximate time', 'சுமார் இந்த நேரம்', 'लगभग इसी समय')));
    }, () => {});
  };
  load(true); etaTimer = setInterval(() => load(false), 30000);
  return box;
}
// Big round buttons that always show every choice. If nothing is picked the whole box turns red,
// so a customer who can't read well still sees what is missing.
function choices(title, opts) {
  const name = 'ch' + Math.random().toString(36).slice(2);
  const box = h('fieldset', { class: 'choices' }, h('legend', {}, title),
    opts.map(([v, l]) => h('label', { class: 'choice' }, h('input', { type: 'radio', name, value: v, onchange: () => box.classList.remove('missing') }), h('span', {}, l))),
    h('div', { class: 'miss-msg' }, tr('⚠ Choose one', '⚠ ஏதாவது ஒன்னு செலக்ட் பண்ணுங்க', '⚠ कोई एक चुनें')));
  Object.defineProperty(box, 'value', { get: () => box.querySelector('input:checked')?.value || '' });
  box.need = () => {
    if (box.value) return true;
    box.classList.remove('missing'); void box.offsetWidth; box.classList.add('missing'); // restart the shake
    box.scrollIntoView({ block: 'center', behavior: 'smooth' }); toast(title + tr(': choose one', ': ஒன்னு செலக்ட் பண்ணுங்க', ': कोई एक चुनें'), true);
    return false;
  };
  return box;
}
const P = { month: null, tab: 'bill' };
// ---------- Diwali greeting: customers only, shows by itself between these dates, then the pages go back to normal ----------
const DIWALI = { from: '2026-11-01', day: '2026-11-08', to: '2026-11-09' };
const isDiwali = () => today() >= DIWALI.from && today() <= DIWALI.to;
const diwaliDaysLeft = () => (Date.parse(DIWALI.day) - Date.parse(today())) / 864e5;
// before the day: a countdown; on the day: the wishes; the day after: thanks
const diwaliWords = () => {
  const n = diwaliDaysLeft();
  if (n > 0) return { title: 'Diwali is coming!', ta: 'தீபாவளி வருகிறது!', count: `${n} ${n === 1 ? 'day' : 'days'} to go · இன்னும் ${n} ${n === 1 ? 'நாள்' : 'நாட்கள்'}`,
    msg: 'The festival of lights is almost here. Have your milk, ghee and sweets ready with GRV Dairy.', msgTa: 'ஒளியின் திருநாள் நெருங்கிவிட்டது.' };
  if (n === 0) return { title: 'Happy Diwali!', ta: 'இனிய தீபாவளி நல்வாழ்த்துகள்!',
    msg: 'May your home shine with light, joy and sweetness. Thank you for being part of the GRV Dairy family.', msgTa: 'உங்கள் இல்லம் ஒளியும் மகிழ்ச்சியும் இனிமையும் நிறைந்து விளங்கட்டும்.' };
  return { title: 'Hope you had a wonderful Diwali!', ta: 'தீபாவளி மகிழ்ச்சியாக அமைந்திருக்கும் என நம்புகிறோம்!', small: true,
    msg: 'Thank you for celebrating with GRV Dairy.', msgTa: 'எங்களுடன் கொண்டாடியதற்கு நன்றி.' };
};
const DIYA = `<svg class="dw-diya" viewBox="0 0 64 64" aria-hidden="true">
  <g class="dw-flame"><path d="M32 4c8 11 11 16 11 22a11 11 0 0 1-22 0c0-6 3-11 11-22z" fill="#ffb020"/><path d="M32 16c4 6 6 9 6 12a6 6 0 0 1-12 0c0-3 2-6 6-12z" fill="#fff1a8"/></g>
  <ellipse cx="32" cy="39" rx="27" ry="5" fill="#f2b544"/><path d="M5 39c2 12 13 20 27 20s25-8 27-20c-6 4-16 5-27 5s-21-1-27-5z" fill="#c8501e"/></svg>`;
function diwaliPoster() {
  const rangoli = h('div', { class: 'dw-rangoli' });
  rangoli.innerHTML = `<svg viewBox="-50 -50 100 100" aria-hidden="true">${Array.from({ length: 12 }, (_, i) => `<g transform="rotate(${i * 30})"><path d="M0 -10C7 -20 7 -32 0 -46C-7 -32 -7 -20 0 -10z" fill="none" stroke="#f2b544" stroke-width="1"/><circle cy="-40" r="1.6" fill="#ff8a3d"/></g>`).join('')}<circle r="7" fill="none" stroke="#f2b544" stroke-width="1"/></svg>`;
  const diyas = h('div', { class: 'dw-diyas' }); diyas.innerHTML = DIYA + DIYA + DIYA;
  const w = diwaliWords();
  return h('section', { class: 'diwali-poster', 'aria-label': w.title + ' From GRV Dairy' }, rangoli,
    Array.from({ length: 10 }, (_, i) => h('i', { class: 'dw-star', style: `left:${6 + i * 9.6}%;top:${8 + ((i * 37) % 70)}%;animation-delay:${(i * 0.37).toFixed(2)}s` })),
    h('div', { class: 'dw-title' + (w.small ? ' small' : '') }, w.title), h('div', { class: 'dw-tamil' }, w.ta), w.count ? h('div', { class: 'dw-count' }, w.count) : null, diyas,
    h('p', { class: 'dw-msg' }, w.msg), h('p', { class: 'dw-msg ta' }, w.msgTa),
    h('div', { class: 'dw-sign' }, h('img', { src: 'logo.png', alt: '' }), 'With love, GRV Dairy'));
}
// fireworks on the day and the day after, once per visit; they never block taps and clear themselves
let diwaliSkyDay = null;
function diwaliFireworks() {
  if (diwaliDaysLeft() > 0 || diwaliSkyDay === today()) return;
  diwaliSkyDay = today();
  const colors = ['#ffb020', '#ff5d73', '#7be0a4', '#7cc4ff', '#fff1a8'];
  const sky = h('div', { class: 'diwali-sky', 'aria-hidden': 'true' }, Array.from({ length: 9 }, (_, b) => h('div', { class: 'dw-burst', style: `left:${10 + Math.random() * 80}%;top:${8 + Math.random() * 50}%;--c:${colors[b % colors.length]}` },
    Array.from({ length: 14 }, (_, i) => h('i', { style: `--a:${i * 360 / 14}deg;animation-delay:${(b * 0.55).toFixed(2)}s` })))));
  document.body.append(sky); setTimeout(() => sky.remove(), 7000);
}
pages.portal = async (v) => {
  const d = await api('portal' + (P.month ? '?month=' + P.month : ''));
  P.month = d.month;
  const nameForm = (first) => {
    const yourName = tr('Your name', 'உங்க பேரு', 'आपका नाम');
    const i = h('input', { type: 'text', placeholder: yourName, maxlength: 60, required: true, value: d.customer.name, autocomplete: 'name' });
    return h('form', { class: 'form card', style: first ? 'border-color:var(--brand);margin-bottom:12px' : '', onsubmit: guard(async (e) => { e.preventDefault(); await api('portal/name', 'PUT', { name: i.value }); toast(tr('Name saved', 'பேரு சேவ் ஆயிடுச்சு', 'नाम सेव हो गया')); again(); }) },
      h('h2', { style: 'margin-top:0' }, first ? tr('Welcome! What is your name?', 'வணக்கம்! உங்க பேரு என்ன?', 'नमस्ते! आपका नाम क्या है?') : tr('Name on my bill', 'பில்ல வர்ற பேரு', 'बिल पर मेरा नाम')),
      h('p', { class: 'tag' }, tr('This is the name printed on your milk bill. You can change it any time.', 'இந்த பேரு தான் உங்க பால் பில்ல வரும். எப்ப வேணாலும் மாத்திக்கலாம்.', 'यही नाम आपके दूध के बिल पर आएगा। इसे कभी भी बदल सकते हैं।')),
      h('label', {}, yourName, i), h('button', { class: 'pri', type: 'submit' }, tr('Save name', 'பேரை சேவ் பண்ணுங்க', 'नाम सेव करें')));
  };
  const again = () => { v.innerHTML = ''; pages.portal(v).catch((e) => v.append(h('p', { class: 'bad' }, e.message))); };
  if (isDiwali()) { v.append(diwaliPoster()); diwaliFireworks(); }
  // big tabs with an icon over the word, so they are easy to spot even for someone who doesn't read well
  const tabs = h('div', { class: 'seg ptabs', role: 'tablist' }, [['bill', '🧾', tr('My bill', 'என் பில்', 'मेरा बिल')], ['skip', '🚫', tr('No milk', 'பால் வேண்டாம்', 'दूध नहीं चाहिए')], ['shop', '🛒', tr('GRV Shop', 'GRV ஷாப்', 'GRV शॉप')], ['account', '👤', tr('Account', 'அக்கவுண்ட்', 'अकाउंट')]]
    .map(([k, ic, l]) => h('button', { class: P.tab === k ? 'on' : '', role: 'tab', 'aria-selected': String(P.tab === k), onclick: () => { P.tab = k; again(); } }, h('span', { class: 'ic', 'aria-hidden': 'true' }, ic), h('span', { class: 'lb' }, l))));
  v.append(h('div', { class: 'who-card' }, h('div', { class: 'avatar' }, (d.customer.name || d.customer.id).trim()[0]?.toUpperCase() || '?'),
    h('div', {}, h('h1', {}, d.customer.name || tr('Welcome', 'வணக்கம்', 'नमस्ते')), h('div', { class: 'tag' }, tr('Customer ', 'கஸ்டமர் ', 'ग्राहक ') + d.customer.id))), d.needs_name ? nameForm(true) : null, etaCard(), h('div', { class: 'bar' }, tabs));

  if (P.tab === 'bill') {
    const upTo = d.cutoff < d.month + '-01' ? null : d.cutoff;
    const rows = d.days.map((x) => h('tr', { class: x.am === null ? 'mute' : x.am + x.pm === 0 ? 'zero' : '' }, h('td', {}, dayLabel(x.date)), h('td', { class: 'n' }, x.am === null ? '–' : x.am ? lit(x.am) : '0'), h('td', { class: 'n' }, x.pm === null ? '–' : x.pm ? lit(x.pm) : '0'), h('td', { class: 'n' }, x.am === null ? '–' : lit(x.am + x.pm))));
    const m = h('input', { type: 'month', value: d.month, max: d.today.slice(0, 7), onchange: (e) => { if (e.target.value) { P.month = e.target.value; again(); } } });
    const hr = d.update_hour, h12 = hr % 12 || 12;
    const at = tr(`${h12} ${hr >= 12 ? 'PM' : 'AM'}`, `${hr < 12 ? 'காலை' : hr < 16 ? 'மதியம்' : hr < 19 ? 'சாயங்காலம்' : 'ராத்திரி'} ${h12} மணிக்கு`, `${hr < 12 ? 'सुबह' : hr < 16 ? 'दोपहर' : hr < 19 ? 'शाम' : 'रात'} ${h12} बजे`);
    const Total = tr('Total', 'மொத்தம்', 'कुल'), Item = tr('Item', 'பொருள்', 'सामान');
    v.append(h('div', { class: 'bar' }, h('label', { class: 'tag' }, tr('Month ', 'மாசம் ', 'महीना '), m)),
      h('p', { class: 'tag' }, upTo ? tr(`Updated up to ${dayLabel(upTo)}. Each day is added at ${at}.`, `${dayLabel(upTo)} வரைக்கும் அப்டேட் ஆயிருக்கு. தினமும் ${at} அன்னைக்கு கணக்கு சேரும்.`, `${dayLabel(upTo)} तक अपडेट है। हर दिन का हिसाब ${at} जुड़ता है।`)
        : tr(`Not updated yet — each day is added at ${at}.`, `இன்னும் அப்டேட் ஆகல — தினமும் ${at} அன்னைக்கு கணக்கு சேரும்.`, `अभी अपडेट नहीं हुआ — हर दिन का हिसाब ${at} जुड़ता है।`)),
      h('div', { class: 'hero' }, h('div', { class: 'l' }, d.due > 0 ? tr('Amount due', 'கட்ட வேண்டிய பணம்', 'बाकी रकम') : tr('All settled', 'எல்லாம் கட்டியாச்சு', 'सब चुका दिया')), h('div', { class: 'big' }, inr(Math.max(d.due, 0))),
        h('div', { class: 'row' }, h('div', {}, tr('Milk so far', 'இதுவரை பால்', 'अब तक दूध'), h('b', {}, lit(d.total) + ' L')), h('div', {}, tr('Bill so far', 'இதுவரை பில்', 'अब तक बिल'), h('b', {}, inr(d.amount))),
          h('div', {}, tr('You paid', 'நீங்க கட்டினது', 'आपने दिए'), h('b', {}, inr(d.paid))), h('div', {}, tr('Pending', 'பாக்கி', 'बाकी'), h('b', {}, inr(Math.max(d.due, 0))))),
        null),
      d.paid > 0 ? h('div', { class: 'thanks' }, h('div', { class: 'tick' }, '✓'), h('div', {}, h('b', {}, d.due > 0 ? tr('Thank you for your payment!', 'பணம் கட்டினதுக்கு நன்றி!', 'पेमेंट के लिए शुक्रिया!') : tr('Thank you! Your bill is paid in full.', 'நன்றி! உங்க பில் முழுசா கட்டியாச்சு.', 'शुक्रिया! आपका पूरा बिल चुक गया है।')),
        h('div', { class: 'tag' }, d.due > 0 ? tr(`We received ${inr(d.paid)}. ${inr(d.due)} is still pending.`, `${inr(d.paid)} வந்துடுச்சு. இன்னும் ${inr(d.due)} பாக்கி இருக்கு.`, `${inr(d.paid)} मिल गए। ${inr(d.due)} अभी बाकी है।`)
          : tr(`We received ${inr(d.paid)}. Nothing is pending.`, `${inr(d.paid)} வந்துடுச்சு. எந்த பாக்கியும் இல்ல.`, `${inr(d.paid)} मिल गए। कुछ बाकी नहीं है।`)))) : null,
      monthCalendar(d),
      h('h2', {}, tr('Daily details', 'தினசரி கணக்கு', 'रोज़ का हिसाब')),
      h('div', { class: 'tablewrap noselect' }, h('table', {}, h('thead', {}, h('tr', {}, [tr('Date', 'தேதி', 'तारीख'), sessionName('AM'), sessionName('PM'), tr('Litres', 'லிட்டர்', 'लीटर')].map((t, i) => h('th', { class: i ? 'n' : '' }, t)))), h('tbody', {}, rows),
        h('tfoot', {}, h('tr', {}, h('td', {}, Total), h('td', { class: 'n' }, lit(d.am)), h('td', { class: 'n' }, lit(d.pm)), h('td', { class: 'n' }, lit(d.total)))))),
      d.extras.length ? h('div', {}, h('h2', {}, tr('GRV Shop items delivered', 'வந்த GRV ஷாப் பொருட்கள்', 'GRV शॉप से आया सामान')), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, [tr('Date', 'தேதி', 'तारीख'), Item, tr('Qty', 'அளவு', 'मात्रा'), tr('Amount', 'தொகை', 'रकम')].map((t, i) => h('th', { class: i > 1 ? 'n' : '' }, t)))),
        h('tbody', {}, d.extras.map((x) => h('tr', {}, h('td', {}, dayLabel(x.date)), h('td', {}, x.product || Item), h('td', { class: 'n' }, qtyText(x.qty, x.unit)), h('td', { class: 'n' }, inr(x.qty * x.price))))),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: 3 }, tr('GRV Shop total (included in your bill)', 'GRV ஷாப் மொத்தம் (உங்க பில்லிலேயே சேர்ந்திருக்கு)', 'GRV शॉप कुल (आपके बिल में जुड़ा है)')), h('td', { class: 'n' }, inr(d.extras_total))))))) : null,
      d.payments.length ? h('div', {}, h('h2', {}, tr('Payments received', 'வந்த பணம்', 'मिले पेमेंट')), h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, d.payments.map((p) => h('tr', {}, h('td', {}, p.date), h('td', {}, p.mode || ''), h('td', { class: 'n' }, inr(p.amount))))))))  : null,
      h('p', { class: 'tag' }, tr(`Rate: ${inr(d.customer.price)} per litre.`, `விலை: லிட்டருக்கு ${inr(d.customer.price)}.`, `रेट: ${inr(d.customer.price)} एक लीटर का।`)));
  } else if (P.tab === 'shop') {
    const sh = await api('portal/products');
    const card = (i) => {
      const dec = i.unit === 'Litre' || i.unit === 'Kg';
      const q = h('input', { type: 'number', min: dec ? 0.25 : 1, step: dec ? 'any' : 1, inputmode: dec ? 'decimal' : 'numeric', placeholder: dec ? tr('Litres', 'எத்தனை லிட்டர்', 'कितने लीटर') : tr('How many', 'எத்தனை', 'कितने'), 'aria-label': i.name + ' quantity', disabled: !i.left });
      const go = guard(async () => { await api('portal/orders', 'POST', { product_id: i.id, qty: q.value }); toast(tr('Booked!', 'புக் ஆயிடுச்சு!', 'बुक हो गया!')); again(); });
      const per = { Nos: tr('piece', 'ஒன்னு', 'पीस'), Litre: tr('litre', 'லிட்டர்', 'लीटर'), Kg: tr('kg', 'கிலோ', 'किलो') }[i.unit] || i.unit.toLowerCase();
      return h('form', { class: 'rcard', onsubmit: (e) => { e.preventDefault(); go(); } }, h('div', { class: 'rname' }, i.name), h('div', { class: 'tag' }, tr(`${inr(i.price)} per ${per}`, `${inr(i.price)} / ${per}`, `${inr(i.price)} / ${per}`)),
        h('div', { style: 'margin:8px 0' }, i.left ? h('b', {}, tr(`${qtyText(i.left, i.unit)} available`, `${qtyText(i.left, i.unit)} இருக்கு`, `${qtyText(i.left, i.unit)} बचा है`)) : h('b', { class: 'bad' }, tr('Sold out', 'தீர்ந்துடுச்சு', 'खत्म हो गया'))),
        h('div', { class: 'bar' }, q, h('button', { class: 'pri', type: 'submit', disabled: !i.left }, tr('Book', 'புக் பண்ணு', 'बुक करें'))));
    };
    const status = (s) => ({ Booked: tr('Booked', 'புக் ஆயிருக்கு', 'बुक है'), Delivered: tr('Delivered', 'கொடுத்தாச்சு', 'पहुँच गया'), Cancelled: tr('Cancelled', 'கேன்சல் ஆச்சு', 'कैंसल हुआ') }[s] || s);
    v.append(h('h2', { style: 'margin-top:0' }, tr('GRV Shop', 'GRV ஷாப்', 'GRV शॉप')),
      h('p', { class: 'tag' }, tr('Book egg, ghee, curd and more. The quantity left goes down as people book. The admin will deliver it to you.',
        'முட்டை, நெய், தயிர் எல்லாம் இங்கயே புக் பண்ணலாம். மத்தவங்க புக் பண்ண பண்ண இருக்கிற அளவு குறையும். நாங்களே உங்க வீட்டுக்கு கொண்டு வந்து தருவோம்.',
        'अंडे, घी, दही और भी बहुत कुछ यहीं बुक करें। जैसे-जैसे लोग बुक करते हैं, बचा हुआ सामान कम होता जाता है। हम आपके घर पहुँचा देंगे।')),
      sh.items.length ? h('div', { class: 'cards-list' }, sh.items.map(card)) : h('p', { class: 'mute' }, tr('Nothing is available to book right now.', 'இப்போ புக் பண்ண எதுவும் இல்ல.', 'अभी बुक करने के लिए कुछ नहीं है।')),
      h('h2', {}, tr('My bookings', 'நான் புக் பண்ணது', 'मेरी बुकिंग')),
      sh.orders.length ? h('div', { class: 'cards-list' }, sh.orders.map((o) => h('div', { class: 'rcard' }, h('div', { class: 'rname' }, `${o.product || tr('Item', 'பொருள்', 'सामान')} — ${qtyText(o.qty, o.unit)}`),
        h('div', { class: 'tag' }, `${dayLabel(o.date)} · ${inr(o.qty * o.price)}`), h('div', { style: 'margin-top:6px' }, h('span', { class: 'pill ' + o.status }, status(o.status))),
        o.status === 'Booked' ? h('div', { class: 'ract' }, h('button', { class: 'abs', onclick: guard(async () => { if (!confirm(tr('Cancel this booking?', 'இந்த புக்கிங்க கேன்சல் பண்ணவா?', 'यह बुकिंग कैंसल करें?'))) return; await api('portal/orders/' + o.id, 'DELETE'); toast(tr('Cancelled', 'கேன்சல் ஆயிடுச்சு', 'कैंसल हो गया')); again(); }) }, tr('Cancel', 'கேன்சல்', 'कैंसल'))) : null)))
        : h('p', { class: 'mute' }, tr('You have not booked anything yet.', 'இன்னும் எதுவும் புக் பண்ணல.', 'अभी तक कुछ बुक नहीं किया।')));
  } else if (P.tab === 'skip') {
    // a fun pop-up after the request is sent; each request shows the next line in turn, then starts over
    const NO_MILK_FUN = [
      ['Planning to go out, I see… 👀😂 Enjoy!', 'வெளியே போக பிளான் பண்ணிட்டீங்க போல… 👀😂 Enjoy பண்ணுங்க!', 'लगता है बाहर घूमने का प्लान है… 👀😂 मज़े कीजिए!'],
      ['Aha… taking a day off from us, I see! 😏😂', 'ஆஹா… எங்களுக்கும் ஒரு நாள் லீவு கொடுக்கிறீங்க போல! 😏😂', 'अच्छा… हमसे एक दिन की छुट्टी ले रहे हैं! 😏😂'],
      ['Looks like you have plans without us! 😂 Enjoy!', 'எங்களை விட்டுட்டு ஏதோ பிளான் இருக்கு போல! 😂 Enjoy பண்ணுங்க!', 'लगता है हमारे बिना कोई प्लान है! 😂 मज़े कीजिए!'],
      ['Looks like the milkman gets a little break! 🛵😂', 'பால்காரருக்கு ஒரு டெலிவரி லீவு! 🛵😂', 'दूधवाले भैया को भी थोड़ी छुट्टी! 🛵😂'],
      ['Aha… saving space in the fridge, I see! 😏🥛😂', 'ஆஹா… ஃப்ரிட்ஜ்ல கொஞ்சம் இடம் சேமிக்கிறீங்க போல! 😏🥛😂', 'अच्छा… फ्रिज में जगह बचा रहे हैं! 😏🥛😂'],
      ['Fine… we’ll keep your bottle waiting for tomorrow! 😏🥛❤️', 'சரி… உங்க பாட்டில் நாளைக்கு வரைக்கும் காத்திருக்கட்டும்! 😏🥛❤️', 'ठीक है… आपकी बोतल कल तक इंतज़ार करेगी! 😏🥛❤️']];
    // sad cow for the pop-up: head sways and a tear rolls down (animation in style.css)
    const SAD_COW = `<svg viewBox="0 0 120 112" width="110" height="103">
      <g class="cow-head">
        <path d="M34 26 q-8 -14 -2 -20 q2 10 10 14z M86 26 q8 -14 2 -20 q-2 10 -10 14z" fill="#efe2c4" stroke="#3a2a20" stroke-width="2"/>
        <ellipse cx="20" cy="44" rx="15" ry="8" transform="rotate(20 20 44)" fill="#f3e6d8" stroke="#3a2a20" stroke-width="2"/>
        <ellipse cx="100" cy="44" rx="15" ry="8" transform="rotate(-20 100 44)" fill="#f3e6d8" stroke="#3a2a20" stroke-width="2"/>
        <ellipse cx="60" cy="56" rx="35" ry="40" fill="#fff" stroke="#3a2a20" stroke-width="2.5"/>
        <path d="M30 40 q4 -20 22 -22 q-4 12 -14 16 q-6 3 -8 6z" fill="#3a2a20"/>
        <path d="M76 22 q10 2 12 12 q-8 0 -12 -12z" fill="#3a2a20"/>
        <path d="M39 42 l13 -5 M81 42 l-13 -5" stroke="#3a2a20" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M41 51 q5 4 10 0 M69 51 q5 4 10 0" fill="none" stroke="#3a2a20" stroke-width="2.5" stroke-linecap="round"/>
        <path class="cow-tear" d="M76 56 q-4 6 0 8 q4 -2 0 -8z" fill="#5bb4f0"/>
        <ellipse cx="60" cy="80" rx="23" ry="15" fill="#f6b8c0" stroke="#3a2a20" stroke-width="2"/>
        <ellipse cx="52" cy="77" rx="3" ry="4" fill="#3a2a20"/><ellipse cx="68" cy="77" rx="3" ry="4" fill="#3a2a20"/>
        <path d="M53 89 q7 -5 14 0" fill="none" stroke="#3a2a20" stroke-width="2.2" stroke-linecap="round"/>
      </g></svg>`;
    const noMilkFun = (days, from) => {
      let i = 0; try { i = (Number(localStorage.getItem('grv.noMilkFun')) || 0) % NO_MILK_FUN.length; localStorage.setItem('grv.noMilkFun', i + 1); } catch {}
      const [en, ta, hi] = NO_MILK_FUN[i];
      const dlg = $('#dlg'); dlg.innerHTML = '';
      const cow = h('div', { class: 'sad-cow', 'aria-hidden': 'true' });
      cow.innerHTML = SAD_COW;
      dlg.append(h('form', { class: 'form funny', method: 'dialog' }, cow,
        h('h1', {}, tr('No milk — ', 'பால் வேண்டாம் — ', 'दूध नहीं — ') + (days === 1 ? dayLabel(from) : tr(`${days} days`, `${days} நாள்`, `${days} दिन`))),
        h('p', {}, tr(en, ta, hi)), langOn() === 'en' ? h('p', { lang: 'ta' }, 'இன்னைக்கு பால் இல்லை — ' + ta) : null,
        h('p', { class: 'tag' }, tr('Your delivery boy and the admin are notified.', 'உங்க டெலிவரி பையனுக்கும் அட்மினுக்கும் சொல்லியாச்சு.', 'आपके डिलीवरी वाले भैया और एडमिन को बता दिया है।')),
        h('div', { class: 'acts' }, h('button', { class: 'pri', type: 'submit' }, 'OK 👍'))));
      dlg.showModal();
    };
    // calendar like My bill: tap each day you don't want milk (tap again to undo) — no From/To to understand
    const isoAdd = (s, n) => { const x = new Date(s + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const lastDay = isoAdd(d.today, 89); // pick up to 3 months ahead
    const asked = new Set(); // days already requested — shown, not tappable (cancel them in "Your requests")
    for (const k of d.skips) for (let x = k.from < d.today ? d.today : k.from, i = 0; x <= k.to && i < 400; x = isoAdd(x, 1), i++) asked.add(x);
    const picked = new Set();
    let calMonth = d.today.slice(0, 7);
    const sum = h('p', { class: 'pick-sum' });
    const showSum = () => {
      const l = [...picked].sort();
      sum.className = 'pick-sum' + (l.length ? ' has' : '');
      sum.textContent = l.length ? tr(`✕ No milk on ${l.length} day${l.length > 1 ? 's' : ''}: `, `✕ ${l.length} நாள் பால் வேண்டாம்: `, `✕ ${l.length} दिन दूध नहीं: `) + l.map(dayLabel).join(', ')
        : tr('Tap the days you don’t need milk. Tap again to undo.', 'பால் வேண்டாத நாளை தொடுங்க. திரும்ப தொட்டா மாறிடும்.', 'जिस दिन दूध नहीं चाहिए, उस तारीख को दबाइए। दोबारा दबाने से हट जाएगा।');
    };
    const cal = h('div', { class: 'cal noselect pick-cal' });
    const drawCal = () => {
      const first = new Date(calMonth + '-01T00:00:00Z'), lead = (first.getUTCDay() + 6) % 7;
      const n = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      const cells = [...Array(lead).fill(null), ...Array.from({ length: n }, (_, i) => `${calMonth}-${String(i + 1).padStart(2, '0')}`)];
      const canPrev = calMonth > d.today.slice(0, 7), canNext = calMonth < lastDay.slice(0, 7);
      const go = (k) => { const x = new Date(calMonth + '-01T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + k); calMonth = x.toISOString().slice(0, 7); drawCal(); };
      const cell = (date, i) => {
        if (!date) return h('div', {});
        const off = date < d.today || date > lastDay, was = asked.has(date);
        const el = h('div', { class: 'cal-d' + (off ? ' past' : was ? ' asked' : picked.has(date) ? ' pick' : '') + (date === d.today ? ' today' : ''), style: `--w:${Math.floor(i / 7) + (i % 7)}`,
          title: was ? tr('Already asked: no milk', 'ஏற்கனவே சொல்லியாச்சு: பால் வேண்டாம்', 'पहले ही बता दिया: दूध नहीं') : '', role: off || was ? null : 'button', tabindex: off || was ? null : 0, 'aria-pressed': off || was ? null : String(picked.has(date)) }, Number(date.slice(8)));
        if (!off && !was) {
          const tap = () => { picked.has(date) ? picked.delete(date) : picked.add(date); el.classList.toggle('pick', picked.has(date)); el.setAttribute('aria-pressed', String(picked.has(date))); cal.classList.remove('missing'); showSum(); };
          el.addEventListener('click', tap);
          el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap(); } });
        }
        return el;
      };
      cal.innerHTML = '';
      cal.append(h('div', { class: 'cal-nav' },
          h('button', { type: 'button', class: 'cal-arrow', disabled: !canPrev, 'aria-label': tr('Previous month', 'போன மாசம்', 'पिछला महीना'), onclick: () => go(-1) }, '‹'),
          h('b', {}, monthLabel(calMonth)),
          h('button', { type: 'button', class: 'cal-arrow', disabled: !canNext, 'aria-label': tr('Next month', 'அடுத்த மாசம்', 'अगला महीना'), onclick: () => go(1) }, '›')),
        h('div', { class: 'cal-grid' }, WEEK().map((w) => h('div', { class: 'cal-w' }, w)), cells.map(cell)),
        h('div', { class: 'cal-key' }, h('span', { class: 'pick' }, tr('No milk (your pick)', 'பால் வேண்டாம் (நீங்க தொட்டது)', 'दूध नहीं (आपने चुना)')), asked.size ? h('span', { class: 'asked' }, tr('Already asked', 'ஏற்கனவே சொன்னது', 'पहले बता दिया')) : null));
    };
    drawCal(); showSum();
    // picked days become one request per run of days in a row (Mon+Tue+Wed = 1 request, Fri = another)
    const runs = () => {
      const l = [...picked].sort(), out = [];
      for (const x of l) { const r = out[out.length - 1]; if (r && isoAdd(r[1], 1) === x) r[1] = x; else out.push([x, x]); }
      return out;
    };
    // nothing is picked at first, so an evening-only customer can't skip the morning by mistake
    const ses = choices(tr('Which delivery', 'எந்த டெலிவரி?', 'कौन सी डिलीवरी?'), [['AM', '🌅 ' + sessionName('AM')], ['PM', '🌇 ' + sessionName('PM')], ['BOTH', '🌅🌇 ' + sessionName('BOTH')]]);
    const note = h('input', { type: 'text', placeholder: tr('Optional note (e.g. out of town)', 'ஏதாவது சொல்லணும்னா (உதா: ஊருக்கு போறோம்)', 'कुछ बताना हो तो (जैसे: शहर से बाहर हैं)'), maxlength: 200 });
    v.append(h('form', { class: 'form card', onsubmit: guard(async (e) => { e.preventDefault(); if (!picked.size) { cal.classList.remove('missing'); void cal.offsetWidth; cal.classList.add('missing'); cal.scrollIntoView({ block: 'center', behavior: 'smooth' }); return toast(tr('Tap at least one day on the calendar', 'காலண்டர்ல ஒரு நாளாவது தொடுங்க', 'कैलेंडर में कम से कम एक दिन चुनिए'), true); }
        if (!ses.need()) return;
        const list = runs();
        for (const [from, to] of list) { await api('portal/skips', 'POST', { from, to, session: ses.value, note: note.value }); }
        noMilkFun(picked.size, list[0][0]); again(); }) },
      h('h2', { style: 'margin-top:0' }, tr("I don't need milk", 'எனக்கு பால் வேண்டாம்', 'मुझे दूध नहीं चाहिए')),
      h('p', { class: 'tag' }, tr('Your delivery boy and the admin are notified. You are not billed for the days you skip. You can pause from today too.',
        'உங்க டெலிவரி பையனுக்கும் அட்மினுக்கும் சொல்லிடுவோம். பால் வாங்காத நாளுக்கு பில் போட மாட்டோம். இன்னைக்கே கூட நிறுத்திக்கலாம்.',
        'आपके डिलीवरी वाले भैया और एडमिन को बता दिया जाएगा। जिन दिनों दूध नहीं लेंगे, उनका पैसा नहीं लगेगा। आज से भी रोक सकते हैं।')),
      cal, sum, ses, h('label', {}, tr('Note', 'குறிப்பு', 'नोट'), note), h('button', { class: 'pri', type: 'submit' }, tr('Send request', 'அனுப்புங்க', 'भेजें'))),
      h('h2', {}, tr('Your requests', 'நீங்க சொன்னது', 'आपकी रिक्वेस्ट')),
      d.skips.length ? h('div', { class: 'cards-list' }, d.skips.map((k) => h('div', { class: 'rcard' }, h('div', { class: 'rname' }, k.from === k.to ? dayLabel(k.from) : `${dayLabel(k.from)} → ${dayLabel(k.to)}`), h('div', { class: 'tag' }, sessionName(k.session) + (k.note ? ' · ' + k.note : '')),
        h('div', { class: 'ract' }, h('button', { class: 'abs', onclick: guard(async () => {
          if (!confirm(k.from <= d.today ? tr('Start getting milk again from today?', 'இன்னைக்கே மறுபடியும் பால் வேணுமா?', 'आज से फिर से दूध चालू करें?') : tr('Cancel this request?', 'இதை கேன்சல் பண்ணவா?', 'यह रिक्वेस्ट कैंसल करें?'))) return;
          await api('portal/skips/' + k.id, 'DELETE'); toast(tr('Done', 'சரி, ஆயிடுச்சு', 'हो गया')); again(); }) },
        k.from <= d.today ? tr('Resume milk from today', 'இன்னைக்கே பால் வேணும்', 'आज से दूध चालू करें') : tr('Cancel', 'கேன்சல்', 'कैंसल')))))) : h('p', { class: 'mute' }, tr('No active requests.', 'இப்போ எதுவும் இல்ல.', 'अभी कोई रिक्वेस्ट नहीं है।')));
  } else {
    // language for this phone: each button shows its own name, so anyone can find theirs whatever is showing now
    const langCard = h('div', { class: 'form card' }, h('h2', { style: 'margin-top:0' }, tr('Language', 'மொழி', 'भाषा')),
      h('p', { class: 'tag' }, tr('Choose the language you want to see the app in.', 'ஆப் எந்த மொழியில வரணும்னு செலக்ட் பண்ணுங்க.', 'ऐप किस भाषा में दिखे, चुनिए।')),
      h('div', { class: 'seg lang-pick' }, [['en', 'English'], ['ta', 'தமிழ்'], ['hi', 'हिंदी']].map(([k, l]) => h('button', { type: 'button', lang: k, class: LANG === k ? 'on' : '', onclick: () => {
        LANG = k; try { localStorage.setItem('grv.lang', k); } catch {}
        render().then(() => toast(tr('Language changed', 'மொழி மாத்தியாச்சு', 'भाषा बदल गई')));
      } }, l))));
    const o = h('input', { type: 'password', autocomplete: 'current-password', required: true }), n1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 6, required: true }), n2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 6, required: true });
    v.append(langCard, h('div', { style: 'margin-top:12px' }, nameForm(false)), h('form', { class: 'form card', style: 'margin-top:12px', onsubmit: guard(async (e) => { e.preventDefault(); if (n1.value !== n2.value) return toast(tr('New passwords do not match', 'புது பாஸ்வேர்டு ரெண்டும் ஒன்னா இல்ல', 'दोनों नए पासवर्ड एक जैसे नहीं हैं'), true); await api('portal/password', 'PUT', { old: o.value, password: n1.value }); toast(tr('Password changed', 'பாஸ்வேர்டு மாத்தியாச்சு', 'पासवर्ड बदल गया')); again(); }) },
      h('h2', { style: 'margin-top:0' }, tr('Change password', 'பாஸ்வேர்டு மாத்துங்க', 'पासवर्ड बदलें')), h('p', { class: 'tag' }, tr('If you forget your password, ask the admin to reset it.', 'பாஸ்வேர்டு மறந்துட்டா அட்மின் கிட்ட கேளுங்க, புதுசா போட்டு தருவாங்க.', 'पासवर्ड भूल जाएँ तो एडमिन से बोलिए, वो नया बना देंगे।')),
      h('label', {}, tr('Current password', 'இப்போ இருக்கிற பாஸ்வேர்டு', 'अभी वाला पासवर्ड'), pwBox(o)), h('label', {}, tr('New password (min 6 characters)', 'புது பாஸ்வேர்டு (குறைஞ்சது 6 எழுத்து)', 'नया पासवर्ड (कम से कम 6 अक्षर)'), pwBox(n1)),
      h('label', {}, tr('Repeat new password', 'புது பாஸ்வேர்டு திரும்ப போடுங்க', 'नया पासवर्ड फिर से डालें'), pwBox(n2)), h('button', { class: 'pri', type: 'submit' }, tr('Change password', 'பாஸ்வேர்டு மாத்துங்க', 'पासवर्ड बदलें'))));
  }
};

// ---------- router ----------
// Monthly calendar: each date coloured by its status (green = delivered, yellow = paused, red = milk unavailable).
function monthCalendar(d) {
  const first = new Date(d.month + '-01T00:00:00'), lead = (first.getDay() + 6) % 7; // Monday first
  const cells = [...Array(lead).fill(null), ...d.days];
  const cls = { Delivered: 'ok', Paused: 'pause', Unavailable: 'out' };
  const word = { Delivered: tr('Delivered', 'பால் வந்தது', 'दूध आया'), Paused: tr('Paused', 'நிறுத்தினது', 'रोका गया'), Unavailable: tr('Milk Unavailable', 'பால் இல்ல', 'दूध नहीं था') };
  return h('div', { class: 'cal noselect' },
    h('div', { class: 'cal-grid' }, WEEK().map((w) => h('div', { class: 'cal-w' }, w)),
      // dates pop in as a diagonal wave (row + column sets the delay); today's date keeps a gentle pulse
      cells.map((x, i) => x ? h('div', { class: 'cal-d ' + (cls[x.st] || '') + (x.date === d.today ? ' today' : ''), style: `--w:${Math.floor(i / 7) + (i % 7)}`, title: x.st ? word[x.st] || x.st : '' }, Number(x.date.slice(8))) : h('div', {}))),
    h('div', { class: 'cal-key' }, h('span', { class: 'ok' }, word.Delivered), h('span', { class: 'pause' }, word.Paused), h('span', { class: 'out' }, word.Unavailable)));
}
const NAV = [['dashboard', 'Dashboard'], ['delivery', 'Delivery'], ['notices', 'Notices'], ['daily', 'Daily Summary'], ['bills', 'Bills'], ['customers', 'Customers'], ['income', 'Income'], ['expenses', 'Expenses'], ['pnl', 'P&L'], ['cows', 'Cows'], ['yield', 'Cow Yield'], ['extras', 'Extras'], ['locations', 'Location Tracker'], ['settings', 'Settings']];
// the admin menu in the order picked in Settings; a page missing from the saved order keeps its default place at the end
const navInOrder = () => { const saved = S.user.nav_order || []; return [...saved.map((k) => NAV.find((n) => n[0] === k)).filter(Boolean), ...NAV.filter((n) => !saved.includes(n[0]))]; };
const DELIVERY_NAV = [['delivery', 'Deliveries'], ['locations', 'Locations'], ['notices', 'Notices']];
const hdr = $('header');

// Each person has their own sign-in address: / = customers, /delivery = delivery staff, /admin = admin.
// The page shows only that one form — no role picker, and no hint that the other logins exist.
function showLogin() {
  hdr.hidden = true;
  const v = $('#view'); v.innerHTML = '';
  const asParam = new URLSearchParams(location.search).get('as'); // ?as=admin works too (used by the GitHub Pages demo)
  const mode = ['customer', 'delivery', 'admin'].includes(asParam) ? asParam : { '/admin': 'admin', '/delivery': 'delivery' }[location.pathname.replace(/\/+$/, '')] || 'customer';
  const title = { customer: 'Customer sign in', delivery: 'Delivery sign in', admin: 'Admin sign in' }[mode];
  const id = h('input', { type: 'text', placeholder: 'e.g. GRV001', autocapitalize: 'characters', autocomplete: 'username', required: true, value: localStorage.getItem('grv.cid') || '' });
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const shiftCh = mode === 'delivery' ? choices('Which delivery do you do?', [['AM', '🌅 Morning'], ['PM', '🌇 Evening'], ['BOTH', '🌅🌇 Both']]) : null;
  if (shiftCh) { let last = null; try { last = localStorage.getItem('grv.shift'); } catch {} const r = last && shiftCh.querySelector(`input[value="${last}"]`); if (r) r.checked = true; }
  const form = h('form', { class: 'login form', onsubmit: guard(async (e) => {
    e.preventDefault();
    if (shiftCh && !shiftCh.need()) return;
    await api('login', 'POST', { role: mode, id: id.value, password: pw.value, shift: shiftCh ? shiftCh.value : undefined });
    if (shiftCh) try { localStorage.setItem('grv.shift', shiftCh.value); } catch {}
    if (mode === 'customer') localStorage.setItem('grv.cid', id.value.trim().toUpperCase());
    S.lists = null; S.user = null; render();
  }) }, mode === 'customer' && isDiwali() ? diwaliPoster() : null, h('img', { class: 'logo big', src: 'logo.png', alt: 'GRV Dairy' }), h('h1', { style: 'text-align:center;font-size:19px;margin-bottom:2px' }, title),
    h('p', { class: 'tag' }, mode === 'customer' ? 'Fresh milk, delivered daily' : 'GRV Dairy staff'),
    mode === 'customer' ? h('label', {}, 'Customer ID', id) : null, shiftCh, h('label', {}, 'Password', pwBox(pw)), h('button', { class: 'pri', type: 'submit' }, 'Sign in'));
  v.append(form); (mode === 'customer' && !id.value ? id : pw).focus();
  if (mode === 'customer' && isDiwali()) diwaliFireworks();
}

async function render() {
  if (!S.user) {
    try { S.user = await api('me'); } catch { return showLogin(); }
  }
  hdr.hidden = false;
  if (LIVE.watch == null) liveKick(); // live map: share this phone's GPS while a round is running (delivery by default)
  const role = S.user.role, admin = role === 'admin';
  const [hashPage, arg] = (location.hash.slice(2) || '').split('/');
  const nav = $('#nav'); nav.innerHTML = ''; nav.classList.remove('open');
  let page;
  if (role === 'customer') page = 'portal';
  else if (role === 'delivery') page = ['notices', 'locations'].includes(hashPage) ? hashPage : 'delivery';
  else page = hashPage || 'dashboard';
  // the red count bubbles load in the background so they never hold the page up
  const badgeP = Promise.all([
    role !== 'customer' ? api('notices').then((n) => [n.items.filter((k) => k.from <= n.today).length, (n.requests || []).length], () => [0, 0]) : [0, 0],
    admin ? api('cow-alerts').then((a) => a.length, () => 0) : 0]);
  const links = admin ? navInOrder() : role === 'delivery' ? DELIVERY_NAV : [];
  for (const [k, l] of links) nav.append(h('a', { href: '#/' + k, class: k === page || (page === 'bill' && k === 'bills') ? 'on' : '' }, l));
  $('#menu').hidden = !links.length; $('.month').hidden = !admin;
  $('#who').textContent = { admin: 'Admin', delivery: { AM: 'Morning delivery', PM: 'Evening delivery' }[S.user.shift] || 'Delivery', customer: S.user.cid }[role];
  document.body.classList.toggle('customer', role === 'customer');
  document.documentElement.lang = langOn();
  $('#logout').textContent = tr('Sign out', 'லாக் அவுட்', 'लॉग आउट');
  const v = $('#view'); v.innerHTML = '';
  v.append = (...kids) => Element.prototype.append.apply(v, kids.flat().filter((k) => k != null && k !== false)); // pages may pass null for "nothing"
  badgeP.then(([[badge, chgBadge], cowBadge]) => {
    for (const a of nav.children) {
      const k = a.getAttribute('href').slice(2);
      if (k === 'notices') { // no-milk today in the usual colour, change-milk requests waiting in blue
        if (badge) a.append(h('span', { class: 'badge', title: 'No milk today' }, badge));
        if (chgBadge) a.append(h('span', { class: 'badge chg', title: 'Change milk requests waiting' }, chgBadge));
      } else if (k === 'cows' && cowBadge) a.append(h('span', { class: 'badge cow' }, cowBadge));
    }
  });
  try { S.lists = S.lists || (admin ? await api('lists') : {}); await (pages[page] || pages.dashboard)(v, arg); }
  catch (e) { if (S.user) v.append(h('p', { class: 'bad' }, 'Error: ' + e.message)); }
}
$('#menu').addEventListener('click', () => $('#nav').classList.toggle('open'));
$('#logout').addEventListener('click', guard(async () => { await api('logout', 'POST'); liveStopGps(); clearTimeout(LIVE.recheck); S.user = null; S.lists = null; render(); }));
window.addEventListener('hashchange', () => { if (reloadIfUpdated()) return; D.data = null; render(); });
monthInput.addEventListener('change', () => { D.data = null; });
render();
