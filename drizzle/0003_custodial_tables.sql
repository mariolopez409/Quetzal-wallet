CREATE TABLE custody_vault (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  fee_gtq TEXT NOT NULL DEFAULT '1',
  encrypted_seed TEXT NOT NULL,
  salt TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE custodial_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  account_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE user_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  derivation_path TEXT NOT NULL DEFAULT '',
  last_synced_balance TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE ledger_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  balance TEXT NOT NULL DEFAULT '0',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  fee_gtq TEXT NOT NULL DEFAULT '0',
  related_user_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN user_id INTEGER;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN related_user_id INTEGER;
