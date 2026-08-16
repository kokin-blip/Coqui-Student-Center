import assert from "node:assert/strict";
import test from "node:test";
import { AiStructureResult, EncryptedMutation } from "../src/index.js";

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
