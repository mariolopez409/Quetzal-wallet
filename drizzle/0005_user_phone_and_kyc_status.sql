ALTER TABLE `custodial_users` ADD COLUMN `phone` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `custodial_users` ADD COLUMN `kyc_status` text DEFAULT 'none' NOT NULL;
