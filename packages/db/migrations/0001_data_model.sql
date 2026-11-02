CREATE TABLE `crawl_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`config_id` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	`fetched_count` integer DEFAULT 0 NOT NULL,
	`extracted_count` integer DEFAULT 0 NOT NULL,
	`date_found_count` integer DEFAULT 0 NOT NULL,
	`upserted_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_id`) REFERENCES `extraction_configs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "crawl_runs_status_check" CHECK("status" IN ('running', 'success', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `crawl_runs_source_started_idx` ON `crawl_runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `crawl_runs_config_idx` ON `crawl_runs` (`config_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`crawl_run_id` integer,
	`title` text NOT NULL,
	`summary` text,
	`start_at` text NOT NULL,
	`end_at` text,
	`all_day` integer DEFAULT false NOT NULL,
	`recurrence` text,
	`prefecture` text NOT NULL,
	`city` text,
	`venue` text,
	`age_min` integer,
	`age_max` integer,
	`with_parent` integer,
	`age_text` text,
	`price_free` integer,
	`price_min_yen` integer,
	`price_max_yen` integer,
	`price_text` text,
	`categories` text DEFAULT '[]' NOT NULL,
	`source_url` text NOT NULL,
	`dedup_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`crawl_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedup_key_unique` ON `events` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `events_prefecture_start_idx` ON `events` (`prefecture`,`start_at`);--> statement-breakpoint
CREATE INDEX `events_source_idx` ON `events` (`source_id`);--> statement-breakpoint
CREATE TABLE `extraction_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`version` integer NOT NULL,
	`config` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`quality_score` real,
	`parent_config_id` integer,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`adopted_at` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_config_id`) REFERENCES `extraction_configs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "extraction_configs_status_check" CHECK("status" IN ('candidate', 'active', 'retired', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extraction_configs_source_version_unique` ON `extraction_configs` (`source_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `extraction_configs_one_active_per_source` ON `extraction_configs` (`source_id`) WHERE status = 'active';--> statement-breakpoint
CREATE TABLE `facilities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`prefecture` text NOT NULL,
	`url` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
-- 手修正: D1 では PRAGMA foreign_keys を切り替えられないため defer_foreign_keys を使う
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`type` text NOT NULL,
	`prefecture` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`submitted_by` text DEFAULT 'owner' NOT NULL,
	`facility_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`policy_status` text,
	`policy_checked_at` text,
	`policy_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`facility_id`) REFERENCES `facilities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sources_type_check" CHECK("type" IN ('jsonld', 'ical', 'rss', 'html', 'pdf', 'llm')),
	CONSTRAINT "sources_submitted_by_check" CHECK("submitted_by" IN ('owner', 'facility')),
	CONSTRAINT "sources_status_check" CHECK("status" IN ('approved', 'pending', 'rejected')),
	CONSTRAINT "sources_policy_status_check" CHECK("policy_status" IS NULL OR "policy_status" IN ('ok', 'caution', 'ng'))
);
--> statement-breakpoint
-- 手修正: 旧 sources にある列だけ移す。旧行は種別不明のため html・未承認(pending)扱い（同期コマンドで上書きされる）
INSERT INTO `__new_sources`("id", "name", "url", "type", "prefecture", "created_at", "updated_at") SELECT "id", "name", "url", 'html', "prefecture", "created_at", "created_at" FROM `sources`;--> statement-breakpoint
DROP TABLE `sources`;--> statement-breakpoint
ALTER TABLE `__new_sources` RENAME TO `sources`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `sources_url_unique` ON `sources` (`url`);--> statement-breakpoint
CREATE INDEX `sources_prefecture_idx` ON `sources` (`prefecture`);