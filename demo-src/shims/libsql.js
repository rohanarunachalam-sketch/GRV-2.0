// Stand-in for @libsql/client: the same execute()/executeMultiple() calls, backed by SQLite compiled to WebAssembly (sql.js).
// The database lives in this browser's localStorage, so every visitor gets a private demo.
import initSqlJs from 'sql.js';

const KEY = 'grv-demo-db';
const BASE = (document.currentScript && document.currentScript.src) || location.href; // the wasm file sits next to demo.js
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

export function createClient() {
  const ready = (async () => {
    const SQL = await initSqlJs({ locateFile: (f) => new URL(f, BASE).href });
    let data; try { const s = localStorage.getItem(KEY); if (s) data = fromB64(s); } catch { /* start fresh */ }
    return new SQL.Database(data);
  })();
  let timer;
  const save = () => { clearTimeout(timer); timer = setTimeout(async () => { try { localStorage.setItem(KEY, toB64((await ready).export())); } catch { /* storage full or blocked */ } }, 250); };
  return {
    async execute(q) {
      const db = await ready; const sql = typeof q === 'string' ? q : q.sql;
      const args = ((typeof q === 'string' ? [] : q.args) || []).map((a) => (a === undefined ? null : a));
      const st = db.prepare(sql);
      try {
        st.bind(args);
        const columns = st.getColumnNames(), rows = [];
        while (st.step()) rows.push(st.get());
        const read = /^\s*(select|pragma|with)/i.test(sql);
        const out = { columns, rows, rowsAffected: read ? 0 : db.getRowsModified(), lastInsertRowid: read ? null : db.exec('select last_insert_rowid()')[0].values[0][0] };
        if (!read) save();
        return out;
      } finally { st.free(); }
    },
    async executeMultiple(sql) { (await ready).exec(sql); save(); },
  };
}
