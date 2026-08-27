import { z } from "zod";

const opaqueBase64Url = z.string().min(32).max(16_000_000).regex(/^[A-Za-z0-9_-]+={0,2}$/);

export const DeviceRegistration = z.object({
  deviceId:z.string().uuid(),
  publicKey:opaqueBase64Url.max(2048),
  signingPublicKey:opaqueBase64Url.max(2048),
  displayName:z.string().trim().min(1).max(100),
  platform:z.enum(["windows-x64","macos-arm64"]),
  requestApproval:z.boolean().default(false)
});
export type DeviceRegistration = z.infer<typeof DeviceRegistration>;

/** A raw 64-byte Ed25519 signature, base64url without padding. */
const ed25519Signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);

export const EncryptedMutation = z.object({
  mutationId:z.string().uuid(), accountId:z.string().uuid(), deviceId:z.string().uuid(),
  logicalTimestamp:z.string().regex(/^\d{13}-\d{10}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), entityId:z.string().uuid(), entityType:z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  nonce:opaqueBase64Url.max(128), ciphertext:opaqueBase64Url, schemaVersion:z.literal(3), signature:ed25519Signature, tombstone:z.boolean().default(false)
});
export type EncryptedMutation = z.infer<typeof EncryptedMutation>;

/**
 * The exact bytes a device signs when it authors an encrypted mutation.
 *
 * Authorship cannot rest on the AEAD alone: the associated data is authenticated under the shared
 * ACCOUNT key, so any device holding it could re-encrypt different plaintext under another device's
 * metadata. The signature therefore covers the routing metadata AND the nonce and ciphertext.
 *
 * This lives beside the schema so the field order cannot drift away from it. The Rust signer builds
 * the same JSON via serde field order; a golden vector on both sides fails loudly if either moves.
 */
export function encryptedMutationSigningMessage(mutation:Omit<EncryptedMutation,"signature">):string{
  return JSON.stringify({
    aad:{
      protocol:"student-center.encrypted-mutation.v3",
      mutationId:mutation.mutationId,
      accountId:mutation.accountId,
      deviceId:mutation.deviceId,
      logicalTimestamp:mutation.logicalTimestamp,
      entityId:mutation.entityId,
      entityType:mutation.entityType,
      schemaVersion:mutation.schemaVersion,
      tombstone:mutation.tombstone
    },
    nonce:mutation.nonce,
    ciphertext:mutation.ciphertext
  });
}

export const EncryptedObjectManifest = z.object({
  documentId:z.string().uuid(), encryptedMetadata:opaqueBase64Url, chunkHashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10_000),
  wrappedObjectKey:opaqueBase64Url.max(4096), version:z.number().int().positive().max(10_000)
});
export type EncryptedObjectManifest = z.infer<typeof EncryptedObjectManifest>;
export const EncryptedObjectChunk = z.object({
  documentId:z.string().uuid(), index:z.number().int().min(0).max(9_999), ciphertext:opaqueBase64Url.max(8_000_000), sha256:z.string().regex(/^[a-f0-9]{64}$/)
});
export type EncryptedObjectChunk = z.infer<typeof EncryptedObjectChunk>;

export const DeviceEnvelope = z.object({
  envelopeId:z.string().uuid(), targetDeviceId:z.string().uuid(), senderDeviceId:z.string().uuid(), encryptedAccountKey:opaqueBase64Url.max(4096),
  signature:ed25519Signature, createdAt:z.string().datetime(), expiresAt:z.string().datetime()
});
export type DeviceEnvelope = z.infer<typeof DeviceEnvelope>;

export const SyncCursor = z.string().regex(/^\d{1,20}$/);
export const SyncPush = z.object({ cursor:SyncCursor.optional(), mutations:z.array(EncryptedMutation).min(1).max(1000) });
/** 8 MiB of image, expressed as the base64 length that carries it. */
const MAX_IMAGE_BASE64 = Math.ceil((8*1024*1024)/3)*4;
/**
 * An image sent alongside the excerpt, never instead of it.
 *
 * A schedule screenshot has no text for `evidence` to be a substring of, which
 * is why the desktop app OCRs it locally first and sends that text as the
 * excerpt. The model groups text we already hold; it does not read pixels
 * unsupervised. That is what lets this exist without loosening the grounding
 * check in managed_ai.rs.
 */
export const AiImage = z.object({
  mimeType:z.enum(["image/png","image/jpeg"]),
  // Deliberately not z.string().base64(): Zod's base64 pattern groups in fours
  // and recurses once per group, so an 11 MB payload — the largest this field
  // legally holds — overflows the stack and turns a 400 into a 500. A plain
  // character class is linear and answers the same question.
  data:z.string().min(1).max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/]*={0,2}$/,"expected base64")
}).strict();
export type AiImage = z.infer<typeof AiImage>;

