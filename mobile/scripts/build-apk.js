// Build the GRV Dairy Android app.
//   set APP_URL=https://your-site.vercel.app   (the address the app opens)   then:   npm run build:apk
// Output: android/app/build/outputs/apk/debug/app-debug.apk   (copied to GRV-Dairy.apk)
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const url = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
if (!/^https?:\/\/[^\s/]+/.test(url)) { console.error('Set APP_URL first, e.g.  set APP_URL=http://192.168.1.5:3000'); process.exit(1); }
const clear = url.startsWith('http://');
if (clear) console.log('Note: http:// (not https://) is for testing on your Wi-Fi only. Use the https:// address when the site is online.');

// 1. point the app at the site
for (const f of ['index.html', 'error.html']) {
  const src = fs.readFileSync(path.join(ROOT, 'www', f), 'utf8').replace(/https?:\/\/[^'"]*|__APP_URL__/g, (m) => (m === '__APP_URL__' || m.startsWith('http') ? url : m));
  fs.writeFileSync(path.join(ROOT, 'www', f), src);
}
fs.writeFileSync(path.join(ROOT, 'capacitor.config.json'), JSON.stringify({
  appId: 'com.grvdairy.app', appName: 'GRV Dairy', webDir: 'www',
  server: { url, cleartext: clear, errorPath: 'error.html', androidScheme: clear ? 'http' : 'https' },
  android: { allowMixedContent: clear },
}, null, 2));

// 2. sync and build
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
if (!fs.existsSync(sdk)) { console.error('Android SDK not found. Install Android Studio or set ANDROID_HOME.'); process.exit(1); }
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
fs.writeFileSync(path.join(ROOT, 'android', 'local.properties'), `sdk.dir=${sdk.split(path.sep).join('/')}\n`);
execSync('npx cap sync android', { cwd: ROOT, stdio: 'inherit', env });
execSync(process.platform === 'win32' ? '.\\gradlew.bat assembleDebug' : './gradlew assembleDebug', { cwd: path.join(ROOT, 'android'), stdio: 'inherit', env });
const apk = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
fs.copyFileSync(apk, path.join(ROOT, 'GRV-Dairy.apk'));
console.log('\nDone: ' + path.join(ROOT, 'GRV-Dairy.apk'));
