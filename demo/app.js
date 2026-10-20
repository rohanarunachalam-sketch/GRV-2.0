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
const monthLabel = (m) => new Date(m + '-01T00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const dayLabel = (d) => new Date(d + 'T00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

async function api(path, method = 'GET', body) {
  const r = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
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
      stat(left >= 0 ? 'Left over' : 'Short', lit(Math.abs(left)) + ' L', left >= 0 ? 'good' : 'bad'), stat('Days', rows.length)),
      h('details', { class: 'ms-days' }, h('summary', {}, 'Show each day'), table([{ label: 'Date', render: (r) => dayLabel(r.date) }, { label: 'Yield L', num: 1, render: (r) => lit(r.yield) }, { label: 'Sold L', num: 1, render: (r) => lit(r.sold) },
        { label: 'Left / short', num: 1, render: (r) => h('span', { class: r.left < 0 ? 'bad' : '' }, (r.left < 0 ? '−' : '') + lit(Math.abs(r.left))) }], rows,
      { foot: ['Total', lit(sum('yield')), lit(sum('sold')), (left < 0 ? '−' : '') + lit(Math.abs(left))] })));
  });
  const preset = (a, b) => () => { fromIn.value = a; toIn.value = b; show(); };
  const lm = shiftMonth(t.slice(0, 7), -1);
  const download = guard(async () => {
    if (!rows.length) return toast('Nothing to download', true);
    const sheet = rows.map((r) => ({ Date: r.date, 'Yield AM (L)': r.yield_am, 'Yield PM (L)': r.yield_pm, 'Total yield (L)': r.yield, 'Sold AM (L)': r.sold_am, 'Sold PM (L)': r.sold_pm, 'Total sold (L)': r.sold, 'Left over / short (L)': r.left }));
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
  const staff = S.user.role !== 'admin';
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
  const sessionSeg = h('div', { class: 'seg' }, ['AM', 'PM'].map((s) => h('button', { class: R.session === s ? 'on' : '', onclick: () => { R.session = s; rerender(); } }, s)));
  const rerender = () => { v.innerHTML = ''; routeView(v).catch((e) => v.append(h('p', { class: 'bad' }, e.message))); };
  const dateCtl = staff
    ? h('div', { class: 'seg' }, [[S.user.today, 'Today'], [S.user.yesterday, 'Yesterday']].map(([d, l]) => h('button', { class: R.date === d ? 'on' : '', onclick: () => { R.date = d; rerender(); } }, l)))
    : h('input', { type: 'date', value: R.date, onchange: (e) => { if (e.target.value) { R.date = e.target.value; rerender(); } } });
  v.append(h('h1', {}, 'Deliveries'), h('p', { class: 'sub' }, `${dayLabel(R.date)} · ${R.session === 'AM' ? 'Morning' : 'Evening'}. Customers get their usual quantity unless you change it.`),
    staff ? null : h('div', { class: 'bar' }, viewTabs(() => { v.innerHTML = ''; pages.delivery(v); })),
    h('div', { class: 'bar sticky' }, dateCtl, sessionSeg, search), h('div', { class: 'bar' }, prog), cardsBox);
  if (R.filter) for (const c of cardsBox.children) c.hidden = !c.dataset.name.includes(R.filter);
  if (!items.length) cardsBox.append(h('p', { class: 'mute' }, 'No customers for this session.'));
  stats();
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
  v.append(h('h1', {}, 'Delivery'), h('p', { class: 'sub' }, 'Leave a box blank to use the default quantity. Enter 0 for no delivery. Yellow boxes are changes from default.'), bar, body);
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
});

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
    milkSummary(), h('h2', {}, `Deliveries — ${monthLabel(S.month)}`),
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

