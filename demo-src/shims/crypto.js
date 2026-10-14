// Browser stand-in for the few node:crypto calls lib/core.js makes. Demo only (lighter scrypt cost than the real server).
import { sha256 } from '@noble/hashes/sha256';
import { scrypt } from '@noble/hashes/scrypt';
import { Buffer } from 'buffer';

export function randomBytes(n) { const u = new Uint8Array(n); globalThis.crypto.getRandomValues(u); return Buffer.from(u); }
export function randomInt(a, b) { const u = new Uint32Array(1); globalThis.crypto.getRandomValues(u); return a + (u[0] % (b - a)); }
export function scryptSync(pw, salt, len) { return Buffer.from(scrypt(String(pw), String(salt), { N: 1024, r: 8, p: 1, dkLen: len })); }
export function createHash() {
  const parts = [];
  return { update(v) { parts.push(Buffer.from(v)); return this; }, digest() { return Buffer.from(sha256(Buffer.concat(parts))); } };
}
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new Error('Input buffers must have the same byte length');
  let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}
