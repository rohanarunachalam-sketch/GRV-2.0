// Copy your local database (app/data/grv.db) into Turso. Logins and sessions are NOT copied.
//   set TURSO_DATABASE_URL=libsql://...  &  set TURSO_AUTH_TOKEN=...   then:   npm run push-db
// Refuses to run if the Turso database already has customers, unless you pass --force.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) { console.error('Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) first.'); process.exit(1); }
const src = createClient({ url: pathToFileURL(path.join(__dirname, '..', 'data', 'grv.db')).href });
const dst = createClient({ url, authToken });
const TABLES = ['customers', 'deliveries', 'payments', 'income', 'expenses', 'cows', 'cow_yield', 'cow_ai', 'settings', 'skips', 'milk_unavailable', 'customer_auth'];

(async () => {
  const had = await dst.execute("SELECT name FROM sqlite_master WHERE name='customers'");
  if (had.rows.length) {
    const n = (await dst.execute('SELECT COUNT(*) n FROM customers')).rows[0][0];
    if (n > 0 && !process.argv.includes('--force')) { console.error(`Turso already has ${n} customers. Re-run with --force to overwrite.`); process.exit(1); }
  }
  const { SCHEMA } = require('../lib/core');
  await src.executeMultiple(SCHEMA); // adds tables an older local database is missing (additive only)
  await dst.executeMultiple(SCHEMA);
  for (const t of TABLES) {
    let rs;
    try { rs = await src.execute(`SELECT * FROM ${t}`); } catch (e) { if (/no such table/.test(e.message)) { console.log(t.padEnd(12), 'not in local db, skipped'); continue; } throw e; }
    await dst.execute(`DELETE FROM ${t}`);
    if (!rs.rows.length) { console.log(t.padEnd(12), 0); continue; }
    const stmts = rs.rows.map((r) => ({ sql: `INSERT INTO ${t}(${rs.columns.join(',')}) VALUES(${rs.columns.map(() => '?').join(',')})`, args: rs.columns.map((_, i) => r[i]) }));
    for (let i = 0; i < stmts.length; i += 100) await dst.batch(stmts.slice(i, i + 100), 'write');
    console.log(t.padEnd(12), rs.rows.length);
  }
  console.log('Done.');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
