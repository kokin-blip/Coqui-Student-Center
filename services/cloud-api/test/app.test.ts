import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { encryptedMutationSigningMessage } from "@student-center/contracts";
import { buildApp } from "../src/app.js";
import { MemorySyncRepository } from "../src/sync-repository.js";

// One signing identity stands in for every device in these tests; the routes look the key up from
// the registration payload, so tests that care about authorship register this key explicitly.
const signing=generateKeyPairSync("ed25519");
const signingPublicKey=signing.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64url");
type Unsigned=Parameters<typeof encryptedMutationSigningMessage>[0];
function signMutation(unsigned:Unsigned){
  return {...unsigned,signature:sign(null,Buffer.from(encryptedMutationSigningMessage(unsigned)),signing.privateKey).toString("base64url")};
}
/** Re-sign a mutation after changing it: editing a signed envelope in place invalidates it. */
function reign(mutation:Unsigned&{signature:string},changes:Partial<Unsigned>){
  const {signature:_,...unsigned}=mutation;
  return signMutation({...unsigned,...changes});
}

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
function pushAuth(deviceId=deviceA,token="token-a"){return {...auth(token),"x-student-center-device-id":deviceId};}
function devicePayload(deviceId=deviceA){return {deviceId,publicKey:"P".repeat(43),signingPublicKey,displayName:"Alex's computer",platform:"windows-x64"};}
function mutation(accountId=accountA,deviceId=deviceA){return signMutation({mutationId,accountId,deviceId,logicalTimestamp:`1723478400000-0000000000-${deviceId}`,entityId,entityType:"task",nonce:"N".repeat(32),ciphertext:"C".repeat(64),schemaVersion:3,tombstone:false});}

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
  const malformed=await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[{ciphertext:"readable homework"}]}});
  assert.equal(malformed.statusCode,400);
  const crossAccount=await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[mutation(accountB)]}});
  assert.equal(crossAccount.statusCode,403);
  const unregistered=await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(deviceB),payload:{mutations:[mutation(accountA,deviceB)]}});
  assert.equal(unregistered.statusCode,403);
  await app.close();
});

test("push is refused without an authorized device header",async()=>{
  const {app}=testApp();
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload()});
  // The header identifies the pushing device; without it the server cannot attribute the write at all.
  const headerless=await app.inject({method:"POST",url:"/v1/sync/push",headers:auth(),payload:{mutations:[mutation()]}});
  assert.equal(headerless.statusCode,401);
  // A registered but still-pending device must not be able to append to the log.
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload(deviceB)});
  const pending=await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(deviceB),payload:{mutations:[mutation(accountA,deviceB)]}});
  assert.equal(pending.statusCode,403);
  // An authorized device may not author a mutation under a sibling device's ID.
  const spoofed=await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[mutation(accountA,deviceB)]}});
  assert.equal(spoofed.statusCode,403);
  await app.close();
});

test("a push batch mixing a revoked device's mutation is rejected whole",async()=>{
  const {app,repository}=testApp();
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload()});
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload(deviceB)});
  await app.inject({method:"DELETE",url:`/v1/devices/${deviceB}`,headers:pushAuth()});
  const mixed=await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[
    mutation(),
    reign(mutation(accountA,deviceB),{mutationId:"12121212-1212-4121-8121-121212121212"})
  ]}});
  assert.equal(mixed.statusCode,403);
  assert.equal(repository.mutations.length,0,"a rejected batch must not be partially stored");
  await app.close();
});

test("sync push is idempotent and rejects mutation ID ciphertext substitution",async()=>{
  const {app}=testApp();
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload()});
  const first=await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[mutation()]}});
  const duplicate=await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[mutation()]}});
  // Correctly signed, but reusing a mutation ID with different ciphertext: the log must refuse it.
  const substituted=await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[reign(mutation(),{ciphertext:"X".repeat(64)})]}});
  assert.deepEqual(first.json(),{accepted:1,cursor:"1"});
  assert.deepEqual(duplicate.json(),{accepted:0,cursor:"1"});
  assert.equal(substituted.statusCode,409);
  await app.close();
});

test("push refuses mutations that are not signed by the pushing device",async()=>{
  const {app}=testApp();
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload()});
  // Tampering with the ciphertext after signing must invalidate the signature: authorship covers
  // the payload, not just the routing metadata.
  const tampered=await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[{...mutation(),ciphertext:"X".repeat(64)}]}});
  assert.equal(tampered.statusCode,403);
  // A signature from a different key, even a well-formed one, is not this device's authorship.
  const stranger=generateKeyPairSync("ed25519");
  const {signature:_ignored,...unsigned}=mutation();
  const foreign={...mutation(),signature:sign(null,Buffer.from(encryptedMutationSigningMessage(unsigned)),stranger.privateKey).toString("base64url")};
  assert.equal((await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[foreign]}})).statusCode,403);
  // A malformed signature is rejected by the schema before it reaches any verification.
  assert.equal((await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[{...mutation(),signature:"tooshort"}]}})).statusCode,400);
  await app.close();
});

test("sync pull isolates accounts and advances a stable cursor",async()=>{
  const {app}=testApp();
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth(),payload:devicePayload()});
  await app.inject({method:"POST",url:"/v1/devices/register",headers:auth("token-b"),payload:devicePayload(deviceB)});
  await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(),payload:{mutations:[mutation()]}});
  await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(deviceB,"token-b"),payload:{mutations:[reign(mutation(accountB,deviceB),{mutationId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"})]}});
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
  assert.equal((await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(deviceB),payload:{mutations:[mutation(accountA,deviceB)]}})).statusCode,200);
  assert.equal((await app.inject({method:"DELETE",url:`/v1/devices/${deviceB}`,headers:{...auth(),"x-student-center-device-id":deviceA}})).statusCode,200);
  assert.equal((await app.inject({method:"POST",url:"/v1/sync/push",headers:pushAuth(deviceB),payload:{mutations:[reign(mutation(accountA,deviceB),{mutationId:"12121212-1212-4121-8121-121212121212"})]}})).statusCode,403);
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

// Recovery is entirely client-side (BIP-39 recovery code -> account key), so a server endpoint here
// is a false affordance implying a server-mediated protocol that does not exist.
test("there is no server-side recovery endpoint",async()=>{
  const {app}=testApp();
  const response=await app.inject({method:"POST",url:"/v1/devices/recovery",headers:auth(),payload:{}});
  assert.equal(response.statusCode,404);
  await app.close();
});
