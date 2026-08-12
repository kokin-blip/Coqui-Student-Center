import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  version: integer("version").notNull().default(1),
};

export const students = sqliteTable("students", {
  id: text("id").primaryKey(),
  authUserId: text("auth_user_id").notNull(),
  displayName: text("display_name").notNull(),
  timezone: text("timezone").notNull(),
  ...timestamps,
}, table => [uniqueIndex("idx_students_auth_user_id").on(table.authUserId)]);

export const studentPreferences = sqliteTable("student_preferences", {
  id: text("id").primaryKey(),
  studentId: text("student_id").notNull().references(()=>students.id, { onDelete:"cascade" }),
  dayStartHour: integer("day_start_hour").notNull().default(8),
  dayEndHour: integer("day_end_hour").notNull().default(21),
  sleepTargetMinutes: integer("sleep_target_minutes").notNull().default(480),
  maxSessionMinutes: integer("max_session_minutes").notNull().default(60),
  transitionMinutes: integer("transition_minutes").notNull().default(15),
  ...timestamps,
}, table => [uniqueIndex("idx_student_preferences_student").on(table.studentId)]);

export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(), studentId:text("student_id").notNull().references(()=>students.id,{onDelete:"cascade"}),
  externalId:text("external_id"), name:text("name").notNull(), code:text("code"), termId:text("term_id"), color:text("color"),
  ...timestamps,
}, table => [index("idx_courses_student").on(table.studentId)]);

export const tasks = sqliteTable("tasks", {
  id:text("id").primaryKey(), studentId:text("student_id").notNull().references(()=>students.id,{onDelete:"cascade"}), courseId:text("course_id").references(()=>courses.id,{onDelete:"set null"}),
  title:text("title").notNull(), kind:text("kind").notNull(), status:text("status").notNull().default("pending"), dueAt:text("due_at"), earliestStart:text("earliest_start"), durationMinutes:integer("duration_minutes").notNull(), priority:integer("priority").notNull().default(3), energy:text("energy").notNull().default("medium"), splittable:integer("splittable",{mode:"boolean"}).notNull().default(true), sourceEdited:integer("source_edited",{mode:"boolean"}).notNull().default(false),
  ...timestamps,
}, table => [index("idx_tasks_student_status_due").on(table.studentId,table.status,table.dueAt)]);

export const commitments = sqliteTable("commitments", {
  id:text("id").primaryKey(), studentId:text("student_id").notNull().references(()=>students.id,{onDelete:"cascade"}), title:text("title").notNull(), kind:text("kind").notNull(), startsAt:text("starts_at").notNull(), endsAt:text("ends_at").notNull(), recurrenceRule:text("recurrence_rule"), locked:integer("locked",{mode:"boolean"}).notNull().default(true),
  ...timestamps,
}, table => [index("idx_commitments_student_start").on(table.studentId,table.startsAt)]);

export const plans = sqliteTable("plans", {
  id:text("id").primaryKey(), studentId:text("student_id").notNull().references(()=>students.id,{onDelete:"cascade"}), horizonStart:text("horizon_start").notNull(), horizonEnd:text("horizon_end").notNull(), trigger:text("trigger").notNull(), status:text("status").notNull().default("active"),
  ...timestamps,
}, table => [index("idx_plans_student_created").on(table.studentId,table.createdAt)]);

export const planBlocks = sqliteTable("plan_blocks", {
  id:text("id").primaryKey(), planId:text("plan_id").notNull().references(()=>plans.id,{onDelete:"cascade"}), taskId:text("task_id").references(()=>tasks.id,{onDelete:"set null"}), title:text("title").notNull(), startsAt:text("starts_at").notNull(), endsAt:text("ends_at").notNull(), reasonCodes:text("reason_codes").notNull(), locked:integer("locked",{mode:"boolean"}).notNull().default(false), completed:integer("completed",{mode:"boolean"}).notNull().default(false),
  ...timestamps,
}, table => [index("idx_plan_blocks_plan_start").on(table.planId,table.startsAt)]);

export const importRuns = sqliteTable("import_runs", {
  id:text("id").primaryKey(), studentId:text("student_id").notNull().references(()=>students.id,{onDelete:"cascade"}), sourceKind:text("source_kind").notNull(), sourceName:text("source_name").notNull(), status:text("status").notNull(), observedAt:text("observed_at").notNull(), errorCode:text("error_code"),
  ...timestamps,
}, table => [index("idx_import_runs_student_created").on(table.studentId,table.createdAt)]);

export const importCandidates = sqliteTable("import_candidates", {
  id:text("id").primaryKey(), importRunId:text("import_run_id").notNull().references(()=>importRuns.id,{onDelete:"cascade"}), kind:text("kind").notNull(), normalizedPayload:text("normalized_payload").notNull(), evidence:text("evidence").notNull(), confidence:real("confidence").notNull(), warnings:text("warnings").notNull().default("[]"), status:text("status").notNull().default("pending"), canonicalId:text("canonical_id"),
  ...timestamps,
}, table => [index("idx_import_candidates_run_status").on(table.importRunId,table.status)]);

export const integrationConnections = sqliteTable("integration_connections", {
  id:text("id").primaryKey(), studentId:text("student_id").notNull().references(()=>students.id,{onDelete:"cascade"}), provider:text("provider").notNull(), baseUrl:text("base_url"), encryptedCredential:text("encrypted_credential"), status:text("status").notNull(), syncCursor:text("sync_cursor"), lastSyncedAt:text("last_synced_at"),
  ...timestamps,
}, table => [index("idx_connections_student_provider").on(table.studentId,table.provider)]);

export const domainEvents = sqliteTable("domain_events", {
  id:text("id").primaryKey(), studentId:text("student_id").notNull().references(()=>students.id,{onDelete:"cascade"}), type:text("type").notNull(), aggregateId:text("aggregate_id").notNull(), payload:text("payload").notNull(), occurredAt:text("occurred_at").notNull(), processedAt:text("processed_at"),
}, table => [index("idx_domain_events_unprocessed").on(table.processedAt,table.occurredAt)]);
