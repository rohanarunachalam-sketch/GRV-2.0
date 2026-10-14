'use strict';
// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
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

// ---------- modal form ----------
function openForm({ title, fields, values = {}, onSave }) {
  const dlg = $('#dlg'); dlg.innerHTML = '';
  const inputs = {};
  const form = h('form', { class: 'form', method: 'dialog' }, h('h1', {}, title),
    fields.map((f) => {
      let el;
      const v = values[f.key] ?? f.default ?? '';
      if (f.type === 'select') el = h('select', {}, (f.options || []).map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return h('option', { value: val, selected: String(val) === String(v) }, lab); }));
      else if (f.type === 'textarea') { el = h('textarea', { rows: 2 }); el.value = v; }
      else { el = h('input', { type: f.type || 'text', step: f.type === 'number' ? 'any' : null, min: f.type === 'number' ? 0 : null, value: v, required: f.required, autocomplete: 'off' }); }
      inputs[f.key] = el;
      return h('label', {}, f.label, el);
    }),
    h('div', { class: 'acts' }, h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'pri', type: 'submit' }, 'Save')));
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const data = {}; for (const f of fields) data[f.key] = inputs[f.key].value;
    await onSave(data); dlg.close();
  }));
  dlg.append(form); dlg.showModal();
  const first = Object.values(inputs)[0]; if (first) first.focus();
}

// ---------- generic table ----------
function table(cols, rows, { foot } = {}) {
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'n' : '' }, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.num ? 'n' : '' }, c.render ? c.render(r) : r[c.key] ?? ''))))),
    foot ? h('tfoot', {}, h('tr', {}, cols.map((c, i) => h('td', { class: c.num ? 'n' : '' }, foot[i] ?? '')))) : null));
}
const pill = (s) => h('span', { class: 'pill ' + String(s).split(' ')[0] }, s);
const actions = (edit, del) => h('span', {}, h('button', { class: 'link', onclick: edit }, 'Edit'), h('button', { class: 'link del', onclick: del }, 'Delete'));
const confirmDel = (what) => confirm(`Delete ${what}? This cannot be undone.`);

// ---------- pages ----------
const pages = {};

pages.dashboard = async (v) => {
  const d = await api('dashboard?month=' + S.month);
  const max = Math.max(1, ...d.daily.map((x) => x.total));
  v.append(h('h1', {}, 'Dashboard'), h('p', { class: 'sub' }, monthLabel(S.month)),
    h('div', { class: 'cards' },
      [['Active Customers', `${d.active} / ${d.customers}`], ['Milk Sold', lit(d.litres) + ' L'], ['Total Sales', inr(d.sales)], ['Payments Collected', inr(d.collected)],
        ['Pending Amount', inr(d.pending), d.pending > 0 ? 'warn' : ''], ['Other Income', inr(d.other_income)], ['Expenses', inr(d.expenses)], ['Net Profit', inr(d.net), d.net >= 0 ? 'good' : 'bad'],
        ['Cow Yield', lit(d.yield_litres) + ' L']].map(([l, val, c]) => h('div', { class: 'card' }, h('div', { class: 'l' }, l), h('div', { class: 'v ' + (c || '') }, val)))),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Litres per day'), h('div', { class: 'spark' }, d.daily.map((x) => h('div', { style: `height:${(x.total / max) * 100}%`, title: `${dayLabel(x.date)}: ${lit(x.total)} L` })))),
      h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Highest pending'),
        d.top_pending.length ? h('div', { class: 'bars' }, d.top_pending.map((p) => h('div', { class: 'row' }, h('span', { class: 'name' }, p.name), h('span', { class: 'bar-fill', style: `width:${(p.pending / d.top_pending[0].pending) * 160}px` }), inr(p.pending)))) : h('p', { class: 'mute' }, 'Nothing pending 🎉'))));
};

