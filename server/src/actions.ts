import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";
import { privileged } from "@space/privileged";

// ---------------------------------------------------------------------------
// CROSSMINT-ONLY ARCHITECTURE.
//
// This app is only the shell (cascarón). EVERY wallet function goes through
// the operator's Crossmint server API key:
//   · Registration → Crossmint creates the user's Solana Smart Wallet.
//   · Balances     → read live from the Crossmint balances endpoint.
//   · Sends        → created as real transfers in Crossmint, signed locally
//                    with the operator's server signer (privileged contract;
//                    Crossmint never sees that secret) and submitted back to
//                    Crossmint for approval; Crossmint broadcasts on-chain.
// There is NO internal ledger, NO manual balance crediting and NO public-RPC
// balance reading anymore: a balance or a movement exists only if Crossmint
// reports it. GTQ (Quetzal) lives on Solana as a Token-2022 mint.
// ---------------------------------------------------------------------------

export const GTQ_MINT = "GTqK16bpGTqhYhXQzfHCxySJW4EswwtNw6THJ8VAMcXd";

// The only network this wallet operates: Solana, through Crossmint.
type NetDef = { id: string; name: string; kind: string; native: string; testnet: boolean };
const NETWORKS: NetDef[] = [
  { id: "solana", name: "Solana", kind: "solana", native: "SOL", testnet: false },
];

// Assets a Crossmint Solana wallet can hold here, with their Crossmint
// token locators (chain:contract-or-symbol).
const CROSSMINT_TOKENS: { asset: string; locator: string; isGtq: boolean }[] = [
  { asset: "GTQ", locator: `solana:${GTQ_MINT}`, isGtq: true },
  { asset: "SOL", locator: "solana:sol", isGtq: false },
  { asset: "USDT", locator: "solana:usdt", isGtq: false },
  { asset: "USDC", locator: "solana:usdc", isGtq: false },
];

const PRICE_IDS: Record<string, string> = {
  SOL: "solana", USDT: "tether", USDC: "usd-coin",
};

async function fetchPrices(): Promise<Record<string, number>> {
  try {
    const ids = [...new Set(Object.values(PRICE_IDS))].join(",");
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { signal: AbortSignal.timeout(10000) });
    const json = (await res.json()) as Record<string, { usd?: number }>;
    const byId = new Map(Object.entries(json).map(([id, v]) => [id, v.usd ?? 0]));
    const out: Record<string, number> = {};
    for (const [symbol, id] of Object.entries(PRICE_IDS)) {
      const p = byId.get(id);
      if (p) out[symbol] = p;
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------

const txShape = z.object({
  id: z.number(),
  kind: z.string(),
  network: z.string(),
  fromAsset: z.string(),
  toAsset: z.string().nullable(),
  amount: z.string(),
  feeGtq: z.string(),
  toAddress: z.string().nullable(),
  note: z.string(),
  payload: z.string(),
  status: z.string(),
  userId: z.number().nullable(),
  relatedUserId: z.number().nullable(),
  createdAt: z.string(),
});

const userShape = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  kycStatus: z.string(),
  accountIndex: z.number(),
  crossmintAddress: z.string(),
  createdAt: z.string(),
  addresses: z.array(z.object({ network: z.string(), address: z.string(), derivationPath: z.string() })),
});

// ---------------- App settings helpers ----------------

function numStr(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(10).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
}
// There is NO seed vault: the wallet runs only on the operator's Crossmint
// API key. app_settings holds the GTQ service fee and the server secret the
// API key is encrypted with.

type Db = ReturnType<Ctx["db"]>;

type SettingsRow = typeof schema.appSettings.$inferSelect;

async function getSettingsRow(ctx: Ctx): Promise<SettingsRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.appSettings).orderBy(asc(schema.appSettings.id)).limit(1);
  return rows[0] ?? null;
}

// The GTQ service fee for sends and transfers between users.
async function getFeeGtq(ctx: Ctx): Promise<string> {
  const row = await getSettingsRow(ctx);
  return row?.feeGtq ?? "1";
}

// Returns the server secret, generating and storing one on first use. The
// operator never sees or types it: it exists only so the saved Crossmint
// API key is encrypted at rest while the server can still use it on its own
// (automatic wallet creation at registration, NC Wallet style).
async function ensureServerSecret(ctx: Ctx): Promise<string> {
  const db = ctx.db<typeof schema>();
  const row = await getSettingsRow(ctx);
  if (row?.serverSecret) return row.serverSecret;
  const gen = await ctx.executePrivileged(privileged.generateServerSecret, {});
  if (row) {
    await db.update(schema.appSettings).set({ serverSecret: gen.secret })
      .where(eq(schema.appSettings.id, row.id));
  } else {
    await db.insert(schema.appSettings).values({ feeGtq: "1", serverSecret: gen.secret });
  }
  return gen.secret;
}

type UserRow = typeof schema.custodialUsers.$inferSelect;

async function getUserRow(db: Db, userId: number) {
  const rows = await db.select().from(schema.custodialUsers).where(eq(schema.custodialUsers.id, userId));
  return rows[0] ?? null;
}

async function buildUser(db: Db, u: UserRow) {
  const addrs = await db.select().from(schema.userAddresses).where(eq(schema.userAddresses.userId, u.id));
  const order = new Map(NETWORKS.map((n, i) => [n.id, i]));
  addrs.sort((a, b) => (order.get(a.network) ?? 99) - (order.get(b.network) ?? 99));
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone, kycStatus: u.kycStatus,
    accountIndex: u.accountIndex, crossmintAddress: u.crossmintAddress ?? "",
    createdAt: u.createdAt.toISOString(),
    addresses: addrs.map((a) => ({ network: a.network, address: a.address, derivationPath: a.derivationPath })),
  };
}

// ---------------- Password auth, sessions, recovery (migration 0008) ------
// Production access control. Every account has a password stored as a scrypt
// hash + per-user salt (never plaintext). Login issues a session token; only
// its SHA-256 hash is stored, it expires in 30 days, and logout deletes it.
// The first registered account (account_index 0) is the operator: only the
// operator can save the Crossmint API key, change the service fee, verify
// KYC or list every user. Money-moving actions require a valid session and
// act only on the session user's own account. Failed logins are
// rate-limited per email (10 per 15 minutes). Recovery codes are 6 digits,
// stored only as a scrypt hash, valid 30 minutes, single-use, with at most
// 5 attempts; requesting a new one voids the old.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECOVERY_TTL_MS = 30 * 60 * 1000;
const RECOVERY_MAX_ATTEMPTS = 5;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SESSION_ERROR = "Tu sesión no es válida o ya venció. Inicia sesión de nuevo.";

