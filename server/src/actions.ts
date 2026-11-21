import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";
import { privileged } from "@space/privileged";

// ---------------------------------------------------------------------------
// Network catalog — every RPC below was probed live during the build.
// GTQ (Quetzal) lives on Solana as a Token-2022 mint.
// ---------------------------------------------------------------------------

export const GTQ_MINT = "GTqK16bpGTqhYhXQzfHCxySJW4EswwtNw6THJ8VAMcXd";
const SOL_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const TRON_API = "https://api.trongrid.io";
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_USDC = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";

type Stable = { contract: string; decimals: number };
type NetDef = {
  id: string;
  name: string;
  kind: "solana" | "evm" | "tron";
  native: string;
  rpc?: string;
  testnet?: boolean;
  usdt?: Stable;
  usdc?: Stable;
};

const NETWORKS: NetDef[] = [
  { id: "solana", name: "Solana", kind: "solana", native: "SOL" },
  {
    id: "ethereum", name: "Ethereum", kind: "evm", native: "ETH",
    rpc: "https://ethereum-rpc.publicnode.com",
    usdt: { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    usdc: { contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  },
  {
    id: "bsc", name: "BNB Smart Chain", kind: "evm", native: "BNB",
    rpc: "https://bsc-dataseed.binance.org",
    usdt: { contract: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
    usdc: { contract: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
  },
  {
    id: "polygon", name: "Polygon", kind: "evm", native: "POL",
    rpc: "https://polygon.drpc.org",
    usdt: { contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    usdc: { contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
  },
  {
    id: "arbitrum", name: "Arbitrum One", kind: "evm", native: "ETH",
    rpc: "https://arb1.arbitrum.io/rpc",
    usdt: { contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    usdc: { contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
  },
  {
    id: "optimism", name: "Optimism", kind: "evm", native: "ETH",
    rpc: "https://mainnet.optimism.io",
    usdt: { contract: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
    usdc: { contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
  },
  {
    id: "avalanche", name: "Avalanche C-Chain", kind: "evm", native: "AVAX",
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    usdt: { contract: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
    usdc: { contract: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
  },
  {
    id: "base", name: "Base", kind: "evm", native: "ETH",
    rpc: "https://mainnet.base.org",
    usdt: { contract: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
    usdc: { contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  },
  {
    id: "linea", name: "Linea", kind: "evm", native: "ETH",
    rpc: "https://rpc.linea.build",
    usdt: { contract: "0xA219439258C9da29E9Cc4cE5596924745e12B93f", decimals: 6 },
    usdc: { contract: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", decimals: 6 },
  },
  {
    id: "zksync", name: "zkSync Era", kind: "evm", native: "ETH",
    rpc: "https://mainnet.era.zksync.io",
    usdt: { contract: "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C", decimals: 6 },
    usdc: { contract: "0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4", decimals: 6 },
  },
  { id: "tron", name: "Tron", kind: "tron", native: "TRX" },
  {
    id: "robinhood", name: "Robinhood Chain (testnet)", kind: "evm", native: "ETH",
    rpc: "https://rpc.testnet.chain.robinhood.com", testnet: true,
  },
];

const PRICE_IDS: Record<string, string> = {
  SOL: "solana", ETH: "ethereum", BNB: "binancecoin", POL: "matic-network",
  AVAX: "avalanche-2", TRX: "tron", USDT: "tether", USDC: "usd-coin",
};

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? "RPC error");
  return json.result;
}

function fmt(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const digits = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const int = decimals === 0 ? digits : digits.slice(0, -decimals);
  const frac = decimals === 0 ? "" : digits.slice(-decimals).replace(/0+$/, "");
  const out = frac ? `${int}.${frac}` : int;
  return neg ? `-${out}` : out;
}

type AssetRow = {
  network: string;
  networkName: string;
  asset: string;
  balance: string;
  usdPrice: number | null;
  isGtq: boolean;
};

async function solanaBalances(address: string, out: AssetRow[]) {
  const lamports = (await rpc(SOLANA_RPC, "getBalance", [address])) as { value: number };
  const tokens = new Map<string, string>();
  for (const program of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
    try {
      const res = (await rpc(SOLANA_RPC, "getTokenAccountsByOwner", [
        address,
        { programId: program },
        { encoding: "jsonParsed" },
      ])) as { value: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmountString: string } } } } } }> };
      for (const acc of res.value ?? []) {
        const info = acc.account.data.parsed.info;
        tokens.set(info.mint, info.tokenAmount.uiAmountString);
      }
    } catch { /* one program failing must not lose the other */ }
  }
  out.push({ network: "solana", networkName: "Solana", asset: "GTQ", balance: tokens.get(GTQ_MINT) ?? "0", usdPrice: null, isGtq: true });
  out.push({ network: "solana", networkName: "Solana", asset: "SOL", balance: fmt(BigInt(lamports.value ?? 0), 9), usdPrice: null, isGtq: false });
  out.push({ network: "solana", networkName: "Solana", asset: "USDT", balance: tokens.get(SOL_USDT) ?? "0", usdPrice: null, isGtq: false });
  out.push({ network: "solana", networkName: "Solana", asset: "USDC", balance: tokens.get(SOL_USDC) ?? "0", usdPrice: null, isGtq: false });
}

async function evmBalances(net: NetDef, address: string, out: AssetRow[]) {
  const rpcUrl = net.rpc;
  if (!rpcUrl) return;
  const nativeHex = (await rpc(rpcUrl, "eth_getBalance", [address, "latest"])) as string;
  out.push({ network: net.id, networkName: net.name, asset: net.native, balance: fmt(BigInt(nativeHex), 18), usdPrice: null, isGtq: false });
  const padded = address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  for (const [symbol, stable] of [["USDT", net.usdt], ["USDC", net.usdc]] as const) {
    if (!stable) continue;
    try {
      const hex = (await rpc(rpcUrl, "eth_call", [{ to: stable.contract, data: `0x70a08231${padded}` }, "latest"])) as string;
      out.push({ network: net.id, networkName: net.name, asset: symbol, balance: fmt(BigInt(hex), stable.decimals), usdPrice: null, isGtq: false });
    } catch { /* skip a failing token read */ }
  }
}

async function tronBalances(address: string, out: AssetRow[]) {
  const res = await fetch(`${TRON_API}/v1/accounts/${address}`, { signal: AbortSignal.timeout(12000) });
  const json = (await res.json()) as { data?: Array<{ balance?: number; trc20?: Array<Record<string, string>> }> };
  const acct = json.data?.[0];
  out.push({ network: "tron", networkName: "Tron", asset: "TRX", balance: fmt(BigInt(acct?.balance ?? 0), 6), usdPrice: null, isGtq: false });
  const trc20 = new Map<string, string>();
  for (const entry of acct?.trc20 ?? []) {
    for (const [contract, bal] of Object.entries(entry)) trc20.set(contract, bal);
  }
  out.push({ network: "tron", networkName: "Tron", asset: "USDT", balance: fmt(BigInt(trc20.get(TRON_USDT) ?? "0"), 6), usdPrice: null, isGtq: false });
  out.push({ network: "tron", networkName: "Tron", asset: "USDC", balance: fmt(BigInt(trc20.get(TRON_USDC) ?? "0"), 6), usdPrice: null, isGtq: false });
}

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

const walletShape = z.object({
  id: z.number(),
  label: z.string(),
  feeGtq: z.string(),
  addresses: z.array(z.object({ network: z.string(), address: z.string() })),
});
const walletResponse = z.object({ wallet: walletShape.nullable() });
type WalletResponse = z.infer<typeof walletResponse>;

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
  ledger: z.array(z.object({ network: z.string(), asset: z.string(), balance: z.string() })),
});

// ---------------- Custody helpers ----------------

function numStr(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(10).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

type Db = ReturnType<Ctx["db"]>;

async function getVaultRow(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.custodyVault).orderBy(asc(schema.custodyVault.id)).limit(1);
  return rows[0] ?? null;
}

type VaultRow = NonNullable<Awaited<ReturnType<typeof getVaultRow>>>;
function vaultEnc(vault: VaultRow) {
  return { ciphertext: vault.encryptedSeed, salt: vault.salt, iv: vault.iv, authTag: vault.authTag };
}

async function ledgerBalance(db: Db, userId: number, network: string, asset: string): Promise<number> {
  const rows = await db.select().from(schema.ledgerBalances)
    .where(eq(schema.ledgerBalances.userId, userId));
  const row = rows.find((r) => r.network === network && r.asset === asset);
  return row ? Number(row.balance) || 0 : 0;
}

async function adjustLedger(db: Db, userId: number, network: string, asset: string, delta: number): Promise<string> {
  const rows = await db.select().from(schema.ledgerBalances)
    .where(eq(schema.ledgerBalances.userId, userId));
  const row = rows.find((r) => r.network === network && r.asset === asset);
  const next = (row ? Number(row.balance) || 0 : 0) + delta;
  const nextStr = numStr(next);
  if (row) {
    await db.update(schema.ledgerBalances).set({ balance: nextStr }).where(eq(schema.ledgerBalances.id, row.id));
  } else {
    await db.insert(schema.ledgerBalances).values({ userId, network, asset, balance: nextStr });
  }
  return nextStr;
}

async function buildUser(db: Db, u: typeof schema.custodialUsers.$inferSelect) {
  const addrs = await db.select().from(schema.userAddresses).where(eq(schema.userAddresses.userId, u.id));
  const bals = await db.select().from(schema.ledgerBalances).where(eq(schema.ledgerBalances.userId, u.id));
  const order = new Map(NETWORKS.map((n, i) => [n.id, i]));
  addrs.sort((a, b) => (order.get(a.network) ?? 99) - (order.get(b.network) ?? 99));
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone, kycStatus: u.kycStatus,
    accountIndex: u.accountIndex, crossmintAddress: u.crossmintAddress ?? "",
    createdAt: u.createdAt.toISOString(),
    addresses: addrs.map((a) => ({ network: a.network, address: a.address, derivationPath: a.derivationPath })),
    ledger: bals.filter((b) => Number(b.balance) !== 0)
      .map((b) => ({ network: b.network, asset: b.asset, balance: b.balance })),
  };
}

// ---------------- KYC, limits, gas and swap-fee policy ----------------
// Verbatim product rules from the operator (2026-11-19): KYC is requested by
// email to gt.guatemala.com@gmail.com, and ONLY that email has authority to
// grant the verified badge. Monthly deposit/withdrawal limit: 10,000 GTQ
// without KYC, 1,000,000 GTQ with KYC verified. Swap fee is a fixed 0.1% of
// the swapped amount, charged in GTQ. To send or swap, the user must hold at
// least $0.50 USD worth of the network's native coin on-chain for gas.

const KYC_AUTHORITY_EMAIL = "gt.guatemala.com@gmail.com";
const LIMIT_SIN_KYC_GTQ = 10000;
const LIMIT_CON_KYC_GTQ = 1000000;
const MIN_GAS_USD = 0.5;
const SWAP_FEE_RATE = 0.001; // 0.1% fijo

// GTQ has no public market price, so a non-GTQ amount is expressed in
// GTQ-equivalent units as its USD market value (1 unit = $1 of value).
// GTQ amounts count at face value. This convention is shown in the Perfil.
function gtqEquivalent(asset: string, amount: number, prices: Record<string, number>): number {
  if (asset === "GTQ") return amount;
  const p = prices[asset];
  return p != null ? amount * p : 0;
}

async function monthlyUsageGtq(db: Db, userId: number, prices: Record<string, number>) {
  const entries = await db.select().from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.userId, userId));
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let deposits = 0;
  let withdrawals = 0;
  for (const e of entries) {
    if (e.createdAt.getTime() < start) continue;
    const amt = Number(e.amount) || 0;
    if (e.kind === "deposit" && amt > 0) deposits += gtqEquivalent(e.asset, amt, prices);
    if (e.kind === "send" && amt < 0) withdrawals += gtqEquivalent(e.asset, -amt, prices);
  }
  return { deposits, withdrawals };
}

function monthlyLimitGtq(kycStatus: string): number {
  return kycStatus === "verified" ? LIMIT_CON_KYC_GTQ : LIMIT_SIN_KYC_GTQ;
}

// ---------------- Crossmint integration ----------------
// The operator stores their Crossmint SERVER API key in the admin panel; it is
// encrypted at rest with the vault passphrase (scrypt + AES-256-GCM, same
// scheme as the master seed) and only ever decrypted server-side to call the
// Crossmint Wallets API. Each registered user gets a Solana Smart Wallet with
// a server signer (the operator is the custodian; the signer secret never
// leaves the operator). The Crossmint address is bound permanently to the
// user's email and is the address shown in Recibir and used to read Solana
// balances.

const CROSSMINT_API = "https://www.crossmint.com/api/2025-06-09/wallets";
const CROSSMINT_SERVER_SIGNER = "84Vx1DJx8RGJizV7gKxLZRcPGTiVofi7Pvn7cjcqTQvy";

type CrossmintRow = typeof schema.crossmintSettings.$inferSelect;

async function getCrossmintRow(ctx: Ctx): Promise<CrossmintRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.crossmintSettings)
    .orderBy(asc(schema.crossmintSettings.id)).limit(1);
  return rows[0] ?? null;
}

