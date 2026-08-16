import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { MemorySyncRepository } from "../src/sync-repository.js";

const accountA="11111111-1111-4111-8111-111111111111";
const accountB="22222222-2222-4222-8222-222222222222";
const deviceA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const deviceB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const entityId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const mutationId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function testApp(){
  const repository=new MemorySyncRepository();
  const app=buildApp({repository,verifyAccessToken:async accessToken=>{
    if(accessToken==="token-a")return {accountId:accountA,accessToken};
    if(accessToken==="token-b")return {accountId:accountB,accessToken};
    throw new Error("invalid token");
  }});
  return {app,repository};
}

function auth(token="token-a"){return {authorization:`Bearer ${token}`};}
function devicePayload(deviceId=deviceA){return {deviceId,publicKey:"P".repeat(43),signingPublicKey:"S".repeat(43),displayName:"Alex's computer",platform:"windows-x64"};}
function mutation(accountId=accountA,deviceId=deviceA){return {mutationId,accountId,deviceId,logicalTimestamp:`1723478400000-0000000000-${deviceId}`,entityId,entityType:"task",nonce:"N".repeat(32),ciphertext:"C".repeat(64),schemaVersion:2,tombstone:false};}

test("account routes reject missing and invalid access tokens",async()=>{
  const {app}=testApp();
  assert.equal((await app.inject({method:"POST",url:"/v1/devices/register",payload:devicePayload()})).statusCode,401);
  assert.equal((await app.inject({method:"POST",url:"/v1/devices/register",headers:auth("invalid"),payload:devicePayload()})).statusCode,401);
  await app.close();
});

test("device identity is derived from the verified account token",async()=>{
  const {app,repository}=testApp();
  const response=await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:{...devicePayload(),accountId:accountB}});
  assert.equal(response.statusCode,201);
  assert.equal(response.json().accountId,accountA);
  assert.equal(repository.devices.get(`${accountA}:${deviceA}`)?.accountId,accountA);
  assert.equal(repository.devices.has(`${accountB}:${deviceA}`),false);
  await app.close();
});

test("sync accepts only opaque mutations from an authorized account device",async()=>{
  const {app}=testApp();
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload()});
  const malformed=await app.inject({method:"POST",url:"/v1/sync/push",headers:auth(),payload:{mutations:[{ciphertext:"readable homework"}]}});
  assert.equal(malformed.statusCode,400);
  const crossAccount=await app.inject({method:"POST",url:"/v1/sync/push",headers:auth(),payload:{mutations:[mutation(accountB)]}});
  assert.equal(crossAccount.statusCode,403);
  const unregistered=await app.inject({method:"POST",url:"/v1/sync/push",headers:auth(),payload:{mutations:[mutation(accountA,deviceB)]}});
  assert.equal(unregistered.statusCode,403);
  await app.close();
});

test("sync push is idempotent and rejects mutation ID ciphertext substitution",async()=>{
  const {app}=testApp();
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload()});
  const first=await app.inject({method:"POST",url:"/v1/sync/push",headers:auth(),payload:{mutations:[mutation()]}});
  const duplicate=await app.inject({method:"POST",url:"/v1/sync/push",headers:auth(),payload:{mutations:[mutation()]}});
  const substituted=await app.inject({method:"POST",url:"/v1/sync/push",headers:auth(),payload:{mutations:[{...mutation(),ciphertext:"X".repeat(64)}]}});
  assert.deepEqual(first.json(),{accepted:1,cursor:"1"});
  assert.deepEqual(duplicate.json(),{accepted:0,cursor:"1"});
  assert.equal(substituted.statusCode,409);
  await app.close();
});

