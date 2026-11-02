import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  sha256Hex,
  hmacHex,
  verifyHmac,
  constantTimeEqual,
  encryptField,
  decryptField,
} from "../src/lib/crypto";

describe("password hashing", () => {
  it("round-trips a password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces unique salts per hash", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toEqual(b);
  });

  it("rejects malformed hashes safely", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "md5$abc$def$ghi")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$1$AAAA$AAAA")).toBe(false);
  });
});

describe("tokens", () => {
  it("generates distinct url-safe tokens", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,50}$/);
  });

  it("sha256 is deterministic", async () => {
    expect(await sha256Hex("microbiz")).toEqual(await sha256Hex("microbiz"));
    expect(await sha256Hex("microbiz")).toHaveLength(64);
  });
});

describe("hmac webhook signatures", () => {
  it("verifies valid signatures and rejects forged ones", async () => {
    const payload = JSON.stringify({ order_id: "123", amount: 150000 });
    const sig = await hmacHex("sandbox-secret", payload);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyHmac("sandbox-secret", payload, sig)).toBe(true);
    expect(await verifyHmac("other-secret", payload, sig)).toBe(false);
    const tampered = payload.replace("150000", "100");
    expect(await verifyHmac("sandbox-secret", tampered, sig)).toBe(false);
  });

  it("executes in constant time on length mismatch", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("xyz", "xyz")).toBe(true);
  });
});

function randBytesB64(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

describe("sensitive field encryption", () => {
  it("aes-256-gcm round-trips and is non-deterministic", async () => {
    const secret = randBytesB64(32);
    const a = await encryptField("IBAN: PK00TEST0000000000000000", secret);
    const b = await encryptField("IBAN: PK00TEST0000000000000000", secret);
    expect(a).not.toEqual(b); // random IV
    expect(await decryptField(a, secret)).toBe("IBAN: PK00TEST0000000000000000");
    await expect(decryptField(a, randBytesB64(32))).rejects.toThrow();
  });
});
