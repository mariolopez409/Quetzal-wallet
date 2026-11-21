DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  fee_gtq TEXT NOT NULL DEFAULT '1',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id INTEGER NOT NULL,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  network TEXT NOT NULL,
  from_asset TEXT NOT NULL,
  to_asset TEXT,
  amount TEXT NOT NULL,
  fee_gtq TEXT NOT NULL DEFAULT '0',
  to_address TEXT,
  note TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmada',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