// Delivery: day entry + whole-month grid. Blank = default quantity, 0 = no delivery.
const D = { view: innerWidth < 800 ? 'cards' : 'day', date: null, session: 'AM', filter: '', data: null, month: null };
// Phone-friendly cards: one per customer for a date + session, with − / + and Absent. Used by delivery staff and admin.
const R = { session: new Date().getHours() < 14 ? 'AM' : 'PM', date: null, filter: '' };
async function routeView(v) {
  const staff = S.user.role !== 'admin';
  if (staff || !R.date) R.date = (R.date && (!staff || [S.user.today, S.user.yesterday].includes(R.date))) ? R.date : (staff ? S.user.today : monthDefaultDate());
  const data = await api(`route?date=${R.date}&session=${R.session}`);
  const items = data.items;
  const eff = (it) => (it.qty ?? it.def);
  const cardsBox = h('div', { class: 'cards-list' });
  const prog = h('b', {});
  const setQ = guard(async (it, val, card) => {
    val = Math.max(0, Math.round(val * 100) / 100);
    const send = val === it.def ? null : val; // back to default clears the override
    await api('delivery', 'PUT', { date: R.date, customer_id: it.id, session: R.session, qty: send });
    it.qty = send; paint(it, card);
  });
  const paint = (it, card) => {
    const q = eff(it);
    card.className = 'rcard' + (it.qty === 0 ? ' absent' : it.qty !== null ? ' changed' : '');
    card.querySelector('.qty').textContent = lit(q) + ' L';
    card.querySelector('.def').textContent = it.qty === null ? 'usual quantity' : it.qty === 0 ? 'ABSENT (usual ' + lit(it.def) + ' L)' : 'changed (usual ' + lit(it.def) + ' L)';
    const ab = card.querySelector('.abs'); ab.textContent = it.qty === 0 ? 'Undo' : '✕ Absent'; ab.classList.toggle('on', it.qty === 0);
    stats();
  };
  const stats = () => { const done = items.filter((i) => i.qty !== null).length; prog.textContent = `${lit(items.reduce((a, i) => a + eff(i), 0))} L to deliver · ${items.filter((i) => eff(i) > 0).length} customers · ${done} changed`; };
  const card = (it) => {
    const c = h('div', { class: 'rcard', 'data-name': (it.name + ' ' + it.id).toLowerCase() },
      h('div', { class: 'rtop' }, h('div', {}, h('div', { class: 'rname' }, it.name), h('div', { class: 'def tag' })), h('div', { class: 'qty' })),
      h('div', { class: 'ract' }, h('button', { class: 'step', onclick: () => setQ(it, eff(it) - 0.25, c) }, '−'), h('button', { class: 'step', onclick: () => setQ(it, eff(it) + 0.25, c) }, '+'),
        h('button', { class: 'abs', onclick: () => setQ(it, it.qty === 0 ? it.def : 0, c) }), h('button', { class: 'step', title: 'Type exact quantity', onclick: () => { const x = prompt(`${it.name} — quantity in litres`, eff(it)); if (x !== null && x.trim() !== '' && Number(x) >= 0) setQ(it, Number(x), c); } }, '✎')));
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
    h('div', { class: 'bar sticky' }, dateCtl, sessionSeg, search), h('div', { class: 'bar' }, prog), cardsBox);
  if (R.filter) for (const c of cardsBox.children) c.hidden = !c.dataset.name.includes(R.filter);
  if (!items.length) cardsBox.append(h('p', { class: 'mute' }, 'No customers for this session.'));
  stats();
}

