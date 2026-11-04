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
CREATE TABLE IF NOT EXISTS qty_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT, date TEXT, session TEXT, qty REAL, note TEXT DEFAULT '', status TEXT DEFAULT 'Pending', created TEXT, decided TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS customer_locations(customer_id TEXT PRIMARY KEY, lat REAL, lng REAL, acc REAL, marked TEXT);
CREATE TABLE IF NOT EXISTS road_legs(a TEXT, b TEXT, m REAL, PRIMARY KEY(a, b));
CREATE TABLE IF NOT EXISTS delivery_runs(date TEXT, session TEXT, started INTEGER, paused_at INTEGER, paused_ms INTEGER DEFAULT 0, ended INTEGER, started_by TEXT, PRIMARY KEY(date, session));
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
  try { await client.execute('ALTER TABLE delivery_runs ADD COLUMN last_by TEXT'); } catch { /* already there */ }
  try { await client.execute('ALTER TABLE sessions ADD COLUMN shift TEXT'); } catch { /* already there */ }
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
  // optional starting passwords for the morning / evening delivery logins (used by the demo); the admin can change them in Settings
  for (const [role, pw] of [['delivery_am', process.env.DELIVERY_AM_PASSWORD], ['delivery_pm', process.env.DELIVERY_PM_PASSWORD]])
    if (pw && !(await get('SELECT 1 x FROM users WHERE role=?', [role]))) await setPassword(role, pw);
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
// delivery staff may also mark houses, set the delivery order (Location Tracker) and start / pause / finish a delivery; the routes themselves stop them changing saved locations
const deliveryExtra = (key) => key === 'GET /api/locations' || /^PUT \/api\/locations\/[^/]+$/.test(key) || key === 'GET /api/run' || /^(GET|PUT|DELETE) \/api\/live$/.test(key) || key === 'POST /api/road' || key === 'GET /api/learned' || /^POST \/api\/run\/(start|pause|resume|end)$/.test(key);
const DELIVERY_ALLOWED = new Set(['GET /api/me', 'POST /api/logout', 'GET /api/route', 'PUT /api/delivery', 'PUT /api/delivery/unavailable', 'GET /api/notices']);
const roleAllows = (role, key) => role === 'admin' || (role === 'delivery' && (DELIVERY_ALLOWED.has(key) || deliveryExtra(key))) ||
  (role === 'customer' && (['GET /api/me', 'POST /api/logout'].includes(key) || key.split(' ')[1].startsWith('/api/portal')));
// delivery staff may only touch today's and yesterday's entries
// a morning-only or evening-only delivery login may only see and change its own session
const checkShift = (user, session) => need(!user.shift || user.shift === 'BOTH' || user.shift === session, `This login is for the ${user.shift === 'AM' ? 'morning' : 'evening'} delivery only`);
const checkDeliveryDate = (user, date) => { if (user.role !== 'admin') need(date === today() || date === yesterday(), 'You can only edit today or yesterday'); };

route('GET', '/api/lists', () => lists());
route('PUT', '/api/lists', async ({ body }) => {
  for (const k of ['modes', 'expense_categories', 'income_types']) if (Array.isArray(body[k])) {
    const v = [...new Set(body[k].map((s) => String(s).trim()).filter(Boolean))];
    need(v.length, `${k} cannot be empty`); await setSetting(k, v);
  }
  return lists();
});
route('PUT', '/api/nav-order', async ({ body }) => { // the admin menu order picked in Settings; [] means the default order
  need(Array.isArray(body.order), 'order must be a list');
  const order = [...new Set(body.order.map(String))].slice(0, 50);
  await setSetting('nav_order', order);
  return { order };
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
    return { date: d.date, yield_am: r2(r.am), yield_pm: r2(r.pm), yield: yt, sold_am: d.am, sold_pm: d.pm, sold: d.total, left: r2(yt - d.total), amount: d.sales };
  });
});
// payments received on the days from..to (by payment date, whatever bill month they were for)
route('GET', '/api/collections', async ({ q }) => {
  const from = validDate(q.from), to = validDate(q.to);
  need(from <= to, 'From date must be before To date');
  return all('SELECT p.id, p.date, p.customer_id, c.name, p.bill_month, p.amount, p.mode FROM payments p LEFT JOIN customers c ON c.id=p.customer_id WHERE p.date>=? AND p.date<=? ORDER BY p.date, p.id', [from, to]);
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
  validDate(body.date); checkDeliveryDate(user, body.date); need(['AM', 'PM'].includes(body.session), 'session must be AM or PM'); checkShift(user, body.session);
  need(await exists('customers', body.customer_id), 'unknown customer');
  await run('DELETE FROM milk_unavailable WHERE date=? AND customer_id=? AND session=?', [body.date, body.customer_id, body.session]); // a manual change replaces the 'Milk Unavailable' mark
  if (body.qty === null || body.qty === '' || body.qty === undefined) await run('DELETE FROM deliveries WHERE date=? AND customer_id=? AND session=?', [body.date, body.customer_id, body.session]);
  else await run('INSERT OR REPLACE INTO deliveries(date,customer_id,session,qty) VALUES(?,?,?,?)', [body.date, body.customer_id, body.session, num(body.qty, 'qty')]);
  return { ok: true };
});
// Admin marks a delivery as "Milk Unavailable" (supply shortage). Stored as a 0 quantity (so bills are unchanged) plus a flag that tells it apart from a normal Absent.
route('PUT', '/api/delivery/unavailable', async ({ body, user }) => {
  validDate(body.date); checkDeliveryDate(user, body.date); need(['AM', 'PM'].includes(body.session), 'session must be AM or PM'); checkShift(user, body.session); need(await exists('customers', body.customer_id), 'unknown customer');
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
  validDate(q.date); need(['AM', 'PM'].includes(q.session), 'session must be AM or PM'); checkDeliveryDate(user, q.date); checkShift(user, q.session);
  return { date: q.date, session: q.session, items: await routeList(q.date, q.session) };
});
// the delivery list for one date + session, in the saved Location Tracker order (also used for the customers' delivery times)
async function routeList(date, session) {
  const q = { date, session };
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
  // follow the delivery order saved on the Location Tracker page; customers not placed yet go last (by ID)
  const pos = new Map((await getSetting('route_order_' + q.session, [])).map((id, i) => [id, i]));
  items.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  return items;
}