export const AiStructureRequest = z.object({
  capability:z.enum(["brain_dump","document_extraction","task_decomposition","planner_explanation"]),
  excerpt:z.string().trim().min(1).max(12_000),
  locale:z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).default("en-US"),
  image:AiImage.optional()
});
/** `HH:MM` on a 24-hour clock. A class recurs, so it has no single instant. */
const localClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const AiCandidate = z.object({
  kind:z.enum(["task","commitment","assignment","exam","class_meeting","academic_event"]),
  title:z.string().trim().min(1).max(240),
  course:z.string().trim().max(200).nullable().transform(value=>value??undefined),
  durationMinutes:z.number().int().min(5).max(480).nullable().transform(value=>value??undefined),
  dueAt:z.string().datetime({offset:true}).nullable().transform(value=>value??undefined),
  startsAt:z.string().datetime({offset:true}).nullable().transform(value=>value??undefined),
  endsAt:z.string().datetime({offset:true}).nullable().transform(value=>value??undefined),
  evidence:z.string().trim().min(1).max(2_000),
  confidence:z.number().min(0).max(1),
  warnings:z.array(z.string().trim().min(1).max(300)).max(20),
  // The weekly half. 0 = Sunday, matching DAY_INDEX in the catalog scripts and
  // weekly_pattern in imports.rs. Defaulted so a desktop build that predates
  // these fields still parses a response carrying them.
  weekdays:z.array(z.number().int().min(0).max(6)).max(7).default([]),
  startsAtLocal:localClock.nullable().default(null).transform(value=>value??undefined),
  endsAtLocal:localClock.nullable().default(null).transform(value=>value??undefined),
  location:z.string().trim().min(1).max(200).nullable().default(null).transform(value=>value??undefined),
  component:z.string().trim().min(1).max(200).nullable().default(null).transform(value=>value??undefined),
  modality:z.string().trim().min(1).max(200).nullable().default(null).transform(value=>value??undefined),
  sectionNumber:z.string().trim().min(1).max(200).nullable().default(null).transform(value=>value??undefined)
}).superRefine((value,context)=>{
  const fail=(message:string)=>context.addIssue({code:z.ZodIssueCode.custom,message});
  const weekly=value.weekdays.length>0||value.startsAtLocal!==undefined||value.endsAtLocal!==undefined;
  // A task carrying weekdays would have them dropped on the way into the review
  // queue, and a silent drop is a class the student never sees again.
  if(weekly&&value.kind!=="class_meeting")fail("only a class_meeting carries a weekly pattern");
  if(new Set(value.weekdays).size!==value.weekdays.length)fail("weekdays must be a unique set");
  // Half a time range is not a class time.
  if((value.startsAtLocal===undefined)!==(value.endsAtLocal===undefined))fail("a class needs both a start and an end");
  if(value.startsAtLocal!==undefined&&value.endsAtLocal!==undefined&&value.startsAtLocal>=value.endsAtLocal){
    fail("a class must start before it ends");
  }
  // An asynchronous online section legitimately meets on no weekday, but it has
  // to say so rather than simply omitting the days.
  if(value.kind==="class_meeting"&&!value.weekdays.length&&value.modality?.toLowerCase()!=="online"){
    fail("a class_meeting needs weekdays unless it is marked online");
  }
});
export const AiStructureResult = z.object({
  candidates:z.array(AiCandidate).max(100),
  explanation:z.string().trim().min(1).max(4_000).nullable().transform(value=>value??undefined)
}).superRefine((value,context)=>{
  if(!value.candidates.length&&!value.explanation)context.addIssue({code:z.ZodIssueCode.custom,message:"AI output contains no reviewable result"});
});
export type AiStructureRequest = z.infer<typeof AiStructureRequest>;
export type AiCandidate = z.infer<typeof AiCandidate>;
export type AiStructureResult = z.infer<typeof AiStructureResult>;

export const AiProviderId = z.enum(["openai", "anthropic", "gemini"]);
export type AiProviderId = z.infer<typeof AiProviderId>;

export const AiCapability = z.enum([
  "brain_dump",
  "document_extraction",
  "schedule_vision",
  "task_decomposition",
  "planner_explanation",
  "source_qa",
  "study_guide",
  "flashcards",
  "practice_questions",
  "practice_test",
]);
export type AiCapability = z.infer<typeof AiCapability>;

export const AiCapabilityRequirements = z.object({
  text:z.boolean(), image:z.boolean(), structuredOutput:z.boolean(), streaming:z.boolean(),
  minimumContextTokens:z.number().int().positive().optional()
});
export type AiCapabilityRequirements = z.infer<typeof AiCapabilityRequirements>;

