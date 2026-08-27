import assert from "node:assert/strict";
import test from "node:test";
import { AiStructureRequest, AiStructureResult, EncryptedMutation, encryptedMutationSigningMessage, FieldProvenance } from "../src/index.js";

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

/**
 * The weekly half of the AI contract, mirrored three ways: this schema, the
 * JSON Schema handed to the model in services/cloud-api, and validate_response
 * in apps/desktop/src-tauri/src/managed_ai.rs. All three enforce the same rules
 * so that no single one of them is the only thing standing between a model and
 * a student's timetable.
 */
const classCandidate=(overrides:Record<string,unknown>={})=>({
  kind:"class_meeting",title:"Statistics 201",course:"STA 201",durationMinutes:null,
  dueAt:null,startsAt:null,endsAt:null,evidence:"STA 201 MWF 9:00",confidence:0.8,warnings:[],
  weekdays:[1,3,5],startsAtLocal:"09:00",endsAtLocal:"09:50",
  location:"COOR 174",component:"lecture",modality:"in-person",sectionNumber:"87991",
  ...overrides
});

test("managed AI accepts a weekly class meeting",()=>{
  const result=AiStructureResult.safeParse({candidates:[classCandidate()],explanation:null});
  assert.equal(result.success,true);
  assert.deepEqual(result.success?result.data.candidates[0].weekdays:[],[1,3,5]);
});

test("managed AI rejects a weekly pattern that could not describe a real class",()=>{
  const rejected=[
    classCandidate({weekdays:[7]}),
    classCandidate({weekdays:[1,1,3]}),
    classCandidate({startsAtLocal:"09:50",endsAtLocal:"09:00"}),
    classCandidate({startsAtLocal:"09:00",endsAtLocal:"09:00"}),
    classCandidate({startsAtLocal:"9:00"}),
    classCandidate({endsAtLocal:null}),
    // No days and no claim of being online.
    classCandidate({weekdays:[],startsAtLocal:null,endsAtLocal:null,modality:null}),
    // A task cannot carry a weekly pattern; it would be dropped on import.
    classCandidate({kind:"task"})
  ];
  for(const [index,candidate] of rejected.entries()){
    const result=AiStructureResult.safeParse({candidates:[candidate],explanation:null});
    assert.equal(result.success,false,`case ${index} was accepted`);
  }
});

// institution-catalogs.json already ships asynchronous online sections with no
// weekdays, so that shape has to stay legal — as long as it says so.
test("managed AI accepts an online class that meets on no weekday",()=>{
  const online=classCandidate({weekdays:[],startsAtLocal:null,endsAtLocal:null,modality:"online"});
  assert.equal(AiStructureResult.safeParse({candidates:[online],explanation:null}).success,true);
});

// The desktop app and the cloud service deploy separately, so a payload written
// before the weekly fields existed still has to parse.
test("a candidate without the weekly fields still parses",()=>{
  const older={kind:"task",title:"Draft",course:null,durationMinutes:null,dueAt:null,startsAt:null,endsAt:null,evidence:"draft",confidence:0.5,warnings:[]};
  const result=AiStructureResult.safeParse({candidates:[older],explanation:null});
  assert.equal(result.success,true);
  assert.deepEqual(result.success?result.data.candidates[0].weekdays:null,[]);
});

test("an attached image is bounded and typed, and never replaces the excerpt",()=>{
  const data=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).toString("base64");
  assert.equal(AiStructureRequest.safeParse({capability:"document_extraction",excerpt:"STA 201",locale:"en-US",image:{mimeType:"image/png",data}}).success,true);
  // The excerpt stays mandatory: the image is a layout aid for text we already
  // hold, not a second source.
  assert.equal(AiStructureRequest.safeParse({capability:"document_extraction",excerpt:"",locale:"en-US",image:{mimeType:"image/png",data}}).success,false);
  assert.equal(AiStructureRequest.safeParse({capability:"document_extraction",excerpt:"STA 201",locale:"en-US",image:{mimeType:"image/gif",data}}).success,false);
  assert.equal(AiStructureRequest.safeParse({capability:"document_extraction",excerpt:"STA 201",locale:"en-US",image:{mimeType:"image/png",data:"not base64!"}}).success,false);
  // An image is optional, and a request omitting it is unchanged from 0.9.2.
  assert.equal(AiStructureRequest.safeParse({capability:"brain_dump",excerpt:"finish paper",locale:"en-US"}).success,true);
});

// Zod's own base64 pattern groups in fours and recurses per group, so the
// largest legal payload overflowed the stack and turned a 400 into a 500.
test("an oversized image is rejected rather than crashing the parser",()=>{
  const oversized="A".repeat(12*1024*1024);
  const result=AiStructureRequest.safeParse({capability:"document_extraction",excerpt:"STA 201",locale:"en-US",image:{mimeType:"image/png",data:oversized}});
  assert.equal(result.success,false);
});

test("field provenance distinguishes source observation from a student edit",()=>{
  const result=FieldProvenance.safeParse({
    sourceKind:"canvas_calendar",
    sanitizedSourceIdentifier:"canvas-calendar-source:connection-id",
    externalStableId:"canvas-calendar:event-uid:instance",
    evidence:"SUMMARY:Midterm Exam",
    confidence:0.92,
    importTime:"2026-08-25T12:00:00Z",
    studentEdited:true,
    lastObservedSourceValue:"2026-09-03T19:00:00Z"
  });
  assert.equal(result.success,true);
});
