CREATE TABLE `app_settings` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `fee_gtq` text DEFAULT '1' NOT NULL,
  `server_secret` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `app_settings` (`fee_gtq`, `server_secret`, `created_at`)
SELECT `fee_gtq`, '', `created_at` FROM `custody_vault` ORDER BY `id` LIMIT 1;
--> statement-breakpoint
INSERT INTO `app_settings` (`fee_gtq`, `server_secret`, `created_at`)
SELECT '1', '', CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE NOT EXISTS (SELECT 1 FROM `app_settings`);
--> statement-breakpoint
ALTER TABLE `crossmint_settings` ADD COLUMN `key_version` integer DEFAULT 1 NOT NULL;
