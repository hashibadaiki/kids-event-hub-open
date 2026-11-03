PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_config_evaluations` (
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
	CONSTRAINT "config_evaluations_decision_check" CHECK("decision" IN ('adopted', 'pending', 'rejected'))
);
--> statement-breakpoint
INSERT INTO `__new_config_evaluations`("id", "source_id", "baseline_config_id", "candidate_config_id", "baseline_score", "candidate_score", "baseline_metrics", "candidate_metrics", "sample_count", "decision", "reason", "created_at") SELECT "id", "source_id", "baseline_config_id", "candidate_config_id", "baseline_score", "candidate_score", "baseline_metrics", "candidate_metrics", "sample_count", "decision", "reason", "created_at" FROM `config_evaluations`;--> statement-breakpoint
DROP TABLE `config_evaluations`;--> statement-breakpoint
ALTER TABLE `__new_config_evaluations` RENAME TO `config_evaluations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `config_evaluations_source_created_idx` ON `config_evaluations` (`source_id`,`created_at`);