export const AiProviderStatus = z.object({
  provider:AiProviderId, connected:z.boolean(), healthy:z.boolean(), model:z.string(),
  maskedKey:z.string().optional(), capabilities:z.array(AiCapability), lastCheckedAt:z.string().datetime().optional(),
  disclosureUrl:z.string().url()
});
export type AiProviderStatus = z.infer<typeof AiProviderStatus>;

export const AiRoutingPreference = z.object({ order:z.array(AiProviderId).length(3) });
export type AiRoutingPreference = z.infer<typeof AiRoutingPreference>;

export const AiUsageSummary = z.object({
  provider:AiProviderId, model:z.string(), requests:z.number().int().nonnegative(),
  failures:z.number().int().nonnegative(), inputTokens:z.number().int().nonnegative(),
  outputTokens:z.number().int().nonnegative(), averageLatencyMs:z.number().nonnegative()
});
export type AiUsageSummary = z.infer<typeof AiUsageSummary>;

export const AiInvocationResult = z.object({
  invocationId:z.string().uuid(), provider:AiProviderId, model:z.string(), capability:AiCapability,
  status:z.enum(["review_created","artifact_created","explanation_created","failed"]),
  inputTokens:z.number().int().nonnegative(), outputTokens:z.number().int().nonnegative(),
  latencyMs:z.number().int().nonnegative(), errorCategory:z.string().optional()
});
export type AiInvocationResult = z.infer<typeof AiInvocationResult>;

export const CanvasCalendarConnection = z.object({
  id:z.string().uuid(), origin:z.string().url(), label:z.string(), status:z.string(),
  credentialRef:z.string(),
  refreshOnStartup:z.boolean(), lastRefreshedAt:z.string().datetime().optional(),
  nextEligibleRefreshAt:z.string().datetime().optional(), lastError:z.string().optional(),
  pendingCandidates:z.number().int().nonnegative()
});
export type CanvasCalendarConnection = z.infer<typeof CanvasCalendarConnection>;

export const SourceRetentionDecision = z.enum(["keep_encrypted", "delete_now"]);
export type SourceRetentionDecision = z.infer<typeof SourceRetentionDecision>;

export const ScheduleCandidate = z.object({
  id:z.string(), sourceId:z.string(), courseName:z.string().min(1), courseCode:z.string().optional(),
  section:z.string().optional(), weekdays:z.array(z.number().int().min(0).max(6)).max(7),
  startsAtLocal:localClock.optional(), endsAtLocal:localClock.optional(), location:z.string().optional(),
  modality:z.string().optional(), termStartsOn:z.string().date().optional(), termEndsOn:z.string().date().optional(),
  termId:z.string().uuid().optional(),
  confidence:z.number().min(0).max(1), evidence:z.string().min(1), warnings:z.array(z.string()),
  action:z.enum(["add","update","ignore","resolve_conflict"]).optional()
});
export type ScheduleCandidate = z.infer<typeof ScheduleCandidate>;

export const FieldProvenance = z.object({
  sourceKind:z.string().min(1), sanitizedSourceIdentifier:z.string().min(1),
  externalStableId:z.string().optional(), evidence:z.string(), confidence:z.number().min(0).max(1),
  importTime:z.string().datetime({offset:true}), studentEdited:z.boolean(),
  lastObservedSourceValue:z.string().optional()
});
export type FieldProvenance = z.infer<typeof FieldProvenance>;

export const ExternalCalendarCandidate = z.object({
  stableId:z.string().min(1), recurrenceInstanceId:z.string().optional(), kind:z.enum(["class","commitment","assignment","exam"]),
  title:z.string().min(1), startsAt:z.string().datetime({offset:true}).optional(), endsAt:z.string().datetime({offset:true}).optional(),
  dueAt:z.string().datetime({offset:true}).optional(), evidence:z.string().min(1), confidence:z.number().min(0).max(1)
});
export type ExternalCalendarCandidate = z.infer<typeof ExternalCalendarCandidate>;

export const ScheduleImportSession = z.object({
  id:z.string().uuid(), sourceKind:z.enum(["canvas_calendar","screenshot","pdf","ics","document","manual"]),
  status:z.enum(["analyzing","review","applied","cancelled","settled","failed"]), candidateIds:z.array(z.string()),
  conflictIds:z.array(z.string()), startedAt:z.string().datetime(), settledAt:z.string().datetime().optional(),
  retentionDecision:SourceRetentionDecision.optional()
});
export type ScheduleImportSession = z.infer<typeof ScheduleImportSession>;

export const ImportConflict = z.object({
  id:z.string(), candidateId:z.string().optional(), field:z.string(), currentValue:z.string().optional(),
  proposedValue:z.string().optional(), resolution:z.enum(["keep_existing", "use_source"]).optional()
});
export type ImportConflict = z.infer<typeof ImportConflict>;

// The bundled school descriptor. Kept in its own module because it mirrors a
// resource file rather than a wire format, and because the Rust side is a
// separate module for the same reason.
export * from "./school-provider.js";
