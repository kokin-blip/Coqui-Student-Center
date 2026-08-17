/**
 * One case table, run against BOTH repository adapters.
 *
 * The unauthorized-push defect existed because the rule lived only in MemorySyncRepository, so the
 * contract tests were green while the production Supabase adapter had no gate. Every shared
 * invariant belongs here, exercised identically on both sides, so a future divergence fails loudly.
 *
 * See postgrest-double.ts for what this harness can and cannot prove.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizingSyncRepository } from "../src/authorizing-repository.js";
import { MemorySyncRepository, RepositoryConflict, RepositoryForbidden, SupabaseRestSyncRepository, type SyncAuth, type SyncRepository } from "../src/sync-repository.js";
import { PostgrestDouble } from "./postgrest-double.js";

const accountA="11111111-1111-4111-8111-111111111111";
const accountB="22222222-2222-4222-8222-222222222222";
const deviceA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const deviceB="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const entityId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const authA:SyncAuth={accountId:accountA,accessToken:"token-a"};
const authB:SyncAuth={accountId:accountB,accessToken:"token-b"};

function device(deviceId=deviceA,requestApproval=false){
  return {deviceId,publicKey:"P".repeat(43),signingPublicKey:"S".repeat(43),displayName:"Alex's computer",platform:"windows-x64" as const,requestApproval};
}
function mutation(mutationId:string,deviceId=deviceA,accountId=accountA){
  return {mutationId,accountId,deviceId,logicalTimestamp:`1723478400000-0000000000-${deviceId}`,entityId,entityType:"task",nonce:"N".repeat(32),ciphertext:"C".repeat(64),schemaVersion:3 as const,signature:"G".repeat(86),tombstone:false};
}

type Adapter={name:string;create():SyncRepository};

const adapters:Adapter[]=[
  {name:"memory",create:()=>new AuthorizingSyncRepository(new MemorySyncRepository())},
  {name:"supabase",create:()=>{
    const double=new PostgrestDouble(new Map([["token-a",accountA],["token-b",accountB]]));
    return new AuthorizingSyncRepository(new SupabaseRestSyncRepository("https://project.supabase.co/","publishable-key-that-is-long-enough",double.fetch));
  }}
];

async function rejects(run:()=>Promise<unknown>,expected:new(...args:never[])=>Error,message:string){
  await assert.rejects(run,error=>{assert.ok(error instanceof expected,`${message}: got ${String(error)}`);return true;});
}

for(const adapter of adapters){
  test(`[${adapter.name}] a pending device cannot append to the mutation log`,async()=>{
    const repository=adapter.create();
    await repository.registerDevice(authA,device(deviceA));
    const pending=await repository.registerDevice(authA,device(deviceB));
    assert.equal(pending.authorized,false);
    await rejects(()=>repository.pushMutations(authA,[mutation("dddddddd-dddd-4ddd-8ddd-dddddddddddd",deviceB)]),RepositoryForbidden,"pending device push");
  });

  test(`[${adapter.name}] a revoked device cannot append to the mutation log`,async()=>{
    const repository=adapter.create();
    await repository.registerDevice(authA,device(deviceA));
    await repository.revokeDevice(authA,deviceA);
    await rejects(()=>repository.pushMutations(authA,[mutation("dddddddd-dddd-4ddd-8ddd-dddddddddddd")]),RepositoryForbidden,"revoked device push");
  });

  test(`[${adapter.name}] an unregistered device cannot append to the mutation log`,async()=>{
    const repository=adapter.create();
    await repository.registerDevice(authA,device(deviceA));
    await rejects(()=>repository.pushMutations(authA,[mutation("dddddddd-dddd-4ddd-8ddd-dddddddddddd",deviceB)]),RepositoryForbidden,"unregistered device push");
  });

  test(`[${adapter.name}] a batch with one unauthorized mutation stores none of it`,async()=>{
    const repository=adapter.create();
    await repository.registerDevice(authA,device(deviceA));
    await repository.registerDevice(authA,device(deviceB));
    await rejects(()=>repository.pushMutations(authA,[
      mutation("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      mutation("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",deviceB)
    ]),RepositoryForbidden,"mixed batch");
    const stored=await repository.pullMutations(authA,0,100);
    assert.deepEqual(stored.mutations,[],"a rejected batch must be stored atomically or not at all");
  });

  test(`[${adapter.name}] push is idempotent and rejects ciphertext substitution`,async()=>{
    const repository=adapter.create();
    await repository.registerDevice(authA,device(deviceA));
    const id="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const first=await repository.pushMutations(authA,[mutation(id)]);
    assert.equal(first.accepted,1);
    const duplicate=await repository.pushMutations(authA,[mutation(id)]);
    assert.equal(duplicate.accepted,0);
    assert.equal(duplicate.cursor,first.cursor);
    await rejects(()=>repository.pushMutations(authA,[{...mutation(id),ciphertext:"X".repeat(64)}]),RepositoryConflict,"substituted ciphertext");
  });

  test(`[${adapter.name}] pull isolates accounts and advances a stable cursor`,async()=>{
    const repository=adapter.create();
    await repository.registerDevice(authA,device(deviceA));
    await repository.registerDevice(authB,device(deviceB));
    await repository.pushMutations(authA,[mutation("dddddddd-dddd-4ddd-8ddd-dddddddddddd")]);
    await repository.pushMutations(authB,[mutation("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",deviceB,accountB)]);
    const pulled=await repository.pullMutations(authA,0,100);
    assert.equal(pulled.mutations.length,1);
    assert.equal(pulled.mutations[0]!.accountId,accountA);
    const after=await repository.pullMutations(authA,Number(pulled.cursor),100);
    assert.deepEqual(after.mutations,[]);
  });

  test(`[${adapter.name}] only a first and only device is auto-authorized`,async()=>{
    const repository=adapter.create();
    assert.equal((await repository.registerDevice(authA,device(deviceA))).authorized,true);
    assert.equal((await repository.registerDevice(authA,device(deviceB))).authorized,false);
  });

  test(`[${adapter.name}] a second device is not auto-authorized while the first is still pending`,async()=>{
    const repository=adapter.create();
    // The first device asked for approval, so the account has a device but no AUTHORIZED device.
    // Keying auto-authorization off "no authorized device" would hand full trust to whoever
    // registers next, which is the divergence that let the two adapters disagree.
    assert.equal((await repository.registerDevice(authA,device(deviceA,true))).authorized,false);
    assert.equal((await repository.registerDevice(authA,device(deviceB))).authorized,false,"an existing pending device must still block auto-authorization");
  });

  test(`[${adapter.name}] a device ID cannot be rebound to another key`,async()=>{
    const repository=adapter.create();
    await repository.registerDevice(authA,device(deviceA));
    await rejects(()=>repository.registerDevice(authA,{...device(deviceA),publicKey:"Q".repeat(43)}),RepositoryConflict,"rebound device key");
  });

  test(`[${adapter.name}] approval never resurrects a revoked device`,async()=>{
    const repository=adapter.create();
    await repository.registerDevice(authA,device(deviceA));
    await repository.registerDevice(authA,device(deviceB));
    await repository.revokeDevice(authA,deviceB);
    await rejects(()=>repository.authorizeDevice(authA,deviceB),RepositoryForbidden,"authorize revoked device");
    const revoked=await repository.getDevice(authA,deviceB);
    assert.equal(revoked?.revoked,true);
    assert.equal(revoked?.authorized,false);
  });

  test(`[${adapter.name}] another account's device is never visible`,async()=>{
    const repository=adapter.create();
    await repository.registerDevice(authA,device(deviceA));
    assert.equal(await repository.getDevice(authB,deviceA),null);
    assert.deepEqual(await repository.listDevices(authB),[]);
  });

  test(`[${adapter.name}] a consumed device envelope is not listed again`,async()=>{
    const repository=adapter.create();
    await repository.registerDevice(authA,device(deviceA));
    await repository.registerDevice(authA,device(deviceB));
    const envelope={envelopeId:"ffffffff-ffff-4fff-8fff-ffffffffffff",targetDeviceId:deviceB,senderDeviceId:deviceA,encryptedAccountKey:"E".repeat(64),signature:"G".repeat(86),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()};
    await repository.saveDeviceEnvelope(authA,envelope);
    assert.equal((await repository.listDeviceEnvelopes(authA,deviceB)).length,1);
    await repository.markDeviceEnvelopeConsumed(authA,deviceB,envelope.envelopeId);
    assert.deepEqual(await repository.listDeviceEnvelopes(authA,deviceB),[],"a consumed envelope must not be re-delivered");
    await rejects(()=>repository.saveDeviceEnvelope(authA,envelope),RepositoryConflict,"reused envelope ID");
  });
}