// Admin: customers whose milk on one day is different from their usual quantity, and why
route('GET', '/api/day-changes', async ({ q }) => {
  validDate(q.date);
  const sessions = q.session === 'AM' || q.session === 'PM' ? [q.session] : ['AM', 'PM'];
  const [customers, plans, dels, unv, skips, reqs] = await Promise.all([all('SELECT * FROM customers ORDER BY id'), plansOf(),
    all('SELECT customer_id c, session s, qty q FROM deliveries WHERE date=?', [q.date]), all('SELECT customer_id c, session s FROM milk_unavailable WHERE date=?', [q.date]),
    all("SELECT * FROM skips WHERE status='active' AND from_date<=? AND to_date>=?", [q.date, q.date]), all("SELECT customer_id c, session s, qty q, note FROM qty_requests WHERE date=? AND status='Accepted'", [q.date])]);
  const key = (c, s) => `${c}|${s}`;
  const ov = new Map(dels.map((r) => [key(r.c, r.s), r.q])), un = new Set(unv.map((r) => key(r.c, r.s))), rq = new Map(reqs.map((r) => [key(r.c, r.s), r]));
  const sk = new Map();
  for (const k of skips) for (const s of sessionsOf(k.session)) sk.set(key(k.customer_id, s), k);
  const items = [];
  for (const c of customers) for (const s of sessions) {
    const k = key(c.id, s), usual = defQty(planOn(c, plans.get(c.id), q.date), s);
    let qty = usual, why = '', note = '';
    if (ov.has(k)) {
      qty = ov.get(k);
      if (un.has(k) && qty === 0) why = 'Milk unavailable';
      else if (rq.has(k) && rq.get(k).q === qty) { why = 'Customer asked (accepted)'; note = rq.get(k).note || ''; }
      else why = 'Changed by admin / delivery';
    } else if (sk.has(k)) { qty = 0; why = 'No milk (customer pause)'; note = sk.get(k).note || ''; }
    if (qty !== usual) items.push({ id: c.id, name: c.name, session: s, usual, qty, diff: r2(qty - usual), why, note });
  }
  return { date: q.date, items };
});

