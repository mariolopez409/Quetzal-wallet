import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";
import {
  encryptText, decryptText, generateServerSecret, type EncryptedText,
  hashSecret, verifySecret, generateSessionToken, hashToken, generateRecoveryCode,
} from "./crypto";

// Only two privileged operations remain: encrypting/decrypting the
// operator's Crossmint API key at rest, and generating the server secret it
// is encrypted with. There is deliberately NO seed-phrase contract here:
// this wallet never generates, imports, recovers or derives from a mnemonic.
export const privileged = definePrivilegedContracts({
  encryptText: {
    request: z.object({ text: z.string().min(1).max(500), passphrase: z.string().min(1).max(200) }),
    response: z.object({
      ciphertext: z.string(), salt: z.string(), iv: z.string(), authTag: z.string(),
    }),
    timeoutMs: 30000,
  },
  decryptText: {
    request: z.object({
      ciphertext: z.string(), salt: z.string(), iv: z.string(), authTag: z.string(),
      passphrase: z.string().min(1).max(200),
    }),
    response: z.object({ text: z.string() }),
    timeoutMs: 30000,
  },
  generateServerSecret: {
    request: z.object({}),
    response: z.object({ secret: z.string() }),
    timeoutMs: 30000,
  },
  hashSecret: {
    request: z.object({ secret: z.string().min(1).max(200) }),
    response: z.object({ hash: z.string(), salt: z.string() }),
    timeoutMs: 30000,
  },
  verifySecret: {
    request: z.object({ secret: z.string().min(1).max(200), hash: z.string().max(300), salt: z.string().max(100) }),
    response: z.object({ ok: z.boolean() }),
    timeoutMs: 30000,
  },
  generateSessionToken: {
    request: z.object({}),
    response: z.object({ token: z.string() }),
    timeoutMs: 30000,
  },
  hashToken: {
    request: z.object({ token: z.string().min(1).max(200) }),
    response: z.object({ hash: z.string() }),
    timeoutMs: 30000,
  },
  generateRecoveryCode: {
    request: z.object({}),
    response: z.object({ code: z.string() }),
    timeoutMs: 30000,
  },
});

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  encryptText(args) {
    return { ...encryptText(args.text, args.passphrase) };
  },
  decryptText(args) {
    const { passphrase, ...enc } = args;
    try {
      return { text: decryptText(enc as EncryptedText, passphrase) };
    } catch {
      throw new Error("No se pudo descifrar la API key de Crossmint guardada.");
    }
  },
  generateServerSecret() {
    return { secret: generateServerSecret() };
  },
  hashSecret(args) {
    return hashSecret(args.secret);
  },
  verifySecret(args) {
    return { ok: verifySecret(args.secret, args.hash, args.salt) };
  },
  generateSessionToken() {
    return { token: generateSessionToken() };
  },
  hashToken(args) {
    return { hash: hashToken(args.token) };
  },
  generateRecoveryCode() {
    return { code: generateRecoveryCode() };
  },
});
