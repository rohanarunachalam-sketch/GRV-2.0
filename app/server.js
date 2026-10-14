// GRV Dairy — local server. Run: node server.js   then open http://localhost:3000
// (On Vercel, api/index.js serves the API and public/ is served as static files.)
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handle, init } = require('./lib/core');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return handle(req, res);
  const page = ['/', '/admin', '/delivery'].includes(url.pathname.replace(/(.)\/+$/, '$1')); // sign-in addresses all serve the app
  const file = path.normalize(path.join(ROOT, page ? 'index.html' : url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(fs.readFileSync(file));
});

init().then(() => {
  // 0.0.0.0 so phones on the same Wi-Fi can connect
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`GRV Dairy running at http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log(`On your phone (same Wi-Fi): http://${a.address}:${PORT}`);
  });
}).catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
