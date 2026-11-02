/**
 * WebCrypto helpers. Works in Workers and in Node 20+ (global crypto.webcrypto),
 * so these functions are unit-testable with plain vitest.
 */

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH_BITS = 256;

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of view) str += String.fromCharCode(b);
  return btoa(str);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, saltArg: Uint8Array, iterations: number): Promise<Uint8Array> {
  const salt = saltArg as unknown as BufferSource;
  const keyMaterial = await subtle().importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await subtle().deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    KEY_LENGTH_BITS
  );
  return new Uint8Array(bits);
}

/** Format: pbkdf2$iterations$b64salt$b64hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 5_000_000) return false;
  const salt = fromB64(parts[2]!);
  const expected = fromB64(parts[3]!);
  const actual = await pbkdf2(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

export function constantTimeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const aa = typeof a === "string" ? new TextEncoder().encode(a) : a;
  const bb = typeof b === "string" ? new TextEncoder().encode(b) : b;
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}

/** Random 256-bit token, URL-safe base64. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data: BufferSource =
    typeof input === "string" ? new TextEncoder().encode(input) : (input as unknown as BufferSource);
  const digest = await subtle().digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 signature, hex encoded. Already base64-decoded secrets supported. */
export async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await subtle().importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await subtle().sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyHmac(secret: string, payload: string, signatureHex: string): Promise<boolean> {
  const expected = await hmacHex(secret, payload);
  return constantTimeEqual(expected, signatureHex.trim().toLowerCase());
}

/** AES-256-GCM encryption for sensitive fields at rest (e.g. payout profiles). */
export async function encryptField(text: string, secretB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await subtle().importKey("raw", fromB64(secretB64) as unknown as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const enc = await subtle().encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, new TextEncoder().encode(text) as unknown as BufferSource);
  const out = new Uint8Array(iv.length + enc.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(enc), iv.length);
  return toB64(out);
}

export async function decryptField(cipherB64: string, secretB64: string): Promise<string> {
  const raw = fromB64(cipherB64);
  const iv = raw.slice(0, 12);
  const key = await subtle().importKey("raw", fromB64(secretB64) as unknown as BufferSource, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const dec = await subtle().decrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, raw.slice(12) as unknown as BufferSource);
  return new TextDecoder().decode(dec);
}
