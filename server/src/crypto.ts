import {
randomBytes, randomInt, scryptSync, createCipheriv, createDecipheriv,
createHash, timingSafeEqual,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Symmetric encryption only (scrypt + AES-256-GCM).
//
// This wallet has NO seed phrase and no key derivation: users' wallets are
// Crossmint Smart Wallets created with the operator's Crossmint API key.
// The only secret this module protects is that API key, encrypted at rest
// with a server secret the app generates automatically (see
// generateServerSecret). Nothing here can create, import, recover or derive
// from a BIP39 mnemonic — that code was removed entirely.
// ---------------------------------------------------------------------------

export type EncryptedText = { ciphertext: string; salt: string; iv: string; authTag: string };

export function encryptText(text: string, passphrase: string): EncryptedText {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: enc.toString("hex"), salt: salt.toString("hex"), iv: iv.toString("hex"), authTag: authTag.toString("hex") };
}

export function decryptText(enc: EncryptedText, passphrase: string): string {
  const salt = Buffer.from(enc.salt, "hex");
  const iv = Buffer.from(enc.iv, "hex");
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(enc.authTag, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, "hex")), decipher.final()]);
  return dec.toString("utf8");
}

// Random per-installation secret used as the API key's encryption
// passphrase. Generated once on the server and stored in app_settings; the
// operator never sees or types it.
export function generateServerSecret(): string {
  return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Password / recovery-code hashing and session tokens (migration 0008).
// Passwords and recovery codes are hashed with scrypt and a random per-secret
// salt; verification is constant-time. Session tokens are 256-bit random
// values; only their SHA-256 hash is ever stored.
// ---------------------------------------------------------------------------

export function hashSecret(secret: string): { hash: string; salt: string } {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

export function verifySecret(secret: string, hashHex: string, saltHex: string): boolean {
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(secret, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateRecoveryCode(): string {
  return String(randomInt(0, 1000000)).padStart(6, "0");
}
