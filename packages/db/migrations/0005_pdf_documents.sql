CREATE TABLE `pdf_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`crawl_run_id` integer,
	`url` text NOT NULL,
	`extracted_count` integer NOT NULL,
	`extracted_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`crawl_run_id`) REFERENCES `crawl_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pdf_documents_source_url_unique` ON `pdf_documents` (`source_id`,`url`);