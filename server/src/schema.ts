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

// ---------------- Custodial model ----------------

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
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ---------------- Crossmint integration ----------------
// The operator's Crossmint server API key, stored encrypted at rest with the
// same scrypt + AES-256-GCM scheme as the custody vault (encrypted with the
// vault passphrase by the privileged handlers). The plaintext key never
// reaches the client; it is decrypted only inside server actions to call the
// Crossmint Wallets API.

export const crossmintSettings = sqliteTable("crossmint_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  salt: text("salt").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
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
