import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";
import {
generateMnemonic, validateMnemonic, encryptSeed, decryptSeed, deriveAllAddresses,
type EncryptedSeed,
} from "./crypto";

export const privileged = definePrivilegedContracts({
  generateVault: {
    request: z.object({ passphrase: z.string().min(1).max(120) }),
    response: z.object({
      mnemonic: z.string(),
      ciphertext: z.string(), salt: z.string(), iv: z.string(), authTag: z.string(),
    }),
    timeoutMs: 30000,
  },
  importVault: {
    request: z.object({ mnemonic: z.string().min(1).max(400), passphrase: z.string().min(1).max(120) }),
    response: z.object({
      ciphertext: z.string(), salt: z.string(), iv: z.string(), authTag: z.string(),
    }),
    timeoutMs: 30000,
  },
  decryptSeedOnly: {
    request: z.object({
      ciphertext: z.string(), salt: z.string(), iv: z.string(), authTag: z.string(),
      passphrase: z.string().min(1).max(120),
    }),
    response: z.object({ mnemonic: z.string() }),
    timeoutMs: 30000,
  },
  deriveAddresses: {
    request: z.object({
      ciphertext: z.string(), salt: z.string(), iv: z.string(), authTag: z.string(),
      passphrase: z.string().min(1).max(120), accountIndex: z.number().int().min(0).max(100000),
    }),
    response: z.object({
      addresses: z.array(z.object({ network: z.string(), address: z.string(), path: z.string() })),
    }),
    timeoutMs: 30000,
  },
  encryptText: {
    request: z.object({ text: z.string().min(1).max(500), passphrase: z.string().min(1).max(120) }),
    response: z.object({
      ciphertext: z.string(), salt: z.string(), iv: z.string(), authTag: z.string(),
    }),
    timeoutMs: 30000,
  },
  decryptText: {
    request: z.object({
      ciphertext: z.string(), salt: z.string(), iv: z.string(), authTag: z.string(),
      passphrase: z.string().min(1).max(120),
    }),
    response: z.object({ text: z.string() }),
    timeoutMs: 30000,
  },
});

function decryptOrThrow(enc: EncryptedSeed, passphrase: string): string {
  try {
    return decryptSeed(enc, passphrase);
  } catch {
    throw new Error("Contraseña incorrecta: no se pudo descifrar la frase semilla.");
  }
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  generateVault(args) {
    const mnemonic = generateMnemonic();
    const enc = encryptSeed(mnemonic, args.passphrase);
    return { mnemonic, ...enc };
  },
  importVault(args) {
    const mnemonic = args.mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
    if (!validateMnemonic(mnemonic)) {
      throw new Error("La frase semilla no es válida (revisa las palabras y el orden, 12 o 24 palabras BIP39).");
    }
    return { ...encryptSeed(mnemonic, args.passphrase) };
  },
  decryptSeedOnly(args) {
    const { passphrase, ...enc } = args;
    return { mnemonic: decryptOrThrow(enc, passphrase) };
  },
  deriveAddresses(args) {
    const { passphrase, accountIndex, ...enc } = args;
    const mnemonic = decryptOrThrow(enc, passphrase);
    return { addresses: deriveAllAddresses(mnemonic, accountIndex) };
  },
  encryptText(args) {
    return { ...encryptSeed(args.text, args.passphrase) };
  },
  decryptText(args) {
    const { passphrase, ...enc } = args;
    try {
      return { text: decryptSeed(enc, passphrase) };
    } catch {
      throw new Error("Contraseña incorrecta: no se pudo descifrar la API key de Crossmint.");
    }
  },
});
