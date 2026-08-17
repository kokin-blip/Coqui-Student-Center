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
export const AiStructureRequest = z.object({
  capability:z.enum(["brain_dump","document_extraction","task_decomposition","explanation"]),
  excerpt:z.string().trim().min(1).max(12_000),
  locale:z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).default("en-US")
});
export const AiCandidate = z.object({
  kind:z.enum(["task","commitment","assignment","exam"]),
  title:z.string().trim().min(1).max(240),
  course:z.string().trim().max(200).nullable().transform(value=>value??undefined),
  durationMinutes:z.number().int().min(5).max(480).nullable().transform(value=>value??undefined),
  dueAt:z.string().datetime({offset:true}).nullable().transform(value=>value??undefined),
  startsAt:z.string().datetime({offset:true}).nullable().transform(value=>value??undefined),
  endsAt:z.string().datetime({offset:true}).nullable().transform(value=>value??undefined),
  evidence:z.string().trim().min(1).max(2_000),
  confidence:z.number().min(0).max(1),
  warnings:z.array(z.string().trim().min(1).max(300)).max(20)
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
