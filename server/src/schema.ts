import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const wallets = sqliteTable("wallets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  feeGtq: text("fee_gtq").notNull().default("1"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const addresses = sqliteTable("addresses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  walletId: integer("wallet_id").notNull(),
  network: text("network").notNull(),
  address: text("address").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["send", "swap", "internal", "deposit"] }).notNull(),
  network: text("network").notNull(),
  fromAsset: text("from_asset").notNull(),
  toAsset: text("to_asset"),
  amount: text("amount").notNull(),
  feeGtq: text("fee_gtq").notNull().default("0"),
  toAddress: text("to_address"),
  note: text("note").notNull().default(""),
  payload: text("payload").notNull().default(""),
  status: text("status").notNull().default("confirmada"),
  userId: integer("user_id"),
  relatedUserId: integer("related_user_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const contacts = sqliteTable("contacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  network: text("network").notNull(),
  address: text("address").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ---------------- App settings (no seed vault) ----------------
// Since the Crossmint-only rework there is NO master seed phrase anywhere in
// the wallet: users' wallets are Crossmint Smart Wallets created with the
// operator's API key alone. This single row holds the GTQ service fee and
// the server secret the API key is encrypted with (generated automatically
// on the server; the operator never types a passphrase).

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  feeGtq: text("fee_gtq").notNull().default("1"),
  serverSecret: text("server_secret").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// LEGACY — the old seed-phrase vault table. No action reads or writes it
// anymore; the row is left untouched in the database only because deleting
// the encrypted blob would permanently strand any funds sitting at the
// addresses derived from it in earlier versions.
export const custodyVault = sqliteTable("custody_vault", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  feeGtq: text("fee_gtq").notNull().default("1"),
  encryptedSeed: text("encrypted_seed").notNull(),
  salt: text("salt").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const custodialUsers = sqliteTable("custodial_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  kycStatus: text("kyc_status").notNull().default("none"),
  accountIndex: integer("account_index").notNull(),
  crossmintAddress: text("crossmint_address").notNull().default(""),
  // Password auth (migration 0008): scrypt hash + per-user salt. The
  // plaintext password is never stored. Empty = account predates passwords
  // and must set one through the recovery flow before it can log in.
  passwordHash: text("password_hash").notNull().default(""),
  passwordSalt: text("password_salt").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ---------------- Sessions & password recovery (migration 0008) ----------------
// Sessions: only the SHA-256 hash of the session token is stored, never the
// token itself; 30-day expiry; logout deletes the row. Recovery codes: only
// the scrypt hash is stored; 30-minute expiry, single use, max 5 attempts.

export const userSessions = sqliteTable("user_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const passwordRecovery = sqliteTable("password_recovery", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  codeHash: text("code_hash").notNull(),
  codeSalt: text("code_salt").notNull(),
  expiresAt: integer("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  used: integer("used").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const loginAttempts = sqliteTable("login_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ---------------- Crossmint integration ----------------
// The operator's Crossmint server API key, stored encrypted at rest with
// scrypt + AES-256-GCM. The encryption passphrase is a server secret the app
// generates automatically (app_settings.server_secret) — there is no seed
// phrase and no operator passphrase anywhere. The plaintext key never
// reaches the client; it is decrypted only inside server actions to call
// the Crossmint Wallets API. key_version 1 rows were encrypted with the old
// vault passphrase and can no longer be decrypted: the key must be saved
// again from the admin panel.

export const crossmintSettings = sqliteTable("crossmint_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  salt: text("salt").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  serverSignerAddress: text("server_signer_address").notNull()
    .default("84Vx1DJx8RGJizV7gKxLZRcPGTiVofi7Pvn7cjcqTQvy"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const userAddresses = sqliteTable("user_addresses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  network: text("network").notNull(),
  address: text("address").notNull(),
  derivationPath: text("derivation_path").notNull().default(""),
  lastSyncedBalance: text("last_synced_balance").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const ledgerBalances = sqliteTable("ledger_balances", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  network: text("network").notNull(),
  asset: text("asset").notNull(),
  balance: text("balance").notNull().default("0"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const ledgerEntries = sqliteTable("ledger_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  kind: text("kind").notNull(),
  network: text("network").notNull(),
  asset: text("asset").notNull(),
  amount: text("amount").notNull(),
  feeGtq: text("fee_gtq").notNull().default("0"),
  relatedUserId: integer("related_user_id"),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
