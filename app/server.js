// GRV Dairy Management — local web app. Zero dependencies (Node 22+ with node:sqlite).
// Run: node server.js   then open http://localhost:3000
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'grv.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '', am REAL DEFAULT 0, pm REAL DEFAULT 0, price REAL DEFAULT 0, status TEXT DEFAULT 'Active');
CREATE TABLE IF NOT EXISTS deliveries(date TEXT, customer_id TEXT, session TEXT, qty REAL, PRIMARY KEY(date, customer_id, session));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, customer_id TEXT, bill_month TEXT, amount REAL, mode TEXT, status TEXT DEFAULT '', remarks TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS income(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, type TEXT, source TEXT DEFAULT '', description TEXT DEFAULT '', amount REAL, mode TEXT DEFAULT '', remarks TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, category TEXT, description TEXT DEFAULT '', amount REAL, mode TEXT DEFAULT '', paid_by TEXT DEFAULT '', remarks TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS cows(id TEXT PRIMARY KEY, name TEXT NOT NULL, breed TEXT DEFAULT '', lactation TEXT DEFAULT '', calving_date TEXT DEFAULT '', status TEXT DEFAULT 'Active', notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS cow_yield(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, cow_id TEXT, am REAL DEFAULT 0, pm REAL DEFAULT 0, notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS users(role TEXT PRIMARY KEY, salt TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, role TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);

// ---- seed from the workbook export on first run
if (db.prepare('SELECT COUNT(*) n FROM customers').get().n === 0 && fs.existsSync(path.join(__dirname, 'seed.json'))) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
  const ins = db.prepare('INSERT INTO customers(id,name,phone,am,pm,price,status) VALUES(?,?,?,?,?,?,?)');
  for (const c of seed.customers) ins.run(c.id, c.name, c.phone, c.am, c.pm, c.price, c.status);
  const L = seed.lists;
  const set = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
  set.run('modes', JSON.stringify(['Cash', ...L.modes]));
  set.run('expense_categories', JSON.stringify(['Cattle Feed', ...L.expense_categories]));
  set.run('income_types', JSON.stringify(['Milk Sales', ...L.income_types]));
  console.log(`Seeded ${seed.customers.length} customers from the workbook.`);
}

const getSetting = (k, def) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : def; };
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k, JSON.stringify(v));
const lists = () => ({
  modes: getSetting('modes', ['Cash', 'GPay', 'Bank', 'Other']),
  expense_categories: getSetting('expense_categories', ['Miscellaneous']),
  income_types: getSetting('income_types', ['Other Income']),
});

