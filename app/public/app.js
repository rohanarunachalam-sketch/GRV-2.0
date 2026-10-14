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
  const eff = (it) => (it.qty ?? (it.skip ? 0 : it.def)); // a customer's no-milk request counts as 0 unless overridden
  const cardsBox = h('div', { class: 'cards-list' });
  const prog = h('b', {});
  const setQ = guard(async (it, val, card) => {
    val = Math.max(0, Math.round(val * 100) / 100);
    const send = val === (it.skip ? 0 : it.def) ? null : val; // back to the usual/requested quantity clears the override
    await api('delivery', 'PUT', { date: R.date, customer_id: it.id, session: R.session, qty: send });
    it.qty = send; paint(it, card);
  });
  const paint = (it, card) => {
    const q = eff(it);
    const skipped = it.skip && it.qty === null;
    card.className = 'rcard' + (skipped ? ' skipped' : it.qty === 0 ? ' absent' : it.qty !== null ? ' changed' : '');
    card.querySelector('.qty').textContent = lit(q) + ' L';
    card.querySelector('.def').textContent = skipped ? `✕ Customer asked: no milk (until ${dayLabel(it.skip.to)})${it.skip.note ? ' — ' + it.skip.note : ''}` : it.qty === null ? 'usual quantity' : it.qty === 0 ? 'ABSENT (usual ' + lit(it.def) + ' L)' : 'changed (usual ' + lit(it.def) + ' L)';
    const ab = card.querySelector('.abs'); ab.textContent = q === 0 ? 'Undo' : '✕ Absent'; ab.classList.toggle('on', q === 0);
    stats();
  };
  const stats = () => { const done = items.filter((i) => i.qty !== null).length, sk = items.filter((i) => i.skip && i.qty === null).length; prog.textContent = `${lit(items.reduce((a, i) => a + eff(i), 0))} L to deliver · ${items.filter((i) => eff(i) > 0).length} customers · ${done} changed` + (sk ? ` · ✕ ${sk} customer request${sk > 1 ? 's' : ''} (no milk)` : ''); };
  const card = (it) => {
    const c = h('div', { class: 'rcard', 'data-name': (it.name + ' ' + it.id).toLowerCase() },
      h('div', { class: 'rtop' }, h('div', {}, h('div', { class: 'rname' }, it.name), h('div', { class: 'def tag' })), h('div', { class: 'qty' })),
      h('div', { class: 'ract' }, h('button', { class: 'step', onclick: () => setQ(it, eff(it) - 0.25, c) }, '−'), h('button', { class: 'step', onclick: () => setQ(it, eff(it) + 0.25, c) }, '+'),
        h('button', { class: 'abs', onclick: () => setQ(it, eff(it) === 0 ? it.def : 0, c) }), h('button', { class: 'step', title: 'Type exact quantity', onclick: () => { const x = prompt(`${it.name} — quantity in litres`, eff(it)); if (x !== null && x.trim() !== '' && Number(x) >= 0) setQ(it, Number(x), c); } }, 'Edit')));
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
  if (D.month !== S.month || !D.data) { D.data = await api('delivery?month=' + S.month); D.month = S.month; D.ov = new Map(D.data.entries.map((e) => [`${e.c}|${e.d}|${e.s}`, e.q])); D.skips = new Set(D.data.skips.map((e) => `${e.c}|${e.d}|${e.s}`)); }
  if (!D.date || !D.date.startsWith(S.month)) D.date = monthDefaultDate();
  const dayStr = (n) => `${S.month}-${pad(n)}`;
  const defQ = (c, s) => (c.status === 'Active' ? (s === 'AM' ? c.am : c.pm) : 0);
  const baseQ = (c, date, s) => (D.skips.has(`${c.id}|${date}|${s}`) ? 0 : defQ(c, s)); // customer "no milk" request = 0
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
      { label: 'ID', key: 'id' }, { label: 'Customer', render: (r) => h('span', {}, r.name, r.bill_name ? h('div', { class: 'tag' }, 'Bill name: ' + r.bill_name) : null) }, { label: 'Phone', key: 'phone' }, { label: 'AM L', num: 1, render: (r) => lit(r.am) }, { label: 'PM L', num: 1, render: (r) => lit(r.pm) },
      { label: 'Total L', num: 1, render: (r) => lit(r.total) }, { label: 'Price/L', num: 1, render: (r) => lit(r.price) }, { label: 'Bill', num: 1, render: (r) => inr(r.amount) },
      { label: 'Paid', num: 1, render: (r) => inr(r.paid) }, { label: 'Pending', num: 1, render: (r) => h('span', { class: r.pending > 0 ? 'bad' : '' }, inr(r.pending)) }, { label: 'Status', render: (r) => pill(r.pay_status) },
      { label: '', render: (r) => h('span', {}, h('a', { href: `#/bill/${r.id}` }, h('button', { class: 'link' }, 'Bill')), h('button', { class: 'link', onclick: () => payFor(r) }, 'Payment')) },
    ], rs, { foot: ['', 'Total', '', lit(sum('am')), lit(sum('pm')), lit(sum('total')), '', inr(sum('amount')), inr(sum('paid')), inr(sum('pending')), '', ''] }));
  };
  // Payment dialog: shows what the customer bought and owes; the amount is pre-filled with the pending balance but can be changed.
  const payFor = guard(async (r) => {
    const paid = (await api('payments?month=' + S.month)).filter((p) => p.customer_id === r.id);
    const line = (l, val, cls = '') => h('div', { class: 'payrow ' + cls }, h('span', {}, l), h('b', {}, val));
    const intro = h('div', { class: 'payinfo' }, h('div', { class: 'tag' }, `${r.id} · ${monthLabel(S.month)}`),
      line('Total milk bought', lit(r.total) + ' L'), line('Bill amount', inr(r.amount)), line('Already paid', inr(r.paid)), line('Pending', inr(Math.max(r.pending, 0)), 'big'),
      paid.length ? h('div', { class: 'paid-list' }, h('div', { class: 'tag' }, 'Payments received'), paid.map((p) => h('div', { class: 'payrow' }, h('span', {}, `${p.date}${p.mode ? ' · ' + p.mode : ''}`),
        h('span', {}, h('b', {}, inr(p.amount)), h('button', { type: 'button', class: 'link del', onclick: guard(async () => { if (!confirm(`Delete this ${inr(p.amount)} payment?`)) return; await api('payments/' + p.id, 'DELETE'); toast('Payment deleted'); $('#dlg').close(); render(); }) }, 'Delete'))))) : null);
    openForm({ title: `Payment — ${r.name}`, intro, saveLabel: 'OK', fields: [
      { key: 'date', label: 'Date', type: 'date', default: monthDefaultDate(), required: true },
      { key: 'customer_id', hidden: true, default: r.id }, { key: 'bill_month', hidden: true, default: S.month },
      { key: 'amount', label: 'Amount received (₹)', type: 'number', placeholder: 'Type the amount', required: true },
      { key: 'mode', label: 'Payment mode', type: 'select', options: S.lists.modes }, { key: 'remarks', label: 'Remarks', type: 'text' }],
    onSave: async (d) => { await api('payments', 'POST', d); toast('Payment saved'); render(); } });
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
    h('table', { class: 'inv-sum' }, h('tbody', {}, row('Morning (AM) litres', lit(b.am) + ' L'), row('Evening (PM) litres', lit(b.pm) + ' L'), row('Total litres', lit(b.total) + ' L', 'b'), row('Rate per litre', inr(b.price)),
      ...b.payments.map((p) => row(`Paid on ${new Date(p.date + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}${p.mode ? ' (' + p.mode + ')' : ''}`, inr(p.amount), 'paid')),
      b.payments.length ? row(b.pending > 0 ? 'Balance due' : 'Balance', b.pending > 0 ? inr(b.pending) : 'Paid in full', 'bal') : null,
      row('Total amount', inr(b.amount), 'total'))),
    h('div', { class: 'inv-foot' }, 'Thank you for your business! — GRV Dairy Products'));
}
const waLink = (b) => {
  let ph = (b.phone || '').replace(/\D/g, ''); if (ph.length === 10) ph = '91' + ph;
  const t = `GRV Dairy — ${monthLabel(b.month)} milk bill\n${b.bill_name || b.name}\n${lit(b.total)} L × ${inr(b.price)} = ${inr(b.amount)}\n` + (b.paid ? `Paid: ${inr(b.paid)}\n` : '') + (b.pending > 0 ? `Amount due: ${inr(b.pending)}` : 'No balance due. Thank you!');
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


function crud({ title, sub, resource, cols, fields, monthly = true, total, master, idKey = 'id', extraBar, rowExtra }) {
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
      const c = [...cols, { label: '', render: (r) => h('span', {}, rowExtra ? rowExtra(r) : null, actions(() => edit(r), guard(async () => { if (!confirmDel(master ? r.name : 'this entry')) return; await api(`${resource}/${r[idKey]}`, 'DELETE'); toast('Deleted'); render(); }))) }];
      holder.append(table(c, rs, total ? { foot: total(rs, c.length) } : undefined));
    };
    v.append(h('h1', {}, /s$|Income|Yield/.test(title) ? (title === 'Income' ? 'Income' : title) : title + 's'), h('p', { class: 'sub' }, sub + (monthly ? ` Showing ${monthLabel(S.month)}.` : '')),
      h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: () => edit() }, '+ Add'), h('input', { type: 'search', placeholder: 'Search…', oninput: (e) => { filter = e.target.value; draw(); } }), h('span', { class: 'grow' }), extraBar ? extraBar() : null), holder);
    draw();
  };
}
const sumRow = (len, idx, val) => Array.from({ length: len }, (_, i) => (i === idx ? val : i === 0 ? 'Total' : ''));