pages.delivery = async (v) => {
  if (S.user.role !== 'admin' || D.view === 'cards') return routeView(v);
  if (D.month !== S.month || !D.data) { D.data = await api('delivery?month=' + S.month); D.month = S.month; D.ov = new Map(D.data.entries.map((e) => [`${e.c}|${e.d}|${e.s}`, e.q])); }
  if (!D.date || !D.date.startsWith(S.month)) D.date = monthDefaultDate();
  const dayStr = (n) => `${S.month}-${pad(n)}`;
  const defQ = (c, s) => (c.status === 'Active' ? (s === 'AM' ? c.am : c.pm) : 0);
  const save = guard(async (c, date, s, input) => {
    const raw = input.value.trim(); const k = `${c.id}|${date}|${s}`;
    if (raw !== '' && !(Number(raw) >= 0)) { toast('Enter a number ≥ 0', true); input.value = D.ov.has(k) ? D.ov.get(k) : ''; return; }
    await api('delivery', 'PUT', { date, customer_id: c.id, session: s, qty: raw === '' ? null : Number(raw) });
    if (raw === '') D.ov.delete(k); else D.ov.set(k, Number(raw));
    paint(input, c, date, s); refreshTotals();
  });
  const paint = (input, c, date, s) => { const k = `${c.id}|${date}|${s}`; input.classList.toggle('set', D.ov.has(k)); input.classList.toggle('zero', D.ov.get(k) === 0); };
  const qInput = (c, date, s) => {
    const k = `${c.id}|${date}|${s}`; const dq = defQ(c, s);
    const i = h('input', { class: 'q', type: 'number', step: 'any', min: 0, inputmode: 'decimal', placeholder: lit(dq), value: D.ov.has(k) ? D.ov.get(k) : '', title: `${c.name} ${s} — default ${lit(dq)}` });
    i.addEventListener('change', () => save(c, date, s, i)); paint(i, c, date, s); return i;
  };
  const eff = (c, date, s) => { const k = `${c.id}|${date}|${s}`; return D.ov.has(k) ? D.ov.get(k) : defQ(c, s); };
  let totalEl;
  const refreshTotals = () => {
    if (!totalEl) return;
    if (D.view === 'day') { let a = 0, p = 0; for (const c of D.data.customers) { a += eff(c, D.date, 'AM'); p += eff(c, D.date, 'PM'); } totalEl.textContent = `AM ${lit(a)} L · PM ${lit(p)} L · Total ${lit(a + p)} L`; }
    else { let t = 0; for (const c of D.data.customers) for (let n = 1; n <= D.data.days; n++) t += eff(c, dayStr(n), D.session); totalEl.textContent = `${D.session} total for month: ${lit(t)} L`; }
  };
  const match = (c) => !D.filter || (c.name + c.id).toLowerCase().includes(D.filter.toLowerCase());
  const reRender = () => { v.innerHTML = ''; pages.delivery(v); };

  const tabs = h('div', { class: 'seg' }, ['cards', 'day', 'month'].map((k) => h('button', { class: D.view === k ? 'on' : '', onclick: () => { D.view = k; reRender(); } }, { cards: 'Cards', day: 'Table', month: 'Month grid' }[k])));
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
    body = h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['ID', 'Customer', 'AM default', 'AM actual', 'PM default', 'PM actual', 'Litres', 'Amount', ''].map((t, i) => h('th', { class: i > 1 && i < 8 ? 'n' : '' }, t)))),
      h('tbody', {}, rows.map((c) => {
        const tl = h('td', { class: 'n' }), am = h('td', { class: 'n' });
        const upd = () => { const t = eff(c, D.date, 'AM') + eff(c, D.date, 'PM'); tl.textContent = lit(t); am.textContent = inr(t * c.price); };
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
        return h('tr', {}, h('td', {}, c.id), h('td', {}, c.name, c.status === 'Inactive' ? h('span', { class: 'tag' }, ' (inactive)') : ''), h('td', { class: 'n mute' }, lit(defQ(c, 'AM'))), h('td', { class: 'n' }, a), h('td', { class: 'n mute' }, lit(defQ(c, 'PM'))), h('td', { class: 'n' }, p), tl, am, h('td', {}, btn));
      }))));
  } else {
    bar.append(h('div', { class: 'seg' }, ['AM', 'PM'].map((s) => h('button', { class: D.session === s ? 'on' : '', onclick: () => { D.session = s; reRender(); } }, s))), search, h('span', { class: 'grow' }), totalEl);
    const days = Array.from({ length: D.data.days }, (_, i) => i + 1);
    const rows = D.data.customers.filter(match);
    body = h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Customer'), h('th', { class: 'n' }, 'Default'), days.map((n) => h('th', { class: 'n' }, n)), h('th', { class: 'n' }, 'Total'))),
      h('tbody', {}, rows.map((c) => {
        const tot = h('td', { class: 'n' });
        const upd = () => { let t = 0; for (const n of days) t += eff(c, dayStr(n), D.session); tot.textContent = lit(t); };
        upd();
        return h('tr', {}, h('td', {}, c.name), h('td', { class: 'n mute' }, lit(defQ(c, D.session))),
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
      { label: 'ID', key: 'id' }, { label: 'Customer', key: 'name' }, { label: 'Phone', key: 'phone' }, { label: 'AM L', num: 1, render: (r) => lit(r.am) }, { label: 'PM L', num: 1, render: (r) => lit(r.pm) },
      { label: 'Total L', num: 1, render: (r) => lit(r.total) }, { label: 'Price/L', num: 1, render: (r) => lit(r.price) }, { label: 'Bill', num: 1, render: (r) => inr(r.amount) },
      { label: 'Paid', num: 1, render: (r) => inr(r.paid) }, { label: 'Pending', num: 1, render: (r) => h('span', { class: r.pending > 0 ? 'bad' : '' }, inr(r.pending)) }, { label: 'Status', render: (r) => pill(r.pay_status) },
      { label: '', render: (r) => h('span', {}, h('a', { href: `#/bill/${r.id}` }, h('button', { class: 'link' }, '🧾 Bill')), h('button', { class: 'link', onclick: () => payFor(r) }, '+ Payment')) },
    ], rs, { foot: ['', 'Total', '', lit(sum('am')), lit(sum('pm')), lit(sum('total')), '', inr(sum('amount')), inr(sum('paid')), inr(sum('pending')), '', ''] }));
  };
  const payFor = (r) => openForm({ title: `Payment — ${r.name}`, fields: paymentFields(r.id, Math.max(r.pending, 0)), onSave: async (d) => { await api('payments', 'POST', d); toast('Payment saved'); render(); } });
  v.append(h('h1', {}, 'Monthly Bills'), h('p', { class: 'sub' }, `${monthLabel(S.month)} — built from actual daily AM/PM quantities.`),
    h('div', { class: 'bar' }, h('input', { type: 'search', placeholder: 'Search customer…', oninput: (e) => { filter = e.target.value; draw(); } }), h('span', { class: 'grow' }),
      h('a', { href: '#/bill/all' }, h('button', {}, '🧾 All bills')), h('a', { href: 'api/bills.csv?month=' + S.month }, h('button', {}, '⬇ CSV')), h('button', { onclick: () => print() }, '🖨 Print')), holder);
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
    h('div', { class: 'inv-to' }, h('div', { class: 'tag' }, 'Bill to'), h('b', { style: 'font-size:18px' }, b.name), h('div', {}, b.id + (b.phone ? ' · ' + b.phone : ''))),
    h('div', { class: 'inv-cols' }, dayTable(b.days.slice(0, half)), dayTable(b.days.slice(half))),
    h('table', { class: 'inv-sum' }, h('tbody', {}, row('Morning (AM) litres', lit(b.am) + ' L'), row('Evening (PM) litres', lit(b.pm) + ' L'), row('Total litres', lit(b.total) + ' L', 'b'), row('Rate per litre', inr(b.price)),
      row('Bill amount', inr(b.amount), 'b'), ...b.payments.map((p) => row(`Paid ${p.date}${p.mode ? ' (' + p.mode + ')' : ''}`, '− ' + inr(p.amount))), row(b.pending > 0 ? 'Amount due' : 'Balance', inr(b.pending), 'due ' + (b.pending > 0 ? 'bad' : 'good')))),
    h('div', { class: 'inv-foot' }, 'Thank you for your business! — GRV Dairy Products'));
}
const waLink = (b) => {
  let ph = (b.phone || '').replace(/\D/g, ''); if (ph.length === 10) ph = '91' + ph;
  const t = `GRV Dairy — ${monthLabel(b.month)} milk bill\n${b.name}\n${lit(b.total)} L × ${inr(b.price)} = ${inr(b.amount)}\n` + (b.paid ? `Paid: ${inr(b.paid)}\n` : '') + (b.pending > 0 ? `Amount due: ${inr(b.pending)}` : 'No balance due. Thank you!');
  return `https://wa.me/${ph}?text=${encodeURIComponent(t)}`;
};
pages.bill = async (v, arg) => {
  const all = !arg || arg === 'all';
  const list = await api(`bill?month=${S.month}` + (all ? '' : '&id=' + encodeURIComponent(arg)));
  v.append(h('div', { class: 'bar' }, h('a', { href: '#/bills' }, h('button', {}, '← Bills')), h('button', { class: 'pri', onclick: () => print() }, '🖨 Print / Save PDF'),
    !all ? h('a', { href: waLink(list[0]), target: '_blank', rel: 'noopener' }, h('button', {}, 'WhatsApp')) : null,
    h('span', { class: 'tag' }, all ? `${list.length} bills for ${monthLabel(S.month)}` : '')));
  if (!list.length) v.append(h('p', { class: 'mute' }, 'No bills for this month.'));
  for (const b of list) v.append(invoice(b));
};