async function decryptCrossmintKey(ctx: Ctx, row: CrossmintRow, passphrase: string): Promise<string> {
  const dec = await ctx.executePrivileged(privileged.decryptText, {
    ciphertext: row.encryptedApiKey, salt: row.salt, iv: row.iv, authTag: row.authTag,
    passphrase,
  });
  return dec.text;
}

// Creates (or fetches, when it already exists) the user's Solana Smart Wallet
// in Crossmint and returns its address. The owner locator guarantees
// idempotency, so no idempotency key is sent.
async function crossmintCreateWallet(apiKey: string, email: string, signerAddress: string): Promise<string> {
  const res = await fetch(CROSSMINT_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({
      chainType: "solana",
      type: "smart",
      owner: `email:${email}`,
      config: { recoveryMethods: [{ type: "server", address: signerAddress }] },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const json = (await res.json().catch(() => ({}))) as { address?: string; message?: string };
  if (res.ok && json.address) return json.address;
  // The wallet may already exist for this email (created earlier): fetch it.
  const locator = encodeURIComponent(`email:${email}:solana:smart`);
  const getRes = await fetch(`${CROSSMINT_API}/${locator}`, {
    headers: { "X-API-KEY": apiKey },
    signal: AbortSignal.timeout(20000),
  });
  const getJson = (await getRes.json().catch(() => ({}))) as { address?: string };
  if (getRes.ok && getJson.address) return getJson.address;
  throw new Error(`Crossmint no creó la wallet (HTTP ${res.status}${json.message ? `: ${json.message}` : ""}). Revisa la API key y sus permisos de wallets.`);
}

// The Solana address used for balance reads, deposit sync and gas checks:
// the user's Crossmint wallet when they have one, else their derived address.
function solanaAddressFor(user: { crossmintAddress?: string | null } | null, derived: string): string {
  return user?.crossmintAddress ? user.crossmintAddress : derived;
}

async function getUserRow(db: Db, userId: number) {
  const rows = await db.select().from(schema.custodialUsers).where(eq(schema.custodialUsers.id, userId));
  return rows[0] ?? null;
}

// Throws unless the user's derived address on `networkId` holds at least
// $0.50 USD worth of the network's native coin on-chain (gas requirement).
async function assertGasBalance(db: Db, userId: number, networkId: string, prices: Record<string, number>) {
  const net = NETWORKS.find((n) => n.id === networkId);
  if (!net) throw new Error("Red no soportada.");
  const addrs = await db.select().from(schema.userAddresses)
    .where(eq(schema.userAddresses.userId, userId));
  const addrRow = addrs.find((a) => a.network === networkId);
  if (!addrRow) throw new Error("Este usuario no tiene dirección derivada en esta red.");
  const userRow = networkId === "solana" ? await getUserRow(db, userId) : null;
  const addr = { ...addrRow, address: solanaAddressFor(userRow, addrRow.address) };
  const rows: AssetRow[] = [];
  try {
    if (net.kind === "solana") await solanaBalances(addr.address, rows);
    else if (net.kind === "tron") await tronBalances(addr.address, rows);
    else await evmBalances(net, addr.address, rows);
  } catch {
    throw new Error(`No se pudo verificar el saldo de gas en ${net.name}. Inténtalo de nuevo en unos segundos.`);
  }
  const nativeRow = rows.find((r) => r.asset === net.native);
  const price = prices[net.native];
  if (!nativeRow || price == null) {
    throw new Error(`No se pudo verificar el saldo de gas en ${net.name}. Inténtalo de nuevo.`);
  }
  const usd = (Number(nativeRow.balance) || 0) * price;
  if (usd < MIN_GAS_USD) {
    throw new Error(
      `Para operar en ${net.name} el usuario debe tener al menos $0.50 USD en ${net.native} para el gas. ` +
      `Su dirección derivada tiene ${nativeRow.balance} ${net.native} (≈ $${usd.toFixed(2)} USD). Deposita ${net.native} en su dirección de ${net.name} y vuelve a intentarlo.`,
    );
  }
}

// ---------------- Automatic deposit sync (NC Wallet style) ----------------
// Reads live on-chain balances at one user's addresses and credits the
// internal ledger with any increase since the last sync. Used by the manual
// syncUserDeposits action AND by syncAllDeposits, which the artifact runs on
// a schedule so deposits are credited automatically — no manual step.

async function syncOneUser(db: Db, userId: number): Promise<{ network: string; asset: string; amount: string }[]> {
  const userRow = await getUserRow(db, userId);
  const rawAddrs = await db.select().from(schema.userAddresses).where(eq(schema.userAddresses.userId, userId));
  if (rawAddrs.length === 0) return [];
  // Solana deposits are detected at the Crossmint wallet address when the
  // user has one; the snapshot stays on the derived-address row.
  const addrs = rawAddrs.map((a) => a.network === "solana"
    ? { ...a, address: solanaAddressFor(userRow, a.address) }
    : a);
  const assets: AssetRow[] = [];
  for (const a of addrs) {
    const net = NETWORKS.find((n) => n.id === a.network);
    if (!net) continue;
    try {
      if (net.kind === "solana") await solanaBalances(a.address, assets);
      else if (net.kind === "tron") await tronBalances(a.address, assets);
      else await evmBalances(net, a.address, assets);
    } catch { /* a failing network is skipped, its snapshot stays */ }
  }
  const byAddr = new Map<string, AssetRow[]>();
  for (const row of assets) {
    const list = byAddr.get(row.network) ?? [];
    list.push(row);
    byAddr.set(row.network, list);
  }
  const credited: { network: string; asset: string; amount: string }[] = [];
  for (const a of addrs) {
    const rows = byAddr.get(a.network);
    if (!rows) continue;
    let snapshot: Record<string, string> = {};
    try { snapshot = JSON.parse(a.lastSyncedBalance || "{}") as Record<string, string>; } catch { snapshot = {}; }
    const nextSnapshot: Record<string, string> = { ...snapshot };
    for (const row of rows) {
      const onChain = Number(row.balance) || 0;
      const prev = Number(snapshot[row.asset] ?? "0") || 0;
      const delta = onChain - prev;
      nextSnapshot[row.asset] = row.balance;
      if (delta > 0.000000001) {
        await adjustLedger(db, userId, row.network, row.asset, delta);
        await db.insert(schema.ledgerEntries).values({
          userId, kind: "deposit", network: row.network, asset: row.asset,
          amount: numStr(delta), feeGtq: "0", note: "Depósito detectado en cadena y acreditado automáticamente",
        });
        await db.insert(schema.transactions).values({
          kind: "deposit", network: row.network, fromAsset: row.asset, toAsset: null,
          amount: numStr(delta), feeGtq: "0", toAddress: a.address,
          note: "Depósito detectado en cadena", payload: "", status: "acreditado",
          userId, relatedUserId: null,
        });
        credited.push({ network: row.network, asset: row.asset, amount: numStr(delta) });
      }
    }
    await db.update(schema.userAddresses)
      .set({ lastSyncedBalance: JSON.stringify(nextSnapshot) })
      .where(eq(schema.userAddresses.id, a.id));
  }
  return credited;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const Actions = {
  getNetworks: defineAction({
    description: "Lists every network the Quetzal Wallet supports, with its native coin.",
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
          id: n.id, name: n.name, kind: n.kind, native: n.native, testnet: n.testnet ?? false,
        })),
      };
    },
  }),

  getWallet: defineAction({
    description: "Returns the saved Quetzal wallet profile and its per-network addresses, or null if none exists yet.",
    request: z.object({}),
    response: walletResponse,
    async handler(ctx): Promise<WalletResponse> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.wallets).orderBy(asc(schema.wallets.id)).limit(1);
      const w = rows[0];
      if (!w) return { wallet: null };
      const addrs = await db.select().from(schema.addresses).where(eq(schema.addresses.walletId, w.id));
      return {
        wallet: {
          id: w.id, label: w.label, feeGtq: w.feeGtq,
          addresses: addrs.map((a) => ({ network: a.network, address: a.address })),
        },
      };
    },
  }),

  saveWallet: defineAction({
    description: "Creates or updates the Quetzal wallet profile: label, GTQ service fee, and one public address per network.",
    request: z.object({
      label: z.string().trim().min(1).max(60),
      feeGtq: z.string().trim().min(1).max(12),
      addresses: z.array(z.object({
        network: z.string().min(1).max(24),
        address: z.string().trim().max(120),
      })).max(20),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const fee = Number(args.feeGtq);
      if (!Number.isFinite(fee) || fee < 0) throw new Error("La comisión en GTQ no es válida.");
      const known = new Set(NETWORKS.map((n) => n.id));
      const clean = args.addresses.filter((a) => known.has(a.network) && a.address.length > 0);
      // Reject addresses nobody controls (zero / burn / system) — their funds
      // are not the user's and must never count as wallet balance.
      const UNCONTROLLABLE = new Set([
        "0x0000000000000000000000000000000000000000",
        "11111111111111111111111111111111",
        "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
      ]);
      for (const a of clean) {
        if (UNCONTROLLABLE.has(a.address) || /^0x0{40}$/.test(a.address)) {
          throw new Error("Esa dirección es la dirección cero/quema de la red: nadie la controla y no puede ser tu wallet.");
        }
      }
      const existing = await db.select().from(schema.wallets).orderBy(asc(schema.wallets.id)).limit(1);
      let walletId = existing[0]?.id;
      if (walletId == null) {
        const inserted = await db.insert(schema.wallets)
          .values({ label: args.label, feeGtq: args.feeGtq })
          .returning({ id: schema.wallets.id });
        walletId = inserted[0]?.id;
        if (walletId == null) throw new Error("No se pudo crear la wallet.");
      } else {
        await db.update(schema.wallets)
          .set({ label: args.label, feeGtq: args.feeGtq })
          .where(eq(schema.wallets.id, walletId));
        await db.delete(schema.addresses).where(eq(schema.addresses.walletId, walletId));
      }
      for (const a of clean) {
        await db.insert(schema.addresses).values({ walletId, network: a.network, address: a.address });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  getBalances: defineAction({
    description: "Reads live on-chain balances for every registered address across all networks, GTQ first, with USD reference prices where a market exists.",
    request: z.object({}),
    response: z.object({
      assets: z.array(z.object({
        network: z.string(), networkName: z.string(), asset: z.string(),
        balance: z.string(), usdPrice: z.number().nullable(), isGtq: z.boolean(),
      })),
      errors: z.array(z.object({ network: z.string(), message: z.string() })),
      totalUsd: z.number().nullable(),
      fetchedAt: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.wallets).orderBy(asc(schema.wallets.id)).limit(1);
      const w = rows[0];
      if (!w) return { assets: [], errors: [], totalUsd: null, fetchedAt: new Date().toISOString() };
      const addrs = await db.select().from(schema.addresses).where(eq(schema.addresses.walletId, w.id));
      const assets: AssetRow[] = [];
      const errors: { network: string; message: string }[] = [];
      const jobs: Promise<void>[] = [];
      for (const a of addrs) {
        const net = NETWORKS.find((n) => n.id === a.network);
        if (!net || !a.address) continue;
        if (a.address === "0x0000000000000000000000000000000000000000" || /^0x0{40}$/.test(a.address)
          || a.address === "11111111111111111111111111111111"
          || a.address === "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb") {
          errors.push({ network: net.id, message: `La dirección guardada en ${net.name} es la dirección cero/quema: nadie la controla. Corrígela en Ajustes.` });
          continue;
        }
        jobs.push((async () => {
          try {
            if (net.kind === "solana") await solanaBalances(a.address, assets);
            else if (net.kind === "tron") await tronBalances(a.address, assets);
            else await evmBalances(net, a.address, assets);
          } catch {
            errors.push({ network: net.id, message: `No se pudo leer ${net.name}.` });
          }
        })());
      }
      const pricesPromise = fetchPrices();
      await Promise.all(jobs);
      const prices = await pricesPromise;
      for (const row of assets) row.usdPrice = prices[row.asset] ?? null;
      const order = new Map(NETWORKS.map((n, i) => [n.id, i]));
      assets.sort((x, y) => {
        if (x.isGtq) return -1;
        if (y.isGtq) return 1;
        const d = (order.get(x.network) ?? 99) - (order.get(y.network) ?? 99);
        return d !== 0 ? d : x.asset.localeCompare(y.asset);
      });
      let total = 0;
      let anyPriced = false;
      for (const row of assets) {
        if (row.usdPrice != null) { total += Number(row.balance) * row.usdPrice; anyPriced = true; }
      }
      return { assets, errors, totalUsd: anyPriced ? total : null, fetchedAt: new Date().toISOString() };
    },
  }),

  recordTransaction: defineAction({
    description: "Records a send or swap the user reviewed and confirmed (signed) in the Quetzal Wallet, including the GTQ service fee and its payment payload.",
    request: z.object({
      kind: z.enum(["send", "swap"]),
      network: z.string().min(1).max(24),
      fromAsset: z.string().min(1).max(10),
      toAsset: z.string().max(10).nullable(),
      amount: z.string().trim().min(1).max(24),
      feeGtq: z.string().trim().min(1).max(12),
      toAddress: z.string().trim().max(120).nullable(),
      note: z.string().trim().max(140),
      payload: z.string().max(600),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("La cantidad no es válida.");
      const db = ctx.db<typeof schema>();
      const inserted = await db.insert(schema.transactions).values({
        kind: args.kind, network: args.network, fromAsset: args.fromAsset,
        toAsset: args.toAsset, amount: args.amount, feeGtq: args.feeGtq,
        toAddress: args.toAddress, note: args.note, payload: args.payload,
      }).returning({ id: schema.transactions.id });
      const row = inserted[0];
      if (!row) throw new Error("No se pudo registrar la operación.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  listTransactions: defineAction({
    description: "Lists the wallet's recorded sends and swaps, newest first.",
    request: z.object({ limit: z.number().int().positive().max(100).default(50) }),
    response: z.object({ transactions: z.array(txShape) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.transactions)
        .orderBy(desc(schema.transactions.id)).limit(args.limit);
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
    description: "Lists saved recipient contacts for sends.",
    request: z.object({}),
    response: z.object({
      contacts: z.array(z.object({
        id: z.number(), name: z.string(), network: z.string(), address: z.string(),
      })),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.contacts).orderBy(asc(schema.contacts.name));
      return { contacts: rows.map((r) => ({ id: r.id, name: r.name, network: r.network, address: r.address })) };
    },
  }),

  addContact: defineAction({
    description: "Saves a recipient contact with a name, network, and address.",
    request: z.object({
      name: z.string().trim().min(1).max(60),
      network: z.string().min(1).max(24),
      address: z.string().trim().min(8).max(120),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db.insert(schema.contacts).values(args).returning({ id: schema.contacts.id });
      const row = inserted[0];
      if (!row) throw new Error("No se pudo guardar el contacto.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteContact: defineAction({
    description: "Deletes one saved recipient contact by id.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.contacts).where(eq(schema.contacts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // ---------------- Custodial actions ----------------

  getCustodyStatus: defineAction({
    description: "Returns whether the custodial vault (one encrypted master seed) exists, its label, GTQ fee and user count. Never returns the seed.",
    request: z.object({}),
    response: z.object({
      initialized: z.boolean(),
      label: z.string().nullable(),
      feeGtq: z.string().nullable(),
      userCount: z.number(),
      createdAt: z.string().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const vault = await getVaultRow(ctx);
      const users = await db.select().from(schema.custodialUsers);
      return {
        initialized: vault != null,
        label: vault?.label ?? null,
        feeGtq: vault?.feeGtq ?? null,
        userCount: users.length,
        createdAt: vault ? vault.createdAt.toISOString() : null,
      };
    },
  }),

  setupCustody: defineAction({
    description: "Creates the custodial vault: generates a new 12-word BIP39 master seed, encrypts it with the operator passphrase (scrypt + AES-256-GCM) and stores only the ciphertext. Returns the seed ONCE for backup.",
    request: z.object({
      label: z.string().trim().min(1).max(60),
      feeGtq: z.string().trim().min(1).max(12),
      passphrase: z.string().min(8).max(120),
    }),
    response: z.object({ mnemonic: z.string() }),
    privileged: [privileged.generateVault],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await getVaultRow(ctx);
      if (existing) throw new Error("La bóveda custodial ya existe. No se puede crear otra frase semilla.");
      const fee = Number(args.feeGtq);
      if (!Number.isFinite(fee) || fee < 0) throw new Error("La comisión en GTQ no es válida.");
      const gen = await ctx.executePrivileged(privileged.generateVault, { passphrase: args.passphrase });
      await db.insert(schema.custodyVault).values({
        label: args.label, feeGtq: args.feeGtq,
        encryptedSeed: gen.ciphertext, salt: gen.salt, iv: gen.iv, authTag: gen.authTag,
      });
      ctx.invalidateQueries();
      return { mnemonic: gen.mnemonic };
    },
  }),

  importCustody: defineAction({
    description: "Imports an existing BIP39 seed phrase (12 or 24 words) as the custodial master seed, encrypted with the operator passphrase. The plaintext is never stored.",
    request: z.object({
      label: z.string().trim().min(1).max(60),
      feeGtq: z.string().trim().min(1).max(12),
      passphrase: z.string().min(8).max(120),
      mnemonic: z.string().trim().min(20).max(400),
    }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.importVault],
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const existing = await getVaultRow(ctx);
      if (existing) throw new Error("La bóveda custodial ya existe.");
      const fee = Number(args.feeGtq);
      if (!Number.isFinite(fee) || fee < 0) throw new Error("La comisión en GTQ no es válida.");
      const enc = await ctx.executePrivileged(privileged.importVault, {
        mnemonic: args.mnemonic, passphrase: args.passphrase,
      });
      await db.insert(schema.custodyVault).values({
        label: args.label, feeGtq: args.feeGtq,
        encryptedSeed: enc.ciphertext, salt: enc.salt, iv: enc.iv, authTag: enc.authTag,
      });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  recoverSeed: defineAction({
    description: "Recovery flow: decrypts and returns the master seed phrase only when the operator passphrase is correct.",
    request: z.object({ passphrase: z.string().min(1).max(120) }),
    response: z.object({ mnemonic: z.string() }),
    privileged: [privileged.decryptSeedOnly],
    async handler(ctx, args) {
      const vault = await getVaultRow(ctx);
      if (!vault) throw new Error("Todavía no hay bóveda custodial.");
      return ctx.executePrivileged(privileged.decryptSeedOnly, { ...vaultEnc(vault), passphrase: args.passphrase });
    },
  }),

  updateCustodySettings: defineAction({
    description: "Updates the custodial vault label and the GTQ service fee charged per send/swap/internal transfer.",
    request: z.object({
      label: z.string().trim().min(1).max(60),
      feeGtq: z.string().trim().min(1).max(12),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const vault = await getVaultRow(ctx);
      if (!vault) throw new Error("Todavía no hay bóveda custodial.");
      const fee = Number(args.feeGtq);
      if (!Number.isFinite(fee) || fee < 0) throw new Error("La comisión en GTQ no es válida.");
      await db.update(schema.custodyVault).set({ label: args.label, feeGtq: args.feeGtq })
        .where(eq(schema.custodyVault.id, vault.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  listUsers: defineAction({
    description: "Lists all custodial users with their derived deposit addresses for all 12 networks and their internal ledger balances.",
    request: z.object({}),
    response: z.object({ users: z.array(userShape) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.custodialUsers).orderBy(asc(schema.custodialUsers.accountIndex));
      const users = [];
      for (const u of rows) users.push(await buildUser(db, u));
      return { users };
    },
  }),

  createUser: defineAction({
    description: "Registers a custodial user with their email (permanent binding: the email can never be changed or reused, and the addresses stay linked to it forever), derives their deposit addresses for all 12 networks from the master seed by account index, and — when a Crossmint API key is saved — also creates their Crossmint Solana Smart Wallet (server signer) and binds its address permanently to the email.",
    request: z.object({
      name: z.string().trim().min(1).max(60),
      email: z.string().trim().min(3).max(120),
      passphrase: z.string().min(1).max(120),
    }),
    response: z.object({ user: userShape, crossmintError: z.string().nullable() }),
    privileged: [privileged.deriveAddresses, privileged.decryptText],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const vault = await getVaultRow(ctx);
      if (!vault) throw new Error("Primero crea la bóveda custodial con su frase semilla cifrada.");
      const email = args.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("El correo electrónico no es válido.");
      const existing = await db.select().from(schema.custodialUsers).orderBy(asc(schema.custodialUsers.accountIndex));
      if (existing.some((u) => u.email.toLowerCase() === email)) {
        throw new Error("Ese correo ya está registrado y ligado permanentemente a las direcciones de su cuenta. Inicia sesión con ese correo en lugar de crear otra cuenta.");
      }
      const nextIndex = existing.length === 0 ? 0 : Math.max(...existing.map((u) => u.accountIndex)) + 1;
      // Decrypt + derive inside the privileged handler: the mnemonic never leaves it.
      const derivedRes = await ctx.executePrivileged(privileged.deriveAddresses, {
        ...vaultEnc(vault), passphrase: args.passphrase, accountIndex: nextIndex,
      });
      const inserted = await db.insert(schema.custodialUsers)
        .values({ name: args.name, email, accountIndex: nextIndex })
        .returning();
      const user = inserted[0];
      if (!user) throw new Error("No se pudo crear el usuario.");
      for (const d of derivedRes.addresses) {
        await db.insert(schema.userAddresses).values({
          userId: user.id, network: d.network, address: d.address, derivationPath: d.path,
        });
      }
      // Crossmint: create the user's Solana Smart Wallet now that the email
      // is registered. A Crossmint failure must not lose the registration:
      // the error is returned so the operator can retry from the admin panel.
      let crossmintError: string | null = null;
      const cmRow = await getCrossmintRow(ctx);
      if (cmRow) {
        try {
          const apiKey = await decryptCrossmintKey(ctx, cmRow, args.passphrase);
          const address = await crossmintCreateWallet(apiKey, email, cmRow.serverSignerAddress);
          await db.update(schema.custodialUsers)
            .set({ crossmintAddress: address })
            .where(eq(schema.custodialUsers.id, user.id));
          user.crossmintAddress = address;
        } catch (e) {
          crossmintError = e instanceof Error ? e.message : "No se pudo crear la wallet de Crossmint.";
        }
      }
      ctx.invalidateQueries();
      return { user: await buildUser(db, user), crossmintError };
    },
  }),

  findUserByEmail: defineAction({
    description: "Email login: finds the custodial account permanently bound to an email address and returns it with its derived addresses and ledger balances, or null if no account is registered with that email.",
    request: z.object({ email: z.string().trim().min(3).max(120) }),
    response: z.object({ user: userShape.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      const rows = await db.select().from(schema.custodialUsers);
      const found = rows.find((u) => u.email.toLowerCase() === email);
      if (!found) return { user: null };
      return { user: await buildUser(db, found) };
    },
  }),

  getUserBalances: defineAction({
    description: "Reads live on-chain balances for one custodial user's derived addresses across all networks, GTQ first, with USD reference prices.",
    request: z.object({ userId: z.number().int().positive() }),
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
      const db = ctx.db<typeof schema>();
      const userRow = await getUserRow(db, args.userId);
      const rawAddrs = await db.select().from(schema.userAddresses).where(eq(schema.userAddresses.userId, args.userId));
      const addrs = rawAddrs.map((a) => a.network === "solana"
        ? { ...a, address: solanaAddressFor(userRow, a.address) }
        : a);
      const assets: AssetRow[] = [];
      const errors: { network: string; message: string }[] = [];
      const jobs: Promise<void>[] = [];
      for (const a of addrs) {
        const net = NETWORKS.find((n) => n.id === a.network);
        if (!net || !a.address) continue;
        jobs.push((async () => {
          try {
            if (net.kind === "solana") await solanaBalances(a.address, assets);
            else if (net.kind === "tron") await tronBalances(a.address, assets);
            else await evmBalances(net, a.address, assets);
          } catch {
            errors.push({ network: net.id, message: `No se pudo leer ${net.name}.` });
          }
        })());
      }
      const pricesPromise = fetchPrices();
      await Promise.all(jobs);
      const prices = await pricesPromise;
      for (const row of assets) row.usdPrice = prices[row.asset] ?? null;
      const order = new Map(NETWORKS.map((n, i) => [n.id, i]));
      assets.sort((x, y) => {
        if (x.isGtq) return -1;
        if (y.isGtq) return 1;
        const d = (order.get(x.network) ?? 99) - (order.get(y.network) ?? 99);
        return d !== 0 ? d : x.asset.localeCompare(y.asset);
      });
      let total = 0; let anyPriced = false;
      for (const row of assets) {
        if (row.usdPrice != null) { total += Number(row.balance) * row.usdPrice; anyPriced = true; }
      }
      return { assets, errors, totalUsd: anyPriced ? total : null, fetchedAt: new Date().toISOString() };
    },
  }),

  syncUserDeposits: defineAction({
    description: "Syncs one user's deposits: reads live on-chain balances at their derived addresses and credits the internal ledger with any increase since the last sync.",
    request: z.object({ userId: z.number().int().positive() }),
    response: z.object({
      credited: z.array(z.object({ network: z.string(), asset: z.string(), amount: z.string() })),
      fetchedAt: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rawAddrs = await db.select().from(schema.userAddresses).where(eq(schema.userAddresses.userId, args.userId));
      if (rawAddrs.length === 0) throw new Error("Usuario sin direcciones derivadas.");
      const credited = await syncOneUser(db, args.userId);
      ctx.invalidateQueries();
      return { credited, fetchedAt: new Date().toISOString() };
    },
  }),

  syncAllDeposits: defineAction({
    description: "Automatic NC Wallet-style deposit sync for ALL custodial users: reads live on-chain balances at every user's addresses (Crossmint address on Solana when present) and credits each internal ledger with any new deposit. Runs on a schedule and when the app opens; no manual step.",
    request: z.object({}),
    response: z.object({
      usersChecked: z.number(),
      credited: z.array(z.object({ userId: z.number(), network: z.string(), asset: z.string(), amount: z.string() })),
      fetchedAt: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const users = await db.select().from(schema.custodialUsers).orderBy(asc(schema.custodialUsers.accountIndex));
      const credited: { userId: number; network: string; asset: string; amount: string }[] = [];
      for (const u of users) {
        try {
          const rows = await syncOneUser(db, u.id);
          for (const r of rows) credited.push({ userId: u.id, ...r });
        } catch { /* one user's failing network must not stop the rest */ }
      }
      if (credited.length > 0) ctx.invalidateQueries();
      return { usersChecked: users.length, credited, fetchedAt: new Date().toISOString() };
    },
  }),

  creditDeposit: defineAction({
    description: "Manually credits a deposit to a custodial user's internal ledger balance (operator-confirmed deposit).",
    request: z.object({
      userId: z.number().int().positive(),
      network: z.string().min(1).max(24),
      asset: z.string().min(1).max(10),
      amount: z.string().trim().min(1).max(24),
      note: z.string().trim().max(140),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("La cantidad no es válida.");
      if (!NETWORKS.some((n) => n.id === args.network)) throw new Error("Red no soportada.");
      const users = await db.select().from(schema.custodialUsers).where(eq(schema.custodialUsers.id, args.userId));
      const user = users[0];
      if (!user) throw new Error("Usuario no encontrado.");
      const prices = await fetchPrices();
      const limit = monthlyLimitGtq(user.kycStatus);
      const usage = await monthlyUsageGtq(db, args.userId, prices);
      const thisEq = gtqEquivalent(args.asset, amount, prices);
      if (usage.deposits + thisEq > limit) {
        throw new Error(
          `Límite mensual de depósitos alcanzado: este usuario ${user.kycStatus === "verified" ? "con KYC verificado" : "sin KYC"} puede depositar hasta ${limit.toLocaleString("en-US")} GTQ al mes ` +
          `y ya lleva ${numStr(Math.round(usage.deposits * 100) / 100)} GTQ este mes (los GTQ cuentan 1:1 y las demás monedas por su valor en USD, porque GTQ no tiene precio público).`,
        );
      }
      await adjustLedger(db, args.userId, args.network, args.asset, amount);
      await db.insert(schema.ledgerEntries).values({
        userId: args.userId, kind: "deposit", network: args.network, asset: args.asset,
        amount: args.amount, feeGtq: "0", note: args.note || "Depósito acreditado manualmente por el operador",
      });
      await db.insert(schema.transactions).values({
        kind: "deposit", network: args.network, fromAsset: args.asset, toAsset: null,
        amount: args.amount, feeGtq: "0", toAddress: null,
        note: args.note || "Depósito manual", payload: "", status: "acreditado",
        userId: args.userId, relatedUserId: null,
      });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  internalTransfer: defineAction({
    description: "Instant internal transfer between two custodial users on the same network/asset, settled only on the internal ledger. Charges the vault GTQ fee to the sender (in GTQ, on Solana ledger).",
    request: z.object({
      fromUserId: z.number().int().positive(),
      toUserId: z.number().int().positive(),
      network: z.string().min(1).max(24),
      asset: z.string().min(1).max(10),
      amount: z.string().trim().min(1).max(24),
      note: z.string().trim().max(140),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      if (args.fromUserId === args.toUserId) throw new Error("Elige dos usuarios distintos.");
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("La cantidad no es válida.");
      const vault = await getVaultRow(ctx);
      if (!vault) throw new Error("No hay bóveda custodial.");
      const fee = Number(vault.feeGtq) || 0;
      const fromBal = await ledgerBalance(db, args.fromUserId, args.network, args.asset);
      if (fromBal < amount) throw new Error(`Saldo interno insuficiente: el remitente tiene ${numStr(fromBal)} ${args.asset} en ${args.network}.`);
      if (fee > 0 && args.asset !== "GTQ") {
        const gtqBal = await ledgerBalance(db, args.fromUserId, "solana", "GTQ");
        if (gtqBal < fee) throw new Error(`El remitente necesita ${vault.feeGtq} GTQ para la comisión y tiene ${numStr(gtqBal)} GTQ.`);
      }
      if (fee > 0 && args.asset === "GTQ" && args.network === "solana" && fromBal < amount + fee) {
        throw new Error(`Saldo insuficiente: cantidad + comisión (${vault.feeGtq} GTQ) supera el saldo.`);
      }
      await adjustLedger(db, args.fromUserId, args.network, args.asset, -amount);
      await adjustLedger(db, args.toUserId, args.network, args.asset, amount);
      if (fee > 0) await adjustLedger(db, args.fromUserId, "solana", "GTQ", -fee);
      await db.insert(schema.ledgerEntries).values({
        userId: args.fromUserId, kind: "internal_out", network: args.network, asset: args.asset,
        amount: numStr(-amount), feeGtq: vault.feeGtq, relatedUserId: args.toUserId, note: args.note,
      });
      await db.insert(schema.ledgerEntries).values({
        userId: args.toUserId, kind: "internal_in", network: args.network, asset: args.asset,
        amount: args.amount, feeGtq: "0", relatedUserId: args.fromUserId, note: args.note,
      });
      if (fee > 0) {
        await db.insert(schema.ledgerEntries).values({
          userId: args.fromUserId, kind: "fee", network: "solana", asset: "GTQ",
          amount: numStr(-fee), feeGtq: "0", relatedUserId: null, note: "Comisión de transferencia interna",
        });
      }
      await db.insert(schema.transactions).values({
        kind: "internal", network: args.network, fromAsset: args.asset, toAsset: args.asset,
        amount: args.amount, feeGtq: vault.feeGtq, toAddress: null,
        note: args.note, payload: "", status: "completada",
        userId: args.fromUserId, relatedUserId: args.toUserId,
      });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  recordUserTransaction: defineAction({
    description: "Records a send or swap for a specific custodial user, debiting their internal ledger balance plus the GTQ service fee.",
    request: z.object({
      userId: z.number().int().positive(),
      kind: z.enum(["send", "swap"]),
      network: z.string().min(1).max(24),
      fromAsset: z.string().min(1).max(10),
      toAsset: z.string().max(10).nullable(),
      amount: z.string().trim().min(1).max(24),
      toAddress: z.string().trim().max(120).nullable(),
      note: z.string().trim().max(140),
      payload: z.string().max(600),
      receiveAmount: z.string().trim().max(24),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("La cantidad no es válida.");
      const vault = await getVaultRow(ctx);
      if (!vault) throw new Error("No hay bóveda custodial.");
      const userRows = await db.select().from(schema.custodialUsers)
        .where(eq(schema.custodialUsers.id, args.userId));
      const user = userRows[0];
      if (!user) throw new Error("Usuario no encontrado.");
      const prices = await fetchPrices();
      // Gas: at least $0.50 USD of the network's native coin on-chain.
      await assertGasBalance(db, args.userId, args.network, prices);
      // Fee: sends pay the vault's fixed GTQ service fee; swaps pay a fixed
      // 0.1% of the swapped amount, charged in GTQ.
      let fee: number;
      if (args.kind === "swap") {
        if (args.fromAsset === "GTQ") fee = amount * SWAP_FEE_RATE;
        else if (args.toAsset === "GTQ" && args.receiveAmount && Number(args.receiveAmount) > 0) {
          fee = Number(args.receiveAmount) * SWAP_FEE_RATE;
        } else {
          fee = gtqEquivalent(args.fromAsset, amount * SWAP_FEE_RATE, prices);
        }
        fee = Math.round(fee * 1e6) / 1e6;
      } else {
        fee = Number(vault.feeGtq) || 0;
        // Monthly withdrawal limit (sends are the withdrawals).
        const limit = monthlyLimitGtq(user.kycStatus);
        const usage = await monthlyUsageGtq(db, args.userId, prices);
        const thisEq = gtqEquivalent(args.fromAsset, amount, prices);
        if (usage.withdrawals + thisEq > limit) {
          throw new Error(
            `Límite mensual de retiros alcanzado: este usuario ${user.kycStatus === "verified" ? "con KYC verificado" : "sin KYC"} puede retirar hasta ${limit.toLocaleString("en-US")} GTQ al mes ` +
            `y ya lleva ${numStr(Math.round(usage.withdrawals * 100) / 100)} GTQ este mes (los GTQ cuentan 1:1 y las demás monedas por su valor en USD, porque GTQ no tiene precio público).`,
          );
        }
      }
      const feeStr = numStr(fee);
      const bal = await ledgerBalance(db, args.userId, args.network, args.fromAsset);
      if (bal < amount) {
        throw new Error(`Saldo interno insuficiente: este usuario tiene ${numStr(bal)} ${args.fromAsset} en esta red. Sincroniza sus depósitos o acredita el depósito primero.`);
      }
      const isGtqSend = args.fromAsset === "GTQ" && args.network === "solana";
      if (fee > 0 && !isGtqSend) {
        const gtqBal = await ledgerBalance(db, args.userId, "solana", "GTQ");
        if (gtqBal < fee) throw new Error(`Este usuario necesita ${feeStr} GTQ para la comisión y tiene ${numStr(gtqBal)} GTQ.`);
      }
      if (fee > 0 && isGtqSend && bal < amount + fee) {
        throw new Error(`Saldo insuficiente: cantidad + comisión (${feeStr} GTQ) supera el saldo.`);
      }
      await adjustLedger(db, args.userId, args.network, args.fromAsset, -amount);
      if (args.kind === "swap" && args.toAsset && args.receiveAmount) {
        const recv = Number(args.receiveAmount);
        if (Number.isFinite(recv) && recv > 0) {
          await adjustLedger(db, args.userId, args.network, args.toAsset, recv);
        }
      }
      if (fee > 0) await adjustLedger(db, args.userId, "solana", "GTQ", -fee);
      await db.insert(schema.ledgerEntries).values({
        userId: args.userId, kind: args.kind, network: args.network, asset: args.fromAsset,
        amount: numStr(-amount), feeGtq: feeStr, note: args.note,
      });
      if (fee > 0) {
        await db.insert(schema.ledgerEntries).values({
          userId: args.userId, kind: "fee", network: "solana", asset: "GTQ",
          amount: numStr(-fee), feeGtq: "0", note: `Comisión de ${args.kind === "swap" ? "swap" : "envío"}`,
        });
      }
      const inserted = await db.insert(schema.transactions).values({
        kind: args.kind, network: args.network, fromAsset: args.fromAsset,
        toAsset: args.toAsset, amount: args.amount, feeGtq: feeStr,
        toAddress: args.toAddress, note: args.note, payload: args.payload,
        userId: args.userId, relatedUserId: null,
      }).returning({ id: schema.transactions.id });
      const row = inserted[0];
      if (!row) throw new Error("No se pudo registrar la operación.");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  listLedgerEntries: defineAction({
    description: "Lists internal ledger entries (deposits, sends, swaps, internal transfers, fees) for one custodial user, newest first.",
    request: z.object({ userId: z.number().int().positive(), limit: z.number().int().positive().max(100).default(50) }),
    response: z.object({
      entries: z.array(z.object({
        id: z.number(), kind: z.string(), network: z.string(), asset: z.string(),
        amount: z.string(), feeGtq: z.string(), relatedUserId: z.number().nullable(),
        note: z.string(), createdAt: z.string(),
      })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.userId, args.userId))
        .orderBy(desc(schema.ledgerEntries.id)).limit(args.limit);
      return {
        entries: rows.map((r) => ({
          id: r.id, kind: r.kind, network: r.network, asset: r.asset, amount: r.amount,
          feeGtq: r.feeGtq, relatedUserId: r.relatedUserId ?? null, note: r.note,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  updateUserProfile: defineAction({
    description: "Updates a custodial user's phone number shown in their profile. The email is permanent and can never be changed.",
    request: z.object({
      userId: z.number().int().positive(),
      phone: z.string().trim().max(24),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
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
    request: z.object({ userId: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
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
    description: "Grants the KYC verified badge to a user. Only the authority email gt.guatemala.com@gmail.com may do this; any other authority email is rejected.",
    request: z.object({
      userId: z.number().int().positive(),
      authorityEmail: z.string().trim().min(3).max(120),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
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
    description: "Returns a user's KYC status, their monthly deposit/withdrawal limit in GTQ (10,000 without KYC, 1,000,000 with KYC verified) and how much of each limit they have used this calendar month.",
    request: z.object({ userId: z.number().int().positive() }),
    response: z.object({
      kycStatus: z.string(),
      limitGtq: z.number(),
      depositsGtq: z.string(),
      withdrawalsGtq: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.custodialUsers)
        .where(eq(schema.custodialUsers.id, args.userId));
      const user = rows[0];
      if (!user) throw new Error("Usuario no encontrado.");
      const prices = await fetchPrices();
      const usage = await monthlyUsageGtq(db, args.userId, prices);
      return {
        kycStatus: user.kycStatus,
        limitGtq: monthlyLimitGtq(user.kycStatus),
        depositsGtq: numStr(Math.round(usage.deposits * 100) / 100),
        withdrawalsGtq: numStr(Math.round(usage.withdrawals * 100) / 100),
      };
    },
  }),

  // ---------------- Crossmint admin actions ----------------

  getCrossmintStatus: defineAction({
    description: "Returns whether a Crossmint server API key is saved (encrypted) in the app, the server signer address used for user Smart Wallets, and how many users already have a Crossmint wallet. Never returns the key.",
    request: z.object({}),
    response: z.object({
      configured: z.boolean(),
      serverSignerAddress: z.string(),
      usersWithWallet: z.number(),
      usersTotal: z.number(),
      savedAt: z.string().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const row = await getCrossmintRow(ctx);
      const users = await db.select().from(schema.custodialUsers);
      return {
        configured: row != null,
        serverSignerAddress: row?.serverSignerAddress ?? CROSSMINT_SERVER_SIGNER,
        usersWithWallet: users.filter((u) => u.crossmintAddress).length,
        usersTotal: users.length,
        savedAt: row ? row.createdAt.toISOString() : null,
      };
    },
  }),

  saveCrossmintKey: defineAction({
    description: "Saves the operator's Crossmint server API key in the admin panel, encrypted at rest with the vault passphrase (scrypt + AES-256-GCM). The key is verified against the Crossmint API before saving; the plaintext is never stored or returned.",
    request: z.object({
      apiKey: z.string().trim().min(10).max(300),
      passphrase: z.string().min(1).max(120),
      serverSignerAddress: z.string().trim().min(32).max(64).default(CROSSMINT_SERVER_SIGNER),
    }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [privileged.encryptText],
    async handler(ctx, args): Promise<{ ok: true }> {
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
      const enc = await ctx.executePrivileged(privileged.encryptText, {
        text: args.apiKey, passphrase: args.passphrase,
      });
      const existing = await getCrossmintRow(ctx);
      if (existing) {
        await db.update(schema.crossmintSettings).set({
          encryptedApiKey: enc.ciphertext, salt: enc.salt, iv: enc.iv, authTag: enc.authTag,
          serverSignerAddress: args.serverSignerAddress,
        }).where(eq(schema.crossmintSettings.id, existing.id));
      } else {
        await db.insert(schema.crossmintSettings).values({
          encryptedApiKey: enc.ciphertext, salt: enc.salt, iv: enc.iv, authTag: enc.authTag,
          serverSignerAddress: args.serverSignerAddress,
        });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  createUserCrossmintWallet: defineAction({
    description: "Creates (or fetches, if it already exists) the Crossmint Solana Smart Wallet for one registered user and binds its address permanently to the user's email. Used to retry or to backfill users registered before the API key was saved.",
    request: z.object({
      userId: z.number().int().positive(),
      passphrase: z.string().min(1).max(120),
    }),
    response: z.object({ address: z.string() }),
    privileged: [privileged.decryptText],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const cmRow = await getCrossmintRow(ctx);
      if (!cmRow) throw new Error("Primero guarda tu API key de Crossmint en el panel de administración.");
      const user = await getUserRow(db, args.userId);
      if (!user) throw new Error("Usuario no encontrado.");
      if (!user.email) throw new Error("Este usuario no tiene correo registrado: la wallet de Crossmint se liga al correo.");
      if (user.crossmintAddress) return { address: user.crossmintAddress };
      const apiKey = await decryptCrossmintKey(ctx, cmRow, args.passphrase);
      const address = await crossmintCreateWallet(apiKey, user.email, cmRow.serverSignerAddress);
      await db.update(schema.custodialUsers)
        .set({ crossmintAddress: address })
        .where(eq(schema.custodialUsers.id, user.id));
      ctx.invalidateQueries();
      return { address };
    },
  }),
} satisfies ActionsModule;
