ALTER TABLE custodial_users ADD COLUMN email TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX custodial_users_email_idx ON custodial_users (email);
