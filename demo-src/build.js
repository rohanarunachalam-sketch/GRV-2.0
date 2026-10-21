// Builds the browser-only demo into ../demo (served by GitHub Pages).   npm run build
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(root, 'demo');
const pub = path.join(root, 'app', 'public');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'entry.js')],
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2020',
  outfile: path.join(out, 'demo.js'), logLevel: 'warning',
  alias: {
    'node:crypto': path.join(__dirname, 'shims', 'crypto.js'),
    'node:fs': path.join(__dirname, 'shims', 'node-misc.js'),
    'node:path': path.join(__dirname, 'shims', 'node-misc.js'),
    'node:url': path.join(__dirname, 'shims', 'node-misc.js'),
    '@libsql/client': path.join(__dirname, 'shims', 'libsql.js'),
  },
  define: {
    __dirname: '"/app/lib"',
    'process.env.TURSO_DATABASE_URL': 'undefined', 'process.env.TURSO_AUTH_TOKEN': 'undefined', 'process.env.VERCEL': 'undefined',
    'process.env.APP_TZ': '"Asia/Kolkata"', 'process.env.BILL_UPDATE_HOUR': 'undefined',
    'process.env.VERCEL_DEPLOYMENT_ID': 'undefined', 'process.env.VERCEL_GIT_COMMIT_SHA': 'undefined',
    'process.env.ADMIN_PASSWORD': '"admin123"', 'process.env.DELIVERY_PASSWORD': '"delivery123"',
  },
});

for (const f of ['app.js', 'style.css', 'logo.png', 'manifest.webmanifest']) fs.copyFileSync(path.join(pub, f), path.join(out, f));
fs.copyFileSync(path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm-browser.wasm'), path.join(out, 'sql-wasm-browser.wasm'));
// cache-busting: GitHub Pages lets browsers keep files for ~10 minutes, so every build gets a fresh version number
const ver = Date.now().toString(36);
fs.writeFileSync(path.join(out, 'index.html'), fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  .replace('href="style.css"', `href="style.css?v=${ver}"`).replace('src="demo.js"', `src="demo.js?v=${ver}"`).replace('src="app.js"', `src="app.js?v=${ver}"`));
fs.writeFileSync(path.join(root, '.nojekyll'), '');
fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=demo/"><title>GRV Dairy</title><a href="demo/">Open the GRV Dairy demo</a>\n');
console.log('Demo built in', out);