pages.settings = async (v) => {
  const L = await api('lists');
  const areas = {};
  const mk = (k, label) => { areas[k] = h('textarea', { rows: 10 }); areas[k].value = L[k].join('\n'); return h('label', { class: 'card', style: 'display:block' }, h('b', {}, label), h('div', { class: 'tag' }, 'One per line'), areas[k]); };
  v.append(h('h1', {}, 'Settings'), h('p', { class: 'sub' }, 'Dropdown lists used in Payments, Income and Expenses. Data is stored in app/data/grv.db.'),
    h('div', { class: 'grid2' }, mk('modes', 'Payment modes'), mk('expense_categories', 'Expense categories'), mk('income_types', 'Income types')),
    h('div', { class: 'bar', style: 'margin-top:12px' }, h('button', { class: 'pri', onclick: guard(async () => {
      const body = {}; for (const k in areas) body[k] = areas[k].value.split('\n'); await api('lists', 'PUT', body); toast('Settings saved');
    }) }, 'Save')));
  for (const a of Object.values(areas)) a.style.cssText = 'display:block;width:100%;margin-top:6px';
  const pwBox = (role, label) => {
    const i = h('input', { type: 'text', placeholder: 'New password (min 6 characters)', autocomplete: 'off' });
    return h('div', { class: 'bar' }, h('b', { style: 'width:90px' }, label), i, h('button', { onclick: guard(async () => { await api('password', 'PUT', { role, password: i.value }); i.value = ''; toast(label + ' password changed'); }) }, 'Change'));
  };
  v.append(h('h2', {}, 'Logins'), h('p', { class: 'sub' }, 'The delivery login only sees today\'s and yesterday\'s delivery list — no prices, bills or reports. Changing a password signs that account out on other phones.'),
    h('div', { class: 'card' }, pwBox('delivery', 'Delivery'), pwBox('admin', 'Admin')),
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
  v.append(h('h1', {}, 'Notices'), h('p', { class: 'sub' }, 'Customers who asked for no milk. A request stays here for every day it covers — and the delivery list and bills follow it automatically.'),
    admin ? h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: () => addSkip() }, '+ Add request (phone call)')) : null,
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