// ---- CRUD pages
let customersCache = null;
const loadCustomers = async () => (customersCache = await api('customers'));
const custName = (id) => (customersCache.find((c) => c.id === id) || {}).name || id;

const paymentFields = (cid, amount) => [
  { key: 'date', label: 'Date', type: 'date', default: monthDefaultDate(), required: true },
  { key: 'customer_id', label: 'Customer', type: 'select', default: cid, options: customersCache.map((c) => [c.id, `${c.id} — ${c.name}`]) },
  { key: 'bill_month', label: 'Bill month', type: 'month', default: S.month, required: true },
  { key: 'amount', label: 'Amount (₹)', type: 'number', default: amount || '', required: true },
  { key: 'mode', label: 'Payment mode', type: 'select', options: S.lists.modes },
  { key: 'status', label: 'Status', type: 'text' }, { key: 'remarks', label: 'Remarks', type: 'text' },
];

function crud({ title, sub, resource, cols, fields, monthly = true, total, master, idKey = 'id', extraBar }) {
  return async (v) => {
    S.lists = await api('lists'); await loadCustomers();
    const load = () => api(resource + (monthly ? '?month=' + S.month : ''));
    let rows = await load(), filter = '';
    const holder = h('div');
    const F = typeof fields === 'function' ? fields : () => fields;
    const edit = (r) => openForm({ title: (r ? 'Edit ' : 'Add ') + title, fields: F(), values: r || {}, onSave: async (d) => { await api(r ? `${resource}/${r[idKey]}` : resource, r ? 'PUT' : 'POST', d); toast('Saved'); render(); } });
    const draw = () => {
      holder.innerHTML = '';
      const rs = rows.filter((r) => !filter || JSON.stringify(Object.values(r)).toLowerCase().includes(filter.toLowerCase()) || (r.customer_id && custName(r.customer_id).toLowerCase().includes(filter.toLowerCase())));
      const c = [...cols, { label: '', render: (r) => actions(() => edit(r), guard(async () => { if (!confirmDel(master ? r.name : 'this entry')) return; await api(`${resource}/${r[idKey]}`, 'DELETE'); toast('Deleted'); render(); })) }];
      holder.append(table(c, rs, total ? { foot: total(rs, c.length) } : undefined));
    };
    v.append(h('h1', {}, /s$|Income|Yield/.test(title) ? (title === 'Income' ? 'Income' : title) : title + 's'), h('p', { class: 'sub' }, sub + (monthly ? ` Showing ${monthLabel(S.month)}.` : '')),
      h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: () => edit() }, '+ Add'), h('input', { type: 'search', placeholder: 'Search…', oninput: (e) => { filter = e.target.value; draw(); } }), h('span', { class: 'grow' }), extraBar ? extraBar() : null), holder);
    draw();
  };
}
const sumRow = (len, idx, val) => Array.from({ length: len }, (_, i) => (i === idx ? val : i === 0 ? 'Total' : ''));

