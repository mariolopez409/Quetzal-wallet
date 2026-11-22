import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";
import {
  encryptText, decryptText, generateServerSecret, type EncryptedText,
  hashSecret, verifySecret, generateSessionToken, hashToken, generateRecoveryCode,
  signApprovalMessage,
} from "./crypto";

// Privileged operations: encrypting/decrypting the operator's Crossmint API
// key at rest, generating the server secret it is encrypted with, password
// hashing / session tokens / recovery codes, and signing Crossmint
// transaction approvals with the operator's server signer (whose secret
// lives only in the operator's own file on this server and is never
// returned). There is deliberately NO seed-phrase contract here: this
// wallet never generates, imports, recovers or derives from a mnemonic.
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
  // Signs ONE Crossmint transaction-approval message with the operator's
  // server signer (Ed25519). The signer secret is read from the operator's
  // own file inside this handler and never leaves it: the response carries
  // only the signature and the signer's PUBLIC address.
  signApprovalMessage: {
    request: z.object({ message: z.string().min(1).max(4096) }),
    response: z.object({ signature: z.string(), signerAddress: z.string() }),
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
  signApprovalMessage(args) {
    return signApprovalMessage(args.message);
  },
});