// ---------- customer portal ----------
const P = { month: null, tab: 'bill' };
pages.portal = async (v) => {
  const d = await api('portal' + (P.month ? '?month=' + P.month : ''));
  P.month = d.month;
  const nameForm = (first) => {
    const i = h('input', { type: 'text', placeholder: 'Your name', maxlength: 60, required: true, value: d.customer.name, autocomplete: 'name' });
    return h('form', { class: 'form card', style: first ? 'border-color:var(--brand);margin-bottom:12px' : '', onsubmit: guard(async (e) => { e.preventDefault(); await api('portal/name', 'PUT', { name: i.value }); toast('Name saved'); again(); }) },
      h('h2', { style: 'margin-top:0' }, first ? 'Welcome! What is your name?' : 'Name on my bill'), h('p', { class: 'tag' }, 'This is the name printed on your milk bill. You can change it any time.'),
      h('label', {}, 'Your name', i), h('button', { class: 'pri', type: 'submit' }, 'Save name'));
  };
  const again = () => { v.innerHTML = ''; pages.portal(v).catch((e) => v.append(h('p', { class: 'bad' }, e.message))); };
  const tabs = h('div', { class: 'seg' }, [['bill', 'My bill'], ['skip', 'No milk'], ['shop', 'Extras'], ['account', 'Account']].map(([k, l]) => h('button', { class: P.tab === k ? 'on' : '', onclick: () => { P.tab = k; again(); } }, l)));
  v.append(h('div', { class: 'who-card' }, h('div', { class: 'avatar' }, (d.customer.name || d.customer.id).trim()[0]?.toUpperCase() || '?'), h('div', {}, h('h1', {}, d.customer.name || 'Welcome'), h('div', { class: 'tag' }, `Customer ${d.customer.id}`))), d.needs_name ? nameForm(true) : null, h('div', { class: 'bar' }, tabs));

  if (P.tab === 'bill') {
    const upTo = d.cutoff < d.month + '-01' ? null : d.cutoff;
    const rows = d.days.map((x) => h('tr', { class: x.am === null ? 'mute' : x.am + x.pm === 0 ? 'zero' : '' }, h('td', {}, dayLabel(x.date)), h('td', { class: 'n' }, x.am === null ? '–' : x.am ? lit(x.am) : '0'), h('td', { class: 'n' }, x.pm === null ? '–' : x.pm ? lit(x.pm) : '0'), h('td', { class: 'n' }, x.am === null ? '–' : lit(x.am + x.pm))));
    const m = h('input', { type: 'month', value: d.month, max: d.today.slice(0, 7), onchange: (e) => { if (e.target.value) { P.month = e.target.value; again(); } } });
    v.append(h('div', { class: 'bar' }, h('label', { class: 'tag' }, 'Month ', m)),
      h('p', { class: 'tag' }, upTo ? `Updated up to ${dayLabel(upTo)}. Each day is added at ${d.update_hour > 12 ? d.update_hour - 12 : d.update_hour} ${d.update_hour >= 12 ? 'PM' : 'AM'}.` : `Not updated yet — each day is added at ${d.update_hour > 12 ? d.update_hour - 12 : d.update_hour} ${d.update_hour >= 12 ? 'PM' : 'AM'}.`),
      h('div', { class: 'hero' }, h('div', { class: 'l' }, d.due > 0 ? 'Amount due' : 'All settled'), h('div', { class: 'big' }, inr(Math.max(d.due, 0))),
        h('div', { class: 'row' }, h('div', {}, 'Milk so far', h('b', {}, lit(d.total) + ' L')), h('div', {}, 'Bill so far', h('b', {}, inr(d.amount))), h('div', {}, 'You paid', h('b', {}, inr(d.paid))), h('div', {}, 'Pending', h('b', {}, inr(Math.max(d.due, 0))))),
        null),
      d.paid > 0 ? h('div', { class: 'thanks' }, h('div', { class: 'tick' }, '✓'), h('div', {}, h('b', {}, d.due > 0 ? 'Thank you for your payment!' : 'Thank you! Your bill is paid in full.'),
        h('div', { class: 'tag' }, d.due > 0 ? `We received ${inr(d.paid)}. ${inr(d.due)} is still pending.` : `We received ${inr(d.paid)}. Nothing is pending.`))) : null,
      monthCalendar(d),
      h('h2', {}, 'Daily details'),
      h('div', { class: 'tablewrap noselect' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Morning', 'Evening', 'Litres'].map((t, i) => h('th', { class: i ? 'n' : '' }, t)))), h('tbody', {}, rows),
        h('tfoot', {}, h('tr', {}, h('td', {}, 'Total'), h('td', { class: 'n' }, lit(d.am)), h('td', { class: 'n' }, lit(d.pm)), h('td', { class: 'n' }, lit(d.total)))))),
      d.extras.length ? h('div', {}, h('h2', {}, 'Extras delivered'), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Item', 'Qty', 'Amount'].map((t, i) => h('th', { class: i > 1 ? 'n' : '' }, t)))),
        h('tbody', {}, d.extras.map((x) => h('tr', {}, h('td', {}, dayLabel(x.date)), h('td', {}, x.product || 'Item'), h('td', { class: 'n' }, qtyText(x.qty, x.unit)), h('td', { class: 'n' }, inr(x.qty * x.price))))),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: 3 }, 'Extras total (included in your bill)'), h('td', { class: 'n' }, inr(d.extras_total))))))) : null,
      d.payments.length ? h('div', {}, h('h2', {}, 'Payments received'), h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, d.payments.map((p) => h('tr', {}, h('td', {}, p.date), h('td', {}, p.mode || ''), h('td', { class: 'n' }, inr(p.amount))))))))  : null,
      h('p', { class: 'tag' }, `Rate: ${inr(d.customer.price)} per litre.`));
  } else if (P.tab === 'shop') {
    const sh = await api('portal/products');
    const card = (i) => {
      const dec = i.unit === 'Litre' || i.unit === 'Kg';
      const q = h('input', { type: 'number', min: dec ? 0.25 : 1, step: dec ? 'any' : 1, inputmode: dec ? 'decimal' : 'numeric', placeholder: dec ? 'Litres' : 'How many', 'aria-label': i.name + ' quantity', disabled: !i.left });
      const go = guard(async () => { await api('portal/orders', 'POST', { product_id: i.id, qty: q.value }); toast('Booked!'); again(); });
      return h('form', { class: 'rcard', onsubmit: (e) => { e.preventDefault(); go(); } }, h('div', { class: 'rname' }, i.name), h('div', { class: 'tag' }, `${inr(i.price)} per ${i.unit === 'Nos' ? 'piece' : i.unit.toLowerCase()}`),
        h('div', { style: 'margin:8px 0' }, i.left ? h('b', {}, `${qtyText(i.left, i.unit)} available`) : h('b', { class: 'bad' }, 'Sold out')),
        h('div', { class: 'bar' }, q, h('button', { class: 'pri', type: 'submit', disabled: !i.left }, 'Book')));
    };
    v.append(h('h2', { style: 'margin-top:0' }, 'Extras'), h('p', { class: 'tag' }, 'Book egg, ghee, curd and more. The quantity left goes down as people book. The admin will deliver it to you.'),
      sh.items.length ? h('div', { class: 'cards-list' }, sh.items.map(card)) : h('p', { class: 'mute' }, 'Nothing is available to book right now.'),
      h('h2', {}, 'My bookings'),
      sh.orders.length ? h('div', { class: 'cards-list' }, sh.orders.map((o) => h('div', { class: 'rcard' }, h('div', { class: 'rname' }, `${o.product || 'Item'} — ${qtyText(o.qty, o.unit)}`),
        h('div', { class: 'tag' }, `${dayLabel(o.date)} · ${inr(o.qty * o.price)}`), h('div', { style: 'margin-top:6px' }, pill(o.status)),
        o.status === 'Booked' ? h('div', { class: 'ract' }, h('button', { class: 'abs', onclick: guard(async () => { if (!confirm('Cancel this booking?')) return; await api('portal/orders/' + o.id, 'DELETE'); toast('Cancelled'); again(); }) }, 'Cancel')) : null)))
        : h('p', { class: 'mute' }, 'You have not booked anything yet.'));
  } else if (P.tab === 'skip') {
    const f = h('input', { type: 'date', value: d.tomorrow, min: d.today, required: true }), t = h('input', { type: 'date', value: d.tomorrow, min: d.today, required: true });
    f.addEventListener('change', () => { if (t.value < f.value) t.value = f.value; t.min = f.value; });
    const ses = h('select', {}, h('option', { value: 'AM' }, 'Morning'), h('option', { value: 'PM' }, 'Evening'), h('option', { value: 'BOTH' }, 'Morning & Evening'));
    const note = h('input', { type: 'text', placeholder: 'Optional note (e.g. out of town)', maxlength: 200 });
    v.append(h('form', { class: 'form card', onsubmit: guard(async (e) => { e.preventDefault(); await api('portal/skips', 'POST', { from: f.value, to: t.value, session: ses.value, note: note.value }); toast('Sent to the delivery team'); again(); }) },
      h('h2', { style: 'margin-top:0' }, "I don't need milk"), h('p', { class: 'tag' }, 'Your delivery boy and the admin are notified. You are not billed for the days you skip. You can pause from today too.'),
      h('label', {}, 'From', f), h('label', {}, 'To (last day)', t), h('label', {}, 'Which delivery', ses), h('label', {}, 'Note', note), h('button', { class: 'pri', type: 'submit' }, 'Send request')),
      h('h2', {}, 'Your requests'),
      d.skips.length ? h('div', { class: 'cards-list' }, d.skips.map((k) => h('div', { class: 'rcard' }, h('div', { class: 'rname' }, k.from === k.to ? dayLabel(k.from) : `${dayLabel(k.from)} → ${dayLabel(k.to)}`), h('div', { class: 'tag' }, { AM: 'Morning', PM: 'Evening', BOTH: 'Morning & Evening' }[k.session] + (k.note ? ' · ' + k.note : '')),
        h('div', { class: 'ract' }, h('button', { class: 'abs', onclick: guard(async () => { if (!confirm(k.from <= d.today ? 'Start getting milk again from today?' : 'Cancel this request?')) return; await api('portal/skips/' + k.id, 'DELETE'); toast('Done'); again(); }) }, k.from <= d.today ? 'Resume milk from today' : 'Cancel'))))) : h('p', { class: 'mute' }, 'No active requests.'));
  } else {
    const o = h('input', { type: 'password', autocomplete: 'current-password', required: true }), n1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 6, required: true }), n2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 6, required: true });
    v.append(nameForm(false), h('form', { class: 'form card', style: 'margin-top:12px', onsubmit: guard(async (e) => { e.preventDefault(); if (n1.value !== n2.value) return toast('New passwords do not match', true); await api('portal/password', 'PUT', { old: o.value, password: n1.value }); toast('Password changed'); again(); }) },
      h('h2', { style: 'margin-top:0' }, 'Change password'), h('p', { class: 'tag' }, 'If you forget your password, ask the admin to reset it.'),
      h('label', {}, 'Current password', pwBox(o)), h('label', {}, 'New password (min 6 characters)', pwBox(n1)), h('label', {}, 'Repeat new password', pwBox(n2)), h('button', { class: 'pri', type: 'submit' }, 'Change password')));
  }
};