test("sync pull isolates accounts and advances a stable cursor",async()=>{
  const {app}=testApp();
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload()});
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth("token-b"),payload:devicePayload(deviceB)});
  await app.inject({method:"POST",url:"/v1/sync/push",headers:auth(),payload:{mutations:[mutation()]}});
  await app.inject({method:"POST",url:"/v1/sync/push",headers:auth("token-b"),payload:{mutations:[{...mutation(accountB,deviceB),mutationId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}]}});
  const accountAPull=await app.inject({method:"GET",url:"/v1/sync/pull?cursor=0",headers:{...auth(),"x-student-center-device-id":deviceA}});
  const accountBPull=await app.inject({method:"GET",url:"/v1/sync/pull?cursor=0",headers:{...auth("token-b"),"x-student-center-device-id":deviceB}});
  assert.equal(accountAPull.json().mutations.length,1);
  assert.equal(accountAPull.json().mutations[0].accountId,accountA);
  assert.equal(accountBPull.json().mutations.length,1);
  assert.equal(accountBPull.json().mutations[0].accountId,accountB);
  const afterCursor=await app.inject({method:"GET",url:`/v1/sync/pull?cursor=${accountAPull.json().cursor}`,headers:{...auth(),"x-student-center-device-id":deviceA}});
  assert.deepEqual(afterCursor.json().mutations,[]);
  await app.close();
});

test("signed approval authorizes a pending device and revocation is immediate",async()=>{
  const {app}=testApp();
  const {privateKey,publicKey}=generateKeyPairSync("ed25519");
  const signingPublicKey=publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64url");
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:{...devicePayload(),signingPublicKey}});
  const pendingRegistration=await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload(deviceB)});
  assert.equal(pendingRegistration.json().authorized,false);
  const pending=await app.inject({method:"GET",url:"/v1/devices/pending",headers:{...auth(),"x-student-center-device-id":deviceA}});
  assert.equal(pending.json().devices.length,1);
  const createdAt=new Date().toISOString();
  const expiresAt=new Date(Date.now()+60_000).toISOString();
  const unsigned={envelopeId:"ffffffff-ffff-4fff-8fff-ffffffffffff",targetDeviceId:deviceB,senderDeviceId:deviceA,encryptedAccountKey:"E".repeat(64),createdAt,expiresAt};
  const signature=sign(null,Buffer.from(JSON.stringify(unsigned)),privateKey).toString("base64url");
  const approved=await app.inject({method:"POST",url:`/v1/devices/${deviceB}/approve`,headers:auth(),payload:{...unsigned,signature}});
  assert.equal(approved.statusCode,200);
  const delivered=await app.inject({method:"GET",url:"/v1/devices/envelopes",headers:{...auth(),"x-student-center-device-id":deviceB}});
  assert.equal(delivered.statusCode,200);
  assert.equal(delivered.json().envelopes[0].envelopeId,unsigned.envelopeId);
  assert.equal(delivered.json().envelopes[0].senderSigningPublicKey,signingPublicKey);
  const authorized=await app.inject({method:"GET",url:"/v1/devices",headers:{...auth(),"x-student-center-device-id":deviceA}});
  assert.deepEqual(authorized.json().devices.map((device:{deviceId:string})=>device.deviceId),[deviceA,deviceB]);
  assert.equal((await app.inject({method:"POST",url:"/v1/sync/push",headers:auth(),payload:{mutations:[mutation(accountA,deviceB)]}})).statusCode,200);
  assert.equal((await app.inject({method:"DELETE",url:`/v1/devices/${deviceB}`,headers:{...auth(),"x-student-center-device-id":deviceA}})).statusCode,200);
  assert.equal((await app.inject({method:"POST",url:"/v1/sync/push",headers:auth(),payload:{mutations:[{...mutation(accountA,deviceB),mutationId:"12121212-1212-4121-8121-121212121212"}]}})).statusCode,403);
  await app.close();
});

