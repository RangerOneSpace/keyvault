// Vault encryption.
//
// Format (JSON "envelope"), compatible with the browser WebCrypto layout:
//   { app: "keyvault", v: 1,
//     kdf: { name: "PBKDF2", hash: "SHA-256", iter, salt },   // salt: base64, 16 bytes
//     iv: base64 (12 bytes),
//     ct: base64 (AES-256-GCM ciphertext with the 16 byte auth tag appended) }

import { pbkdf2, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

export const KDF_ITER = 600_000;          // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
const MIN_ITER = 100_000;
const MAX_ITER = 10_000_000;              // refuse absurd values from a tampered backup

export class WrongPasswordError extends Error {
  constructor() { super('Incorrect password'); this.name = 'WrongPasswordError'; }
}

export function newSalt() { return randomBytes(16); }

export async function deriveKey(password, salt, iter = KDF_ITER) {
  if (typeof password !== 'string' || password.length === 0) throw new Error('Password required');
  return pbkdf2Async(Buffer.from(password, 'utf8'), salt, iter, 32, 'sha256');
}

export function seal(key, salt, iter, data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({
    app: 'keyvault',
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iter, salt: Buffer.from(salt).toString('base64') },
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
  }, null, 2) + '\n';
}

// Returns the parsed envelope, or null if the text is not a KeyVault file.
export function parseEnvelope(text) {
  let e;
  try { e = JSON.parse(text); } catch { return null; }
  if (!e || typeof e !== 'object') return null;
  if (e.app !== 'keyvault' || e.v !== 1) return null;
  const k = e.kdf;
  if (!k || k.name !== 'PBKDF2' || k.hash !== 'SHA-256') return null;
  if (!Number.isInteger(k.iter) || k.iter < MIN_ITER || k.iter > MAX_ITER) return null;
  if (typeof k.salt !== 'string' || typeof e.iv !== 'string' || typeof e.ct !== 'string') return null;
  if (Buffer.from(e.iv, 'base64').length !== 12) return null;
  if (Buffer.from(k.salt, 'base64').length < 16) return null;
  return e;
}

export function decryptWith(key, env) {
  const iv = Buffer.from(env.iv, 'base64');
  const buf = Buffer.from(env.ct, 'base64');
  if (buf.length < 17) throw new WrongPasswordError();
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(0, buf.length - 16);
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch {
    // GCM auth failure means wrong password or a modified file. We cannot tell which.
    throw new WrongPasswordError();
  }
}

export async function openEnvelope(env, password) {
  const salt = Buffer.from(env.kdf.salt, 'base64');
  const key = await deriveKey(password, salt, env.kdf.iter);
  const data = decryptWith(key, env);
  return { key, salt, iter: env.kdf.iter, data };
}