pages.customers = crud({ title: 'Customer', sub: 'Master list — AM/PM defaults and price used for daily delivery and billing.', resource: 'customers', monthly: false, master: true,
  fields: () => [{ key: 'name', label: 'Name', required: true }, { key: 'phone', label: 'Phone' }, { key: 'am', label: 'AM default qty (L)', type: 'number', default: 0 }, { key: 'pm', label: 'PM default qty (L)', type: 'number', default: 0 },
    { key: 'price', label: 'Price per L (₹)', type: 'number', default: 55 }, { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }],
  cols: [{ label: 'ID', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'Phone', key: 'phone' }, { label: 'AM (L)', num: 1, render: (r) => lit(r.am) }, { label: 'PM (L)', num: 1, render: (r) => lit(r.pm) },
    { label: 'Total (L)', num: 1, render: (r) => lit(r.am + r.pm) }, { label: 'Price/L', num: 1, render: (r) => inr(r.price) }, { label: 'Status', render: (r) => pill(r.status) }],
  total: (rs, n) => sumRow(n, 5, lit(rs.reduce((a, r) => a + r.am + r.pm, 0))),
});

pages.payments = crud({ title: 'Payment', sub: 'Customer bill collections. Don\'t repeat these under Income.', resource: 'payments',
  fields: () => paymentFields(),
  cols: [{ label: 'Date', key: 'date' }, { label: 'Customer', render: (r) => `${r.customer_id} — ${custName(r.customer_id)}` }, { label: 'Bill month', key: 'bill_month' }, { label: 'Amount', num: 1, render: (r) => inr(r.amount) }, { label: 'Mode', key: 'mode' }, { label: 'Status', key: 'status' }, { label: 'Remarks', key: 'remarks' }],
  total: (rs, n) => sumRow(n, 3, inr(rs.reduce((a, r) => a + r.amount, 0))) });