// ---- delivery times for customers: worked out only from the SAVED locations + the start time (no live tracking)
const ROAD_FACTOR = 1.4, KMH = 18, STOP_MIN = 1.5, WINDOW_MIN = 15; // roads are ~40% longer than a straight line; ~18 km/h on a bike; ~1.5 min per house
const kmBetween = (a, b) => {
  const R = 6371, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
// ---- road distances (OSRM — free, OpenStreetMap roads, no key). Each stretch between two saved points is asked for once and kept in road_legs;
// the customer times use them, and fall back to straight line × ROAD_FACTOR for any stretch not fetched yet (or when OSRM is down)
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const ptKey = (p) => `${(+p.lat).toFixed(6)},${(+p.lng).toFixed(6)}`;
const roadLegs = async () => new Map((await all('SELECT a, b, m FROM road_legs')).map((r) => [r.a + '|' + r.b, r.m]));
async function osrmRoute(pts) { // ≥ 2 points in order → metres per stretch + the encoded road line(s)
  const legs = [], poly = [];
  for (let i = 0; i < pts.length - 1; i += 39) { // ≤ 40 points per request (the public server's limits)
    const part = pts.slice(i, i + 40);
    const r = await fetch(OSRM + part.map((p) => `${(+p.lng).toFixed(6)},${(+p.lat).toFixed(6)}`).join(';') + '?overview=full&geometries=polyline&steps=false', { signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    need(r.ok && j.code === 'Ok' && j.routes && j.routes[0], 'Road route is not available right now');
    for (const l of j.routes[0].legs) legs.push(l.distance);
    poly.push(j.routes[0].geometry);
  }
  for (let i = 0; i < legs.length; i += 100) { // one statement per 100 stretches (a remote database is slow one row at a time)
    const chunk = legs.slice(i, i + 100);
    await run('INSERT OR REPLACE INTO road_legs(a,b,m) VALUES ' + chunk.map(() => '(?,?,?)').join(','), chunk.flatMap((m, k) => [ptKey(pts[i + k]), ptKey(pts[i + k + 1]), Math.round(m)]));
  }
  return { legs, poly };
}
// today's stops in order (only houses that get milk), with their saved points
async function stopsToday(date, session) {
  const items = (await routeList(date, session)).filter((it) => (it.qty ?? (it.skip ? 0 : it.def)) > 0 && !it.unavail);
  const locs = new Map((await all('SELECT * FROM customer_locations')).map((r) => [r.customer_id, r]));
  return { items, locs, farm: await getSetting('farm_location', null) };
}
// before a round starts: fetch any road stretch of today's order that isn't saved yet (skipped houses make new stretches)
async function fillRoadToday(date, session) {
  const { items, locs, farm } = await stopsToday(date, session), road = await roadLegs();
  const pts = [farm, ...items.map((it) => locs.get(it.id))].filter(Boolean);
  if (pts.length > 1 && pts.some((p, i) => i && !road.has(ptKey(pts[i - 1]) + '|' + ptKey(p)))) await osrmRoute(pts);
}
// minutes after the start until each customer's milk arrives, following the delivery order
async function etaOffsets(date, session) {
  const { items, locs, farm } = await stopsToday(date, session), road = await roadLegs();
  const learned = (await getSetting('learned_' + session, null)) || {};
  const marks = learned.marks || {}, spur = learned.spur || {}; // km along the admin's recorded ride where it passes each saved point; side pieces to houses off the ride
  let prev = farm, t = 0, km = 0;
  const out = new Map();
  for (const it of items) {
    const l = locs.get(it.id);
    if (l && prev) {
      const a = marks[ptKey(prev)], b = marks[ptKey(l)], m = road.get(ptKey(prev) + '|' + ptKey(l));
      const leg = a != null && b != null && b >= a ? (spur[ptKey(prev)] || 0) + (b - a) + (spur[ptKey(l)] || 0) : m != null ? m / 1000 : kmBetween(prev, l) * ROAD_FACTOR;
      km += leg; t += leg / KMH * 60;
    }
    if (l) prev = l;
    out.set(it.id, { min: t, marked: !!l }); t += STOP_MIN;
  }
  return { out, total: t, km, stops: items.length };
}
const runOf = (date, session) => get('SELECT * FROM delivery_runs WHERE date=? AND session=?', [date, session]);
const delayOf = (r, now = Date.now()) => (r.paused_ms || 0) + (r.paused_at ? now - r.paused_at : 0); // time lost to pauses so far
const runView = async (date, session) => {
  const r = await runOf(date, session), e = await etaOffsets(date, session);
  const marked = [...e.out.values()].filter((x) => x.marked).length;
  return { date, session, run: r || null, stops: e.stops, marked, farm: !!(await getSetting('farm_location', null)), minutes: Math.round(e.total), km: Math.round(e.km * 10) / 10,
    finish_at: r && r.started && !r.ended ? r.started + delayOf(r) + e.total * 60000 : null };
};
route('GET', '/api/run', async ({ q, user }) => { need(['AM', 'PM'].includes(q.session), 'session must be AM or PM'); checkShift(user, q.session); return runView(today(), q.session); });
route('POST', '/api/run/(start|pause|resume|end)', async ({ m, body, user }) => {
  need(['AM', 'PM'].includes(body.session), 'session must be AM or PM'); checkShift(user, body.session);
  const d = today(), r = await runOf(d, body.session), now = Date.now();
  if (m[1] === 'start') {
    need(!r || r.ended, 'Delivery has already started');
    await fillRoadToday(d, body.session).catch(() => {}); // road distances for the customer times; if OSRM is down the old estimate is used
    await run('INSERT OR REPLACE INTO delivery_runs(date,session,started,paused_at,paused_ms,ended,started_by,last_by) VALUES(?,?,?,NULL,0,NULL,?,?)', [d, body.session, now, user.role, user.role]);
  } else {
    need(r && !r.ended, 'Delivery has not started');
    if (m[1] === 'pause') { need(!r.paused_at, 'Already paused'); await run('UPDATE delivery_runs SET paused_at=? WHERE date=? AND session=?', [now, d, body.session]); }
    if (m[1] === 'resume') { need(r.paused_at, 'Not paused'); await run('UPDATE delivery_runs SET paused_ms=?, paused_at=NULL WHERE date=? AND session=?', [delayOf(r, now), d, body.session]); }
    if (m[1] === 'end') await run('UPDATE delivery_runs SET ended=?, paused_ms=?, paused_at=NULL WHERE date=? AND session=?', [now, delayOf(r, now), d, body.session]);
    await run('UPDATE delivery_runs SET last_by=? WHERE date=? AND session=?', [user.role, d, body.session]); // shown on the other login: "Paused by delivery"
  }
  return runView(d, body.session);
});
// what a customer sees: a 15-minute window for today's started delivery — never where the delivery person is
route('GET', '/api/portal/eta', async ({ user }) => {
  const d = today(), now = Date.now(), loc = await get('SELECT 1 x FROM customer_locations WHERE customer_id=?', [user.cid]);
  const farm = await getSetting('farm_location', null);
  let best = null;
  for (const s of ['AM', 'PM']) {
    const r = await runOf(d, s); if (!r || !r.started) continue;
    const e = await etaOffsets(d, s), me = e.out.get(user.cid);
    if (!me) continue; // not on this round (no milk this session, or asked for no milk)
    // the window is set on 5-minute marks when the round starts; each whole minute of pause then moves it 1 minute later
    // (6:00–6:15 → 6:01–6:16 …). Customers are never told about a pause — they only see the time move.
    const base = Math.max(Math.floor((r.started + me.min * 60000 - 5 * 60000) / 300000) * 300000, Math.floor(r.started / 60000) * 60000);
    const from = base + Math.floor(delayOf(r, r.ended || now) / 60000) * 60000;
    const v = { session: s, state: r.ended ? 'finished' : 'running', from, to: from + WINDOW_MIN * 60000 };
    if (r.ended && now - r.ended > 2 * 3600e3) continue; // yesterday's news
    if (!best || (best.state === 'finished' && v.state !== 'finished') || v.from > best.from) best = v;
  }
  if (!best || !loc || !farm) return { state: 'none' }; // only saved locations are used — no window until the house and the start are marked
  // no 'late' message: the customer keeps seeing the same window until the round is finished (pauses still move it later)
  return { ...best, now };
});

// ---- Location Tracker (admin): each customer's house on the map, the farm, and the delivery order per session
const validLatLng = (b) => {
  const lat = Number(b.lat), lng = Number(b.lng);
  need(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0), 'Location is not valid');
  const acc = Number(b.acc); return { lat, lng, acc: Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null };
};
route('GET', '/api/locations', async () => {
  const locs = new Map((await all('SELECT * FROM customer_locations')).map((r) => [r.customer_id, r]));
  const plans = await plansOf(), t = today();
  const customers = (await all('SELECT id, name, bill_name, am, pm, price, status FROM customers ORDER BY id')).map((c) => {
    const p = planOn(c, plans.get(c.id), t), l = locs.get(c.id);
    return { id: c.id, name: c.name, am: defQty(p, 'AM'), pm: defQty(p, 'PM'), status: p.status, lat: l ? l.lat : null, lng: l ? l.lng : null, acc: l ? l.acc : null, marked: l ? l.marked : null };
  });
  return { customers, farm: await getSetting('farm_location', null), order: { AM: await getSetting('route_order_AM', []), PM: await getSetting('route_order_PM', []) },
    prev: { AM: await getSetting('route_order_prev_AM', null), PM: await getSetting('route_order_prev_PM', null) } };
});
route('PUT', '/api/locations/farm', async ({ body, user }) => {
  const l = validLatLng(body);
  if (user.role !== 'admin') need(!(await getSetting('farm_location', null)), 'Only the admin can change the saved start location');
  await setSetting('farm_location', { ...l, marked: new Date().toISOString() }); await learnPoint(l); return { ok: true }; });
route('DELETE', '/api/locations/farm', async () => { await run("DELETE FROM settings WHERE key='farm_location'"); return { ok: true }; });
route('PUT', '/api/locations/order', async ({ body, user }) => {
  need(['AM', 'PM'].includes(body.session), 'session must be AM or PM'); checkShift(user, body.session);
  need(Array.isArray(body.ids) && body.ids.length <= 2000, 'ids must be a list');
  const known = new Set((await all('SELECT id FROM customers')).map((r) => r.id));
  const clean = (list) => [...new Set(list.map(String))].filter((id) => known.has(id));
  const ids = clean(body.ids);
  // ⚡ Auto order keeps the order from just before it, so "Go back to old order" can put it back (until the next auto order)
  if (body.auto) {
    need(Array.isArray(body.prev) && body.prev.length <= 2000, 'prev must be a list');
    await setSetting('route_order_prev_' + body.session, { ids: clean(body.prev), at: new Date().toISOString(), by: user.role === 'admin' ? 'Admin' : 'Delivery' });
  }
  await setSetting('route_order_' + body.session, ids); return { ok: true, count: ids.length };
});
route('PUT', '/api/locations/undo-auto-order', async ({ body, user }) => {
  need(['AM', 'PM'].includes(body.session), 'session must be AM or PM'); checkShift(user, body.session);
  const prev = await getSetting('route_order_prev_' + body.session, null);
  need(prev, 'There is no old order to go back to');
  await setSetting('route_order_' + body.session, prev.ids);
  await run('DELETE FROM settings WHERE key=?', ['route_order_prev_' + body.session]);
  return { ok: true };
});
route('PUT', '/api/locations/([^/]+)', async ({ body, m, user }) => {
  need(await get('SELECT id FROM customers WHERE id=?', [m[1]]), 'not found');
  if (user.role !== 'admin') need(!(await get('SELECT 1 x FROM customer_locations WHERE customer_id=?', [m[1]])), 'This house is already saved — only the admin can change it');
  const l = validLatLng(body);
  await run('INSERT OR REPLACE INTO customer_locations(customer_id,lat,lng,acc,marked) VALUES(?,?,?,?,?)', [m[1], l.lat, l.lng, l.acc, new Date().toISOString()]);
  await learnPoint(l);
  return { ok: true };
});
// ---- live map (admin + delivery only, never customers): the phone of whoever is out delivering sends its GPS while a round is running
const LIVE_FRESH_MS = 5 * 60000; // a position older than this is treated as gone (phone locked, no signal)
const liveKey = (user) => 'live_' + user.role + (user.role === 'delivery' && user.shift && user.shift !== 'BOTH' ? '_' + user.shift : '');
const liveName = (key) => ({ live_admin: 'Admin', live_delivery: 'Delivery', live_delivery_AM: 'Morning delivery', live_delivery_PM: 'Evening delivery' }[key] || 'Delivery');
const runningNow = async (user) => { // today's rounds this login may run that are started, not paused, not finished
  const out = [];
  for (const s of ['AM', 'PM']) { if (user.role === 'delivery' && user.shift && user.shift !== 'BOTH' && user.shift !== s) continue; const r = await runOf(today(), s); if (r && r.started && !r.ended && !r.paused_at) out.push(s); }
  return out;
};
route('PUT', '/api/live', async ({ body, user }) => {
  const running = await runningNow(user);
  if (!running.length) return { ok: false, running }; // nothing to share: not started, paused or finished
  const l = validLatLng(body), hd = Number(body.heading);
  await setSetting(liveKey(user), { ...l, heading: Number.isFinite(hd) ? Math.round(hd) : null, at: Date.now(), sessions: running });
  return { ok: true, running };
});
// ---- learned route: the admin records one real ride (🔴 Record route on the map); it is drawn on the map and its distances are used for the times
const LEARN_NEAR_KM = 0.08; // the ride counts as passing a house when it comes within 80 m of the saved point
const rideCum = (pts) => { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + kmBetween({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: pts[i][0], lng: pts[i][1] })); return c; };
const passAt = (pts, cum, p) => { // km along the ride at its closest point to p (within 80 m), or null
  let best = -1, bd = LEARN_NEAR_KM;
  for (let i = 0; i < pts.length; i++) { const d = kmBetween(p, { lat: pts[i][0], lng: pts[i][1] }); if (d < bd) { bd = d; best = i; } }
  return best < 0 ? null : Math.round(cum[best] * 1000) / 1000;
};
const decodePoly = (str) => { const out = []; let i = 0, lat = 0, lng = 0; while (i < str.length) { for (const k of [0, 1]) { let b, sh = 0, v = 0; do { b = str.charCodeAt(i++) - 63; v |= (b & 31) << sh; sh += 5; } while (b >= 32); const d = v & 1 ? ~(v >> 1) : v >> 1; if (k) lng += d; else lat += d; } out.push([lat / 1e5, lng / 1e5]); } return out; };
const nearestOn = (pts, p) => { let bi = 0, bd = Infinity; for (let i = 0; i < pts.length; i++) { const d = kmBetween(p, { lat: pts[i][0], lng: pts[i][1] }); if (d < bd) { bd = d; bi = i; } } return { i: bi, km: bd }; };
const r3 = (n) => Math.round(n * 1000) / 1000;
// put one saved point on a learned ride: 'on' if the ride passes it; otherwise join it to the nearest part of the ride by the road map (a dashed side piece)
async function placePoint(l, p, cum = rideCum(l.pts)) {
  const key = ptKey(p); l.marks = l.marks || {}; l.spur = l.spur || {}; l.pieces = l.pieces || {};
  if (l.pieces[key] && l.pieces[key].kind === 'rode') return; // the admin rode this piece — keep it
  const k = passAt(l.pts, cum, p);
  delete l.spur[key]; delete l.pieces[key];
  if (k != null) { l.marks[key] = k; return; }
  const n = nearestOn(l.pts, p), a = { lat: l.pts[n.i][0], lng: l.pts[n.i][1] };
  let pts, len, kind = 'road';
  try { const r = await osrmRoute([a, p]); pts = r.poly.flatMap(decodePoly); len = r.legs[0] / 1000; }
  catch { pts = [[a.lat, a.lng], [p.lat, p.lng]]; len = kmBetween(a, p) * ROAD_FACTOR; kind = 'straight'; }
  l.marks[key] = r3(cum[n.i]); l.spur[key] = r3(len); l.pieces[key] = { pts, kind };
}
// join every saved point the ride doesn't reach yet, as many as fit in the time given (the rest on the next map open)
async function placeMissing(l, ms) {
  const t0 = Date.now(), cum = rideCum(l.pts), farm = await getSetting('farm_location', null);
  let changed = false;
  for (const p of [farm, ...(await all('SELECT lat, lng FROM customer_locations'))].filter(Boolean)) {
    if ((l.marks || {})[ptKey(p)] != null) continue;
    if (Date.now() - t0 > ms) break;
    await placePoint(l, p, cum); changed = true;
  }
  return changed;
}
// a house marked or re-marked after the ride was recorded: on the ride, or joined to it by a side piece
async function learnPoint(p) {
  for (const s of ['AM', 'PM']) {
    const l = await getSetting('learned_' + s, null); if (!l) continue;
    await placePoint(l, p); await setSetting('learned_' + s, l);
  }
}
route('GET', '/api/learned', async ({ q, user }) => {
  need(['AM', 'PM'].includes(q.session), 'session must be AM or PM'); checkShift(user, q.session);
  const l = await getSetting('learned_' + q.session, null);
  if (!l) return null;
  if (await placeMissing(l, 4000)) await setSetting('learned_' + q.session, l);
  const pieces = l.pieces || {}, status = {};
  for (const k of Object.keys(l.marks || {})) status[k] = pieces[k] ? pieces[k].kind : 'on';
  return { pts: l.pts, km: l.km, minutes: l.minutes, at: l.at, passed: Object.values(status).filter((x) => x === 'on').length, pieces: Object.values(pieces), status };
});
route('PUT', '/api/learned', async ({ body }) => { // admin only (not in the delivery list)
  need(['AM', 'PM'].includes(body.session), 'session must be AM or PM');
  need(Array.isArray(body.pts) && body.pts.length >= 2 && body.pts.length <= 20000, 'The recording is too short');
  const pts = body.pts.map((p) => { const v = validLatLng({ lat: p && p[0], lng: p && p[1] }); return [+v.lat.toFixed(6), +v.lng.toFixed(6)]; });
  const cum = rideCum(pts), marks = {}, farm = await getSetting('farm_location', null);
  // where along the ride each saved point (farm + every house) is passed, so a house-to-house distance is the km ridden between them
  for (const p of [farm, ...(await all('SELECT lat, lng FROM customer_locations'))].filter(Boolean)) { const k = passAt(pts, cum, p); if (k != null) marks[ptKey(p)] = k; }
  const km = Math.round(cum[cum.length - 1] * 10) / 10, minutes = Math.max(0, Math.round(Number(body.minutes) || 0));
  const l = { pts, km, minutes, marks, spur: {}, pieces: {}, at: new Date().toISOString() }, passed = Object.keys(marks).length;
  await placeMissing(l, 5000); // houses the ride didn't pass: joined by the road map (the rest when the map is next opened)
  await setSetting('learned_' + body.session, l);
  return { ok: true, km, passed };
});
// 🔴 Record this piece (admin): a ride from the blue route to one house replaces its dashed road-map piece
route('PUT', '/api/learned/piece', async ({ body }) => {
  need(['AM', 'PM'].includes(body.session), 'session must be AM or PM');
  need(Array.isArray(body.pts) && body.pts.length >= 2 && body.pts.length <= 5000, 'The recording is too short');
  const house = await get('SELECT lat, lng FROM customer_locations WHERE customer_id=?', [String(body.cid || '')]);
  need(house, 'This house has no saved location');
  let pts = body.pts.map((p) => { const v = validLatLng({ lat: p && p[0], lng: p && p[1] }); return [+v.lat.toFixed(6), +v.lng.toFixed(6)]; });
  const at = (i) => ({ lat: pts[i][0], lng: pts[i][1] });
  if (kmBetween(at(0), house) < kmBetween(at(pts.length - 1), house)) pts = pts.reverse(); // ridden house → route: turn it round
  const reach = nearestOn(pts, house);
  need(reach.km <= LEARN_NEAR_KM, 'The ride did not reach the house — ride up to the gate, then tap Stop');
  pts = pts.slice(0, reach.i + 1);
  const len = rideCum(pts)[pts.length - 1], key = ptKey(house);
  let used = 0;
  for (const s of [body.session, body.session === 'AM' ? 'PM' : 'AM']) { // the same piece also joins the other session's route if it starts on it
    const l = await getSetting('learned_' + s, null); if (!l) { need(s !== body.session, 'Record the full route first'); continue; }
    const n = nearestOn(l.pts, at(0));
    if (n.km > 0.15) { need(s !== body.session, 'Start the piece on the blue route (you were too far from it), then ride to the house'); continue; }
    l.marks = { ...(l.marks || {}), [key]: r3(rideCum(l.pts)[n.i]) }; l.spur = { ...(l.spur || {}), [key]: r3(len) }; l.pieces = { ...(l.pieces || {}), [key]: { pts, kind: 'rode' } };
    await setSetting('learned_' + s, l); used++;
  }
  return { ok: true, km: Math.round(len * 100) / 100, sessions: used };
});
route('DELETE', '/api/learned', async ({ q }) => { need(['AM', 'PM'].includes(q.session), 'session must be AM or PM'); await run('DELETE FROM settings WHERE key=?', ['learned_' + q.session]); return { ok: true }; });
// the road route for the map: farm → houses in the order given; saved, so it is only fetched again when the order or a location changes
route('POST', '/api/road', async ({ body, user }) => {
  need(['AM', 'PM'].includes(body.session), 'session must be AM or PM'); checkShift(user, body.session);
  need(Array.isArray(body.ids) && body.ids.length <= 2000, 'ids must be a list');
  const farm = await getSetting('farm_location', null);
  const locs = new Map((await all('SELECT * FROM customer_locations')).map((r) => [r.customer_id, r]));
  const pts = [farm, ...body.ids.map((id) => locs.get(String(id)))].filter(Boolean);
  if (pts.length < 2) return { ok: true, poly: [], km: 0 };
  const sig = pts.map(ptKey).join(';'), key = 'road_geo_' + body.session, saved = await getSetting(key, null);
  if (saved && saved.sig === sig) return { ok: true, poly: saved.poly, km: saved.km };
  let r; try { r = await osrmRoute(pts); } catch { return { ok: false }; }
  const km = Math.round(r.legs.reduce((a, b) => a + b, 0) / 100) / 10;
  await setSetting(key, { sig, poly: r.poly, km });
  return { ok: true, poly: r.poly, km };
});
route('DELETE', '/api/live', async ({ user }) => { await run('DELETE FROM settings WHERE key=?', [liveKey(user)]); return { ok: true }; });
route('GET', '/api/live', async ({ user }) => {
  const now = Date.now(), runs = {};
  for (const s of ['AM', 'PM']) { const r = await runOf(today(), s); runs[s] = !r || !r.started ? 'none' : r.ended ? 'finished' : r.paused_at ? 'paused' : 'running'; }
  const people = (await all("SELECT key, value FROM settings WHERE key LIKE 'live\\_%' ESCAPE '\\'")).map((r) => ({ key: r.key, who: liveName(r.key), ...JSON.parse(r.value) }))
    .filter((p) => now - p.at < LIVE_FRESH_MS && (p.sessions || []).some((s) => runs[s] === 'running'));
  return { now, runs, people, me: liveKey(user) };
});
route('DELETE', '/api/locations/([^/]+)', async ({ m }) => { await run('DELETE FROM customer_locations WHERE customer_id=?', [m[1]]); return { ok: true }; });
route('GET', '/api/me', async ({ user }) => {
  const me = { role: user.role, today: today(), yesterday: yesterday(), shift: user.shift };
  if (user.role === 'customer') { const c = await get('SELECT id, bill_name FROM customers WHERE id=?', [user.cid]); Object.assign(me, { cid: user.cid, name: c && c.bill_name }); }
  if (user.role === 'admin') me.nav_order = await getSetting('nav_order', []);
  return me;
});
route('GET', '/api/logins', async () => { const have = new Set((await all('SELECT role FROM users')).map((r) => r.role)); return { delivery: have.has('delivery'), delivery_am: have.has('delivery_am'), delivery_pm: have.has('delivery_pm') }; });
route('POST', '/api/logout', async ({ user }) => { await run('DELETE FROM sessions WHERE token=?', [user.token]); return { ok: true, clear: true }; });
route('PUT', '/api/password', async ({ body, user }) => {
  need(user.role === 'admin', 'Admin only');
  need(['admin', 'delivery', 'delivery_am', 'delivery_pm'].includes(body.role), 'unknown account');
  need(String(body.password || '').length >= 6, 'Password must be at least 6 characters');
  await setPassword(body.role, body.password);
  // sign out other devices on that account (the three delivery logins are told apart by their shift)
  if (body.role === 'admin') await run('DELETE FROM sessions WHERE role=? AND token<>?', ['admin', user.token]);
  else await run("DELETE FROM sessions WHERE role='delivery' AND COALESCE(shift,'BOTH')=?", [{ delivery: 'BOTH', delivery_am: 'AM', delivery_pm: 'PM' }[body.role]]);
  return { ok: true };
});

// everything in the app, one array of rows per table, for the Excel download in Settings (no logins or sessions)
route('GET', '/api/export', async ({ user }) => {
  need(user.role === 'admin', 'Admin only');
  const out = {};
  for (const [key, sql] of [['Customers', 'SELECT * FROM customers ORDER BY id'], ['Customer Changes', 'SELECT * FROM customer_plans ORDER BY customer_id, from_date'],['Deliveries', 'SELECT * FROM deliveries ORDER BY date, customer_id, session'], ['Payments', 'SELECT * FROM payments ORDER BY date, id'],
    ['Income', 'SELECT * FROM income ORDER BY date, id'], ['Expenses', 'SELECT * FROM expenses ORDER BY date, id'], ['Cows', 'SELECT * FROM cows ORDER BY id'], ['Cow Yield', 'SELECT * FROM cow_yield ORDER BY date, cow_id'],
    ['Extra Items', 'SELECT * FROM products ORDER BY id'], ['Extra Bookings', 'SELECT * FROM product_orders ORDER BY id'], ['Cow AI', 'SELECT * FROM cow_ai ORDER BY id'], ['Pauses', 'SELECT * FROM skips ORDER BY id'], ['Milk Unavailable', 'SELECT * FROM milk_unavailable ORDER BY date, customer_id'], ['Quantity Requests', 'SELECT * FROM qty_requests ORDER BY id'], ['Customer Locations', 'SELECT * FROM customer_locations ORDER BY customer_id']]) out[key] = await all(sql);
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

// Delivery staff and admin: everything that is running now or coming up (quantity change requests wait for the admin only)
route('GET', '/api/notices', async ({ user }) => {
  const rows = await all("SELECT k.*, c.name FROM skips k JOIN customers c ON c.id=k.customer_id WHERE k.status='active' AND k.to_date >= ? ORDER BY k.from_date, c.id", [today()]);
  const requests = user.role === 'admin' ? await qtyRequests("r.status='Pending'") : [];
  const mine = (k) => !user.shift || user.shift === 'BOTH' || sessionsOf(k.session).includes(user.shift); // morning staff see morning no-milk requests only
  return { today: today(), tomorrow: tomorrow(), items: rows.filter(mine).map(skipRow), requests };
});
// customer asks for more or less milk on one delivery; the usual quantity for that day comes along so the admin sees the change
async function qtyRequests(where, args = []) {
  await expireQtyRequests();
  const [rows, plans] = await Promise.all([all(`SELECT r.*, c.name, c.am c_am, c.pm c_pm, c.price, c.status c_status FROM qty_requests r JOIN customers c ON c.id=r.customer_id WHERE ${where} ORDER BY r.date, r.id`, args), plansOf()]);
  return rows.map((r) => ({ id: r.id, customer_id: r.customer_id, name: r.name, date: r.date, session: r.session, qty: r.qty, note: r.note, status: r.status,
    usual: defQty(planOn({ id: r.customer_id, am: r.c_am, pm: r.c_pm, price: r.price, status: r.c_status }, plans.get(r.customer_id), r.date), r.session) }));
}
// customers may also correct a past day, so a request only expires once its day has passed AND nobody answered it for a week
const QTY_REQUEST_DAYS = 7;
const expireQtyRequests = () => run("UPDATE qty_requests SET status='Expired', decided=? WHERE status='Pending' AND date<? AND created<?",
  [new Date().toISOString(), today(), new Date(Date.now() - QTY_REQUEST_DAYS * 864e5).toISOString()]);
// accepting writes the day's quantity, so the delivery list and both bills follow it
route('PUT', '/api/qty-requests/(\\d+)', async ({ m, body }) => {
  await expireQtyRequests();
  const r = await get('SELECT * FROM qty_requests WHERE id=?', [m[1]]);
  need(r && r.status !== 'Expired', `Nobody answered this request within ${QTY_REQUEST_DAYS} days, so it expired`);
  need(r.status === 'Pending', 'That request was already handled');
  need(['Accepted', 'Rejected'].includes(body.status), 'status must be Accepted or Rejected');
  if (body.status === 'Accepted') await run('INSERT OR REPLACE INTO deliveries(date,customer_id,session,qty) VALUES(?,?,?,?)', [r.date, r.customer_id, r.session, r.qty]);
  await run('UPDATE qty_requests SET status=?, decided=? WHERE id=?', [body.status, new Date().toISOString(), r.id]);
  return { ok: true };
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
route('GET', '/api/portal/qty-requests', async ({ user }) => (await qtyRequests('r.customer_id=? AND r.date>=?', [user.cid, addDays(today(), -30)])).map(({ name, ...r }) => r)); // the admin's nickname stays private
route('POST', '/api/portal/qty-requests', async ({ body, user }) => {
  validDate(body.date);
  need(['AM', 'PM'].includes(body.session), 'Choose morning or evening');
  const qty = num(body.qty, 'quantity'); need(qty > 0 && qty <= 50, 'Enter the litres you want (for no milk, use the No milk tab)');
  await run("UPDATE qty_requests SET status='Cancelled' WHERE customer_id=? AND date=? AND session=? AND status='Pending'", [user.cid, body.date, body.session]); // the newest ask replaces an older one
  const r = await run('INSERT INTO qty_requests(customer_id,date,session,qty,note,created) VALUES(?,?,?,?,?,?)', [user.cid, body.date, body.session, qty, String(body.note || '').slice(0, 200), new Date().toISOString()]);
  return { id: r.id };
});
route('DELETE', '/api/portal/qty-requests/(\\d+)', async ({ m, user }) => {
  const r = await get('SELECT * FROM qty_requests WHERE id=? AND customer_id=?', [m[1], user.cid]);
  need(r && r.status === 'Pending', 'Only a request that is still waiting can be cancelled');
  await run("UPDATE qty_requests SET status='Cancelled' WHERE id=?", [r.id]); return { ok: true };
});
route('DELETE', '/api/portal/skips/(\\d+)', async ({ m, user }) => {
  const k = await get('SELECT * FROM skips WHERE id=? AND customer_id=?', [m[1], user.cid]);
  await cancelSkip(k); return { ok: true };
});

// ---- request handler (Node req/res; works for http.createServer and Vercel functions)
const SESSION_MS = 30 * 24 * 3600 * 1000;
// changes with every deploy (or local restart); open pages compare it and reload themselves to pick up new code
const APP_VERSION = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find((c) => c[0] === name)?.[1];
async function sessionOf(req) {
  const t = cookieOf(req, 'grv_sid'); if (!t) return null;
  const r = await get('SELECT role, created, cid, shift FROM sessions WHERE token=?', [t]);
  if (!r || Date.now() - r.created > SESSION_MS) return null;
  return { token: t, role: r.role, cid: r.cid, shift: r.role === 'delivery' ? r.shift || 'BOTH' : null };
}
const readBody = (req) => new Promise((resolve, reject) => {
  if (req.body !== undefined) return resolve(typeof req.body === 'string' ? req.body : req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '');
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } });
  req.on('end', () => resolve(raw)); req.on('error', reject);
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'X-App-Version': APP_VERSION, ...extra }); res.end(body); };
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
      let ok, u, shift = null;
      if (isCust) { ok = !!(await exists('customers', cid)) && await customerPwOk(cid, b.password); u = { role: 'customer' }; }
      else {
        // delivery staff pick Morning / Evening / Both on the sign-in page; each has its own password (Both = the original delivery password)
        if (b.role === 'delivery') shift = ['AM', 'PM'].includes(b.shift) ? b.shift : 'BOTH';
        const acct = b.role === 'delivery' && shift !== 'BOTH' ? 'delivery_' + shift.toLowerCase() : String(b.role);
        u = await get('SELECT * FROM users WHERE role=?', [acct]);
        if (!u && b.role === 'delivery') throw Object.assign(new Error(`The ${shift === 'AM' ? 'morning' : shift === 'PM' ? 'evening' : ''} delivery login is not set up yet. Ask the admin to set its password in Settings.`), { status: 401 });
        ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(b.password ?? '', u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
        if (u) u = { role: b.role === 'delivery' ? 'delivery' : u.role };
      }
      if (!ok) {
        await run('INSERT OR REPLACE INTO login_fails(ip,n,until) VALUES(?,?,?)', [ip, (f && f.until > Date.now() ? f.n : 0) + 1, Date.now() + 60000]);
        await run('INSERT OR REPLACE INTO login_fails(ip,n,until) VALUES(?,?,?)', ['all|' + baseIp, (fAll && fAll.until > Date.now() ? fAll.n : 0) + 1, Date.now() + 60000]);
        throw Object.assign(new Error(isCust ? 'Wrong customer ID or password' : 'Wrong password'), { status: 401 });
      }
      await run('DELETE FROM login_fails WHERE ip=?', [ip]);
      await run('DELETE FROM sessions WHERE created < ?', [Date.now() - SESSION_MS]);
      const token = crypto.randomBytes(32).toString('hex');
      await run('INSERT INTO sessions(token,role,created,cid,shift) VALUES(?,?,?,?,?)', [token, u.role, Date.now(), cid, shift]);
      return send(200, JSON.stringify({ role: u.role, shift }), undefined, { 'Set-Cookie': `grv_sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
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
