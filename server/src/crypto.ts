import {
createHash, createHmac, pbkdf2Sync, randomBytes, scryptSync,
createCipheriv, createDecipheriv, createPrivateKey, createPublicKey,
} from "node:crypto";
import { BIP39_WORDS } from "./wordlist";

// ---------------- Keccak-256 (original Keccak padding 0x01, not SHA3) ----------------
const KECCAK_RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROT: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];
const MASK64 = (1n << 64n) - 1n;
function rotl(x: bigint, n: number): bigint {
  if (n === 0) return x & MASK64;
  const b = BigInt(n);
  return ((x << b) | (x >> (64n - b))) & MASK64;
}
function keccakF(A: bigint[][]) {
  for (let round = 0; round < 24; round++) {
    const C: bigint[] = new Array(5);
    const D: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = A[x]![0]! ^ A[x]![1]! ^ A[x]![2]! ^ A[x]![3]! ^ A[x]![4]!;
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5]! ^ rotl(C[(x + 1) % 5]!, 1);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x]![y] = A[x]![y]! ^ D[x]!;
    const B: bigint[][] = Array.from({ length: 5 }, () => new Array(5).fill(0n));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y]![(2 * x + 3 * y) % 5] = rotl(A[x]![y]!, KECCAK_ROT[x]![y]!);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x]![y] = (B[x]![y]! ^ ((~B[(x + 1) % 5]![y]!) & B[(x + 2) % 5]![y]!)) & MASK64;
    A[0]![0] = A[0]![0]! ^ KECCAK_RC[round]!;
  }
}
export function keccak256(input: Uint8Array): Uint8Array {
  const rate = 136;
  const A: bigint[][] = Array.from({ length: 5 }, () => new Array(5).fill(0n));
  const paddedLen = Math.ceil((input.length + 1) / rate) * rate;
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[paddedLen - 1] = padded[paddedLen - 1]! | 0x80;
  for (let offset = 0; offset < paddedLen; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + j]!);
      const x = i % 5; const y = Math.floor(i / 5);
      A[x]![y] = A[x]![y]! ^ lane;
    }
    keccakF(A);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const x = i % 5; const y = Math.floor(i / 5);
    let lane = A[x]![y]!;
    for (let j = 0; j < 8; j++) { out[i * 8 + j] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

// ---------------- Base58 ----------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(data: Uint8Array): string {
  let zeros = 0;
  while (zeros < data.length && data[zeros] === 0) zeros++;
  let num = 0n;
  for (const byte of data) num = num * 256n + BigInt(byte);
  let out = "";
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  return "1".repeat(zeros) + out;
}
function sha256(data: Uint8Array): Buffer { return createHash("sha256").update(data).digest(); }

// ---------------- BIP39 ----------------
const wordIndex = new Map(BIP39_WORDS.map((w, i) => [w, i]));
export function generateMnemonic(): string {
  const entropy = randomBytes(16); // 128 bits -> 12 words
  const hash = sha256(entropy);
  const checksumBits = (hash[0]! >> 4) & 0xf;
  // Build bit string
  let bits = "";
  for (const b of entropy) bits += b.toString(2).padStart(8, "0");
  bits += checksumBits.toString(2).padStart(4, "0");
  const words: string[] = [];
  for (let i = 0; i < bits.length; i += 11) {
    const idx = parseInt(bits.slice(i, i + 11), 2);
    words.push(BIP39_WORDS[idx]!);
  }
  return words.join(" ");
}
export function validateMnemonic(mnemonic: string): boolean {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) return false;
  let bits = "";
  for (const w of words) {
    const idx = wordIndex.get(w);
    if (idx == null) return false;
    bits += idx.toString(2).padStart(11, "0");
  }
  const entropyBitsLen = (bits.length * 32) / 33;
  const entropyBits = bits.slice(0, entropyBitsLen);
  const checksumBits = bits.slice(entropyBitsLen);
  const entropy = new Uint8Array(entropyBitsLen / 8);
  for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2);
  const hash = sha256(entropy);
  const expected = (hash[0]! >> (8 - checksumBits.length)).toString(2).padStart(checksumBits.length, "0");
  return expected === checksumBits;
}
export function mnemonicToSeed(mnemonic: string): Buffer {
  return pbkdf2Sync(mnemonic.trim().toLowerCase().normalize("NFKD"), "mnemonic", 2048, 64, "sha512");
}