async function createSession(ctx: Ctx, userId: number): Promise<string> {
  const db = ctx.db<typeof schema>();
  const { token } = await ctx.executePrivileged(privileged.generateSessionToken, {});
  const { hash } = await ctx.executePrivileged(privileged.hashToken, { token });
  await db.insert(schema.userSessions).values({
    userId, tokenHash: hash, expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

async function requireSession(ctx: Ctx, token: string): Promise<UserRow> {
  const db = ctx.db<typeof schema>();
  if (!token) throw new Error(SESSION_ERROR);
  const { hash } = await ctx.executePrivileged(privileged.hashToken, { token });
  const rows = await db.select().from(schema.userSessions)
    .where(eq(schema.userSessions.tokenHash, hash));
  const session = rows[0];
  if (!session || session.expiresAt < Date.now()) {
    if (session) await db.delete(schema.userSessions).where(eq(schema.userSessions.id, session.id));
    throw new Error(SESSION_ERROR);
  }
  const user = await getUserRow(db, session.userId);
  if (!user) throw new Error(SESSION_ERROR);
  return user;
}

async function requireSelfOrOperator(ctx: Ctx, token: string, userId: number): Promise<UserRow> {
  const me = await requireSession(ctx, token);
  if (me.id !== userId && me.accountIndex !== 0) {
    throw new Error("No tienes permiso para operar la cuenta de otro usuario.");
  }
  return me;
}

async function requireOperator(ctx: Ctx, token: string): Promise<UserRow> {
  const me = await requireSession(ctx, token);
  if (me.accountIndex !== 0) {
    throw new Error("Esta acción es solo para el operador de la wallet.");
  }
  return me;
}

// ---------------- KYC and monthly withdrawal limits ----------------
// Verbatim product rules from the operator (2026-11-19): KYC is requested by
// email to gt.guatemala.com@gmail.com, and ONLY that email has authority to
// grant the verified badge. Monthly withdrawal limit: 10,000 GTQ without
// KYC, 1,000,000 GTQ with KYC verified. Usage is measured from the sends
// actually executed through Crossmint and recorded in the transactions
// table — under the Crossmint-only model there is no deposit feed to meter
// (Crossmint reports balances, not incoming-deposit history), so only
// withdrawals are metered and enforced.

const KYC_AUTHORITY_EMAIL = "gt.guatemala.com@gmail.com";
const LIMIT_SIN_KYC_GTQ = 10000;
const LIMIT_CON_KYC_GTQ = 1000000;

// GTQ has no public market price, so a non-GTQ amount is expressed in
// GTQ-equivalent units as its USD market value (1 unit = $1 of value).
// GTQ amounts count at face value.
function gtqEquivalent(asset: string, amount: number, prices: Record<string, number>): number {
  if (asset === "GTQ") return amount;
  const p = prices[asset];
  return p != null ? amount * p : 0;
}

async function monthlyWithdrawalsGtq(db: Db, userId: number, prices: Record<string, number>): Promise<number> {
  const rows = await db.select().from(schema.transactions)
    .where(eq(schema.transactions.userId, userId));
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let withdrawals = 0;
  for (const r of rows) {
    if (r.kind !== "send" || r.status === "fallida") continue;
    if (r.createdAt.getTime() < start) continue;
    withdrawals += gtqEquivalent(r.fromAsset, Number(r.amount) || 0, prices);
  }
  return withdrawals;
}

function monthlyLimitGtq(kycStatus: string): number {
  return kycStatus === "verified" ? LIMIT_CON_KYC_GTQ : LIMIT_SIN_KYC_GTQ;
}

async function assertWithdrawalLimit(db: Db, user: UserRow, asset: string, amount: number, prices: Record<string, number>) {
  const limit = monthlyLimitGtq(user.kycStatus);
  const used = await monthlyWithdrawalsGtq(db, user.id, prices);
  const thisEq = gtqEquivalent(asset, amount, prices);
  if (used + thisEq > limit) {
    throw new Error(
      `Límite mensual de retiros alcanzado: esta cuenta ${user.kycStatus === "verified" ? "con KYC verificado" : "sin KYC"} puede retirar hasta ${limit.toLocaleString("en-US")} GTQ al mes ` +
      `y ya lleva ${numStr(Math.round(used * 100) / 100)} GTQ este mes (los GTQ cuentan 1:1 y las demás monedas por su valor en USD, porque GTQ no tiene precio público).`,
    );
  }
}

// ---------------- Crossmint integration ----------------
// The operator's Crossmint SERVER API key is the ONLY credential this wallet
// uses. It is encrypted at rest with scrypt + AES-256-GCM under a server
// secret the app generates automatically — there is NO seed phrase and NO
// operator passphrase anywhere. The key is decrypted only inside server
// actions to call the Crossmint Wallets API (production host, version
// 2025-06-09). Registration, balances and transaction execution all go
// through that API; transaction approvals are signed locally with the
// operator's server signer via the privileged signApprovalMessage contract
// (the signer secret never leaves the server and never reaches Crossmint).

const CROSSMINT_API = "https://www.crossmint.com/api/2025-06-09/wallets";
const CROSSMINT_SERVER_SIGNER = "84Vx1DJx8RGJizV7gKxLZRcPGTiVofi7Pvn7cjcqTQvy";
// key_version 2 = encrypted with the automatic server secret. Version 1
// rows were encrypted with the old vault passphrase and are undecryptable
// now that the seed vault is gone: the operator saves the key once more.
const CROSSMINT_KEY_VERSION = 2;
const LEGACY_KEY_ERROR = "La API key de Crossmint guardada es de la versión anterior y ya no se puede leer. El operador debe volver a guardarla: ahora solo se pega la API key, sin contraseña ni frase semilla.";
const NO_KEY_ERROR = "El operador aún no guarda su API key de Crossmint: sin ella la wallet no puede operar, porque todo (registro, saldos y envíos) pasa por Crossmint.";

type CrossmintRow = typeof schema.crossmintSettings.$inferSelect;

async function getCrossmintRow(ctx: Ctx): Promise<CrossmintRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.crossmintSettings)
    .orderBy(asc(schema.crossmintSettings.id)).limit(1);
  return rows[0] ?? null;
}

// Decrypts the saved API key with the automatic server secret. Returns null
// when no usable key is saved (none yet, or a legacy version-1 row).
async function getCrossmintApiKey(ctx: Ctx): Promise<string | null> {
  const row = await getCrossmintRow(ctx);
  if (!row || row.keyVersion !== CROSSMINT_KEY_VERSION) return null;
  const secret = await ensureServerSecret(ctx);
  const dec = await ctx.executePrivileged(privileged.decryptText, {
    ciphertext: row.encryptedApiKey, salt: row.salt, iv: row.iv, authTag: row.authTag,
    passphrase: secret,
  });
  return dec.text;
}

type CmJson = Record<string, unknown>;

async function cmFetch(apiKey: string, path: string, init?: { method?: string; body?: unknown; idempotencyKey?: string }): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "X-API-KEY": apiKey };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  if (init?.idempotencyKey) headers["x-idempotency-key"] = init.idempotencyKey;
  const res = await fetch(`${CROSSMINT_API}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const json: unknown = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function cmErrorText(json: unknown, status: number): string {
  if (json && typeof json === "object") {
    const o = json as { message?: unknown; error?: unknown };
    if (typeof o.message === "string") return o.message;
    if (typeof o.error === "string") return o.error;
  }
  return `HTTP ${status}`;
}

// Creates (or fetches, when it already exists) the user's Solana Smart Wallet
// in Crossmint and returns its address. The owner locator guarantees
// idempotency, so no idempotency key is sent.
async function crossmintCreateWallet(apiKey: string, email: string, signerAddress: string): Promise<string> {
  const { status, json } = await cmFetch(apiKey, "", {
    method: "POST",
    body: {
      chainType: "solana",
      type: "smart",
      owner: `email:${email}`,
      config: { recoveryMethods: [{ type: "server", address: signerAddress }] },
    },
  });
  const created = (json ?? {}) as { address?: unknown };
  if (status < 300 && typeof created.address === "string") return created.address;
  // The wallet may already exist for this email (created earlier): fetch it.
  const locator = encodeURIComponent(`email:${email}:solana:smart`);
  const got = await cmFetch(apiKey, `/${locator}`);
  const fetched = (got.json ?? {}) as { address?: unknown };
  if (got.status < 300 && typeof fetched.address === "string") return fetched.address;
  throw new Error(`Crossmint no creó la wallet (HTTP ${status}: ${cmErrorText(json, status)}). Revisa la API key y sus permisos de wallets.`);
}

// Ensures a user has their Crossmint wallet, creating it with the saved API
// key when missing and binding the address permanently to their account.
// Returns the address, or null (with an explanatory error) when it cannot be
// created — e.g. no API key saved yet (error null: registration must not
// fail just because the operator has not saved the key).
async function ensureCrossmintWallet(ctx: Ctx, db: Db, user: UserRow): Promise<{ address: string | null; error: string | null }> {
  if (user.crossmintAddress) return { address: user.crossmintAddress, error: null };
  const cmRow = await getCrossmintRow(ctx);
  if (!cmRow) return { address: null, error: null };
  if (cmRow.keyVersion !== CROSSMINT_KEY_VERSION) return { address: null, error: LEGACY_KEY_ERROR };
  try {
    const apiKey = await getCrossmintApiKey(ctx);
    if (!apiKey) return { address: null, error: "No se pudo leer la API key de Crossmint guardada." };
    const address = await crossmintCreateWallet(apiKey, user.email, cmRow.serverSignerAddress);
    await db.update(schema.custodialUsers)
      .set({ crossmintAddress: address })
      .where(eq(schema.custodialUsers.id, user.id));
    user.crossmintAddress = address;
    const addrs = await db.select().from(schema.userAddresses)
      .where(eq(schema.userAddresses.userId, user.id));
    if (!addrs.some((a) => a.network === "solana")) {
      await db.insert(schema.userAddresses).values({
        userId: user.id, network: "solana", address, derivationPath: "crossmint",
      });
    }
    return { address, error: null };
  } catch (e) {
    return { address: null, error: e instanceof Error ? e.message : "No se pudo crear la wallet de Crossmint." };
  }
}

type AssetRow = {
  network: string;
  networkName: string;
  asset: string;
  balance: string;
  usdPrice: number | null;
  isGtq: boolean;
};

// Reads the wallet's balances from Crossmint (GET /wallets/{address}/
// balances). Crossmint returns decimal `amount` strings per token; tokens
// not reported count as 0. This is the ONLY balance source in the app.
async function crossmintBalances(apiKey: string, walletAddress: string): Promise<AssetRow[]> {
  const tokens = CROSSMINT_TOKENS.map((t) => t.locator).join(",");
  const { status, json } = await cmFetch(apiKey, `/${encodeURIComponent(walletAddress)}/balances?tokens=${tokens}`);
  if (status >= 300 || !Array.isArray(json)) {
    throw new Error(`Crossmint no devolvió los saldos (HTTP ${status}: ${cmErrorText(json, status)}).`);
  }
  const bySymbol = new Map<string, string>();
  for (const item of json as Array<{ symbol?: string; amount?: string }>) {
    if (item.symbol) bySymbol.set(item.symbol.toUpperCase(), item.amount ?? "0");
  }
  return CROSSMINT_TOKENS.map((t) => ({
    network: "solana",
    networkName: "Solana",
    asset: t.asset,
    balance: bySymbol.get(t.asset) ?? "0",
    usdPrice: null,
    isGtq: t.isGtq,
  }));
}

type CmTx = {
  id: string;
  status: string;
  onChainTxId: string | null;
  pending: { signerLocator: string; message: string }[];
  errorText: string | null;
};

function parseCmTx(raw: unknown): CmTx {
  const json = (raw ?? {}) as CmJson;
  const onChain = (json.onChain ?? {}) as { txId?: unknown };
  const approvals = (json.approvals ?? {}) as { pending?: unknown };
  const pending: CmTx["pending"] = [];
  if (Array.isArray(approvals.pending)) {
    for (const p of approvals.pending as Array<{ signer?: { locator?: unknown }; message?: unknown }>) {
      if (typeof p?.message === "string" && typeof p?.signer?.locator === "string") {
        pending.push({ signerLocator: p.signer.locator, message: p.message });
      }
    }
  }
  let errorText: string | null = null;
  if (typeof json.error === "string") errorText = json.error;
  else if (json.error && typeof json.error === "object") {
    const m = (json.error as { message?: unknown }).message;
    if (typeof m === "string") errorText = m;
  }
  return {
    id: typeof json.id === "string" ? json.id : "",
    status: typeof json.status === "string" ? json.status : "pending",
    onChainTxId: typeof onChain.txId === "string" ? onChain.txId : null,
    pending,
    errorText,
  };
}

let idemCounter = 0;
function idempotencyKey(prefix: string, userId: number): string {
  idemCounter += 1;
  return `quetzal-${prefix}-${userId}-${Date.now()}-${idemCounter}`;
}

async function crossmintGetTransaction(apiKey: string, walletAddress: string, txId: string): Promise<CmTx> {
  const { status, json } = await cmFetch(apiKey, `/${encodeURIComponent(walletAddress)}/transactions/${encodeURIComponent(txId)}`);
  if (status >= 300) throw new Error(`Crossmint no devolvió la transacción (HTTP ${status}: ${cmErrorText(json, status)}).`);
  return parseCmTx(json);
}

// Executes ONE real transfer through Crossmint, end to end:
//   1. POST /wallets/{from}/tokens/{tokenLocator}/transfers (idempotency key)
//   2. If Crossmint asks for approvals, each pending server-signer approval
//      message is signed locally (privileged contract; the signer secret
//      never leaves the server) and submitted to the approvals endpoint.
//   3. Poll the transaction until Crossmint reports success/failed
//      (bounded, ~30 s); a still-running transaction returns "pending".
// Gas is handled by Crossmint's paymaster for smart wallets.
async function executeCrossmintTransfer(
  ctx: Ctx,
  apiKey: string,
  fromUser: UserRow,
  asset: string,
  recipient: string,
  amount: number,
): Promise<{ cmTxId: string; status: "success" | "pending" | "failed"; txHash: string | null; error: string | null }> {
  const token = CROSSMINT_TOKENS.find((t) => t.asset === asset);
  if (!token) throw new Error(`Moneda no soportada por Crossmint en esta wallet: ${asset}.`);
  const fromAddress = fromUser.crossmintAddress;
  if (!fromAddress) throw new Error("Este usuario aún no tiene wallet de Crossmint.");
  const created = await cmFetch(apiKey, `/${encodeURIComponent(fromAddress)}/tokens/${token.locator}/transfers`, {
    method: "POST",
    body: { recipient, amount: numStr(amount) },
    idempotencyKey: idempotencyKey("send", fromUser.id),
  });
  if (created.status >= 300) {
    throw new Error(`Crossmint rechazó la transferencia (HTTP ${created.status}: ${cmErrorText(created.json, created.status)}).`);
  }
  let tx = parseCmTx(created.json);
  if (!tx.id) throw new Error("Crossmint no devolvió el id de la transacción.");
  if (tx.status === "awaiting-approval") {
    // The SDK flow reads the transaction fresh before approving.
    tx = await crossmintGetTransaction(apiKey, fromAddress, tx.id);
    const approvals: { signer: string; signature: string }[] = [];
    for (const p of tx.pending) {
      const signed = await ctx.executePrivileged(privileged.signApprovalMessage, { message: p.message });
      if (p.signerLocator !== `server:${signed.signerAddress}`) {
        throw new Error("Crossmint pide la firma de otro firmante distinto al firmante del servidor de esta wallet; no se puede firmar automáticamente.");
      }
      approvals.push({ signer: p.signerLocator, signature: signed.signature });
    }
    if (approvals.length > 0) {
      const sub = await cmFetch(apiKey, `/${encodeURIComponent(fromAddress)}/transactions/${encodeURIComponent(tx.id)}/approvals`, {
        method: "POST",
        body: { approvals },
      });
      if (sub.status >= 300) {
        throw new Error(`Crossmint rechazó la firma de la transacción (HTTP ${sub.status}: ${cmErrorText(sub.json, sub.status)}).`);
      }
      tx = parseCmTx(sub.json);
    }
  }
  const deadline = Date.now() + 30000;
  while (tx.status === "pending" || tx.status === "awaiting-approval") {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 2500));
    try {
      tx = await crossmintGetTransaction(apiKey, fromAddress, tx.id);
    } catch { /* keep the last known state and stop polling */ break; }
  }
  if (tx.status === "success") return { cmTxId: tx.id, status: "success", txHash: tx.onChainTxId, error: null };
  if (tx.status === "failed") {
    return { cmTxId: tx.id, status: "failed", txHash: tx.onChainTxId, error: tx.errorText ?? "Crossmint reportó la transacción como fallida." };
  }
  return { cmTxId: tx.id, status: "pending", txHash: tx.onChainTxId, error: null };
}

// Charges the GTQ service fee as a REAL Crossmint transfer from the user to
// the operator's Crossmint wallet. Returns the fee actually charged ("0"
// when no fee applies or it could not be collected) plus a note.
async function chargeFeeViaCrossmint(
  ctx: Ctx, db: Db, apiKey: string, fromUser: UserRow, fee: number,
): Promise<{ charged: string; note: string }> {
  if (fee <= 0) return { charged: "0", note: "" };
  const operators = await db.select().from(schema.custodialUsers)
    .where(eq(schema.custodialUsers.accountIndex, 0));
  const operator = operators[0];
  if (!operator || operator.id === fromUser.id || !operator.crossmintAddress) {
    return { charged: "0", note: "" };
  }
  try {
    const res = await executeCrossmintTransfer(ctx, apiKey, fromUser, "GTQ", operator.crossmintAddress, fee);
    if (res.status === "failed") {
      return { charged: "0", note: `La comisión de ${numStr(fee)} GTQ no se pudo cobrar en Crossmint: ${res.error ?? "falló la transferencia"}.` };
    }
    return { charged: numStr(fee), note: "" };
  } catch (e) {
    return { charged: "0", note: `La comisión de ${numStr(fee)} GTQ no se pudo cobrar en Crossmint: ${e instanceof Error ? e.message : "error"}.` };
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const Actions = {
  getNetworks: defineAction({
    description: "Lists the networks the Quetzal Wallet operates. Everything runs on Solana through Crossmint, so Solana is the only network.",
    request: z.object({}),
    response: z.object({
      networks: z.array(z.object({
        id: z.string(), name: z.string(), kind: z.string(),
        native: z.string(), testnet: z.boolean(),
      })),
      gtqMint: z.string(),
    }),
    async handler() {
      return {
        gtqMint: GTQ_MINT,
        networks: NETWORKS.map((n) => ({
          id: n.id, name: n.name, kind: n.kind, native: n.native, testnet: n.testnet,
        })),
      };
    },
  }),

  getAppSettings: defineAction({
    description: "Returns the wallet's app settings: the fixed GTQ service fee charged per send and transfer between users, collected as a real Crossmint transfer to the operator.",
    request: z.object({}),
    response: z.object({ feeGtq: z.string() }),
    async handler(ctx) {
      return { feeGtq: await getFeeGtq(ctx) };
    },
  }),

  updateAppSettings: defineAction({
    description: "Updates the fixed GTQ service fee charged per send and transfer between users. Operator only.",
    request: z.object({ feeGtq: z.string().trim().min(1).max(12), sessionToken: z.string().max(200) }),
    privileged: [privileged.hashToken],
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireOperator(ctx, args.sessionToken);
      const db = ctx.db<typeof schema>();
      const fee = Number(args.feeGtq);
      if (!Number.isFinite(fee) || fee < 0) throw new Error("La comisión en GTQ no es válida.");
      const row = await getSettingsRow(ctx);
      if (row) {
        await db.update(schema.appSettings).set({ feeGtq: args.feeGtq })
          .where(eq(schema.appSettings.id, row.id));
      } else {
        await db.insert(schema.appSettings).values({ feeGtq: args.feeGtq });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  listUsers: defineAction({
    description: "Lists all custodial users with their Crossmint wallet address (Solana) and any legacy addresses they already had. Operator only: requires the operator's session.",
    request: z.object({ sessionToken: z.string().max(200) }),
    privileged: [privileged.hashToken],
    response: z.object({ users: z.array(userShape) }),
    async handler(ctx, args) {
      await requireOperator(ctx, args.sessionToken);
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.custodialUsers).orderBy(asc(schema.custodialUsers.accountIndex));
      const users = [];
      for (const u of rows) users.push(await buildUser(db, u));
      return { users };
    },
  }),

  createUser: defineAction({
    description: "Registers a user with their email and password (permanent binding: the email can never be changed or reused, and the wallet stays linked to it forever). The password is stored only as a scrypt hash. Automatically creates their Crossmint Solana Smart Wallet (server signer) with the operator's saved API key — no seed phrase. A Crossmint failure never loses the registration; it is returned so the wallet can be created later (it is also retried automatically). Returns a session token so the new user is signed in.",
    request: z.object({
      name: z.string().trim().min(1).max(60),
      email: z.string().trim().min(3).max(120),
      password: z.string().min(8).max(72),
    }),
    response: z.object({ user: userShape, crossmintError: z.string().nullable(), sessionToken: z.string() }),
    privileged: [privileged.hashSecret, privileged.generateSessionToken, privileged.hashToken, privileged.decryptText, privileged.generateServerSecret],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("El correo electrónico no es válido.");
      const existing = await db.select().from(schema.custodialUsers).orderBy(asc(schema.custodialUsers.accountIndex));
      if (existing.some((u) => u.email.toLowerCase() === email)) {
        throw new Error("Ese correo ya está registrado y ligado permanentemente a la wallet de su cuenta. Inicia sesión con ese correo en lugar de crear otra cuenta.");
      }
      const nextIndex = existing.length === 0 ? 0 : Math.max(...existing.map((u) => u.accountIndex)) + 1;
      const pw = await ctx.executePrivileged(privileged.hashSecret, { secret: args.password });
      const inserted = await db.insert(schema.custodialUsers)
        .values({ name: args.name, email, accountIndex: nextIndex, passwordHash: pw.hash, passwordSalt: pw.salt })
        .returning();
      const user = inserted[0];
      if (!user) throw new Error("No se pudo crear el usuario.");
      // Crossmint is the ONLY wallet provider: the user's wallet is created
      // automatically from the saved API key alone.
      const cm = await ensureCrossmintWallet(ctx, db, user);
      const sessionToken = await createSession(ctx, user.id);
      ctx.invalidateQueries();
      return { user: await buildUser(db, user), crossmintError: cm.error, sessionToken };
    },
  }),

  login: defineAction({
    description: "Signs a user in with their email and password. The error is always the same whether the email or the password is wrong, and failed attempts are rate-limited per email. Returns the user and a session token (only its hash is stored server-side). Accounts created before passwords existed have no password and must set one through the recovery flow first.",
    request: z.object({
      email: z.string().trim().min(3).max(120),
      password: z.string().min(1).max(72),
    }),
    response: z.object({ user: userShape, sessionToken: z.string() }),
    privileged: [privileged.verifySecret, privileged.generateSessionToken, privileged.hashToken],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      const since = Date.now() - LOGIN_WINDOW_MS;
      const attempts = await db.select().from(schema.loginAttempts)
        .where(eq(schema.loginAttempts.email, email));
      if (attempts.filter((a) => a.createdAt.getTime() > since).length >= LOGIN_MAX_ATTEMPTS) {
        throw new Error("Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.");
      }
      const fail = async (): Promise<never> => {
        await db.insert(schema.loginAttempts).values({ email });
        throw new Error("Correo o contraseña incorrectos.");
      };
      const rows = await db.select().from(schema.custodialUsers);
      const user = rows.find((u) => u.email.toLowerCase() === email);
      if (!user) return fail();
      if (!user.passwordHash) {
        throw new Error("Esta cuenta aún no tiene contraseña. Toca «Olvidé mi contraseña» para crear una con el código que te enviaremos por correo.");
      }
      const ok = await ctx.executePrivileged(privileged.verifySecret, {
        secret: args.password, hash: user.passwordHash, salt: user.passwordSalt,
      });
      if (!ok.ok) return fail();
      await db.delete(schema.loginAttempts).where(eq(schema.loginAttempts.email, email));
      const sessionToken = await createSession(ctx, user.id);
      ctx.invalidateQueries();
      return { user: await buildUser(db, user), sessionToken };
    },
  }),

  logout: defineAction({
    description: "Signs the session user out: deletes the session so its token can never be used again.",
    request: z.object({ sessionToken: z.string().max(200) }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.hashToken],
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      if (args.sessionToken) {
        const { hash } = await ctx.executePrivileged(privileged.hashToken, { token: args.sessionToken });
        await db.delete(schema.userSessions).where(eq(schema.userSessions.tokenHash, hash));
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  getSessionUser: defineAction({
    description: "Returns the user bound to a session token, or null when the token is unknown or expired. Used by the app to restore the signed-in session on open.",
    request: z.object({ sessionToken: z.string().max(200) }),
    response: z.object({ user: userShape.nullable() }),
    privileged: [privileged.hashToken],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      try {
        const user = await requireSession(ctx, args.sessionToken);
        return { user: await buildUser(db, user) };
      } catch {
        return { user: null };
      }
    },
  }),

  requestPasswordRecovery: defineAction({
    description: "Starts password recovery for an email: generates a 6-digit code (only its scrypt hash is stored; 30-minute expiry, single use, max 5 attempts; a new request voids the previous code) and asks the operator's agent to email the code to the account's own email address. The response is always the same generic success so it never reveals whether an email is registered.",
    request: z.object({ email: z.string().trim().min(3).max(120) }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.generateRecoveryCode, privileged.hashSecret],
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      const rows = await db.select().from(schema.custodialUsers);
      const user = rows.find((u) => u.email.toLowerCase() === email);
      if (user) {
        await db.update(schema.passwordRecovery).set({ used: 1 })
          .where(eq(schema.passwordRecovery.userId, user.id));
        const { code } = await ctx.executePrivileged(privileged.generateRecoveryCode, {});
        const hashed = await ctx.executePrivileged(privileged.hashSecret, { secret: code });
        await db.insert(schema.passwordRecovery).values({
          userId: user.id, codeHash: hashed.hash, codeSalt: hashed.salt,
          expiresAt: Date.now() + RECOVERY_TTL_MS, attempts: 0, used: 0,
        });
        try {
          await ctx.agent.spawnTask(
            `Envía un correo de recuperación de contraseña de la Quetzal Wallet. Destinatario: ${user.email} (es el correo de la cuenta del propio usuario). Asunto: "Código de recuperación — Quetzal Wallet". Cuerpo: un mensaje breve y claro en español indicando que su código de recuperación es ${code}, que vence en 30 minutos, que es de un solo uso, y que si no pidió este código ignore el correo. Envíalo con la cuenta de Gmail conectada del operador. En tu respuesta en el chat NO repitas el código: confirma únicamente que el correo fue enviado.`,
            { dedupeKey: `qw-recovery-${user.id}` },
          );
        } catch {
          // Delivery is best-effort from the action: the code exists and is
          // valid regardless; the generic response must not leak state.
        }
      }
      return { ok: true as const };
    },
  }),

  resetPassword: defineAction({
    description: "Sets a new password using the 6-digit recovery code sent to the account's email. Wrong, expired or reused codes all fail with the same message; after a successful reset every existing session of the user is closed.",
    request: z.object({
      email: z.string().trim().min(3).max(120),
      code: z.string().trim().length(6),
      newPassword: z.string().min(8).max(72),
    }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.verifySecret, privileged.hashSecret],
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      const generic = "El código no es válido o ya venció. Pide un código nuevo.";
      const rows = await db.select().from(schema.custodialUsers);
      const user = rows.find((u) => u.email.toLowerCase() === email);
      if (!user) throw new Error(generic);
      const recs = await db.select().from(schema.passwordRecovery)
        .where(eq(schema.passwordRecovery.userId, user.id))
        .orderBy(desc(schema.passwordRecovery.id));
      const rec = recs.find((r) => r.used === 0);
      if (!rec || rec.expiresAt < Date.now()) throw new Error(generic);
      if (rec.attempts >= RECOVERY_MAX_ATTEMPTS) {
        throw new Error("Demasiados intentos con este código. Pide un código nuevo.");
      }
      const ok = await ctx.executePrivileged(privileged.verifySecret, {
        secret: args.code, hash: rec.codeHash, salt: rec.codeSalt,
      });
      if (!ok.ok) {
        await db.update(schema.passwordRecovery).set({ attempts: rec.attempts + 1 })
          .where(eq(schema.passwordRecovery.id, rec.id));
        throw new Error(generic);
      }
      const pw = await ctx.executePrivileged(privileged.hashSecret, { secret: args.newPassword });
      await db.update(schema.custodialUsers)
        .set({ passwordHash: pw.hash, passwordSalt: pw.salt })
        .where(eq(schema.custodialUsers.id, user.id));
      await db.update(schema.passwordRecovery).set({ used: 1 })
        .where(eq(schema.passwordRecovery.id, rec.id));
      await db.delete(schema.userSessions).where(eq(schema.userSessions.userId, user.id));
      await db.delete(schema.loginAttempts).where(eq(schema.loginAttempts.email, email));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  changePassword: defineAction({
    description: "Changes the signed-in user's password after verifying the current one, and closes their other sessions.",
    request: z.object({
      sessionToken: z.string().max(200),
      currentPassword: z.string().min(1).max(72),
      newPassword: z.string().min(8).max(72),
    }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.hashToken, privileged.verifySecret, privileged.hashSecret],
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const me = await requireSession(ctx, args.sessionToken);
      if (!me.passwordHash) {
        throw new Error("Esta cuenta aún no tiene contraseña. Usa «Olvidé mi contraseña» en la pantalla de acceso para crear una.");
      }
      const ok = await ctx.executePrivileged(privileged.verifySecret, {
        secret: args.currentPassword, hash: me.passwordHash, salt: me.passwordSalt,
      });
      if (!ok.ok) throw new Error("La contraseña actual no es correcta.");
      const pw = await ctx.executePrivileged(privileged.hashSecret, { secret: args.newPassword });
      await db.update(schema.custodialUsers)
        .set({ passwordHash: pw.hash, passwordSalt: pw.salt })
        .where(eq(schema.custodialUsers.id, me.id));
      const { hash } = await ctx.executePrivileged(privileged.hashToken, { token: args.sessionToken });
      const sessions = await db.select().from(schema.userSessions)
        .where(eq(schema.userSessions.userId, me.id));
      for (const s of sessions) {
        if (s.tokenHash !== hash) {
          await db.delete(schema.userSessions).where(eq(schema.userSessions.id, s.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  listTransferRecipients: defineAction({
    description: "Lists the minimal directory (id, name, email) of registered users so a signed-in user can pick a recipient for a transfer between users. Requires a valid session.",
    request: z.object({ sessionToken: z.string().max(200) }),
    response: z.object({
      recipients: z.array(z.object({ id: z.number(), name: z.string(), email: z.string() })),
    }),
    privileged: [privileged.hashToken],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireSession(ctx, args.sessionToken);
      const rows = await db.select().from(schema.custodialUsers)
        .orderBy(asc(schema.custodialUsers.accountIndex));
      return { recipients: rows.map((u) => ({ id: u.id, name: u.name, email: u.email })) };
    },
  }),

  getUserBalances: defineAction({
    description: "Reads one user's balances LIVE from Crossmint (their Solana Smart Wallet: GTQ, SOL, USDT, USDC) with USD reference prices. There is no other balance source: if the user has no Crossmint wallet yet it is created automatically when an API key is saved. Requires a session for that user (or the operator).",
    privileged: [privileged.hashToken, privileged.decryptText, privileged.generateServerSecret],
    request: z.object({ userId: z.number().int().positive(), sessionToken: z.string().max(200) }),
    response: z.object({
      assets: z.array(z.object({
        network: z.string(), networkName: z.string(), asset: z.string(),
        balance: z.string(), usdPrice: z.number().nullable(), isGtq: z.boolean(),
      })),
      errors: z.array(z.object({ network: z.string(), message: z.string() })),
      totalUsd: z.number().nullable(),
      fetchedAt: z.string(),
    }),
    async handler(ctx, args) {
      await requireSelfOrOperator(ctx, args.sessionToken, args.userId);
      const db = ctx.db<typeof schema>();
      const userRow = await getUserRow(db, args.userId);
      if (!userRow) throw new Error("Usuario no encontrado.");
      const fetchedAt = new Date().toISOString();
      const cm = await ensureCrossmintWallet(ctx, db, userRow);
      if (!cm.address) {
        return {
          assets: [], totalUsd: null, fetchedAt,
          errors: [{ network: "solana", message: cm.error ?? NO_KEY_ERROR }],
        };
      }
      const apiKey = await getCrossmintApiKey(ctx);
      if (!apiKey) {
        return { assets: [], totalUsd: null, fetchedAt, errors: [{ network: "solana", message: NO_KEY_ERROR }] };
      }
      let assets: AssetRow[];
      try {
        assets = await crossmintBalances(apiKey, cm.address);
      } catch (e) {
        return {
          assets: [], totalUsd: null, fetchedAt,
          errors: [{ network: "solana", message: e instanceof Error ? e.message : "No se pudieron leer los saldos de Crossmint." }],
        };
      }
      const prices = await fetchPrices();
      for (const row of assets) row.usdPrice = prices[row.asset] ?? null;
      let total = 0; let anyPriced = false;
      for (const row of assets) {
        if (row.usdPrice != null) { total += Number(row.balance) * row.usdPrice; anyPriced = true; }
      }
      return { assets, errors: [], totalUsd: anyPriced ? total : null, fetchedAt };
    },
  }),

  syncAllDeposits: defineAction({
    description: "Automatic Crossmint provisioning for ALL custodial users: creates the Crossmint Solana Smart Wallet for every registered user who still lacks one, so nobody has to do it manually. Runs on a schedule and when the app opens. It never credits balances locally — balances are read live from Crossmint.",
    request: z.object({}),
    privileged: [privileged.decryptText, privileged.generateServerSecret],
    response: z.object({
      usersChecked: z.number(),
      walletsCreated: z.array(z.object({ userId: z.number(), address: z.string() })),
      fetchedAt: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const users = await db.select().from(schema.custodialUsers).orderBy(asc(schema.custodialUsers.accountIndex));
      const walletsCreated: { userId: number; address: string }[] = [];
      for (const u of users) {
        if (u.crossmintAddress) continue;
        try {
          const cm = await ensureCrossmintWallet(ctx, db, u);
          if (cm.address) walletsCreated.push({ userId: u.id, address: cm.address });
        } catch { /* one user's failure must not stop the rest */ }
      }
      if (walletsCreated.length > 0) ctx.invalidateQueries();
      return { usersChecked: users.length, walletsCreated, fetchedAt: new Date().toISOString() };
    },
  }),

  recordUserTransaction: defineAction({
    description: "Executes a REAL send from the user's Crossmint Solana wallet: creates the transfer in Crossmint, signs the approval locally with the server signer, submits it to Crossmint and waits for its result. The GTQ service fee is charged as a second real Crossmint transfer to the operator. Enforces the monthly KYC withdrawal limit. Nothing is recorded as sent unless Crossmint executed (or is executing) it.",
    request: z.object({
      sessionToken: z.string().max(200),
      userId: z.number().int().positive(),
      kind: z.enum(["send"]),
      network: z.string().min(1).max(24),
      fromAsset: z.string().min(1).max(10),
      toAsset: z.string().max(10).nullable(),
      amount: z.string().trim().min(1).max(24),
      toAddress: z.string().trim().max(120).nullable(),
      note: z.string().trim().max(140),
      payload: z.string().max(600),
      receiveAmount: z.string().trim().max(24),
    }),
    response: z.object({ id: z.number(), status: z.string(), txHash: z.string().nullable() }),
    privileged: [privileged.hashToken, privileged.decryptText, privileged.generateServerSecret, privileged.signApprovalMessage],
    async handler(ctx, args) {
      const me = await requireSession(ctx, args.sessionToken);
      if (me.id !== args.userId) throw new Error("Solo puedes operar tu propia cuenta.");
      const db = ctx.db<typeof schema>();
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("La cantidad no es válida.");
      if (args.network !== "solana") {
        throw new Error("Todas las operaciones pasan por Crossmint y la wallet es de Solana: elige la red Solana.");
      }
      if (!CROSSMINT_TOKENS.some((t) => t.asset === args.fromAsset)) {
        throw new Error(`Moneda no soportada en la wallet de Crossmint: ${args.fromAsset}.`);
      }
      const toAddress = (args.toAddress ?? "").trim();
      if (toAddress.length < 32) throw new Error("Escribe la dirección de destino completa de Solana.");
      const user = await getUserRow(db, args.userId);
      if (!user) throw new Error("Usuario no encontrado.");
      const cm = await ensureCrossmintWallet(ctx, db, user);
      if (!cm.address) throw new Error(cm.error ?? NO_KEY_ERROR);
      const apiKey = await getCrossmintApiKey(ctx);
      if (!apiKey) throw new Error(NO_KEY_ERROR);
      const prices = await fetchPrices();
      await assertWithdrawalLimit(db, user, args.fromAsset, amount, prices);
      // Balance checks against what Crossmint actually reports.
      const balances = await crossmintBalances(apiKey, cm.address);
      const balOf = (asset: string) => Number(balances.find((b) => b.asset === asset)?.balance ?? "0") || 0;
      const fee = Number(await getFeeGtq(ctx)) || 0;
      if (balOf(args.fromAsset) < amount) {
        throw new Error(`Saldo insuficiente en Crossmint: esta wallet tiene ${numStr(balOf(args.fromAsset))} ${args.fromAsset}.`);
      }
      if (fee > 0 && args.fromAsset === "GTQ" && balOf("GTQ") < amount + fee) {
        throw new Error(`Saldo insuficiente: cantidad + comisión (${numStr(fee)} GTQ) supera el saldo de Crossmint (${numStr(balOf("GTQ"))} GTQ).`);
      }
      if (fee > 0 && args.fromAsset !== "GTQ" && balOf("GTQ") < fee) {
        throw new Error(`Esta wallet necesita ${numStr(fee)} GTQ para la comisión y tiene ${numStr(balOf("GTQ"))} GTQ en Crossmint.`);
      }
      const result = await executeCrossmintTransfer(ctx, apiKey, user, args.fromAsset, toAddress, amount);
      if (result.status === "failed") {
        await db.insert(schema.transactions).values({
          kind: "send", network: "solana", fromAsset: args.fromAsset, toAsset: null,
          amount: args.amount, feeGtq: "0", toAddress,
          note: args.note, payload: JSON.stringify({ crossmintTxId: result.cmTxId, txHash: result.txHash }),
          status: "fallida", userId: args.userId, relatedUserId: null,
        });
        ctx.invalidateQueries();
        throw new Error(`Crossmint no ejecutó el envío: ${result.error ?? "la transacción falló en la red"}. No se movió ningún fondo.`);
      }
      let feeCharged = "0";
      let note = args.note;
      if (fee > 0) {
        const feeRes = await chargeFeeViaCrossmint(ctx, db, apiKey, user, fee);
        feeCharged = feeRes.charged;
        if (feeRes.note) note = note ? `${note} · ${feeRes.note}` : feeRes.note;
      }
      const inserted = await db.insert(schema.transactions).values({
        kind: "send", network: "solana", fromAsset: args.fromAsset, toAsset: null,
        amount: args.amount, feeGtq: feeCharged, toAddress,
        note, payload: JSON.stringify({ crossmintTxId: result.cmTxId, txHash: result.txHash }),
        status: result.status === "success" ? "confirmada" : "pendiente",
        userId: args.userId, relatedUserId: null,
      }).returning({ id: schema.transactions.id });
      const row = inserted[0];
      if (!row) throw new Error("El envío se ejecutó en Crossmint pero no se pudo guardar su registro.");
      ctx.invalidateQueries();
      return { id: row.id, status: result.status === "success" ? "confirmada" : "pendiente", txHash: result.txHash };
    },
  }),

  internalTransfer: defineAction({
    description: "Transfer between two users of the app, executed as a REAL Crossmint transfer from the sender's Crossmint wallet to the recipient's Crossmint wallet (Solana), plus the GTQ service fee as a real transfer to the operator. Nothing is settled on any internal ledger.",
    request: z.object({
      sessionToken: z.string().max(200),
      fromUserId: z.number().int().positive(),
      toUserId: z.number().int().positive(),
      network: z.string().min(1).max(24),
      asset: z.string().min(1).max(10),
      amount: z.string().trim().min(1).max(24),
      note: z.string().trim().max(140),
    }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.hashToken, privileged.decryptText, privileged.generateServerSecret, privileged.signApprovalMessage],
    async handler(ctx, args): Promise<{ ok: true }> {
      const me = await requireSession(ctx, args.sessionToken);
      if (me.id !== args.fromUserId) throw new Error("Solo puedes enviar desde tu propia cuenta.");
      const db = ctx.db<typeof schema>();
      if (args.fromUserId === args.toUserId) throw new Error("Elige dos usuarios distintos.");
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("La cantidad no es válida.");
      if (args.network !== "solana") {
        throw new Error("Todas las operaciones pasan por Crossmint y la wallet es de Solana: elige la red Solana.");
      }
      if (!CROSSMINT_TOKENS.some((t) => t.asset === args.asset)) {
        throw new Error(`Moneda no soportada en la wallet de Crossmint: ${args.asset}.`);
      }
      const fromUser = await getUserRow(db, args.fromUserId);
      const toUser = await getUserRow(db, args.toUserId);
      if (!fromUser || !toUser) throw new Error("Usuario no encontrado.");
      const cmFrom = await ensureCrossmintWallet(ctx, db, fromUser);
      if (!cmFrom.address) throw new Error(cmFrom.error ?? NO_KEY_ERROR);
      const cmTo = await ensureCrossmintWallet(ctx, db, toUser);
      if (!cmTo.address) {
        throw new Error("El usuario destino aún no tiene wallet de Crossmint, así que no puede recibir la transferencia.");
      }
      const apiKey = await getCrossmintApiKey(ctx);
      if (!apiKey) throw new Error(NO_KEY_ERROR);
      const balances = await crossmintBalances(apiKey, cmFrom.address);
      const balOf = (asset: string) => Number(balances.find((b) => b.asset === asset)?.balance ?? "0") || 0;
      const fee = Number(await getFeeGtq(ctx)) || 0;
      if (balOf(args.asset) < amount) {
        throw new Error(`Saldo insuficiente en Crossmint: esta wallet tiene ${numStr(balOf(args.asset))} ${args.asset}.`);
      }
      if (fee > 0 && args.asset === "GTQ" && balOf("GTQ") < amount + fee) {
        throw new Error(`Saldo insuficiente: cantidad + comisión (${numStr(fee)} GTQ) supera el saldo de Crossmint.`);
      }
      if (fee > 0 && args.asset !== "GTQ" && balOf("GTQ") < fee) {
        throw new Error(`Esta wallet necesita ${numStr(fee)} GTQ para la comisión y tiene ${numStr(balOf("GTQ"))} GTQ en Crossmint.`);
      }
      const result = await executeCrossmintTransfer(ctx, apiKey, fromUser, args.asset, cmTo.address, amount);
      if (result.status === "failed") {
        throw new Error(`Crossmint no ejecutó la transferencia: ${result.error ?? "la transacción falló en la red"}. No se movió ningún fondo.`);
      }
      let feeCharged = "0";
      let note = args.note;
      if (fee > 0) {
        const feeRes = await chargeFeeViaCrossmint(ctx, db, apiKey, fromUser, fee);
        feeCharged = feeRes.charged;
        if (feeRes.note) note = note ? `${note} · ${feeRes.note}` : feeRes.note;
      }
      await db.insert(schema.transactions).values({
        kind: "internal", network: "solana", fromAsset: args.asset, toAsset: args.asset,
        amount: args.amount, feeGtq: feeCharged, toAddress: cmTo.address,
        note, payload: JSON.stringify({ crossmintTxId: result.cmTxId, txHash: result.txHash }),
        status: result.status === "success" ? "confirmada" : "pendiente",
        userId: args.fromUserId, relatedUserId: args.toUserId,
      });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  listTransactions: defineAction({
    description: "Lists the operations executed through Crossmint, newest first. Pending operations are refreshed against Crossmint so their status is Crossmint's own. Requires a session: regular users only see their own operations; the operator sees all.",
    request: z.object({ limit: z.number().int().positive().max(100).default(50), sessionToken: z.string().max(200) }),
    privileged: [privileged.hashToken, privileged.decryptText, privileged.generateServerSecret],
    response: z.object({ transactions: z.array(txShape) }),
    async handler(ctx, args) {
      const me = await requireSession(ctx, args.sessionToken);
      const db = ctx.db<typeof schema>();
      const all = await db.select().from(schema.transactions)
        .orderBy(desc(schema.transactions.id)).limit(500);
      const rows = (me.accountIndex === 0 ? all : all.filter((r) => r.userId === me.id)).slice(0, args.limit);
      // Refresh the status of still-pending Crossmint operations (bounded).
      const apiKey = await getCrossmintApiKey(ctx).catch(() => null);
      if (apiKey) {
        let refreshed = 0;
        for (const r of rows) {
          if (refreshed >= 8) break;
          if (r.status !== "pendiente" || r.userId == null) continue;
          let cmTxId: string | null = null;
          try {
            const p = JSON.parse(r.payload || "{}") as { crossmintTxId?: string };
            cmTxId = p.crossmintTxId ?? null;
          } catch { cmTxId = null; }
          if (!cmTxId) continue;
          const owner = await getUserRow(db, r.userId);
          if (!owner?.crossmintAddress) continue;
          try {
            const tx = await crossmintGetTransaction(apiKey, owner.crossmintAddress, cmTxId);
            if (tx.status === "success" || tx.status === "failed") {
              r.status = tx.status === "success" ? "confirmada" : "fallida";
              await db.update(schema.transactions).set({ status: r.status })
                .where(eq(schema.transactions.id, r.id));
              refreshed++;
            }
          } catch { /* keep the recorded status when Crossmint cannot be read */ }
        }
      }
      return {
        transactions: rows.map((r) => ({
          id: r.id, kind: r.kind, network: r.network, fromAsset: r.fromAsset,
          toAsset: r.toAsset, amount: r.amount, feeGtq: r.feeGtq,
          toAddress: r.toAddress, note: r.note, payload: r.payload,
          status: r.status, userId: r.userId ?? null, relatedUserId: r.relatedUserId ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  listContacts: defineAction({
    description: "Lists saved recipient contacts for sends. Requires a valid session.",
    request: z.object({ sessionToken: z.string().max(200) }),
    privileged: [privileged.hashToken],
    response: z.object({
      contacts: z.array(z.object({
        id: z.number(), name: z.string(), network: z.string(), address: z.string(),
      })),
    }),
    async handler(ctx, args) {
      await requireSession(ctx, args.sessionToken);
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.contacts).orderBy(asc(schema.contacts.name));
      return { contacts: rows.map((r) => ({ id: r.id, name: r.name, network: r.network, address: r.address })) };
    },
  }),

  addContact: defineAction({
    description: "Saves a recipient contact with a name, network, and address.",
    request: z.object({
      sessionToken: z.string().max(200),
      name: z.string().trim().min(1).max(60),
      network: z.string().min(1).max(24),
      address: z.string().trim().min(8).max(120),
    }),
    privileged: [privileged.hashToken],
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      await requireSession(ctx, args.sessionToken);
      const db = ctx.db<typeof schema>();
      const { sessionToken: _tok, ...contact } = args;
      const inserted = await db.insert(schema.contacts).values(contact).returning({ id: schema.contacts.id });
      const row = inserted[0];
      if (!row) throw new Error("No se pudo guardar el contacto.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteContact: defineAction({
    description: "Deletes one saved recipient contact by id.",
    request: z.object({ id: z.number().int().positive(), sessionToken: z.string().max(200) }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.hashToken],
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireSession(ctx, args.sessionToken);
      const db = ctx.db<typeof schema>();
      await db.delete(schema.contacts).where(eq(schema.contacts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  updateUserProfile: defineAction({
    description: "Updates a custodial user's phone number shown in their profile. The email is permanent and can never be changed. Requires a session for that user (or the operator).",
    privileged: [privileged.hashToken],
    request: z.object({
      userId: z.number().int().positive(),
      phone: z.string().trim().max(24),
      sessionToken: z.string().max(200),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireSelfOrOperator(ctx, args.sessionToken, args.userId);
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.custodialUsers)
        .where(eq(schema.custodialUsers.id, args.userId));
      if (!rows[0]) throw new Error("Usuario no encontrado.");
      await db.update(schema.custodialUsers).set({ phone: args.phone })
        .where(eq(schema.custodialUsers.id, args.userId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  requestKyc: defineAction({
    description: "Marks a custodial user's KYC as requested. The user asks for KYC by email to gt.guatemala.com@gmail.com; only that authority email can later grant the verified badge.",
    request: z.object({ userId: z.number().int().positive(), sessionToken: z.string().max(200) }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.hashToken],
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireSelfOrOperator(ctx, args.sessionToken, args.userId);
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.custodialUsers)
        .where(eq(schema.custodialUsers.id, args.userId));
      const user = rows[0];
      if (!user) throw new Error("Usuario no encontrado.");
      if (user.kycStatus !== "verified") {
        await db.update(schema.custodialUsers).set({ kycStatus: "requested" })
          .where(eq(schema.custodialUsers.id, args.userId));
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setKycVerified: defineAction({
    description: "Grants the KYC verified badge to a user. Operator only, and only the authority email gt.guatemala.com@gmail.com may do this; any other authority email is rejected.",
    privileged: [privileged.hashToken],
    request: z.object({
      userId: z.number().int().positive(),
      authorityEmail: z.string().trim().min(3).max(120),
      sessionToken: z.string().max(200),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireOperator(ctx, args.sessionToken);
      if (args.authorityEmail.trim().toLowerCase() !== KYC_AUTHORITY_EMAIL) {
        throw new Error(`Solo ${KYC_AUTHORITY_EMAIL} tiene autoridad para dar la insignia de verificado. Ese correo no está autorizado.`);
      }
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.custodialUsers)
        .where(eq(schema.custodialUsers.id, args.userId));
      if (!rows[0]) throw new Error("Usuario no encontrado.");
      await db.update(schema.custodialUsers).set({ kycStatus: "verified" })
        .where(eq(schema.custodialUsers.id, args.userId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  getMonthlyUsage: defineAction({
    description: "Returns a user's KYC status, their monthly withdrawal limit in GTQ (10,000 without KYC, 1,000,000 with KYC verified) and how much of it they have used this calendar month in sends executed through Crossmint. Deposits are not metered: Crossmint reports balances, not a deposit feed. Requires a session for that user (or the operator).",
    privileged: [privileged.hashToken],
    request: z.object({ userId: z.number().int().positive(), sessionToken: z.string().max(200) }),
    response: z.object({
      kycStatus: z.string(),
      limitGtq: z.number(),
      depositsGtq: z.string(),
      withdrawalsGtq: z.string(),
    }),
    async handler(ctx, args) {
      await requireSelfOrOperator(ctx, args.sessionToken, args.userId);
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.custodialUsers)
        .where(eq(schema.custodialUsers.id, args.userId));
      const user = rows[0];
      if (!user) throw new Error("Usuario no encontrado.");
      const prices = await fetchPrices();
      const withdrawals = await monthlyWithdrawalsGtq(db, args.userId, prices);
      return {
        kycStatus: user.kycStatus,
        limitGtq: monthlyLimitGtq(user.kycStatus),
        depositsGtq: "0",
        withdrawalsGtq: numStr(Math.round(withdrawals * 100) / 100),
      };
    },
  }),

  // ---------------- Crossmint admin actions ----------------

  getCrossmintStatus: defineAction({
    description: "Returns whether a usable Crossmint server API key is saved (encrypted) in the app, whether the saved key is a legacy one that must be re-saved (it was encrypted with the removed vault passphrase), the server signer address used for user Smart Wallets, and how many users already have a Crossmint wallet. Never returns the key.",
    request: z.object({ sessionToken: z.string().max(200) }),
    privileged: [privileged.hashToken],
    response: z.object({
      configured: z.boolean(),
      legacyKey: z.boolean(),
      serverSignerAddress: z.string(),
      usersWithWallet: z.number(),
      usersTotal: z.number(),
      savedAt: z.string().nullable(),
    }),
    async handler(ctx, args) {
      await requireOperator(ctx, args.sessionToken);
      const db = ctx.db<typeof schema>();
      const row = await getCrossmintRow(ctx);
      const users = await db.select().from(schema.custodialUsers);
      return {
        configured: row != null && row.keyVersion === CROSSMINT_KEY_VERSION,
        legacyKey: row != null && row.keyVersion !== CROSSMINT_KEY_VERSION,
        serverSignerAddress: row?.serverSignerAddress ?? CROSSMINT_SERVER_SIGNER,
        usersWithWallet: users.filter((u) => u.crossmintAddress).length,
        usersTotal: users.length,
        savedAt: row ? row.createdAt.toISOString() : null,
      };
    },
  }),

  saveCrossmintKey: defineAction({
    description: "Saves the operator's Crossmint server API key — the ONLY credential this wallet uses. It is verified against the Crossmint API before saving and stored encrypted at rest (scrypt + AES-256-GCM) under a server secret the app generates automatically: no seed phrase and no passphrase are asked. The plaintext is never stored in the clear or returned.",
    request: z.object({
      sessionToken: z.string().max(200),
      apiKey: z.string().trim().min(10).max(300),
      serverSignerAddress: z.string().trim().min(32).max(64).default(CROSSMINT_SERVER_SIGNER),
    }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.encryptText, privileged.hashToken, privileged.generateServerSecret],
    async handler(ctx, args): Promise<{ ok: true }> {
      await requireOperator(ctx, args.sessionToken);
      const db = ctx.db<typeof schema>();
      // Verify the key works before storing it: a wallet lookup for a
      // nonexistent locator must answer 404 (key + scopes valid), not 401/403.
      const probe = await fetch(
        `${CROSSMINT_API}/${encodeURIComponent("email:verificacion@quetzal.wallet:solana:smart")}`,
        { headers: { "X-API-KEY": args.apiKey }, signal: AbortSignal.timeout(20000) },
      ).catch(() => null);
      if (!probe) throw new Error("No se pudo contactar la API de Crossmint. Inténtalo de nuevo.");
      if (probe.status === 401 || probe.status === 403) {
        throw new Error("Crossmint rechazó la API key (401/403). Revisa que sea la API key de SERVIDOR de producción y que tenga permisos de wallets.");
      }
      if (!probe.ok && probe.status !== 404) {
        throw new Error(`Crossmint respondió HTTP ${probe.status} al verificar la API key. No se guardó.`);
      }
      const secret = await ensureServerSecret(ctx);
      const enc = await ctx.executePrivileged(privileged.encryptText, {
        text: args.apiKey, passphrase: secret,
      });
      const existing = await getCrossmintRow(ctx);
      if (existing) {
        await db.update(schema.crossmintSettings).set({
          encryptedApiKey: enc.ciphertext, salt: enc.salt, iv: enc.iv, authTag: enc.authTag,
          keyVersion: CROSSMINT_KEY_VERSION,
          serverSignerAddress: args.serverSignerAddress,
        }).where(eq(schema.crossmintSettings.id, existing.id));
      } else {
        await db.insert(schema.crossmintSettings).values({
          encryptedApiKey: enc.ciphertext, salt: enc.salt, iv: enc.iv, authTag: enc.authTag,
          keyVersion: CROSSMINT_KEY_VERSION,
          serverSignerAddress: args.serverSignerAddress,
        });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  createUserCrossmintWallet: defineAction({
    description: "Creates (or fetches, if it already exists) the Crossmint Solana Smart Wallet for one registered user with the saved API key and binds its address permanently to the user's email. Used to retry or to backfill users registered before the API key was saved.",
    request: z.object({
      userId: z.number().int().positive(),
      sessionToken: z.string().max(200),
    }),
    response: z.object({ address: z.string() }),
    privileged: [privileged.hashToken, privileged.decryptText, privileged.generateServerSecret],
    async handler(ctx, args) {
      await requireOperator(ctx, args.sessionToken);
      const db = ctx.db<typeof schema>();
      const user = await getUserRow(db, args.userId);
      if (!user) throw new Error("Usuario no encontrado.");
      if (!user.email) throw new Error("Este usuario no tiene correo registrado: la wallet de Crossmint se liga al correo.");
      const cm = await ensureCrossmintWallet(ctx, db, user);
      if (!cm.address) throw new Error(cm.error ?? NO_KEY_ERROR);
      ctx.invalidateQueries();
      return { address: cm.address };
    },
  }),
} satisfies ActionsModule;