// ---------- router ----------
// Monthly calendar: each date coloured by its status (green = delivered, yellow = paused, red = milk unavailable).
function monthCalendar(d) {
  const first = new Date(d.month + '-01T00:00:00'), lead = (first.getDay() + 6) % 7; // Monday first
  const cells = [...Array(lead).fill(null), ...d.days];
  const cls = { Delivered: 'ok', Paused: 'pause', Unavailable: 'out' };
  return h('div', { class: 'cal noselect' },
    h('div', { class: 'cal-grid' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => h('div', { class: 'cal-w' }, w)),
      cells.map((x) => x ? h('div', { class: 'cal-d ' + (cls[x.st] || ''), title: x.st ? (x.st === 'Unavailable' ? 'Milk Unavailable' : x.st) : '' }, Number(x.date.slice(8))) : h('div', {}))),
    h('div', { class: 'cal-key' }, h('span', { class: 'ok' }, 'Delivered'), h('span', { class: 'pause' }, 'Paused'), h('span', { class: 'out' }, 'Milk Unavailable')));
}
const NAV = [['dashboard', 'Dashboard'], ['delivery', 'Delivery'], ['notices', 'Notices'], ['daily', 'Daily Summary'], ['bills', 'Bills'], ['customers', 'Customers'], ['income', 'Income'], ['expenses', 'Expenses'], ['pnl', 'P&L'], ['cows', 'Cows'], ['yield', 'Cow Yield'], ['extras', 'Extras'], ['settings', 'Settings']];
const DELIVERY_NAV = [['delivery', 'Deliveries'], ['notices', 'Notices']];
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
  const form = h('form', { class: 'login form', onsubmit: guard(async (e) => {
    e.preventDefault();
    await api('login', 'POST', { role: mode, id: id.value, password: pw.value });
    if (mode === 'customer') localStorage.setItem('grv.cid', id.value.trim().toUpperCase());
    S.lists = null; S.user = null; render();
  }) }, h('img', { class: 'logo big', src: 'logo.png', alt: 'GRV Dairy' }), h('h1', { style: 'text-align:center;font-size:19px;margin-bottom:2px' }, title),
    h('p', { class: 'tag' }, mode === 'customer' ? 'Fresh milk, delivered daily' : 'GRV Dairy staff'),
    mode === 'customer' ? h('label', {}, 'Customer ID', id) : null, h('label', {}, 'Password', pwBox(pw)), h('button', { class: 'pri', type: 'submit' }, 'Sign in'));
  v.append(form); (mode === 'customer' && !id.value ? id : pw).focus();
}

