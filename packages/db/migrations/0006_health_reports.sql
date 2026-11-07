CREATE TABLE `health_reports` (
	`date` text PRIMARY KEY NOT NULL,
	`generated_at` text NOT NULL,
	`target_sources` integer NOT NULL,
	`ran_sources` integer NOT NULL,
	`success_count` integer NOT NULL,
	`partial_count` integer NOT NULL,
	`failed_count` integer NOT NULL,
	`no_run_count` integer NOT NULL,
	`anomaly_count` integer NOT NULL,
	`extracted_count` integer NOT NULL,
	`date_found_count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`source_id` integer NOT NULL,
	`run_id` integer,
	`status` text,
	`nothing_new` integer DEFAULT false NOT NULL,
	`extracted_count` integer DEFAULT 0 NOT NULL,
	`date_found_count` integer DEFAULT 0 NOT NULL,
	`date_rate` real,
	`baseline_extracted_count` real,
	`baseline_date_rate` real,
	`consecutive_failed_days` integer DEFAULT 0 NOT NULL,
	`anomalies` text,
	`error_message` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_health_date_source_unique` ON `source_health` (`date`,`source_id`);--> statement-breakpoint
CREATE INDEX `source_health_source_date_idx` ON `source_health` (`source_id`,`date`);--> statement-breakpoint
ALTER TABLE `crawl_runs` ADD `nothing_new` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `crawl_runs_started_idx` ON `crawl_runs` (`started_at`);