// ---- helpers
const daysIn = (month) => { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const dateStr = (month, d) => `${month}-${String(d).padStart(2, '0')}`;
const monthEnd = (month) => dateStr(month, daysIn(month));
const r2 = (n) => Math.round(n * 100) / 100;
const need = (cond, msg) => { if (!cond) throw Object.assign(new Error(msg), { status: 400 }); };
const validMonth = (m) => { need(/^\d{4}-(0[1-9]|1[0-2])$/.test(m || ''), 'month must be YYYY-MM'); return m; };
const validDate = (d) => { need(/^\d{4}-\d{2}-\d{2}$/.test(d || ''), 'date must be YYYY-MM-DD'); return d; };
const num = (v, name) => { const n = Number(v); need(v !== '' && v != null && Number.isFinite(n) && n >= 0, `${name} must be a non-negative number`); return n; };

// Effective quantity: explicit entry wins (0 = no delivery); blank = default for Active customers.
function monthData(month) {
  const customers = db.prepare('SELECT * FROM customers ORDER BY id').all();
  const ov = new Map();
  for (const r of db.prepare('SELECT * FROM deliveries WHERE date >= ? AND date <= ?').all(dateStr(month, 1), monthEnd(month)))
    ov.set(`${r.customer_id}|${r.date}|${r.session}`, r.qty);
  const n = daysIn(month);
  const eff = (c, date, s) => {
    const k = `${c.id}|${date}|${s}`;
    if (ov.has(k)) return ov.get(k);
    return c.status === 'Active' ? (s === 'AM' ? c.am : c.pm) : 0;
  };
  return { customers, n, eff, ov };
}

function bills(month) {
  const { customers, n, eff } = monthData(month);
  const paid = new Map(db.prepare('SELECT customer_id, SUM(amount) t FROM payments WHERE bill_month=? GROUP BY customer_id').all(month).map(r => [r.customer_id, r.t]));
  return customers.map(c => {
    let am = 0, pm = 0;
    for (let d = 1; d <= n; d++) { const ds = dateStr(month, d); am += eff(c, ds, 'AM'); pm += eff(c, ds, 'PM'); }
    const total = am + pm, amount = r2(total * c.price), p = paid.get(c.id) || 0, pending = r2(amount - p);
    return { id: c.id, name: c.name, phone: c.phone, status: c.status, am: r2(am), pm: r2(pm), total: r2(total), price: c.price, amount, paid: r2(p), pending,
      pay_status: amount === 0 && p === 0 ? '-' : pending <= 0 ? 'Paid' : p > 0 ? 'Part Paid' : 'Pending' };
  });
}

function daily(month) {
  const { customers, n, eff } = monthData(month);
  const out = [];
  for (let d = 1; d <= n; d++) {
    const ds = dateStr(month, d);
    let am = 0, pm = 0, served = 0, absent = 0, sales = 0;
    for (const c of customers) for (const s of ['AM', 'PM']) {
      const q = eff(c, ds, s);
      if (s === 'AM') am += q; else pm += q;
      if (q > 0) served++;
      if (q === 0 && (s === 'AM' ? c.am : c.pm) > 0 && c.status === 'Active') absent++;
      sales += q * c.price;
    }
    out.push({ date: ds, am: r2(am), pm: r2(pm), total: r2(am + pm), served, absent, sales: r2(sales) });
  }
  return out;
}

function pnl(month) {
  const sales = r2(bills(month).reduce((a, b) => a + b.amount, 0));
  const q = (t, col) => db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM ${t} WHERE date>=? AND date<=?`).get(dateStr(month, 1), monthEnd(month)).t;
  const other = r2(q('income')), expenses = r2(q('expenses'));
  const byCat = db.prepare('SELECT category, SUM(amount) t FROM expenses WHERE date>=? AND date<=? GROUP BY category ORDER BY t DESC').all(dateStr(month, 1), monthEnd(month));
  const byType = db.prepare('SELECT type, SUM(amount) t FROM income WHERE date>=? AND date<=? GROUP BY type ORDER BY t DESC').all(dateStr(month, 1), monthEnd(month));
  return { month, sales, other_income: other, total_income: r2(sales + other), expenses, net: r2(sales + other - expenses), by_category: byCat, by_type: byType };
}

function dashboard(month) {
  const b = bills(month);
  const collected = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE bill_month=?').get(month).t;
  const p = pnl(month);
  const yieldL = db.prepare('SELECT COALESCE(SUM(am+pm),0) t FROM cow_yield WHERE date>=? AND date<=?').get(dateStr(month, 1), monthEnd(month)).t;
  return {
    month, customers: db.prepare('SELECT COUNT(*) n FROM customers').get().n,
    active: db.prepare("SELECT COUNT(*) n FROM customers WHERE status='Active'").get().n,
    litres: r2(b.reduce((a, x) => a + x.total, 0)), sales: p.sales, collected: r2(collected),
    pending: r2(b.reduce((a, x) => a + Math.max(x.pending, 0), 0)),
    other_income: p.other_income, expenses: p.expenses, net: p.net, yield_litres: r2(yieldL),
    top_pending: b.filter(x => x.pending > 0).sort((a, b2) => b2.pending - a.pending).slice(0, 8),
    daily: daily(month).map(d => ({ date: d.date, total: d.total })),
  };
}

// ---- generic CRUD resources
const resources = {
  payments: { table: 'payments', order: 'date DESC, id DESC', month: 'bill_month', monthIsExact: true,
    fields: { date: validDate, customer_id: (v) => { need(db.prepare('SELECT 1 FROM customers WHERE id=?').get(v), 'unknown customer'); return v; }, bill_month: validMonth,
      amount: (v) => { const n = num(v, 'amount'); need(n > 0, 'amount must be > 0'); return n; }, mode: (v) => v || '', status: (v) => v || '', remarks: (v) => v || '' } },
  income: { table: 'income', order: 'date DESC, id DESC', month: 'date',
    fields: { date: validDate, type: (v) => { need(v, 'type required'); return v; }, source: (v) => v || '', description: (v) => v || '', amount: (v) => num(v, 'amount'), mode: (v) => v || '', remarks: (v) => v || '' } },
  expenses: { table: 'expenses', order: 'date DESC, id DESC', month: 'date',
    fields: { date: validDate, category: (v) => { need(v, 'category required'); return v; }, description: (v) => v || '', amount: (v) => num(v, 'amount'), mode: (v) => v || '', paid_by: (v) => v || '', remarks: (v) => v || '' } },
  cow_yield: { table: 'cow_yield', order: 'date DESC, id DESC', month: 'date',
    fields: { date: validDate, cow_id: (v) => { need(db.prepare('SELECT 1 FROM cows WHERE id=?').get(v), 'unknown cow'); return v; }, am: (v) => num(v || 0, 'AM yield'), pm: (v) => num(v || 0, 'PM yield'), notes: (v) => v || '' } },
};
// keyed (text id) masters
const masters = {
  customers: { table: 'customers', prefix: 'GRV', pad: 3, order: 'id',
    fields: { name: (v) => { need((v || '').trim(), 'name required'); return v.trim(); }, phone: (v) => v || '', am: (v) => num(v || 0, 'AM qty'), pm: (v) => num(v || 0, 'PM qty'), price: (v) => num(v || 0, 'price'), status: (v) => (v === 'Inactive' ? 'Inactive' : 'Active') } },
  cows: { table: 'cows', prefix: 'CW', pad: 3, order: 'id',
    fields: { name: (v) => { need((v || '').trim(), 'name required'); return v.trim(); }, breed: (v) => v || '', lactation: (v) => v || '', calving_date: (v) => v || '', status: (v) => v || 'Active', notes: (v) => v || '' } },
};

function pick(fields, body, partial) {
  const o = {};
  for (const [k, fn] of Object.entries(fields)) o[k] = fn(body[k]);
  return o;
}

function nextId(table, prefix, pad) {
  const rows = db.prepare(`SELECT id FROM ${table}`).all();
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.id.slice(prefix.length), 10) || 0), 0);
  return prefix + String(max + 1).padStart(pad, '0');
}

// ---- auth: two accounts, "admin" (everything) and "delivery" (delivery screen only)
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const setPassword = (role, pw) => { const salt = crypto.randomBytes(16).toString('hex'); db.prepare('INSERT OR REPLACE INTO users(role,salt,hash) VALUES(?,?,?)').run(role, salt, hashPw(pw, salt)); };
if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
  const creds = { admin: String(crypto.randomInt(100000, 999999)), delivery: String(crypto.randomInt(100000, 999999)) };
  for (const [role, pw] of Object.entries(creds)) setPassword(role, pw);
  fs.writeFileSync(path.join(DATA_DIR, 'credentials.txt'), `First-run passwords (change them in Settings, then delete this file)\r\nadmin:    ${creds.admin}\r\ndelivery: ${creds.delivery}\r\n`);
  console.log('Created accounts - passwords saved in app/data/credentials.txt');
}
const SESSION_MS = 30 * 24 * 3600 * 1000;
const fails = new Map(); // ip -> {n, until}
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find((c) => c[0] === name)?.[1];
const sessionOf = (req) => {
  const t = cookieOf(req, 'grv_sid'); if (!t) return null;
  const r = db.prepare('SELECT role, created FROM sessions WHERE token=?').get(t);
  if (!r || Date.now() - r.created > SESSION_MS) return null;
  return { token: t, role: r.role };
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const yesterday = () => ymd(new Date(Date.now() - 864e5));
// delivery staff may only touch today's and yesterday's entries
const checkDeliveryDate = (user, date) => { if (user.role !== 'admin') need(date === today() || date === yesterday(), 'You can only edit today or yesterday'); };
const DELIVERY_ALLOWED = new Set(['GET /api/me', 'POST /api/logout', 'GET /api/route', 'PUT /api/delivery']);

// ---- routing
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern + '$'), fn });

route('GET', '/api/lists', () => lists());
route('PUT', '/api/lists', ({ body }) => {
  for (const k of ['modes', 'expense_categories', 'income_types']) if (Array.isArray(body[k])) {
    const v = [...new Set(body[k].map(s => String(s).trim()).filter(Boolean))];
    need(v.length, `${k} cannot be empty`); setSetting(k, v);
  }
  return lists();
});
route('GET', '/api/dashboard', ({ q }) => dashboard(validMonth(q.month)));
route('GET', '/api/pnl', ({ q }) => pnl(validMonth(q.month)));
route('GET', '/api/daily', ({ q }) => daily(validMonth(q.month)));
route('GET', '/api/bills', ({ q }) => bills(validMonth(q.month)));
route('GET', '/api/bills.csv', ({ q }) => {
  const rows = bills(validMonth(q.month));
  const head = ['Customer ID', 'Customer Name', 'Phone', 'AM Litres', 'PM Litres', 'Total Litres', 'Price/L', 'Bill Amount', 'Paid', 'Pending', 'Status'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [head, ...rows.map(r => [r.id, r.name, r.phone, r.am, r.pm, r.total, r.price, r.amount, r.paid, r.pending, r.pay_status])].map(r => r.map(esc).join(',')).join('\r\n');
  return { __raw: '﻿' + csv, type: 'text/csv; charset=utf-8', filename: `GRV_bills_${q.month}.csv` };
});

// Printable bill(s): day-by-day quantities plus payments. No id => every customer with milk or payments that month.
route('GET', '/api/bill', ({ q }) => {
  const month = validMonth(q.month);
  const { customers, n, eff } = monthData(month);
  const summary = new Map(bills(month).map((b) => [b.id, b]));
  const out = [];
  for (const c of customers) {
    if (q.id && c.id !== q.id) continue;
    const b = summary.get(c.id);
    if (!q.id && b.total === 0 && b.paid === 0) continue;
    const days = [];
    for (let d = 1; d <= n; d++) { const ds = dateStr(month, d); days.push({ date: ds, am: eff(c, ds, 'AM'), pm: eff(c, ds, 'PM') }); }
    const payments = db.prepare('SELECT date, amount, mode FROM payments WHERE customer_id=? AND bill_month=? ORDER BY date').all(c.id, month);
    out.push({ ...b, month, days, payments, bill_no: `${c.id}-${month.replace('-', '')}` });
  }
  need(!q.id || out.length, 'customer not found');
  return out;
});

// Delivery: month grid of explicit entries; the client fills in defaults.
route('GET', '/api/delivery', ({ q }) => {
  const month = validMonth(q.month);
  const entries = db.prepare('SELECT customer_id c, date d, session s, qty q FROM deliveries WHERE date>=? AND date<=?').all(dateStr(month, 1), monthEnd(month));
  return { month, days: daysIn(month), customers: db.prepare('SELECT * FROM customers ORDER BY id').all(), entries };
});
// qty null/'' => clear the override (back to default); 0 => no delivery.
route('PUT', '/api/delivery', ({ body, user }) => {
  validDate(body.date); checkDeliveryDate(user, body.date); need(['AM', 'PM'].includes(body.session), 'session must be AM or PM');
  need(db.prepare('SELECT 1 FROM customers WHERE id=?').get(body.customer_id), 'unknown customer');
  if (body.qty === null || body.qty === '' || body.qty === undefined)
    db.prepare('DELETE FROM deliveries WHERE date=? AND customer_id=? AND session=?').run(body.date, body.customer_id, body.session);
  else db.prepare('INSERT OR REPLACE INTO deliveries(date,customer_id,session,qty) VALUES(?,?,?,?)').run(body.date, body.customer_id, body.session, num(body.qty, 'qty'));
  return { ok: true };
});
route('POST', '/api/delivery/reset-day', ({ body }) => { // clear all overrides for a day (optionally one session)
  validDate(body.date);
  if (body.session) db.prepare('DELETE FROM deliveries WHERE date=? AND session=?').run(body.date, body.session);
  else db.prepare('DELETE FROM deliveries WHERE date=?').run(body.date);
  return { ok: true };
});

// Delivery-boy friendly list for one date + session: no prices, phones or amounts.
route('GET', '/api/route', ({ q, user }) => {
  validDate(q.date); need(['AM', 'PM'].includes(q.session), 'session must be AM or PM'); checkDeliveryDate(user, q.date);
  const ov = new Map(db.prepare('SELECT customer_id c, qty q FROM deliveries WHERE date=? AND session=?').all(q.date, q.session).map((r) => [r.c, r.q]));
  const items = [];
  for (const c of db.prepare('SELECT * FROM customers ORDER BY id').all()) {
    const def = c.status === 'Active' ? (q.session === 'AM' ? c.am : c.pm) : 0;
    const qty = ov.has(c.id) ? ov.get(c.id) : null;
    if (def > 0 || (qty !== null && qty > 0)) items.push({ id: c.id, name: c.name, def, qty });
  }
  return { date: q.date, session: q.session, items };
});
route('GET', '/api/me', ({ user }) => ({ role: user.role, today: today(), yesterday: yesterday() }));
route('POST', '/api/logout', ({ user }) => { db.prepare('DELETE FROM sessions WHERE token=?').run(user.token); return { ok: true, clear: true }; });
route('PUT', '/api/password', ({ body, user }) => {
  need(user.role === 'admin', 'Admin only');
  need(['admin', 'delivery'].includes(body.role), 'unknown account');
  need(String(body.password || '').length >= 6, 'Password must be at least 6 characters');
  setPassword(body.role, body.password);
  db.prepare('DELETE FROM sessions WHERE role=? AND token<>?').run(body.role, user.token); // sign out other devices on that account
  return { ok: true };
});

for (const [name, cfg] of Object.entries(masters)) {
  route('GET', `/api/${name}`, () => db.prepare(`SELECT * FROM ${cfg.table} ORDER BY ${cfg.order}`).all());
  route('POST', `/api/${name}`, ({ body }) => {
    const o = pick(cfg.fields, body); const id = nextId(cfg.table, cfg.prefix, cfg.pad);
    const cols = ['id', ...Object.keys(o)];
    db.prepare(`INSERT INTO ${cfg.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(id, ...Object.values(o));
    return { id, ...o };
  });
  route('PUT', `/api/${name}/([^/]+)`, ({ body, m }) => {
    need(db.prepare(`SELECT 1 FROM ${cfg.table} WHERE id=?`).get(m[1]), 'not found');
    const o = pick(cfg.fields, body);
    db.prepare(`UPDATE ${cfg.table} SET ${Object.keys(o).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(o), m[1]);
    return { id: m[1], ...o };
  });
  route('DELETE', `/api/${name}/([^/]+)`, ({ m }) => {
    const dep = name === 'customers' ? ['payments', 'deliveries'] : ['cow_yield'];
    const col = name === 'customers' ? 'customer_id' : 'cow_id';
    for (const t of dep) if (db.prepare(`SELECT 1 FROM ${t} WHERE ${col}=?`).get(m[1])) need(false, `Has ${t} records — mark Inactive instead of deleting.`);
    db.prepare(`DELETE FROM ${cfg.table} WHERE id=?`).run(m[1]); return { ok: true };
  });
}
for (const [name, cfg] of Object.entries(resources)) {
  route('GET', `/api/${name}`, ({ q }) => {
    let sql = `SELECT * FROM ${cfg.table}`; const args = [];
    if (q.month) { validMonth(q.month); sql += ` WHERE ${cfg.month} ${cfg.monthIsExact ? '= ?' : 'BETWEEN ? AND ?'}`; args.push(...(cfg.monthIsExact ? [q.month] : [dateStr(q.month, 1), monthEnd(q.month)])); }
    return db.prepare(`${sql} ORDER BY ${cfg.order}`).all(...args);
  });
  route('POST', `/api/${name}`, ({ body }) => {
    const o = pick(cfg.fields, body); const cols = Object.keys(o);
    const r = db.prepare(`INSERT INTO ${cfg.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...Object.values(o));
    return { id: Number(r.lastInsertRowid), ...o };
  });
  route('PUT', `/api/${name}/(\\d+)`, ({ body, m }) => {
    const o = pick(cfg.fields, body);
    const r = db.prepare(`UPDATE ${cfg.table} SET ${Object.keys(o).map(k => k + '=?').join(',')} WHERE id=?`).run(...Object.values(o), m[1]);
    need(r.changes, 'not found'); return { id: Number(m[1]), ...o };
  });
  route('DELETE', `/api/${name}/(\\d+)`, ({ m }) => { db.prepare(`DELETE FROM ${cfg.table} WHERE id=?`).run(m[1]); return { ok: true }; });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(body); };
  if (!url.pathname.startsWith('/api/')) { // static files hold no data; the API enforces login
    const root = path.join(__dirname, 'public');
    const file = path.normalize(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, 'Not found', 'text/plain');
    return send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try {
      const key = `${req.method} ${url.pathname}`;
      if (key === 'POST /api/login') {
        const ip = req.socket.remoteAddress, f = fails.get(ip);
        need(!(f && f.n >= 5 && f.until > Date.now()), 'Too many attempts - wait a minute and try again');
        const b = raw ? JSON.parse(raw) : {};
        const u = db.prepare('SELECT * FROM users WHERE role=?').get(String(b.role));
        const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(b.password ?? '', u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
        if (!ok) { fails.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 60000 }); throw Object.assign(new Error('Wrong password'), { status: 401 }); }
        fails.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions(token,role,created) VALUES(?,?,?)').run(token, u.role, Date.now());
        return send(200, JSON.stringify({ role: u.role }), undefined, { 'Set-Cookie': `grv_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}` });
      }
      const user = sessionOf(req);
      if (!user) throw Object.assign(new Error('Please sign in'), { status: 401 });
      if (user.role !== 'admin' && !DELIVERY_ALLOWED.has(key)) throw Object.assign(new Error('Not allowed for this account'), { status: 403 });
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re); if (!m) continue;
        const body = raw ? JSON.parse(raw) : {};
        const out = r.fn({ q: Object.fromEntries(url.searchParams), body, m: m.map(decodeURIComponent), user });
        if (out && out.__raw !== undefined) return send(200, out.__raw, out.type, { 'Content-Disposition': `attachment; filename="${out.filename}"` });
        return send(200, JSON.stringify(out), undefined, out && out.clear ? { 'Set-Cookie': 'grv_sid=; HttpOnly; Path=/; Max-Age=0' } : {});
      }
      send(404, JSON.stringify({ error: 'Unknown endpoint' }));
    } catch (e) {
      const bad = e instanceof SyntaxError;
      send(e.status || (bad ? 400 : 500), JSON.stringify({ error: bad ? 'Bad request' : e.message }));
      if (!e.status && !bad) console.error(e);
    }
  });
});
// 0.0.0.0 so phones on the same Wi-Fi can connect
server.listen(PORT, '0.0.0.0', () => {
  console.log(`GRV Dairy running at http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log(`On your phone (same Wi-Fi): http://${a.address}:${PORT}`);
});