// ---------------- Encryption (scrypt + AES-256-GCM) ----------------
export type EncryptedSeed = { ciphertext: string; salt: string; iv: string; authTag: string };
export function encryptSeed(mnemonic: string, passphrase: string): EncryptedSeed {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(mnemonic, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: enc.toString("hex"), salt: salt.toString("hex"), iv: iv.toString("hex"), authTag: authTag.toString("hex") };
}
export function decryptSeed(enc: EncryptedSeed, passphrase: string): string {
  const salt = Buffer.from(enc.salt, "hex");
  const iv = Buffer.from(enc.iv, "hex");
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(enc.authTag, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, "hex")), decipher.final()]);
  return dec.toString("utf8");
}

// ---------------- BIP32 secp256k1 ----------------
const CURVE_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
type HDNode = { priv: Buffer; chain: Buffer };
function hmac512(key: Buffer | string, data: Buffer): Buffer {
  return createHmac("sha512", key).update(data).digest();
}
function ser32(i: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(i >>> 0, 0); return b; }
// Pure-BigInt secp256k1 (Bun's ECDH lacks secp256k1). Jacobian coordinates.
const FIELD_P = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F");
const GX = BigInt("0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798");
const GY = BigInt("0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8");
function modP(a: bigint): bigint { const r = a % FIELD_P; return r >= 0n ? r : r + FIELD_P; }
function powMod(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n; let b = ((base % mod) + mod) % mod; let e = exp;
  while (e > 0n) { if (e & 1n) result = (result * b) % mod; b = (b * b) % mod; e >>= 1n; }
  return result;
}
type Jac = { X: bigint; Y: bigint; Z: bigint } | null;
function jacDouble(p: Jac): Jac {
  if (!p || p.Y === 0n) return null;
  const yy = modP(p.Y * p.Y);
  const S = modP(4n * p.X * yy);
  const M = modP(3n * p.X * p.X); // a=0
  const X2 = modP(M * M - 2n * S);
  const Y2 = modP(M * (S - X2) - 8n * yy * yy);
  const Z2 = modP(2n * p.Y * p.Z);
  return { X: X2, Y: Y2, Z: Z2 };
}
function jacAdd(p: Jac, q: Jac): Jac {
  if (!p) return q;
  if (!q) return p;
  const z1z1 = modP(p.Z * p.Z);
  const z2z2 = modP(q.Z * q.Z);
  const u1 = modP(p.X * z2z2);
  const u2 = modP(q.X * z1z1);
  const s1 = modP(p.Y * q.Z * z2z2);
  const s2 = modP(q.Y * p.Z * z1z1);
  if (u1 === u2) {
    if (s1 !== s2) return null;
    return jacDouble(p);
  }
  const Hv = modP(u2 - u1);
  const R = modP(s2 - s1);
  const hh = modP(Hv * Hv);
  const hhh = modP(Hv * hh);
  const v = modP(u1 * hh);
  const X3 = modP(R * R - hhh - 2n * v);
  const Y3 = modP(R * (v - X3) - s1 * hhh);
  const Z3 = modP(Hv * p.Z * q.Z);
  return { X: X3, Y: Y3, Z: Z3 };
}
function secpPub(priv: Buffer, compressed = true): Buffer {
  const k = BigInt("0x" + priv.toString("hex"));
  let result: Jac = null;
  let addend: Jac = { X: GX, Y: GY, Z: 1n };
  let scalar = k;
  // double-and-add LSB first
  while (scalar > 0n) {
    if (scalar & 1n) result = jacAdd(result, addend);
    addend = jacDouble(addend);
    scalar >>= 1n;
  }
  if (!result) throw new Error("Clave inválida");
  const zInv = powMod(result.Z, FIELD_P - 2n, FIELD_P);
  const zInv2 = modP(zInv * zInv);
  const x = modP(result.X * zInv2);
  const y = modP(result.Y * zInv2 * zInv);
  const xBuf = Buffer.from(x.toString(16).padStart(64, "0"), "hex");
  const yBuf = Buffer.from(y.toString(16).padStart(64, "0"), "hex");
  if (compressed) return Buffer.concat([Buffer.from([y % 2n === 0n ? 0x02 : 0x03]), xBuf]);
  return Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);
}
function masterFromSeed(seed: Buffer): HDNode {
  const I = hmac512("Bitcoin seed", seed);
  return { priv: I.subarray(0, 32), chain: I.subarray(32) };
}
function deriveChild(node: HDNode, index: number): HDNode {
  const hardened = index >= 0x80000000;
  const data = hardened
    ? Buffer.concat([Buffer.from([0]), node.priv, ser32(index)])
    : Buffer.concat([secpPub(node.priv), ser32(index)]);
  const I = hmac512(node.chain, data);
  const il = BigInt("0x" + I.subarray(0, 32).toString("hex"));
  const parent = BigInt("0x" + node.priv.toString("hex"));
  const child = (il + parent) % CURVE_N;
  if (child === 0n) throw new Error("Derivación inválida");
  const priv = Buffer.from(child.toString(16).padStart(64, "0"), "hex");
  return { priv, chain: I.subarray(32) };
}
function derivePath(seed: Buffer, path: number[]): HDNode {
  let node = masterFromSeed(seed);
  for (const idx of path) node = deriveChild(node, idx);
  return node;
}
const H = 0x80000000;
export function evmAddressFromSeed(seed: Buffer, accountIndex: number): { address: string; path: string } {
  const pathNums = [44 + H, 60 + H, accountIndex + H, 0, 0];
  const node = derivePath(seed, pathNums);
  const pub = secpPub(node.priv, false); // 65 bytes 0x04 + x + y
  const hash = keccak256(pub.subarray(1));
  const address = "0x" + Buffer.from(hash.subarray(12)).toString("hex");
  // EIP-55 checksum
  const hashHex = Buffer.from(keccak256(new TextEncoder().encode(address.slice(2).toLowerCase()))).toString("hex");
  let checksummed = "0x";
  for (let i = 0; i < 40; i++) {
    const ch = address[2 + i]!;
    checksummed += parseInt(hashHex[i]!, 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return { address: checksummed, path: `m/44'/60'/${accountIndex}'/0/0` };
}
export function tronAddressFromSeed(seed: Buffer, accountIndex: number): { address: string; path: string } {
  const pathNums = [44 + H, 195 + H, accountIndex + H, 0, 0];
  const node = derivePath(seed, pathNums);
  const pub = secpPub(node.priv, false);
  const hash = keccak256(pub.subarray(1));
  const addrBytes = Buffer.concat([Buffer.from([0x41]), Buffer.from(hash.subarray(12))]);
  const checksum = sha256(sha256(addrBytes)).subarray(0, 4);
  const full = Buffer.concat([addrBytes, checksum]);
  return { address: base58Encode(full), path: `m/44'/195'/${accountIndex}'/0/0` };
}

// ---------------- SLIP-0010 ed25519 (Solana) ----------------
type EdNode = { priv: Buffer; chain: Buffer };
function edMaster(seed: Buffer): EdNode {
  const I = hmac512("ed25519 seed", seed);
  return { priv: I.subarray(0, 32), chain: I.subarray(32) };
}
function edChild(node: EdNode, indexHardened: number): EdNode {
  const data = Buffer.concat([Buffer.from([0]), node.priv, ser32(indexHardened)]);
  const I = hmac512(node.chain, data);
  return { priv: I.subarray(0, 32), chain: I.subarray(32) };
}
function ed25519Public(privSeed: Buffer): Buffer {
  // PKCS8 DER for ed25519: 302e020100300506032b657004220420 || seed
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privSeed]);
  const privKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const pubKey = createPublicKey(privKey);
  const spki = pubKey.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32);
}
export function solanaAddressFromSeed(seed: Buffer, accountIndex: number): { address: string; path: string } {
  let node = edMaster(seed);
  for (const idx of [44 + H, 501 + H, accountIndex + H, 0 + H]) node = edChild(node, idx);
  const pub = ed25519Public(node.priv);
  return { address: base58Encode(pub), path: `m/44'/501'/${accountIndex}'/0'` };
}

export function deriveAllAddresses(mnemonic: string, accountIndex: number): { network: string; address: string; path: string }[] {
  const seed = mnemonicToSeed(mnemonic);
  const sol = solanaAddressFromSeed(seed, accountIndex);
  const evm = evmAddressFromSeed(seed, accountIndex);
  const tron = tronAddressFromSeed(seed, accountIndex);
  const evmNetworks = ["ethereum", "bsc", "polygon", "arbitrum", "optimism", "avalanche", "base", "linea", "zksync", "robinhood"];
  const out: { network: string; address: string; path: string }[] = [
    { network: "solana", address: sol.address, path: sol.path },
    ...evmNetworks.map((n) => ({ network: n, address: evm.address, path: evm.path })),
    { network: "tron", address: tron.address, path: tron.path },
  ];
  return out;
}
