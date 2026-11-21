CREATE TABLE `crossmint_settings` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `encrypted_api_key` text NOT NULL,
  `salt` text NOT NULL,
  `iv` text NOT NULL,
  `auth_tag` text NOT NULL,
  `server_signer_address` text NOT NULL DEFAULT '84Vx1DJx8RGJizV7gKxLZRcPGTiVofi7Pvn7cjcqTQvy',
  `created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `custodial_users` ADD COLUMN `crossmint_address` text DEFAULT '' NOT NULL;