async function render() {
  if (!S.user) {
    try { S.user = await api('me'); } catch { return showLogin(); }
  }
  hdr.hidden = false;
  const role = S.user.role, admin = role === 'admin';
  const [hashPage, arg] = (location.hash.slice(2) || '').split('/');
  const nav = $('#nav'); nav.innerHTML = ''; nav.classList.remove('open');
  let page;
  if (role === 'customer') page = 'portal';
  else if (role === 'delivery') page = hashPage === 'notices' ? 'notices' : 'delivery';
  else page = hashPage || 'dashboard';
  // the red count bubbles load in the background so they never hold the page up
  const badgeP = Promise.all([
    role !== 'customer' ? api('notices').then((n) => n.items.filter((k) => k.from <= n.today).length, () => 0) : 0,
    admin ? api('cow-alerts').then((a) => a.length, () => 0) : 0]);
  const links = admin ? NAV : role === 'delivery' ? DELIVERY_NAV : [];
  for (const [k, l] of links) nav.append(h('a', { href: '#/' + k, class: k === page || (page === 'bill' && k === 'bills') ? 'on' : '' }, l));
  $('#menu').hidden = !links.length; $('.month').hidden = !admin;
  $('#who').textContent = { admin: 'Admin', delivery: 'Delivery', customer: S.user.cid }[role];
  document.body.classList.toggle('customer', role === 'customer');
  const v = $('#view'); v.innerHTML = '';
  v.append = (...kids) => Element.prototype.append.apply(v, kids.flat().filter((k) => k != null && k !== false)); // pages may pass null for "nothing"
  badgeP.then(([badge, cowBadge]) => {
    for (const a of nav.children) {
      const k = a.getAttribute('href').slice(2);
      if (k === 'notices' && badge) a.append(h('span', { class: 'badge' }, badge)); else if (k === 'cows' && cowBadge) a.append(h('span', { class: 'badge cow' }, cowBadge));
    }
  });
  try { S.lists = S.lists || (admin ? await api('lists') : {}); await (pages[page] || pages.dashboard)(v, arg); }
  catch (e) { if (S.user) v.append(h('p', { class: 'bad' }, 'Error: ' + e.message)); }
}
$('#menu').addEventListener('click', () => $('#nav').classList.toggle('open'));
$('#logout').addEventListener('click', guard(async () => { await api('logout', 'POST'); S.user = null; S.lists = null; render(); }));
window.addEventListener('hashchange', () => { D.data = null; render(); });
monthInput.addEventListener('change', () => { D.data = null; });
render();