// payments are listed by bill month; the list endpoint filters on bill_month

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

pages.cows = crud({ title: 'Cow', sub: 'Cow master list.', resource: 'cows', monthly: false, master: true,
  fields: () => [{ key: 'name', label: 'Name / number', required: true }, { key: 'breed', label: 'Breed' }, { key: 'lactation', label: 'Lactation status', type: 'select', options: ['', 'Lactating', 'Dry', 'Heifer', 'Calf'] },
    { key: 'calving_date', label: 'Calving date', type: 'date' }, { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Sold', 'Deceased'] }, { key: 'notes', label: 'Notes', type: 'textarea' }],
  cols: [{ label: 'ID', key: 'id' }, { label: 'Name', key: 'name' }, { label: 'Breed', key: 'breed' }, { label: 'Lactation', key: 'lactation' }, { label: 'Calving', key: 'calving_date' }, { label: 'Status', key: 'status' }, { label: 'Notes', key: 'notes' }] });

pages.yield = async (v) => {
  const cows = await api('cows');
  const nameOf = (id) => (cows.find((c) => c.id === id) || {}).name || id;
  if (!cows.length) return v.append(h('h1', {}, 'Cow Yield'), h('p', { class: 'sub' }, 'Add cows in the Cows tab first.'));
  const f = () => [{ key: 'date', label: 'Date', type: 'date', default: monthDefaultDate(), required: true }, { key: 'cow_id', label: 'Cow', type: 'select', options: cows.map((c) => [c.id, `${c.id} — ${c.name}`]) },
    { key: 'am', label: 'AM yield (L)', type: 'number', default: 0 }, { key: 'pm', label: 'PM yield (L)', type: 'number', default: 0 }, { key: 'notes', label: 'Notes' }];
  return crud({ title: 'Cow Yield', sub: 'Daily milk production per cow.', resource: 'cow_yield', fields: f,
    cols: [{ label: 'Date', key: 'date' }, { label: 'Cow', render: (r) => `${r.cow_id} — ${nameOf(r.cow_id)}` }, { label: 'AM (L)', num: 1, render: (r) => lit(r.am) }, { label: 'PM (L)', num: 1, render: (r) => lit(r.pm) }, { label: 'Total (L)', num: 1, render: (r) => lit(r.am + r.pm) }, { label: 'Notes', key: 'notes' }],
    total: (rs, n) => ['Total', '', lit(rs.reduce((a, r) => a + r.am, 0)), lit(rs.reduce((a, r) => a + r.pm, 0)), lit(rs.reduce((a, r) => a + r.am + r.pm, 0)), '', ''].slice(0, n) })(v);
};

pages.daily = async (v) => {
  const rows = await api('daily?month=' + S.month);
  v.append(h('h1', {}, 'Daily Summary'), h('p', { class: 'sub' }, `${monthLabel(S.month)} — litres, deliveries and estimated sales per day.`),
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
    h('div', { class: 'card' }, pwBox('delivery', 'Delivery'), pwBox('admin', 'Admin')));
};

// ---------- router ----------
const NAV = [['dashboard', 'Dashboard'], ['delivery', 'Delivery'], ['daily', 'Daily Summary'], ['bills', 'Bills'], ['payments', 'Payments'], ['customers', 'Customers'], ['income', 'Income'], ['expenses', 'Expenses'], ['pnl', 'P&L'], ['cows', 'Cows'], ['yield', 'Cow Yield'], ['settings', 'Settings']];
const hdr = $('header');

function showLogin() {
  hdr.hidden = true;
  const v = $('#view'); v.innerHTML = '';
  const role = h('select', {}, h('option', { value: 'delivery' }, 'Delivery'), h('option', { value: 'admin' }, 'Admin'));
  role.value = localStorage.getItem('grv.role') || 'delivery';
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true, inputmode: 'text' });
  const form = h('form', { class: 'login form', onsubmit: guard(async (e) => {
    e.preventDefault();
    await api('login', 'POST', { role: role.value, password: pw.value });
    localStorage.setItem('grv.role', role.value); S.lists = null; render();
  }) }, h('img', { class: 'logo big', src: 'logo.png', alt: 'GRV Dairy' }), h('label', {}, 'Sign in as', role), h('label', {}, 'Password', pw), h('button', { class: 'pri', type: 'submit' }, 'Sign in'));
  v.append(form); pw.focus();
}