pages.customers = crud({ title: 'Customer', sub: 'Master list — AM/PM defaults and price used for daily delivery and billing.', resource: 'customers', monthly: false, master: true,
  fields: () => [{ key: 'name', label: 'Nickname (only you see this)', required: true }, { key: 'bill_name', label: "Name on bill (the customer's own — they can also set it)" }, { key: 'phone', label: 'Phone' }, { key: 'am', label: 'AM default qty (L)', type: 'number', default: 0 }, { key: 'pm', label: 'PM default qty (L)', type: 'number', default: 0 },
    { key: 'price', label: 'Price per L (₹)', type: 'number', default: 55 }, { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive'] }],
  cols: [{ label: 'ID', key: 'id' }, { label: 'Nickname', key: 'name' }, { label: 'Name on bill', render: (r) => r.bill_name || h('span', { class: 'mute' }, '—') }, { label: 'Phone', key: 'phone' }, { label: 'AM (L)', num: 1, render: (r) => lit(r.am) }, { label: 'PM (L)', num: 1, render: (r) => lit(r.pm) },
    { label: 'Total (L)', num: 1, render: (r) => lit(r.am + r.pm) }, { label: 'Price/L', num: 1, render: (r) => inr(r.price) }, { label: 'Status', render: (r) => pill(r.status) }],
  total: (rs, n) => sumRow(n, 6, lit(rs.reduce((a, r) => a + r.am + r.pm, 0))),
  rowExtra: (r) => h('button', { class: 'link', onclick: () => customerLogin(r) }, 'Login'),
});

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

// Cow yield as a grid: dates down the side, one pair of columns (AM / PM) per cow. Type straight into a cell; it saves when you leave it.
pages.yield = async (v) => {
  const [cows, rows] = await Promise.all([api('cows'), api('cow_yield?month=' + S.month)]);
  const [yy, mm] = S.month.split('-').map(Number), n = new Date(yy, mm, 0).getDate();
  const dayStr = (d) => `${S.month}-${pad(d)}`;
  const data = new Map(rows.map((r) => [`${r.cow_id}|${r.date}`, { am: r.am, pm: r.pm }]));
  const shown = cows.filter((c) => c.status === 'Active' || rows.some((r) => r.cow_id === c.id));
  v.append(h('h1', {}, 'Cow Yield'), h('p', { class: 'sub' }, `${monthLabel(S.month)} — litres per cow per day. Leave a cell empty if there was no milking.`));
  if (!shown.length) return v.append(h('p', { class: 'mute' }, 'No cows yet. '), h('a', { href: '#/cows' }, h('button', { class: 'pri' }, 'Add cows')));
  v.append(h('div', { class: 'bar' }, h('a', { href: '#/cows' }, h('button', {}, 'Manage cows')), h('span', { class: 'grow' })));

  const num = (x) => Number(x) || 0;
  const dayTot = {}, cowTot = {};
  const sumDay = (d) => shown.reduce((a, c) => { const r = data.get(`${c.id}|${dayStr(d)}`); return a + (r ? r.am + r.pm : 0); }, 0);
  const refresh = (d) => {
    dayTot[d].textContent = sumDay(d) ? lit(sumDay(d)) : '–';
    let all = 0;
    for (const c of shown) {
      let am = 0, pm = 0;
      for (let k = 1; k <= n; k++) { const r = data.get(`${c.id}|${dayStr(k)}`); if (r) { am += r.am; pm += r.pm; } }
      cowTot[c.id].am.textContent = lit(am); cowTot[c.id].pm.textContent = lit(pm); all += am + pm;
    }
    cowTot.all.textContent = lit(all);
  };
  const cellPair = (c, d) => {
    const key = `${c.id}|${dayStr(d)}`, r = data.get(key);
    const mk = (which) => h('input', { class: 'q', type: 'number', step: 'any', min: 0, inputmode: 'decimal', 'aria-label': `${c.name} ${which} ${dayStr(d)}`, value: r && r[which] ? r[which] : '' });
    const a = mk('am'), p = mk('pm');
    const save = guard(async () => {
      if ((a.value !== '' && !(Number(a.value) >= 0)) || (p.value !== '' && !(Number(p.value) >= 0))) { toast('Enter a number ≥ 0', true); return; }
      await api('yield-cell', 'PUT', { date: dayStr(d), cow_id: c.id, am: a.value, pm: p.value });
      if (a.value === '' && p.value === '') data.delete(key); else data.set(key, { am: num(a.value), pm: num(p.value) });
      refresh(d);
    });
    a.addEventListener('change', save); p.addEventListener('change', save);
    return [h('td', { class: 'gridcell' }, a), h('td', { class: 'gridcell' }, p)];
  };
  const t = today();
  const body = [];
  for (let d = 1; d <= n; d++) {
    dayTot[d] = h('td', { class: 'n' });
    body.push(h('tr', { class: dayStr(d) === t ? 'today' : '' }, h('td', { class: 'stick' }, dayLabel(dayStr(d))), shown.map((c) => cellPair(c, d)), dayTot[d]));
  }
  cowTot.all = h('td', { class: 'n' });
  const foot = h('tr', {}, h('td', { class: 'stick' }, 'Total'), shown.map((c) => { cowTot[c.id] = { am: h('td', { class: 'n' }), pm: h('td', { class: 'n' }) }; return [cowTot[c.id].am, cowTot[c.id].pm]; }), cowTot.all);
  v.append(h('div', { class: 'tablewrap' }, h('table', { class: 'ygrid' },
    h('thead', {}, h('tr', {}, h('th', { rowspan: 2, class: 'stick' }, 'Date'), shown.map((c) => h('th', { colspan: 2, class: 'ycow', title: c.breed || '' }, c.name)), h('th', { rowspan: 2, class: 'n' }, 'Day total')),
      h('tr', {}, shown.map(() => [h('th', { class: 'n sub2' }, 'AM'), h('th', { class: 'n sub2' }, 'PM')]))),
    h('tbody', {}, body), h('tfoot', {}, foot))));
  for (let d = 1; d <= n; d++) refresh(d);
  const todayRow = $('tr.today'); if (todayRow) todayRow.scrollIntoView({ block: 'center' });
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
  const tabs = h('div', { class: 'seg' }, [['bill', 'My bill'], ['skip', 'No milk'], ['account', 'Account']].map(([k, l]) => h('button', { class: P.tab === k ? 'on' : '', onclick: () => { P.tab = k; again(); } }, l)));
  v.append(h('div', { class: 'who-card' }, h('div', { class: 'avatar' }, (d.customer.name || d.customer.id).trim()[0]?.toUpperCase() || '?'), h('div', {}, h('h1', {}, d.customer.name || 'Welcome'), h('div', { class: 'tag' }, `Customer ${d.customer.id}`))), d.needs_name ? nameForm(true) : null, d.default_password ? h('div', { class: 'card warn', style: 'margin-bottom:10px' }, 'Your password is your phone number. You can change it in the Account tab.') : null, h('div', { class: 'bar' }, tabs));

  if (P.tab === 'bill') {
    const upTo = d.cutoff < d.month + '-01' ? null : d.cutoff;
    const rows = d.days.map((x) => h('tr', { class: x.am === null ? 'mute' : x.am + x.pm === 0 ? 'zero' : '' }, h('td', {}, dayLabel(x.date)), h('td', { class: 'n' }, x.am === null ? '–' : x.am ? lit(x.am) : '0'), h('td', { class: 'n' }, x.pm === null ? '–' : x.pm ? lit(x.pm) : '0'), h('td', { class: 'n' }, x.am === null ? '–' : lit(x.am + x.pm))));
    const m = h('input', { type: 'month', value: d.month, max: d.today.slice(0, 7), onchange: (e) => { if (e.target.value) { P.month = e.target.value; again(); } } });
    v.append(h('div', { class: 'bar' }, h('label', { class: 'tag' }, 'Month ', m)),
      h('p', { class: 'tag' }, upTo ? `Updated up to ${dayLabel(upTo)}. Each day is added at ${d.update_hour > 12 ? d.update_hour - 12 : d.update_hour} ${d.update_hour >= 12 ? 'PM' : 'AM'}.` : `Not updated yet — each day is added at ${d.update_hour > 12 ? d.update_hour - 12 : d.update_hour} ${d.update_hour >= 12 ? 'PM' : 'AM'}.`),
      h('div', { class: 'hero' }, h('div', { class: 'l' }, d.due > 0 ? 'Amount due' : 'All settled'), h('div', { class: 'big' }, inr(Math.max(d.due, 0))),
        h('div', { class: 'row' }, h('div', {}, 'Milk so far', h('b', {}, lit(d.total) + ' L')), h('div', {}, 'Bill so far', h('b', {}, inr(d.amount))), h('div', {}, 'Paid', h('b', {}, inr(d.paid))))),
      h('div', { class: 'tablewrap noselect' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Morning', 'Evening', 'Litres'].map((t, i) => h('th', { class: i ? 'n' : '' }, t)))), h('tbody', {}, rows),
        h('tfoot', {}, h('tr', {}, h('td', {}, 'Total'), h('td', { class: 'n' }, lit(d.am)), h('td', { class: 'n' }, lit(d.pm)), h('td', { class: 'n' }, lit(d.total)))))),
      d.payments.length ? h('div', {}, h('h2', {}, 'Payments received'), h('div', { class: 'tablewrap' }, h('table', {}, h('tbody', {}, d.payments.map((p) => h('tr', {}, h('td', {}, p.date), h('td', {}, p.mode || ''), h('td', { class: 'n' }, inr(p.amount))))))))  : null,
      h('p', { class: 'tag' }, `Rate: ${inr(d.customer.price)} per litre.`));
  } else if (P.tab === 'skip') {
    const f = h('input', { type: 'date', value: d.tomorrow, min: d.tomorrow, required: true }), t = h('input', { type: 'date', value: d.tomorrow, min: d.tomorrow, required: true });
    f.addEventListener('change', () => { if (t.value < f.value) t.value = f.value; t.min = f.value; });
    const ses = h('select', {}, h('option', { value: 'AM' }, 'Morning'), h('option', { value: 'PM' }, 'Evening'), h('option', { value: 'BOTH' }, 'Morning & Evening'));
    const note = h('input', { type: 'text', placeholder: 'Optional note (e.g. out of town)', maxlength: 200 });
    v.append(h('form', { class: 'form card', onsubmit: guard(async (e) => { e.preventDefault(); await api('portal/skips', 'POST', { from: f.value, to: t.value, session: ses.value, note: note.value }); toast('Sent to the delivery team'); again(); }) },
      h('h2', { style: 'margin-top:0' }, "I don't need milk"), h('p', { class: 'tag' }, 'Your delivery boy and the admin are notified. You are not billed for the days you skip. For today, please call us.'),
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
const NAV = [['dashboard', 'Dashboard'], ['delivery', 'Delivery'], ['notices', 'Notices'], ['daily', 'Daily Summary'], ['bills', 'Bills'], ['customers', 'Customers'], ['income', 'Income'], ['expenses', 'Expenses'], ['pnl', 'P&L'], ['cows', 'Cows'], ['yield', 'Cow Yield'], ['settings', 'Settings']];
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
  const pw = h('input', { type: 'password', placeholder: mode === 'customer' ? 'Password (phone no. at first)' : 'Password', autocomplete: 'current-password', required: true });
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
  let badge = 0;
  if (role !== 'customer') { try { const n = await api('notices'); badge = n.items.filter((k) => k.from <= n.today).length; } catch {} }
  const links = admin ? NAV : role === 'delivery' ? DELIVERY_NAV : [];
  for (const [k, l] of links) nav.append(h('a', { href: '#/' + k, class: k === page || (page === 'bill' && k === 'bills') ? 'on' : '' }, l, k === 'notices' && badge ? h('span', { class: 'badge' }, badge) : null));
  $('#menu').hidden = !links.length; $('.month').hidden = !admin;
  $('#who').textContent = { admin: 'Admin', delivery: 'Delivery', customer: S.user.cid }[role];
  document.body.classList.toggle('customer', role === 'customer');
  const v = $('#view'); v.innerHTML = '';
  v.append = (...kids) => Element.prototype.append.apply(v, kids.flat().filter((k) => k != null && k !== false)); // pages may pass null for "nothing"
  try { S.lists = S.lists || (admin ? await api('lists') : {}); await (pages[page] || pages.dashboard)(v, arg); }
  catch (e) { if (S.user) v.append(h('p', { class: 'bad' }, 'Error: ' + e.message)); }
}
$('#menu').addEventListener('click', () => $('#nav').classList.toggle('open'));
$('#logout').addEventListener('click', guard(async () => { await api('logout', 'POST'); S.user = null; S.lists = null; render(); }));
window.addEventListener('hashchange', () => { D.data = null; render(); });
monthInput.addEventListener('change', () => { D.data = null; });
render();
