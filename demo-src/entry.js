// Demo entry: runs the real API (lib/core.js) inside the browser and answers the app's fetch('/api/...') calls locally.
import { handle, init, client } from '../app/lib/core.js';
import { Buffer } from 'buffer';
globalThis.Buffer = globalThis.Buffer || Buffer;

const SID = 'grv-demo-sid';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (ds, n) => { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function seed() {
  const run = (sql, args) => client.execute({ sql, args });
  const n = (await client.execute('SELECT COUNT(*) n FROM customers')).rows[0][0];
  if (n > 0) return;
  const people = [
    ['Block A - 101 Sharma', 0.75, 0.5], ['Block A - 102 Iyer', 1, 0], ['Block A - 203 Khan', 0, 0.5], ['Block B - 104 Reddy', 0.5, 0.5], ['Block B - 205 Nair', 1, 1],
    ['Block B - 306 Das', 0.5, 0], ['Block C - 107 Menon', 1.5, 0.5], ['Block C - 208 Patel', 0, 0.75], ['Block C - 309 Singh', 1, 0.5], ['Block D - 110 Rao', 0.5, 0.5],
    ['Block D - 211 Joseph', 2, 1], ['Block D - 312 Gupta', 0.75, 0], ['Villa 1 - Murthy', 1, 1], ['Villa 2 - Bose', 0.5, 0.25], ['Villa 3 - Fernandes', 1, 0.5],
  ];
  for (let i = 0; i < people.length; i++) {
    const id = 'GRV' + String(i + 1).padStart(3, '0');
    await run('INSERT INTO customers(id,name,phone,am,pm,price,status) VALUES(?,?,?,?,?,?,?)', [id, people[i][0], '90000000' + String(i + 1).padStart(2, '0'), people[i][1], people[i][2], 55, 'Active']);
  }
  const t = today(), month = t.slice(0, 7);
  await run('INSERT INTO payments(date,customer_id,bill_month,amount,mode,status,remarks) VALUES(?,?,?,?,?,?,?)', [t, 'GRV001', month, 500, 'GPay', '', 'sample']);
  await run('INSERT INTO deliveries(date,customer_id,session,qty) VALUES(?,?,?,?)', [t, 'GRV004', 'AM', 0]);
  await run('INSERT INTO skips(customer_id,from_date,to_date,session,note,created,created_by) VALUES(?,?,?,?,?,?,?)', ['GRV002', addDays(t, 1), addDays(t, 3), 'AM', 'Out of town', new Date().toISOString(), 'customer']);
  await run('INSERT INTO expenses(date,category,description,amount,mode,paid_by,remarks) VALUES(?,?,?,?,?,?,?)', [t, 'Cattle Feed', 'Sample feed purchase', 1200, 'Cash', '', '']);
  await run('INSERT INTO cows(id,name,breed,lactation,calving_date,status,notes) VALUES(?,?,?,?,?,?,?)', ['CW001', 'Lakshmi', 'HF cross', 'Lactating', '', 'Active', 'sample']);
  await run('INSERT INTO cows(id,name,breed,lactation,calving_date,status,notes) VALUES(?,?,?,?,?,?,?)', ['CW002', 'Gowri', 'Jersey', 'Lactating', '', 'Active', 'sample']);
  for (const [d, c, am, pm] of [[addDays(t, -1), 'CW001', 6.5, 5], [addDays(t, -1), 'CW002', 8, 6.5], [t, 'CW001', 6, 0]])
    await run('INSERT INTO cow_yield(date,cow_id,am,pm,notes) VALUES(?,?,?,?,?)', [d, c, am, pm, '']);
}

const ready = init().then(seed);
const realFetch = window.fetch.bind(window);

window.fetch = async (input, opts = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const m = url.match(/\/(api\/[^#]*)$/);
  if (!m) return realFetch(input, opts);
  await ready;
  const sid = localStorage.getItem(SID);
  const req = { method: (opts.method || 'GET').toUpperCase(), url: '/' + m[1], headers: { cookie: sid ? 'grv_sid=' + sid : '' }, body: opts.body || '', socket: { remoteAddress: 'demo' } };
  return new Promise((resolve) => {
    let status = 200, headers = {};
    handle(req, {
      writeHead(code, h) { status = code; headers = { ...h }; },
      end(body) {
        const sc = headers['Set-Cookie'];
        if (sc) { const v = (sc.match(/grv_sid=([^;]*)/) || [])[1]; if (v) localStorage.setItem(SID, v); else localStorage.removeItem(SID); delete headers['Set-Cookie']; }
        resolve(new Response(body, { status, headers }));
      },
    });
  });
};

window.__demoReset = () => { localStorage.removeItem('grv-demo-db'); localStorage.removeItem(SID); location.href = location.pathname; };
