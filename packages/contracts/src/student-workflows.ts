import { z } from "zod";
/** Device-local workflow API v1; revisions provide optimistic concurrency. */
export const STUDENT_WORKFLOW_API_VERSION = 1;
// Existing local task/source IDs include prefixes (for example study-review:<id>).
const LocalRecordId = z.string().min(1).max(256);
export const CheckinSettings = z.object({enabled:z.boolean(),time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),followRhythm:z.boolean(),offerDismissed:z.boolean(),streakVisible:z.boolean()}).strict();
export const QuickNoteInput = z.object({id:z.string().uuid().nullish(),expectedRevision:z.number().int().nonnegative(),content:z.string().min(1).max(4000).refine(s=>Boolean(s.trim())),courseId:LocalRecordId.nullable(),taskId:LocalRecordId.nullable(),pinned:z.boolean()}).strict();
export const CheckinResponse = z.object({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),taskId:LocalRecordId,action:z.enum(["complete","in_progress","not_completed","rescheduled"]),expectedVersion:z.number().int().positive(),completedAt:z.string().datetime({offset:true}).nullable()}).strict();
export const PreparedStudyConsent = z.object({preparedId:z.string().uuid(),expectedProvider:z.enum(["openai","anthropic","gemini"]),expectedModel:z.string().min(1),consent:z.literal(true)}).strict();
export const StudyNoteInput = z.object({id:z.string().uuid().optional(),expectedRevision:z.number().int().nonnegative(),courseId:LocalRecordId,kind:z.enum(["notes","summary","outline","slides","source_qa","study_guide","flashcards","practice_questions","practice_test"]),title:z.string().trim().min(1).max(200),content:z.string().min(1).max(40000),tags:z.array(z.string().trim().min(1).max(60)).max(30),pinned:z.boolean(),sourceIds:z.array(LocalRecordId).max(100),previewId:z.string().uuid().optional()}).strict();
