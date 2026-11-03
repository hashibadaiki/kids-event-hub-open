CREATE TABLE `config_evaluations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`baseline_config_id` integer NOT NULL,
	`candidate_config_id` integer NOT NULL,
	`baseline_score` real NOT NULL,
	`candidate_score` real NOT NULL,
	`baseline_metrics` text NOT NULL,
	`candidate_metrics` text NOT NULL,
	`sample_count` integer NOT NULL,
	`decision` text NOT NULL,
	`reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`baseline_config_id`) REFERENCES `extraction_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_config_id`) REFERENCES `extraction_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "config_evaluations_decision_check" CHECK("decision" IN ('adopted', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `config_evaluations_source_created_idx` ON `config_evaluations` (`source_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `raw_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`crawl_run_id` integer,
	`url` text NOT NULL,
	`content_type` text,
	`body` text NOT NULL,
	`fetched_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`crawl_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `raw_documents_source_fetched_idx` ON `raw_documents` (`source_id`,`fetched_at`);--> statement-breakpoint
ALTER TABLE `crawl_runs` ADD `quality_score` real;