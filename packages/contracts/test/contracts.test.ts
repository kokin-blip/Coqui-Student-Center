import assert from "node:assert/strict";
import test from "node:test";
import { AiStructureResult, EncryptedMutation, encryptedMutationSigningMessage } from "../src/index.js";

/**
 * Fixed envelope shared with the Rust golden-vector test in sync_transport.rs. The signing message
 * is a cross-language contract: if either side reorders a field, the bytes change, every signature
 * stops verifying, and sync breaks silently. Both sides pin these exact bytes so drift fails loudly.
 *
 * Keep this in lockstep with GOLDEN_SIGNING_MESSAGE in apps/desktop/src-tauri/src/sync_transport.rs.
 */
const goldenEnvelope={
  mutationId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  accountId:"11111111-1111-4111-8111-111111111111",
  deviceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  logicalTimestamp:"1723478400000-0000000000-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entityId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  entityType:"task",
  nonce:"N".repeat(32),
  ciphertext:"C".repeat(64),
  schemaVersion:3 as const,
  tombstone:false
};
const GOLDEN_SIGNING_MESSAGE='{"aad":{"protocol":"student-center.encrypted-mutation.v3","mutationId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","accountId":"11111111-1111-4111-8111-111111111111","deviceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","logicalTimestamp":"1723478400000-0000000000-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","entityId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","entityType":"task","schemaVersion":3,"tombstone":false},"nonce":"NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN","ciphertext":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"}';

test("the mutation signing message matches the cross-language golden vector",()=>{
  assert.equal(encryptedMutationSigningMessage(goldenEnvelope),GOLDEN_SIGNING_MESSAGE);
});

test("the signing message covers the ciphertext, not only the routing metadata",()=>{
  // The AEAD binds metadata under the SHARED account key, so a sibling device could otherwise
  // re-encrypt different plaintext under the same metadata and reuse the original signature.
  const tampered=encryptedMutationSigningMessage({...goldenEnvelope,ciphertext:"X".repeat(64)});
  assert.notEqual(tampered,GOLDEN_SIGNING_MESSAGE);
  const reattributed=encryptedMutationSigningMessage({...goldenEnvelope,deviceId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"});
  assert.notEqual(reattributed,GOLDEN_SIGNING_MESSAGE);
});

test("a v2 envelope and a malformed signature are both refused",()=>{
  const {mutationId,accountId,deviceId,logicalTimestamp,entityId,entityType,nonce,ciphertext,tombstone}=goldenEnvelope;
  const base={mutationId,accountId,deviceId,logicalTimestamp,entityId,entityType,nonce,ciphertext,tombstone,signature:"G".repeat(86)};
  assert.equal(EncryptedMutation.safeParse({...base,schemaVersion:2}).success,false,"unsigned v2 envelopes must not be accepted");
  assert.equal(EncryptedMutation.safeParse({...base,schemaVersion:3}).success,true);
  assert.equal(EncryptedMutation.safeParse({...base,schemaVersion:3,signature:"G".repeat(85)}).success,false);
  const {signature:_,...unsigned}=base;
  assert.equal(EncryptedMutation.safeParse({...unsigned,schemaVersion:3}).success,false,"a missing signature must not be accepted");
});

test("sync rejects readable or undersized payloads",()=>{
  const deviceId=crypto.randomUUID();
  const result=EncryptedMutation.safeParse({mutationId:crypto.randomUUID(),accountId:crypto.randomUUID(),deviceId,logicalTimestamp:`0000000000001-0000000000-${deviceId}`,entityId:crypto.randomUUID(),entityType:"task",nonce:"short",ciphertext:"my homework",schemaVersion:2,tombstone:false});
  assert.equal(result.success,false);
});

test("managed AI requires a complete bounded review result",()=>{
  const valid=AiStructureResult.safeParse({candidates:[{kind:"task",title:"Draft introduction",course:null,durationMinutes:30,dueAt:null,startsAt:null,endsAt:null,evidence:"draft the introduction",confidence:0.9,warnings:[]}],explanation:null});
  assert.equal(valid.success,true);
  const partial=AiStructureResult.safeParse({candidates:[{kind:"task",title:"Draft introduction",confidence:0.9,warnings:[]}],explanation:null});
  assert.equal(partial.success,false);
  const empty=AiStructureResult.safeParse({candidates:[],explanation:null});
  assert.equal(empty.success,false);
});