test("encrypted objects verify bounded chunks and revoked devices lose access",async()=>{
  const {app}=testApp();
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload()});
  const deviceHeaders={...auth(),"x-student-center-device-id":deviceA};
  const documentId="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const bytes=Buffer.from("opaque encrypted document bytes");
  const ciphertext=bytes.toString("base64url");
  const sha256=createHash("sha256").update(bytes).digest("hex");
  const manifest={documentId,encryptedMetadata:"M".repeat(64),chunkHashes:[sha256],wrappedObjectKey:"K".repeat(64),version:1};
  const initiated=await app.inject({method:"POST",url:"/v1/objects/initiate",headers:deviceHeaders,payload:manifest});
  assert.deepEqual(initiated.json().missingChunks,[0]);
  assert.equal((await app.inject({method:"PUT",url:`/v1/objects/${documentId}/chunks/0`,headers:deviceHeaders,payload:{ciphertext,sha256}})).statusCode,200);
  const resumed=await app.inject({method:"POST",url:"/v1/objects/initiate",headers:deviceHeaders,payload:manifest});
  assert.deepEqual(resumed.json().missingChunks,[]);
  assert.equal((await app.inject({method:"POST",url:"/v1/objects/complete",headers:deviceHeaders,payload:{documentId}})).statusCode,200);
  const downloaded=await app.inject({method:"GET",url:`/v1/objects/${documentId}/download`,headers:deviceHeaders});
  assert.equal(downloaded.statusCode,200);
  assert.equal(downloaded.json().chunks[0].ciphertext,ciphertext);
  assert.equal((await app.inject({method:"DELETE",url:`/v1/devices/${deviceA}`,headers:deviceHeaders})).statusCode,200);
  assert.equal((await app.inject({method:"GET",url:"/v1/sync/pull?cursor=0",headers:deviceHeaders})).statusCode,403);
  assert.equal((await app.inject({method:"GET",url:`/v1/objects/${documentId}/download`,headers:deviceHeaders})).statusCode,403);
  await app.close();
});

test("managed AI requires both an authenticated account and server credentials",async()=>{
  const {app}=testApp();
  const response=await app.inject({method:"POST",url:"/v1/ai/structure",headers:auth(),payload:{capability:"brain_dump",excerpt:"finish paper",locale:"en-US"}});
  assert.equal(response.statusCode,503);
  await app.close();
});

test("managed AI accepts only a complete strict review schema",async()=>{
  const providerOutputs=[
    JSON.stringify({candidates:[{kind:"task",title:"Draft introduction",course:null,durationMinutes:30,dueAt:null,startsAt:null,endsAt:null,evidence:"draft the introduction",confidence:0.9,warnings:[]}],explanation:null}),
    JSON.stringify({candidates:[{kind:"task",title:"Missing evidence",course:null,durationMinutes:30,dueAt:null,startsAt:null,endsAt:null,confidence:0.9,warnings:[]}],explanation:null})
  ];
  const app=buildApp({
    repository:new MemorySyncRepository(),
    verifyAccessToken:async accessToken=>({accountId:accountA,accessToken}),
    aiProvider:async()=>({outputText:providerOutputs.shift()!,model:"test-model",inputTokens:3,outputTokens:4})
  });
  const valid=await app.inject({method:"POST",url:"/v1/ai/structure",headers:auth(),payload:{capability:"brain_dump",excerpt:"I need to draft the introduction",locale:"en-US"}});
  assert.equal(valid.statusCode,200);
  assert.equal(valid.json().reviewRequired,true);
  assert.equal(valid.json().candidates.length,1);
  assert.deepEqual(valid.json().usage,{inputTokens:3,outputTokens:4});
  const invalid=await app.inject({method:"POST",url:"/v1/ai/structure",headers:auth(),payload:{capability:"brain_dump",excerpt:"finish paper",locale:"en-US"}});
  assert.equal(invalid.statusCode,502);
  await app.close();
});

test("managed AI maps quota and timeout failures without exposing provider details",async()=>{
  const failures=[Object.assign(new Error("secret quota response"),{status:429}),Object.assign(new Error("secret timeout response"),{name:"APIConnectionTimeoutError"})];
  const app=buildApp({
    repository:new MemorySyncRepository(),
    verifyAccessToken:async accessToken=>({accountId:accountA,accessToken}),
    aiProvider:async()=>{throw failures.shift()!;}
  });
  const request={method:"POST" as const,url:"/v1/ai/structure",headers:auth(),payload:{capability:"brain_dump",excerpt:"private student excerpt",locale:"en-US"}};
  const quota=await app.inject(request);
  assert.equal(quota.statusCode,429);
  assert.equal(JSON.stringify(quota.json()).includes("secret"),false);
  const timeout=await app.inject(request);
  assert.equal(timeout.statusCode,504);
  assert.equal(JSON.stringify(timeout.json()).includes("secret"),false);
  await app.close();
});
