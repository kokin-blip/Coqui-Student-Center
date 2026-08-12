CREATE TABLE `commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`recurrence_rule` text,
	`locked` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_commitments_student_start` ON `commitments` (`student_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`external_id` text,
	`name` text NOT NULL,
	`code` text,
	`term_id` text,
	`color` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_courses_student` ON `courses` (`student_id`);--> statement-breakpoint
CREATE TABLE `domain_events` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload` text NOT NULL,
	`occurred_at` text NOT NULL,
	`processed_at` text,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_domain_events_unprocessed` ON `domain_events` (`processed_at`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `import_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`import_run_id` text NOT NULL,
	`kind` text NOT NULL,
	`normalized_payload` text NOT NULL,
	`evidence` text NOT NULL,
	`confidence` real NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`canonical_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`import_run_id`) REFERENCES `import_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_import_candidates_run_status` ON `import_candidates` (`import_run_id`,`status`);--> statement-breakpoint
CREATE TABLE `import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_name` text NOT NULL,
	`status` text NOT NULL,
	`observed_at` text NOT NULL,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_import_runs_student_created` ON `import_runs` (`student_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `integration_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`provider` text NOT NULL,
	`base_url` text,
	`encrypted_credential` text,
	`status` text NOT NULL,
	`sync_cursor` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_connections_student_provider` ON `integration_connections` (`student_id`,`provider`);--> statement-breakpoint
CREATE TABLE `plan_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`task_id` text,
	`title` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`reason_codes` text NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_plan_blocks_plan_start` ON `plan_blocks` (`plan_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`horizon_start` text NOT NULL,
	`horizon_end` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_plans_student_created` ON `plans` (`student_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `student_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`day_start_hour` integer DEFAULT 8 NOT NULL,
	`day_end_hour` integer DEFAULT 21 NOT NULL,
	`sleep_target_minutes` integer DEFAULT 480 NOT NULL,
	`max_session_minutes` integer DEFAULT 60 NOT NULL,
	`transition_minutes` integer DEFAULT 15 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_student_preferences_student` ON `student_preferences` (`student_id`);--> statement-breakpoint
CREATE TABLE `students` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`timezone` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_students_auth_user_id` ON `students` (`auth_user_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`course_id` text,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` text,
	`earliest_start` text,
	`duration_minutes` integer NOT NULL,
	`priority` integer DEFAULT 3 NOT NULL,
	`energy` text DEFAULT 'medium' NOT NULL,
	`splittable` integer DEFAULT true NOT NULL,
	`source_edited` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_student_status_due` ON `tasks` (`student_id`,`status`,`due_at`);