async function render() {
  if (!S.user) {
    try { S.user = await api('me'); } catch { return showLogin(); }
  }
  hdr.hidden = false;
  const staff = S.user.role !== 'admin';
  const [hashPage, arg] = (location.hash.slice(2) || 'dashboard').split('/');
  const page = staff ? 'delivery' : hashPage;
  const nav = $('#nav'); nav.innerHTML = ''; nav.classList.remove('open');
  if (!staff) for (const [k, l] of NAV) nav.append(h('a', { href: '#/' + k, class: k === page || (page === 'bill' && k === 'bills') ? 'on' : '' }, l));
  $('#menu').hidden = staff; $('.month').hidden = staff;
  $('#who').textContent = staff ? 'Delivery' : 'Admin';
  const v = $('#view'); v.innerHTML = '';
  try { S.lists = S.lists || (staff ? {} : await api('lists')); await (pages[page] || pages.dashboard)(v, arg); }
  catch (e) { if (S.user) v.append(h('p', { class: 'bad' }, 'Error: ' + e.message)); }
}
$('#menu').addEventListener('click', () => $('#nav').classList.toggle('open'));
$('#logout').addEventListener('click', guard(async () => { await api('logout', 'POST'); S.user = null; S.lists = null; render(); }));
window.addEventListener('hashchange', () => { D.data = null; render(); });
monthInput.addEventListener('change', () => { D.data = null; });
render();
