// GRV Dairy — API core shared by the local server (server.js) and the Vercel function (api/index.js).
// Database: libSQL — a local file by default, or Turso when TURSO_DATABASE_URL is set.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createClient } = require('@libsql/client');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ON_VERCEL = !!process.env.VERCEL;
const TZ = process.env.APP_TZ || 'Asia/Kolkata';

let client;
if (process.env.TURSO_DATABASE_URL) client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
else { fs.mkdirSync(DATA_DIR, { recursive: true }); client = createClient({ url: pathToFileURL(path.join(DATA_DIR, 'grv.db')).href }); }

// ---- tiny async db helpers
const toObjs = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
const all = async (sql, args = []) => toObjs(await client.execute({ sql, args }));
const get = async (sql, args = []) => (await all(sql, args))[0];
const run = async (sql, args = []) => { const r = await client.execute({ sql, args }); return { changes: r.rowsAffected, id: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) }; };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, name TEXT NOT NULL, bill_name TEXT DEFAULT '', phone TEXT DEFAULT '', am REAL DEFAULT 0, pm REAL DEFAULT 0, price REAL DEFAULT 0, status TEXT DEFAULT 'Active');
CREATE TABLE IF NOT EXISTS deliveries(date TEXT, customer_id TEXT, session TEXT, qty REAL, PRIMARY KEY(date, customer_id, session));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, customer_id TEXT, bill_month TEXT, amount REAL, mode TEXT, status TEXT DEFAULT '', remarks TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS income(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, type TEXT, source TEXT DEFAULT '', description TEXT DEFAULT '', amount REAL, mode TEXT DEFAULT '', remarks TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, category TEXT, description TEXT DEFAULT '', amount REAL, mode TEXT DEFAULT '', paid_by TEXT DEFAULT '', remarks TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS cows(id TEXT PRIMARY KEY, name TEXT NOT NULL, breed TEXT DEFAULT '', lactation TEXT DEFAULT '', calving_date TEXT DEFAULT '', status TEXT DEFAULT 'Active', notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS cow_yield(id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, cow_id TEXT, am REAL DEFAULT 0, pm REAL DEFAULT 0, notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS cow_ai(id INTEGER PRIMARY KEY AUTOINCREMENT, cow_id TEXT, ai_date TEXT, confirm_date TEXT DEFAULT '', result TEXT DEFAULT 'Pending', ack INTEGER DEFAULT 0, notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS users(role TEXT PRIMARY KEY, salt TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, role TEXT, created INTEGER, cid TEXT);
CREATE TABLE IF NOT EXISTS customer_auth(customer_id TEXT PRIMARY KEY, salt TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS skips(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT, from_date TEXT, to_date TEXT, session TEXT, note TEXT DEFAULT '', status TEXT DEFAULT 'active', created TEXT, created_by TEXT);
CREATE TABLE IF NOT EXISTS milk_unavailable(date TEXT, customer_id TEXT, session TEXT, PRIMARY KEY(date, customer_id, session));
CREATE TABLE IF NOT EXISTS login_fails(ip TEXT PRIMARY KEY, n INTEGER, until INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT DEFAULT 'Nos', price REAL DEFAULT 0, stock REAL DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS customer_plans(customer_id TEXT, from_date TEXT, am REAL DEFAULT 0, pm REAL DEFAULT 0, price REAL DEFAULT 0, status TEXT DEFAULT 'Active', PRIMARY KEY(customer_id, from_date));
CREATE TABLE IF NOT EXISTS product_orders(id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, customer_id TEXT, qty REAL, price REAL, date TEXT, status TEXT DEFAULT 'Booked', note TEXT DEFAULT '', created TEXT, created_by TEXT);
`;

// ---- auth helpers
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const setPassword = (role, pw) => { const salt = crypto.randomBytes(16).toString('hex'); return run('INSERT OR REPLACE INTO users(role,salt,hash) VALUES(?,?,?)', [role, salt, hashPw(pw, salt)]); };

let ready;
const init = () => ready || (ready = (async () => {
  await client.executeMultiple(SCHEMA);
  try { await client.execute('ALTER TABLE sessions ADD COLUMN cid TEXT'); } catch { /* already there */ }
  try { await client.execute('ALTER TABLE product_orders ADD COLUMN delivered_on TEXT'); } catch { /* already there */ }
  try { await client.execute("ALTER TABLE customers ADD COLUMN bill_name TEXT DEFAULT ''"); } catch { /* already there */ }
  if ((await get('SELECT COUNT(*) n FROM users')).n === 0) {
    let creds = { admin: process.env.ADMIN_PASSWORD, delivery: process.env.DELIVERY_PASSWORD };
    if (!creds.admin || !creds.delivery) {
      if (ON_VERCEL) throw new Error('No logins yet: set ADMIN_PASSWORD and DELIVERY_PASSWORD environment variables, then redeploy.');
      creds = { admin: String(crypto.randomInt(100000, 999999)), delivery: String(crypto.randomInt(100000, 999999)) };
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'credentials.txt'), `First-run passwords (change them in Settings, then delete this file)\r\nadmin:    ${creds.admin}\r\ndelivery: ${creds.delivery}\r\n`);
      console.log('Created accounts - passwords saved in app/data/credentials.txt');
    }
    for (const [role, pw] of Object.entries(creds)) await setPassword(role, pw);
  }
  const seedFile = path.join(ROOT, 'seed.json');
  if (!ON_VERCEL && (await get('SELECT COUNT(*) n FROM customers')).n === 0 && fs.existsSync(seedFile)) {
    const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    for (const c of seed.customers) await run('INSERT INTO customers(id,name,phone,am,pm,price,status) VALUES(?,?,?,?,?,?,?)', [c.id, c.name, c.phone, c.am, c.pm, c.price, c.status]);
    await setSetting('modes', ['Cash', ...seed.lists.modes]);
    await setSetting('expense_categories', ['Cattle Feed', ...seed.lists.expense_categories]);
    await setSetting('income_types', ['Milk Sales', ...seed.lists.income_types]);
    console.log(`Seeded ${seed.customers.length} customers from the workbook.`);
  }
})().catch((e) => { ready = null; throw e; }));

const getSetting = async (k, def) => { const r = await get('SELECT value FROM settings WHERE key=?', [k]); return r ? JSON.parse(r.value) : def; };
const setSetting = (k, v) => run('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)', [k, JSON.stringify(v)]);
const lists = async () => ({
  modes: await getSetting('modes', ['Cash', 'GPay', 'Bank', 'Other']),
  expense_categories: await getSetting('expense_categories', ['Miscellaneous']),
  income_types: await getSetting('income_types', ['Other Income']),
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
const ymdIn = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD in the business time zone
const today = () => ymdIn(Date.now());
const yesterday = () => ymdIn(Date.now() - 864e5);
const tomorrow = () => ymdIn(Date.now() + 864e5);
const hourNow = () => Number(new Date().toLocaleString('en-GB', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;
const BILL_HOUR = Number(process.env.BILL_UPDATE_HOUR || 22); // customers see a day's delivery only after this hour (10 pm)
const billCutoff = () => (hourNow() >= BILL_HOUR ? today() : yesterday()); // last day customers can see
const addDays = (ds, n) => { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sessionsOf = (s) => (s === 'BOTH' ? ['AM', 'PM'] : [s]);

// Customer quantity/price history: each customer_plans row applies from its from_date until the next one.
// A customer with no rows uses the customers row for every date (how all customers worked before).
// Dates before a customer's first row are before they started, so nothing is delivered.
const BASE_DATE = '0000-01-01'; // "since always" — keeps the old values when the first dated change is made
const planOn = (c, plans, date) => {
  if (!plans || !plans.length) return c;
  let p = null;
  for (const r of plans) { if (r.from_date <= date) p = r; else break; }
  return p || { am: 0, pm: 0, price: plans[0].price, status: 'Inactive' };
};
const defQty = (p, s) => (p.status === 'Active' ? (s === 'AM' ? p.am : p.pm) : 0);
const plansOf = async (cid) => {
  const rows = await all(cid ? 'SELECT * FROM customer_plans WHERE customer_id=? ORDER BY from_date' : 'SELECT * FROM customer_plans ORDER BY customer_id, from_date', cid ? [cid] : []);
  const m = new Map();
  for (const r of rows) { if (!m.has(r.customer_id)) m.set(r.customer_id, []); m.get(r.customer_id).push(r); }
  return m;
};

// Effective quantity: explicit entry wins (0 = no delivery); blank = default for Active customers.
async function monthData(month) {
  const [customers, dels, skipRows, plans] = await Promise.all([ // asked together, so the wait is one round trip instead of four (matters on a remote database)
    all('SELECT * FROM customers ORDER BY id'),
    all('SELECT * FROM deliveries WHERE date >= ? AND date <= ?', [dateStr(month, 1), monthEnd(month)]),
    all("SELECT * FROM skips WHERE status='active' AND from_date <= ? AND to_date >= ?", [monthEnd(month), dateStr(month, 1)]), plansOf()]);
  const ov = new Map();
  for (const r of dels) ov.set(`${r.customer_id}|${r.date}|${r.session}`, r.qty);
  const n = daysIn(month);
  // customer "no milk" requests: an explicit delivery entry still wins; otherwise a skipped session counts as 0
  const skipSet = new Set();
  for (const k of skipRows)
    for (let d = Math.max(k.from_date < dateStr(month, 1) ? 1 : Number(k.from_date.slice(8)), 1); d <= (k.to_date > monthEnd(month) ? n : Number(k.to_date.slice(8))); d++)
      for (const s of sessionsOf(k.session)) skipSet.add(`${k.customer_id}|${dateStr(month, d)}|${s}`);
  const planAt = (c, date) => planOn(c, plans.get(c.id), date);
  const eff = (c, date, s) => {
    const k = `${c.id}|${date}|${s}`;
    if (ov.has(k)) return ov.get(k);
    if (skipSet.has(k)) return 0;
    return defQty(planAt(c, date), s);
  };
  return { customers, n, eff, ov, skipSet, planAt, plans };
}

// delivered extras (egg, curd, ghee...) of a month, counted in the month they were marked delivered
const extrasIn = (month, cid) => all(`SELECT o.id, o.customer_id, o.qty, o.price, COALESCE(o.delivered_on, o.date) AS date, p.name AS product, p.unit FROM product_orders o LEFT JOIN products p ON p.id=o.product_id
  WHERE o.status='Delivered' AND COALESCE(o.delivered_on, o.date) BETWEEN ? AND ?${cid ? ' AND o.customer_id=?' : ''} ORDER BY 4, o.id`, cid ? [dateStr(month, 1), monthEnd(month), cid] : [dateStr(month, 1), monthEnd(month)]);

async function bills(month) {
  const [{ customers, n, eff, planAt }, extraRows, paidRows] = await Promise.all([monthData(month), extrasIn(month), all('SELECT customer_id, SUM(amount) t FROM payments WHERE bill_month=? GROUP BY customer_id', [month])]);
  const extra = new Map();
  for (const x of extraRows) extra.set(x.customer_id, (extra.get(x.customer_id) || 0) + x.qty * x.price);
  const paid = new Map(paidRows.map((r) => [r.customer_id, r.t]));
  return customers.map((c) => {
    let am = 0, pm = 0, milk = 0; // the price can change mid-month, so each day is priced on its own
    for (let d = 1; d <= n; d++) { const ds = dateStr(month, d), a = eff(c, ds, 'AM'), b = eff(c, ds, 'PM'); am += a; pm += b; milk += (a + b) * planAt(c, ds).price; }
    const total = am + pm, price = planAt(c, monthEnd(month)).price, milk_amount = r2(milk), extras_amount = r2(extra.get(c.id) || 0), amount = r2(milk_amount + extras_amount), p = paid.get(c.id) || 0, pending = r2(amount - p);
    return { id: c.id, name: c.name, bill_name: c.bill_name || '', phone: c.phone, status: c.status, am: r2(am), pm: r2(pm), total: r2(total), price, milk_amount, extras_amount, amount, paid: r2(p), pending,
      pay_status: amount === 0 && p === 0 ? '-' : pending <= 0 ? 'Paid' : p > 0 ? 'Part Paid' : 'Pending' };
  });
}

async function daily(month) {
  const { customers, n, eff, planAt } = await monthData(month);
  const out = [];
  for (let d = 1; d <= n; d++) {
    const ds = dateStr(month, d);
    let am = 0, pm = 0, served = 0, absent = 0, sales = 0;
    for (const c of customers) for (const s of ['AM', 'PM']) {
      const q = eff(c, ds, s), p = planAt(c, ds);
      if (s === 'AM') am += q; else pm += q;
      if (q > 0) served++;
      if (q === 0 && defQty(p, s) > 0) absent++;
      sales += q * p.price;
    }
    out.push({ date: ds, am: r2(am), pm: r2(pm), total: r2(am + pm), served, absent, sales: r2(sales) });
  }
  return out;
}

async function pnl(month, billRows) {
  const sales = r2((billRows || await bills(month)).reduce((a, b) => a + b.amount, 0));
  const range = [dateStr(month, 1), monthEnd(month)];
  const sum = async (t) => (await get(`SELECT COALESCE(SUM(amount),0) t FROM ${t} WHERE date>=? AND date<=?`, range)).t;
  const other = r2(await sum('income')), expenses = r2(await sum('expenses'));
  const byCat = await all('SELECT category, SUM(amount) t FROM expenses WHERE date>=? AND date<=? GROUP BY category ORDER BY t DESC', range);
  const byType = await all('SELECT type, SUM(amount) t FROM income WHERE date>=? AND date<=? GROUP BY type ORDER BY t DESC', range);
  return { month, sales, other_income: other, total_income: r2(sales + other), expenses, net: r2(sales + other - expenses), by_category: byCat, by_type: byType };
}

async function dashboard(month) {
  const b = await bills(month);
  const collected = (await get('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE bill_month=?', [month])).t;
  const p = await pnl(month, b);
  const yieldL = (await get('SELECT COALESCE(SUM(am+pm),0) t FROM cow_yield WHERE date>=? AND date<=?', [dateStr(month, 1), monthEnd(month)])).t;
  const t = today(), days = await daily(month);
  const soldToday = (days.find((d) => d.date === t) || (await daily(t.slice(0, 7))).find((d) => d.date === t)).total; // today's month may differ from the one shown
  const yieldToday = (await get('SELECT COALESCE(SUM(am+pm),0) t FROM cow_yield WHERE date=?', [t])).t;
  return {
    month, customers: (await get('SELECT COUNT(*) n FROM customers')).n,
    active: (await get("SELECT COUNT(*) n FROM customers WHERE status='Active'")).n,
    litres: r2(b.reduce((a, x) => a + x.total, 0)), sales: p.sales, collected: r2(collected),
    pending: r2(b.reduce((a, x) => a + Math.max(x.pending, 0), 0)),
    other_income: p.other_income, expenses: p.expenses, net: p.net, yield_litres: r2(yieldL),
    top_pending: b.filter((x) => x.pending > 0).sort((a, c) => c.pending - a.pending).slice(0, 8),
    today: { date: t, yield: r2(yieldToday), sold: r2(soldToday) },
    daily: days.map((d) => ({ date: d.date, total: d.total })),
  };
}

// ---- generic CRUD resources (validators may be async)
const exists = (table, id) => get(`SELECT 1 x FROM ${table} WHERE id=?`, [id]);
const resources = {
  payments: { table: 'payments', order: 'date DESC, id DESC', month: 'bill_month', monthIsExact: true,
    fields: { date: validDate, customer_id: async (v) => { need(await exists('customers', v), 'unknown customer'); return v; }, bill_month: validMonth,
      amount: (v) => { const n = num(v, 'amount'); need(n > 0, 'amount must be > 0'); return n; }, mode: (v) => v || '', status: (v) => v || '', remarks: (v) => v || '' } },
  income: { table: 'income', order: 'date DESC, id DESC', month: 'date',
    fields: { date: validDate, type: (v) => { need(v, 'type required'); return v; }, source: (v) => v || '', description: (v) => v || '', amount: (v) => num(v, 'amount'), mode: (v) => v || '', remarks: (v) => v || '' } },
  expenses: { table: 'expenses', order: 'date DESC, id DESC', month: 'date',
    fields: { date: validDate, category: (v) => { need(v, 'category required'); return v; }, description: (v) => v || '', amount: (v) => num(v, 'amount'), mode: (v) => v || '', paid_by: (v) => v || '', remarks: (v) => v || '' } },
  cow_yield: { table: 'cow_yield', order: 'date DESC, id DESC', month: 'date',
    fields: { date: validDate, cow_id: async (v) => { need(await exists('cows', v), 'unknown cow'); return v; }, am: (v) => num(v || 0, 'AM yield'), pm: (v) => num(v || 0, 'PM yield'), notes: (v) => v || '' } },
};
const masters = {
  customers: { table: 'customers', prefix: 'GRV', pad: 3, order: 'id',
    fields: { name: (v) => { need((v || '').trim(), 'name required'); return v.trim(); }, bill_name: (v) => String(v || '').trim().slice(0, 60), phone: (v) => v || '', am: (v) => num(v || 0, 'AM qty'), pm: (v) => num(v || 0, 'PM qty'), price: (v) => num(v || 0, 'price'), status: (v) => (v === 'Inactive' ? 'Inactive' : 'Active') } },
  cows: { table: 'cows', prefix: 'CW', pad: 3, order: 'id',
    fields: { name: (v) => { need((v || '').trim(), 'name required'); return v.trim(); }, breed: (v) => v || '', lactation: (v) => v || '', calving_date: (v) => v || '', status: (v) => v || 'Active', notes: (v) => v || '' } },
};

async function pick(fields, body) {
  const o = {};
  for (const [k, fn] of Object.entries(fields)) o[k] = await fn(body[k]);
  return o;
}
async function nextId(table, prefix, pad) {
  const rows = await all(`SELECT id FROM ${table}`);
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.id.slice(prefix.length), 10) || 0), 0);
  return prefix + String(max + 1).padStart(pad, '0');
}

// ---- routing
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern + '$'), fn });
const DELIVERY_ALLOWED = new Set(['GET /api/me', 'POST /api/logout', 'GET /api/route', 'PUT /api/delivery', 'PUT /api/delivery/unavailable', 'GET /api/notices']);
const roleAllows = (role, key) => role === 'admin' || (role === 'delivery' && DELIVERY_ALLOWED.has(key)) ||
  (role === 'customer' && (['GET /api/me', 'POST /api/logout'].includes(key) || key.split(' ')[1].startsWith('/api/portal')));
// delivery staff may only touch today's and yesterday's entries
const checkDeliveryDate = (user, date) => { if (user.role !== 'admin') need(date === today() || date === yesterday(), 'You can only edit today or yesterday'); };

route('GET', '/api/lists', () => lists());
route('PUT', '/api/lists', async ({ body }) => {
  for (const k of ['modes', 'expense_categories', 'income_types']) if (Array.isArray(body[k])) {
    const v = [...new Set(body[k].map((s) => String(s).trim()).filter(Boolean))];
    need(v.length, `${k} cannot be empty`); await setSetting(k, v);
  }
  return lists();
});
route('GET', '/api/dashboard', ({ q }) => dashboard(validMonth(q.month)));
// milk yield vs sold for each day from..to (at most a year), for the dashboard summary and its Excel download
route('GET', '/api/milk-summary', async ({ q }) => {
  const from = validDate(q.from), to = validDate(q.to);
  need(from <= to, 'From date must be before To date'); need(to <= addDays(from, 366), 'Pick at most one year');
  const months = []; for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addDays(m + '-28', 5).slice(0, 7)) months.push(m);
  const [sold, yields] = await Promise.all([Promise.all(months.map(daily)), all('SELECT date, SUM(am) am, SUM(pm) pm FROM cow_yield WHERE date>=? AND date<=? GROUP BY date', [from, to])]);
  const y = new Map(yields.map((r) => [r.date, r]));
  return sold.flat().filter((d) => d.date >= from && d.date <= to).map((d) => {
    const r = y.get(d.date) || { am: 0, pm: 0 }, yt = r2(r.am + r.pm);
    return { date: d.date, yield_am: r2(r.am), yield_pm: r2(r.pm), yield: yt, sold_am: d.am, sold_pm: d.pm, sold: d.total, left: r2(yt - d.total) };
  });
});
route('GET', '/api/pnl', ({ q }) => pnl(validMonth(q.month)));
route('GET', '/api/daily', ({ q }) => daily(validMonth(q.month)));
route('GET', '/api/bills', ({ q }) => bills(validMonth(q.month)));
route('GET', '/api/bills.csv', async ({ q }) => {
  const rows = await bills(validMonth(q.month));
  const head = ['Customer ID', 'Customer Name', 'Phone', 'AM Litres', 'PM Litres', 'Total Litres', 'Price/L', 'Milk Amount', 'Extras Amount', 'Bill Amount', 'Paid', 'Pending', 'Status'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [head, ...rows.map((r) => [r.id, r.name, r.phone, r.am, r.pm, r.total, r.price, r.milk_amount, r.extras_amount, r.amount, r.paid, r.pending, r.pay_status])].map((r) => r.map(esc).join(',')).join('\r\n');
  return { __raw: '﻿' + csv, type: 'text/csv; charset=utf-8', filename: `GRV_bills_${q.month}.csv` };
});

// Printable bill(s): day-by-day quantities plus payments. No id => every customer with milk or payments that month.
route('GET', '/api/bill', async ({ q }) => {
  const month = validMonth(q.month);
  const { customers, n, eff } = await monthData(month);
  const summary = new Map((await bills(month)).map((b) => [b.id, b]));
  const out = [];
  for (const c of customers) {
    if (q.id && c.id !== q.id) continue;
    const b = summary.get(c.id);
    if (!q.id && b.total === 0 && b.paid === 0 && b.extras_amount === 0) continue;
    const days = [];
    for (let d = 1; d <= n; d++) { const ds = dateStr(month, d); days.push({ date: ds, am: eff(c, ds, 'AM'), pm: eff(c, ds, 'PM') }); }
    const payments = await all('SELECT date, amount, mode FROM payments WHERE customer_id=? AND bill_month=? ORDER BY date', [c.id, month]);
    out.push({ ...b, month, days, payments, extras: await extrasIn(month, c.id), bill_no: `${c.id}-${month.replace('-', '')}` });
  }
  need(!q.id || out.length, 'customer not found');
  return out;
});

// Delivery: month grid of explicit entries; the client fills in defaults.
route('GET', '/api/delivery', async ({ q }) => {
  const month = validMonth(q.month);
  const entries = await all('SELECT customer_id c, date d, session s, qty q FROM deliveries WHERE date>=? AND date<=?', [dateStr(month, 1), monthEnd(month)]);
  const { skipSet, customers, plans } = await monthData(month);
  const skips = [...skipSet].map((k) => { const [c, d, s] = k.split('|'); return { c, d, s }; });
  return { month, days: daysIn(month), customers: customers.map((c) => ({ ...c, plans: plans.get(c.id) || [] })), entries, skips };
});
// qty null/'' => clear the override (back to default); 0 => no delivery.
route('PUT', '/api/delivery', async ({ body, user }) => {
  validDate(body.date); checkDeliveryDate(user, body.date); need(['AM', 'PM'].includes(body.session), 'session must be AM or PM');
  need(await exists('customers', body.customer_id), 'unknown customer');
  await run('DELETE FROM milk_unavailable WHERE date=? AND customer_id=? AND session=?', [body.date, body.customer_id, body.session]); // a manual change replaces the 'Milk Unavailable' mark
  if (body.qty === null || body.qty === '' || body.qty === undefined) await run('DELETE FROM deliveries WHERE date=? AND customer_id=? AND session=?', [body.date, body.customer_id, body.session]);
  else await run('INSERT OR REPLACE INTO deliveries(date,customer_id,session,qty) VALUES(?,?,?,?)', [body.date, body.customer_id, body.session, num(body.qty, 'qty')]);
  return { ok: true };
});
// Admin marks a delivery as "Milk Unavailable" (supply shortage). Stored as a 0 quantity (so bills are unchanged) plus a flag that tells it apart from a normal Absent.
route('PUT', '/api/delivery/unavailable', async ({ body, user }) => {
  validDate(body.date); checkDeliveryDate(user, body.date); need(['AM', 'PM'].includes(body.session), 'session must be AM or PM'); need(await exists('customers', body.customer_id), 'unknown customer');
  const k = [body.date, body.customer_id, body.session];
  if (body.on) { await run('INSERT OR REPLACE INTO deliveries(date,customer_id,session,qty) VALUES(?,?,?,0)', k); await run('INSERT OR IGNORE INTO milk_unavailable(date,customer_id,session) VALUES(?,?,?)', k); }
  else { await run('DELETE FROM milk_unavailable WHERE date=? AND customer_id=? AND session=?', k); await run('DELETE FROM deliveries WHERE date=? AND customer_id=? AND session=?', k); }
  return { ok: true };
});
route('POST', '/api/delivery/reset-day', async ({ body }) => { // clear all overrides for a day (optionally one session)
  validDate(body.date);
  if (body.session) await run('DELETE FROM deliveries WHERE date=? AND session=?', [body.date, body.session]);
  else await run('DELETE FROM deliveries WHERE date=?', [body.date]);
  await run(body.session ? 'DELETE FROM milk_unavailable WHERE date=? AND session=?' : 'DELETE FROM milk_unavailable WHERE date=?', body.session ? [body.date, body.session] : [body.date]);
  return { ok: true };
});

// Delivery-boy friendly list for one date + session: no prices, phones or amounts.
route('GET', '/api/route', async ({ q, user }) => {
  validDate(q.date); need(['AM', 'PM'].includes(q.session), 'session must be AM or PM'); checkDeliveryDate(user, q.date);
  const ov = new Map((await all('SELECT customer_id c, qty q FROM deliveries WHERE date=? AND session=?', [q.date, q.session])).map((r) => [r.c, r.q]));
  const unv = new Set((await all('SELECT customer_id c FROM milk_unavailable WHERE date=? AND session=?', [q.date, q.session])).map((r) => r.c));
  const skipBy = new Map();
  for (const k of await all("SELECT * FROM skips WHERE status='active' AND from_date<=? AND to_date>=?", [q.date, q.date]))
    if (sessionsOf(k.session).includes(q.session)) skipBy.set(k.customer_id, { note: k.note, to: k.to_date });
  const items = [], plans = await plansOf();
  for (const c of await all('SELECT * FROM customers ORDER BY id')) {
    const def = defQty(planOn(c, plans.get(c.id), q.date), q.session);
    const qty = ov.has(c.id) ? ov.get(c.id) : null;
    if (def > 0 || (qty !== null && qty > 0)) items.push({ id: c.id, name: c.name, def, qty, skip: skipBy.get(c.id) || null, unavail: unv.has(c.id) && qty === 0 });
  }
  return { date: q.date, session: q.session, items };
});
route('GET', '/api/me', async ({ user }) => {
  const me = { role: user.role, today: today(), yesterday: yesterday() };
  if (user.role === 'customer') { const c = await get('SELECT id, bill_name FROM customers WHERE id=?', [user.cid]); Object.assign(me, { cid: user.cid, name: c && c.bill_name }); }
  return me;
});
route('POST', '/api/logout', async ({ user }) => { await run('DELETE FROM sessions WHERE token=?', [user.token]); return { ok: true, clear: true }; });
route('PUT', '/api/password', async ({ body, user }) => {
  need(user.role === 'admin', 'Admin only');
  need(['admin', 'delivery'].includes(body.role), 'unknown account');
  need(String(body.password || '').length >= 6, 'Password must be at least 6 characters');
  await setPassword(body.role, body.password);
  await run('DELETE FROM sessions WHERE role=? AND token<>?', [body.role, user.token]); // sign out other devices on that account
  return { ok: true };
});

// everything in the app, one array of rows per table, for the Excel download in Settings (no logins or sessions)
route('GET', '/api/export', async ({ user }) => {
  need(user.role === 'admin', 'Admin only');
  const out = {};
  for (const [key, sql] of [['Customers', 'SELECT * FROM customers ORDER BY id'], ['Customer Changes', 'SELECT * FROM customer_plans ORDER BY customer_id, from_date'],['Deliveries', 'SELECT * FROM deliveries ORDER BY date, customer_id, session'], ['Payments', 'SELECT * FROM payments ORDER BY date, id'],
    ['Income', 'SELECT * FROM income ORDER BY date, id'], ['Expenses', 'SELECT * FROM expenses ORDER BY date, id'], ['Cows', 'SELECT * FROM cows ORDER BY id'], ['Cow Yield', 'SELECT * FROM cow_yield ORDER BY date, cow_id'],
    ['Extra Items', 'SELECT * FROM products ORDER BY id'], ['Extra Bookings', 'SELECT * FROM product_orders ORDER BY id'], ['Cow AI', 'SELECT * FROM cow_ai ORDER BY id'], ['Pauses', 'SELECT * FROM skips ORDER BY id'], ['Milk Unavailable', 'SELECT * FROM milk_unavailable ORDER BY date, customer_id']]) out[key] = await all(sql);
  return out;
});

// Customers: an add or edit says from which date it applies (a customer who joins mid-month, or changes quantity or price).
// An edit with no date applies to every date, past ones too (for fixing a mistake), and clears the history.
// These are registered before the generic master routes, so they win.
const PLAN_SQL = 'INSERT OR REPLACE INTO customer_plans(customer_id,from_date,am,pm,price,status) VALUES(?,?,?,?,?,?)';
const samePlan = (a, b) => a.am === b.am && a.pm === b.pm && a.price === b.price && a.status === b.status;
route('GET', '/api/customers', async () => {
  const plans = await plansOf();
  return (await all('SELECT * FROM customers ORDER BY id')).map((c) => ({ ...c, plans: plans.get(c.id) || [] }));
});
route('POST', '/api/customers', async ({ body }) => {
  const from = body.from_date ? validDate(body.from_date) : null;
  const o = await pick(masters.customers.fields, body); const id = await nextId('customers', 'GRV', 3);
  const cols = ['id', ...Object.keys(o)];
  await run(`INSERT INTO customers(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, [id, ...Object.values(o)]);
  if (from) await run(PLAN_SQL, [id, from, o.am, o.pm, o.price, o.status]); // no milk before the start date
  return { id, ...o };
});
route('PUT', '/api/customers/([^/]+)', async ({ body, m }) => {
  const old = await get('SELECT * FROM customers WHERE id=?', [m[1]]); need(old, 'not found');
  const o = await pick(masters.customers.fields, body);
  if (body.bill_name === undefined) delete o.bill_name; // an edit that doesn't mention it must not wipe the customer's own name
  if (!body.from_date) await run('DELETE FROM customer_plans WHERE customer_id=?', [old.id]);
  else {
    const from = validDate(body.from_date);
    let plans = (await plansOf(old.id)).get(old.id) || [];
    if (!samePlan(planOn(old, plans, from), o) || plans.some((p) => p.from_date > from)) { // a name or phone edit adds no history
      if (!plans.length) await run(PLAN_SQL, [old.id, BASE_DATE, old.am, old.pm, old.price, old.status]); // earlier dates keep the old quantity
      await run('DELETE FROM customer_plans WHERE customer_id=? AND from_date>?', [old.id, from]); // "from this date on" replaces later changes
      await run(PLAN_SQL, [old.id, from, o.am, o.pm, o.price, o.status]);
      plans = (await plansOf(old.id)).get(old.id);
    }
    const now = planOn(old, plans, today()); // the customer row shows what applies today; a change dated later waits for its day
    if (now.from_date) Object.assign(o, { am: now.am, pm: now.pm, price: now.price, status: now.status });
  }
  await run(`UPDATE customers SET ${Object.keys(o).map((k) => k + '=?').join(',')} WHERE id=?`, [...Object.values(o), old.id]);
  return { id: old.id, ...o };
});
// Undo one dated change: the change before it carries on in its place
route('DELETE', '/api/customers/([^/]+)/plans/([0-9-]+)', async ({ m }) => {
  const c = await get('SELECT * FROM customers WHERE id=?', [m[1]]); need(c, 'not found');
  need(m[2] !== BASE_DATE, 'This is how the customer started — edit the customer instead');
  const r = await run('DELETE FROM customer_plans WHERE customer_id=? AND from_date=?', [c.id, m[2]]); need(r.changes, 'That change is not there any more');
  const plans = (await plansOf(c.id)).get(c.id) || [];
  if (plans.length === 1 && plans[0].from_date === BASE_DATE) { // only the starting values are left, so there is no history any more
    await run('DELETE FROM customer_plans WHERE customer_id=?', [c.id]);
    await run('UPDATE customers SET am=?, pm=?, price=?, status=? WHERE id=?', [plans[0].am, plans[0].pm, plans[0].price, plans[0].status, c.id]);
  } else {
    const now = planOn(c, plans, today());
    if (now.from_date) await run('UPDATE customers SET am=?, pm=?, price=?, status=? WHERE id=?', [now.am, now.pm, now.price, now.status, c.id]);
  }
  return { ok: true };
});

for (const [name, cfg] of Object.entries(masters)) {
  route('GET', `/api/${name}`, () => all(`SELECT * FROM ${cfg.table} ORDER BY ${cfg.order}`));
  route('POST', `/api/${name}`, async ({ body }) => {
    const o = await pick(cfg.fields, body); const id = await nextId(cfg.table, cfg.prefix, cfg.pad);
    const cols = ['id', ...Object.keys(o)];
    await run(`INSERT INTO ${cfg.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, [id, ...Object.values(o)]);
    return { id, ...o };
  });
  route('PUT', `/api/${name}/([^/]+)`, async ({ body, m }) => {
    need(await exists(cfg.table, m[1]), 'not found');
    const o = await pick(cfg.fields, body);
    if ('bill_name' in o && body.bill_name === undefined) delete o.bill_name; // an edit that doesn't mention it must not wipe the customer's own name
    await run(`UPDATE ${cfg.table} SET ${Object.keys(o).map((k) => k + '=?').join(',')} WHERE id=?`, [...Object.values(o), m[1]]);
    return { id: m[1], ...o };
  });
  route('DELETE', `/api/${name}/([^/]+)`, async ({ m }) => {
    const dep = name === 'customers' ? ['payments', 'deliveries'] : ['cow_yield', 'cow_ai'];
    const col = name === 'customers' ? 'customer_id' : 'cow_id';
    for (const t of dep) if (await get(`SELECT 1 x FROM ${t} WHERE ${col}=?`, [m[1]])) need(false, `Has ${t} records — mark Inactive instead of deleting.`);
    await run(`DELETE FROM ${cfg.table} WHERE id=?`, [m[1]]);
    if (name === 'customers') await run('DELETE FROM customer_plans WHERE customer_id=?', [m[1]]);
    return { ok: true };
  });
}
for (const [name, cfg] of Object.entries(resources)) {
  route('GET', `/api/${name}`, ({ q }) => {
    let sql = `SELECT * FROM ${cfg.table}`; const args = [];
    if (q.month) { validMonth(q.month); sql += ` WHERE ${cfg.month} ${cfg.monthIsExact ? '= ?' : 'BETWEEN ? AND ?'}`; args.push(...(cfg.monthIsExact ? [q.month] : [dateStr(q.month, 1), monthEnd(q.month)])); }
    return all(`${sql} ORDER BY ${cfg.order}`, args);
  });
  route('POST', `/api/${name}`, async ({ body }) => {
    const o = await pick(cfg.fields, body); const cols = Object.keys(o);
    const r = await run(`INSERT INTO ${cfg.table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, Object.values(o));
    return { id: r.id, ...o };
  });
  route('PUT', `/api/${name}/(\\d+)`, async ({ body, m }) => {
    const o = await pick(cfg.fields, body);
    const r = await run(`UPDATE ${cfg.table} SET ${Object.keys(o).map((k) => k + '=?').join(',')} WHERE id=?`, [...Object.values(o), m[1]]);
    need(r.changes, 'not found'); return { id: Number(m[1]), ...o };
  });
  route('DELETE', `/api/${name}/(\\d+)`, async ({ m }) => { await run(`DELETE FROM ${cfg.table} WHERE id=?`, [m[1]]); return { ok: true }; });
}

// ---- customer accounts: password defaults to the phone number until the customer sets their own
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const sameStr = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
async function customerPwOk(cid, pw) {
  const a = await get('SELECT * FROM customer_auth WHERE customer_id=?', [cid]);
  if (a) return crypto.timingSafeEqual(Buffer.from(hashPw(pw ?? '', a.salt), 'hex'), Buffer.from(a.hash, 'hex'));
  const c = await get('SELECT phone FROM customers WHERE id=?', [cid]);
  const ph = digits(c && c.phone);
  return ph.length >= 6 && sameStr(digits(pw), ph);
}
const setCustomerPassword = (cid, pw) => { const salt = crypto.randomBytes(16).toString('hex'); return run('INSERT OR REPLACE INTO customer_auth(customer_id,salt,hash) VALUES(?,?,?)', [cid, salt, hashPw(pw, salt)]); };

// ending/cancelling a request never rewrites days that already passed
async function cancelSkip(k) {
  need(k && k.status === 'active', 'request not found');
  const t = today();
  need(k.to_date >= t, 'That request has already finished');
  if (k.from_date >= t) await run("UPDATE skips SET status='cancelled' WHERE id=?", [k.id]);
  else await run('UPDATE skips SET to_date=? WHERE id=?', [yesterday(), k.id]);
}
const skipRow = (k) => ({ id: k.id, customer_id: k.customer_id, name: k.name, session: k.session, from: k.from_date, to: k.to_date, note: k.note, created_by: k.created_by });

// Delivery staff and admin: everything that is running now or coming up
route('GET', '/api/notices', async () => {
  const rows = await all("SELECT k.*, c.name FROM skips k JOIN customers c ON c.id=k.customer_id WHERE k.status='active' AND k.to_date >= ? ORDER BY k.from_date, c.id", [today()]);
  return { today: today(), tomorrow: tomorrow(), items: rows.map(skipRow) };
});
route('POST', '/api/skips', async ({ body }) => { // admin records a request taken by phone
  need(await exists('customers', body.customer_id), 'unknown customer');
  validDate(body.from); validDate(body.to); need(body.to >= body.from, 'End date is before the start date');
  need(['AM', 'PM', 'BOTH'].includes(body.session), 'session must be AM, PM or BOTH');
  const r = await run('INSERT INTO skips(customer_id,from_date,to_date,session,note,created,created_by) VALUES(?,?,?,?,?,?,?)', [body.customer_id, body.from, body.to, body.session, String(body.note || '').slice(0, 200), new Date().toISOString(), 'admin']);
  return { id: r.id };
});
route('DELETE', '/api/skips/(\\d+)', async ({ m }) => { await cancelSkip(await get('SELECT * FROM skips WHERE id=?', [m[1]])); return { ok: true }; });

// Admin: customer login status and reset
route('GET', '/api/customers/([^/]+)/login', async ({ m }) => {
  const c = await get('SELECT id, phone FROM customers WHERE id=?', [m[1]]); need(c, 'not found');
  const custom = !!(await get('SELECT 1 x FROM customer_auth WHERE customer_id=?', [m[1]]));
  return { id: c.id, phone: c.phone, custom, password: custom ? null : (digits(c.phone).length >= 6 ? c.phone : null) };
});
route('PUT', '/api/customers/([^/]+)/password', async ({ body, m }) => { // no password => back to phone number
  need(await exists('customers', m[1]), 'not found');
  if (body.password) { need(String(body.password).length >= 4, 'Password must be at least 4 characters'); await setCustomerPassword(m[1], String(body.password)); }
  else await run('DELETE FROM customer_auth WHERE customer_id=?', [m[1]]);
  await run("DELETE FROM sessions WHERE role='customer' AND cid=?", [m[1]]);
  return { ok: true };
});

// ---- cow yield grid: one cell = one cow on one date (blank = no entry)
route('PUT', '/api/yield-cell', async ({ body }) => {
  validDate(body.date); need(await exists('cows', body.cow_id), 'unknown cow');
  const blank = (v) => v === '' || v === null || v === undefined;
  const am = blank(body.am) ? 0 : num(body.am, 'AM yield'), pm = blank(body.pm) ? 0 : num(body.pm, 'PM yield');
  const old = await get('SELECT id FROM cow_yield WHERE date=? AND cow_id=?', [body.date, body.cow_id]);
  if (blank(body.am) && blank(body.pm)) { if (old) await run('DELETE FROM cow_yield WHERE id=?', [old.id]); }
  else if (old) await run('UPDATE cow_yield SET am=?, pm=? WHERE id=?', [am, pm, old.id]);
  else await run('INSERT INTO cow_yield(date,cow_id,am,pm,notes) VALUES(?,?,?,?,?)', [body.date, body.cow_id, am, pm, '']);
  return { ok: true };
});


// ---- artificial insemination (AI): AI date -> confirmation check -> pregnancy tracking, with a reminder every 3 months
const GESTATION_DAYS = 283, CONFIRM_AFTER_DAYS = 45, MILESTONE_DAYS = 90;
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);
const aiRow = (r) => {
  const days = daysBetween(r.ai_date, today());
  return { ...r, days, confirm_from: addDays(r.ai_date, CONFIRM_AFTER_DAYS), due_date: r.result === 'Pregnant' ? addDays(r.ai_date, GESTATION_DAYS) : '',
    months: r.result === 'Pregnant' ? Math.floor(days / 30.4) : null };
};
const milestone = (r) => (r.result === 'Pregnant' ? Math.min(Math.floor(r.days / MILESTONE_DAYS), 4) : 0); // 1-3 = every 3 months, 4 = calving due (day 283+)
route('GET', '/api/cow-ai', async ({ q }) => (await all(q.cow_id ? 'SELECT * FROM cow_ai WHERE cow_id=? ORDER BY ai_date DESC, id DESC' : 'SELECT * FROM cow_ai ORDER BY ai_date DESC, id DESC', q.cow_id ? [q.cow_id] : [])).map(aiRow));
route('POST', '/api/cow-ai', async ({ body }) => {
  need(await exists('cows', body.cow_id), 'unknown cow'); validDate(body.ai_date);
  need(body.ai_date <= today(), 'AI date cannot be in the future');
  const r = await run('INSERT INTO cow_ai(cow_id,ai_date,notes) VALUES(?,?,?)', [body.cow_id, body.ai_date, String(body.notes || '').slice(0, 200)]);
  return { id: r.id };
});
route('PUT', '/api/cow-ai/(\\d+)', async ({ body, m }) => { // record the confirmation (or fix the AI date / notes)
  const r = await get('SELECT * FROM cow_ai WHERE id=?', [m[1]]); need(r, 'not found');
  const ai_date = body.ai_date ? validDate(body.ai_date) : r.ai_date;
  const result = body.result === undefined ? r.result : body.result;
  need(['Pending', 'Pregnant', 'Not pregnant'].includes(result), 'result must be Pending, Pregnant or Not pregnant');
  const confirm_date = result === 'Pending' ? '' : validDate(body.confirm_date || r.confirm_date);
  need(!confirm_date || confirm_date >= ai_date, 'Confirmation date is before the AI date');
  const ack = ai_date !== r.ai_date || result !== r.result ? 0 : r.ack; // a changed date or result restarts the reminders
  await run('UPDATE cow_ai SET ai_date=?, confirm_date=?, result=?, ack=?, notes=? WHERE id=?', [ai_date, confirm_date, result, ack, body.notes === undefined ? r.notes : String(body.notes).slice(0, 200), m[1]]);
  return { ok: true };
});
route('DELETE', '/api/cow-ai/(\\d+)', async ({ m }) => { await run('DELETE FROM cow_ai WHERE id=?', [m[1]]); return { ok: true }; });
route('POST', '/api/cow-ai/(\\d+)/ack', async ({ m }) => { // admin has seen the current reminder
  const r = await get('SELECT * FROM cow_ai WHERE id=?', [m[1]]); need(r, 'not found');
  await run('UPDATE cow_ai SET ack=? WHERE id=?', [Math.max(r.ack, milestone(aiRow(r))), m[1]]); return { ok: true };
});
route('GET', '/api/cow-alerts', async () => {
  const out = [];
  for (const r of (await all("SELECT a.*, c.name cow_name FROM cow_ai a JOIN cows c ON c.id=a.cow_id WHERE a.result<>'Not pregnant'")).map((x) => ({ ...aiRow(x), cow_name: x.cow_name }))) {
    const base = { id: r.id, cow_id: r.cow_id, cow_name: r.cow_name, ai_date: r.ai_date, days: r.days, due_date: r.due_date };
    if (r.result === 'Pending' && r.days >= CONFIRM_AFTER_DAYS) out.push({ ...base, type: 'confirm' });
    const k = milestone(r);
    if (k > r.ack) out.push({ ...base, type: 'milestone', milestone: k });
  }
  return out.sort((a, b) => b.days - a.days);
});


// ---- extra items (egg, ghee, curd...): admin sets the quantity available, customers (or the admin, for phone orders) book against it
const UNITS = ['Nos', 'Litre', 'Kg', 'Packet', 'Dozen'], DECIMAL_UNITS = new Set(['Litre', 'Kg']);
const LEFT_SQL = `p.stock - COALESCE((SELECT SUM(o.qty) FROM product_orders o WHERE o.product_id=p.id AND o.status<>'Cancelled'), 0)`; // stock minus everything booked (cancelled bookings give it back)
const productRows = async (where = '', args = []) => (await all(`SELECT p.*, ${LEFT_SQL} AS left_qty FROM products p ${where} ORDER BY p.name COLLATE NOCASE`, args)).map((p) => ({ ...p, left_qty: r2(Math.max(p.left_qty, 0)), booked: r2(p.stock - Math.max(p.left_qty, 0)) }));
const checkQty = (unit, v) => { const n = Number(v); need(v !== '' && v != null && Number.isFinite(n) && n > 0, 'Enter a quantity greater than 0'); need(DECIMAL_UNITS.has(unit) || Number.isInteger(n), `${unit} must be a whole number`); need(n <= 100000, 'Quantity too large'); return r2(n); };
async function placeOrder(productId, customerId, qty, by, note) {
  const p = await get('SELECT * FROM products WHERE id=?', [productId]); need(p && p.active, 'This item is not available');
  qty = checkQty(p.unit, qty);
  const r = await run(`INSERT INTO product_orders(product_id,customer_id,qty,price,date,status,note,created,created_by)
    SELECT p.id, ?, ?, p.price, ?, 'Booked', ?, ?, ? FROM products p WHERE p.id=? AND ${LEFT_SQL} >= ?`, [customerId, qty, today(), String(note || '').slice(0, 200), new Date().toISOString(), by, p.id, qty]); // the stock check and the insert are one statement, so two people can't both take the last one
  if (!r.changes) { const left = (await productRows('WHERE p.id=?', [p.id]))[0].left_qty; need(false, left > 0 ? `Only ${left} ${p.unit} left` : `${p.name} is sold out`); }
  return { id: r.id };
}
const productFields = (b) => {
  const name = String(b.name || '').trim(); need(name && name.length <= 60, 'Enter the item name');
  need(UNITS.includes(b.unit), 'Choose a unit');
  return [name, b.unit, num(b.price || 0, 'price'), num(b.stock || 0, 'quantity')];
};
route('GET', '/api/products', () => productRows());
route('POST', '/api/products', async ({ body }) => { const [n, u, pr, st] = productFields(body); const r = await run('INSERT INTO products(name,unit,price,stock) VALUES(?,?,?,?)', [n, u, pr, st]); return { id: r.id }; });
route('PUT', '/api/products/([0-9]+)', async ({ body, m }) => {
  need(await exists('products', m[1]), 'not found');
  const [n, u, pr, st] = productFields(body);
  const booked = (await productRows('WHERE p.id=?', [m[1]]))[0].booked;
  need(st >= booked, `${booked} already booked — the total cannot be less than that`);
  await run('UPDATE products SET name=?, unit=?, price=?, stock=?, active=? WHERE id=?', [n, u, pr, st, body.active === 0 || body.active === '0' ? 0 : 1, m[1]]); return { ok: true };
});
route('DELETE', '/api/products/([0-9]+)', async ({ m }) => {
  need(!(await get('SELECT 1 x FROM product_orders WHERE product_id=?', [m[1]])), 'This item has bookings — set it to Hidden instead of deleting.');
  await run('DELETE FROM products WHERE id=?', [m[1]]); return { ok: true };
});
route('GET', '/api/product-orders', () => all(`SELECT o.*, p.name AS product, p.unit, c.name AS customer FROM product_orders o LEFT JOIN products p ON p.id=o.product_id LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC LIMIT 1000`));
route('POST', '/api/product-orders', async ({ body }) => { need(await exists('customers', body.customer_id), 'Choose a customer'); return placeOrder(Number(body.product_id), body.customer_id, body.qty, 'admin', body.note); });
route('PUT', '/api/product-orders/([0-9]+)', async ({ body, m }) => {
  const o = await get('SELECT * FROM product_orders WHERE id=?', [m[1]]); need(o, 'not found');
  need(['Booked', 'Delivered', 'Cancelled'].includes(body.status), 'bad status');
  if (o.status === 'Cancelled' && body.status !== 'Cancelled') { // bringing a cancelled booking back needs the stock again
    const left = (await productRows('WHERE p.id=?', [o.product_id]))[0].left_qty; need(left >= o.qty, `Only ${left} left — cannot reopen this booking`);
  }
  await run('UPDATE product_orders SET status=?, delivered_on=? WHERE id=?', [body.status, body.status === 'Delivered' ? today() : null, o.id]); return { ok: true };
});
route('DELETE', '/api/product-orders/([0-9]+)', async ({ m }) => { await run('DELETE FROM product_orders WHERE id=?', [m[1]]); return { ok: true }; });
route('GET', '/api/portal/products', async ({ user }) => ({
  items: (await productRows('WHERE p.active=1')).map(({ id, name, unit, price, left_qty }) => ({ id, name, unit, price, left: left_qty })),
  orders: await all('SELECT o.id, o.qty, o.price, o.date, o.status, p.name AS product, p.unit FROM product_orders o LEFT JOIN products p ON p.id=o.product_id WHERE o.customer_id=? ORDER BY o.id DESC LIMIT 100', [user.cid]),
}));
route('POST', '/api/portal/orders', async ({ body, user }) => placeOrder(Number(body.product_id), user.cid, body.qty, 'customer', body.note));
route('DELETE', '/api/portal/orders/([0-9]+)', async ({ m, user }) => {
  const o = await get('SELECT * FROM product_orders WHERE id=? AND customer_id=?', [m[1], user.cid]); need(o, 'not found');
  need(o.status === 'Booked', 'Only a booking that is not yet delivered can be cancelled');
  await run("UPDATE product_orders SET status='Cancelled' WHERE id=?", [o.id]); return { ok: true };
});

// ---- customer portal
route('GET', '/api/portal', async ({ q, user }) => {
  const cid = user.cid, cutoff = billCutoff();
  const month = q.month ? validMonth(q.month) : cutoff.slice(0, 7);
  need(month <= today().slice(0, 7), 'No bills for future months');
  const c = await get('SELECT * FROM customers WHERE id=?', [cid]); need(c, 'customer not found');
  const { n, eff, planAt } = await monthData(month);
  const unv = new Set((await all('SELECT date, session FROM milk_unavailable WHERE customer_id=? AND date>=? AND date<=?', [cid, dateStr(month, 1), monthEnd(month)])).map((r) => r.date + '|' + r.session));
  const days = []; let am = 0, pm = 0, milk = 0;
  for (let d = 1; d <= n; d++) {
    const ds = dateStr(month, d);
    if (ds > cutoff) { days.push({ date: ds, am: null, pm: null }); continue; } // not yet updated
    const a = eff(c, ds, 'AM'), p = eff(c, ds, 'PM'), plan = planAt(c, ds); am += a; pm += p; milk += (a + p) * plan.price;
    // display-only status for the customer's calendar: Delivered / Paused / Milk Unavailable (blank before they started)
    const st = (unv.has(ds + '|AM') && a === 0) || (unv.has(ds + '|PM') && p === 0) ? 'Unavailable' : a + p === 0 && plan.status !== 'Active' ? '' : (a === 0 && defQty(plan, 'AM') > 0) || (p === 0 && defQty(plan, 'PM') > 0) || a + p === 0 ? 'Paused' : 'Delivered'; // a paused morning OR evening shows the day as Paused
    days.push({ date: ds, am: a, pm: p, st });
  }
  const payments = await all('SELECT date, amount, mode FROM payments WHERE customer_id=? AND bill_month=? ORDER BY date', [cid, month]);
  const paid = payments.reduce((a, x) => a + x.amount, 0), amount = r2(milk), now = planAt(c, today());
  const skips = (await all("SELECT k.*, ? AS name FROM skips k WHERE customer_id=? AND status='active' AND to_date >= ? ORDER BY from_date", [c.bill_name || '', cid, today()])).map(skipRow);
  const extras = await extrasIn(month, cid), extras_total = r2(extras.reduce((t, x) => t + x.qty * x.price, 0)), milk_amount = amount;
  return { customer: { id: c.id, name: c.bill_name || '', price: now.price, am: defQty(now, 'AM'), pm: defQty(now, 'PM') }, needs_name: !c.bill_name, month, cutoff, update_hour: BILL_HOUR, today: today(), tomorrow: tomorrow(),
    extras, extras_total, milk_amount, days, am: r2(am), pm: r2(pm), total: r2(am + pm), amount: r2(amount + extras_total), paid: r2(paid), due: r2(amount + extras_total - paid), payments, skips,
    default_password: !(await get('SELECT 1 x FROM customer_auth WHERE customer_id=?', [cid])) };
});
route('PUT', '/api/portal/password', async ({ body, user }) => {
  need(await customerPwOk(user.cid, body.old), 'Current password is wrong');
  need(String(body.password || '').length >= 6, 'New password must be at least 6 characters');
  await setCustomerPassword(user.cid, String(body.password));
  await run("DELETE FROM sessions WHERE role='customer' AND cid=? AND token<>?", [user.cid, user.token]);
  return { ok: true };
});
route('PUT', '/api/portal/name', async ({ body, user }) => { // the name that appears on this customer's bill (the admin's own nickname is untouched)
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  need(name.length >= 2 && name.length <= 60, 'Please enter your name (2 to 60 characters)');
  await run('UPDATE customers SET bill_name=? WHERE id=?', [name, user.cid]);
  return { ok: true, name };
});
route('POST', '/api/portal/skips', async ({ body, user }) => {
  validDate(body.from); validDate(body.to);
  need(body.from >= today(), 'Requests cannot start in the past');
  need(body.to >= body.from, 'End date is before the start date');
  need(addDays(body.from, 59) >= body.to, 'You can skip up to 60 days at a time');
  need(['AM', 'PM', 'BOTH'].includes(body.session), 'Choose morning, evening or both');
  const r = await run('INSERT INTO skips(customer_id,from_date,to_date,session,note,created,created_by) VALUES(?,?,?,?,?,?,?)', [user.cid, body.from, body.to, body.session, String(body.note || '').slice(0, 200), new Date().toISOString(), 'customer']);
  return { id: r.id };
});
route('DELETE', '/api/portal/skips/(\\d+)', async ({ m, user }) => {
  const k = await get('SELECT * FROM skips WHERE id=? AND customer_id=?', [m[1], user.cid]);
  await cancelSkip(k); return { ok: true };
});

// ---- request handler (Node req/res; works for http.createServer and Vercel functions)
const SESSION_MS = 30 * 24 * 3600 * 1000;
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find((c) => c[0] === name)?.[1];
async function sessionOf(req) {
  const t = cookieOf(req, 'grv_sid'); if (!t) return null;
  const r = await get('SELECT role, created, cid FROM sessions WHERE token=?', [t]);
  if (!r || Date.now() - r.created > SESSION_MS) return null;
  return { token: t, role: r.role, cid: r.cid };
}
const readBody = (req) => new Promise((resolve, reject) => {
  if (req.body !== undefined) return resolve(typeof req.body === 'string' ? req.body : req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '');
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } });
  req.on('end', () => resolve(raw)); req.on('error', reject);
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra }); res.end(body); };
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  try {
    await init();
    const raw = await readBody(req);
    const key = `${req.method} ${url.pathname}`;
    if (key === 'POST /api/login') {
      const b = raw ? JSON.parse(raw) : {};
      const isCust = b.role === 'customer';
      const cid = isCust ? String(b.id || '').trim().toUpperCase() : null;
      const baseIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      const ip = baseIp + (isCust ? '|' + cid : '');
      const f = await get('SELECT n, until FROM login_fails WHERE ip=?', [ip]);
      const fAll = await get('SELECT n, until FROM login_fails WHERE ip=?', ['all|' + baseIp]); // stops one device cycling through many customer IDs
      need(!(f && f.n >= 5 && f.until > Date.now()) && !(fAll && fAll.n >= 20 && fAll.until > Date.now()), 'Too many attempts - wait a minute and try again');
      let ok, u;
      if (isCust) { ok = !!(await exists('customers', cid)) && await customerPwOk(cid, b.password); u = { role: 'customer' }; }
      else { u = await get('SELECT * FROM users WHERE role=?', [String(b.role)]); ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(b.password ?? '', u.salt), 'hex'), Buffer.from(u.hash, 'hex')); }
      if (!ok) {
        await run('INSERT OR REPLACE INTO login_fails(ip,n,until) VALUES(?,?,?)', [ip, (f && f.until > Date.now() ? f.n : 0) + 1, Date.now() + 60000]);
        await run('INSERT OR REPLACE INTO login_fails(ip,n,until) VALUES(?,?,?)', ['all|' + baseIp, (fAll && fAll.until > Date.now() ? fAll.n : 0) + 1, Date.now() + 60000]);
        throw Object.assign(new Error(isCust ? 'Wrong customer ID or password' : 'Wrong password'), { status: 401 });
      }
      await run('DELETE FROM login_fails WHERE ip=?', [ip]);
      await run('DELETE FROM sessions WHERE created < ?', [Date.now() - SESSION_MS]);
      const token = crypto.randomBytes(32).toString('hex');
      await run('INSERT INTO sessions(token,role,created,cid) VALUES(?,?,?,?)', [token, u.role, Date.now(), cid]);
      return send(200, JSON.stringify({ role: u.role }), undefined, { 'Set-Cookie': `grv_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
    }
    const user = await sessionOf(req);
    if (!user) throw Object.assign(new Error('Please sign in'), { status: 401 });
    if (!roleAllows(user.role, key)) throw Object.assign(new Error('Not allowed for this account'), { status: 403 });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re); if (!m) continue;
      const body = raw ? JSON.parse(raw) : {};
      const out = await r.fn({ q: Object.fromEntries(url.searchParams), body, m: m.map(decodeURIComponent), user });
      if (out && out.__raw !== undefined) return send(200, out.__raw, out.type, { 'Content-Disposition': `attachment; filename="${out.filename}"` });
      return send(200, JSON.stringify(out), undefined, out && out.clear ? { 'Set-Cookie': `grv_sid=; HttpOnly; Path=/; Max-Age=0${secure}` } : {});
    }
    send(404, JSON.stringify({ error: 'Unknown endpoint' }));
  } catch (e) {
    const bad = e instanceof SyntaxError;
    send(e.status || (bad ? 400 : 500), JSON.stringify({ error: bad ? 'Bad request' : e.message }));
    if (!e.status && !bad) console.error(e);
  }
}

module.exports = { handle, init, client, SCHEMA };
