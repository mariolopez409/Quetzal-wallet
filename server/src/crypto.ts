import {
randomBytes, randomInt, scryptSync, createCipheriv, createDecipheriv,
createHash, timingSafeEqual, createPrivateKey, createPublicKey, sign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

// ---------------------------------------------------------------------------
// Crossmint server signer (Ed25519).
//
// Every user's Crossmint Smart Wallet has ONE admin/recovery signer: the
// operator's server signer keypair. Crossmint never sees its secret — a
// transaction is created through the Crossmint API, Crossmint returns the
// approval message, THIS function signs it locally, and only the signature
// is sent back to Crossmint. The secret itself is never stored in the app
// database, never returned by any contract, and never leaves this process:
// it is read at signing time from the operator's own signer file on the
// server (QUETZAL_SIGNER_SECRET_FILE, or ~/workspace/crossmint/
// server-signer-solana.json by default). If the file is not on the server,
// signing is impossible and the caller gets a clear error — sends simply
// cannot execute on a deployment that does not hold the signer secret.
// ---------------------------------------------------------------------------

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const idx = B58_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error("Carácter base58 no válido.");
    n = n * 58n + BigInt(idx);
  }
  let body = Buffer.alloc(0);
  if (n > 0n) {
    let hex = n.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    body = Buffer.from(hex, "hex");
  }
  let pad = 0;
  while (s[pad] === "1") pad++;
  return Buffer.concat([Buffer.alloc(pad), body]);
}

export function base58Encode(buf: Buffer): string {
  let n = buf.length > 0 ? BigInt(`0x${buf.toString("hex")}`) : 0n;
  let out = "";
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  let pad = 0;
  while (buf[pad] === 0) pad++;
  return "1".repeat(pad) + out;
}

function loadServerSignerKeypair(): { seed: Buffer; address: string } {
  const path = process.env.QUETZAL_SIGNER_SECRET_FILE
    ?? join(homedir(), "workspace", "crossmint", "server-signer-solana.json");
  let parsed: { secret_key_base58?: string };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { secret_key_base58?: string };
  } catch {
    throw new Error("El secreto del firmante del servidor no está disponible en este servidor: sin él no se puede firmar ninguna transacción de Crossmint.");
  }
  if (!parsed.secret_key_base58) {
    throw new Error("El archivo del firmante del servidor no contiene la clave esperada.");
  }
  const raw = base58Decode(parsed.secret_key_base58);
  if (raw.length !== 64 && raw.length !== 32) {
    throw new Error("La clave del firmante del servidor tiene un formato no válido.");
  }
  const seed = raw.subarray(0, 32);
  // Derive the signer's public address from the seed to prove which signer
  // this is (and to build the Crossmint signer locator).
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
  const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const pubRaw = spki.subarray(spki.length - 32);
  return { seed: Buffer.from(seed), address: base58Encode(Buffer.from(pubRaw)) };
}

// Signs one Crossmint approval message (base58) with the server signer and
// returns the base58 signature plus the signer's public address. Mirrors
// the Crossmint SDK's Solana server signer exactly: decode the message
// from base58, Ed25519-sign the raw bytes, base58-encode the signature.
export function signApprovalMessage(messageBase58: string): { signature: string; signerAddress: string } {
  const { seed, address } = loadServerSignerKeypair();
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const message = base58Decode(messageBase58);
  const sig = sign(null, message, priv);
  return { signature: base58Encode(Buffer.from(sig)), signerAddress: address };
}
