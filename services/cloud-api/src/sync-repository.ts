import type { DeviceEnvelope, DeviceRegistration, EncryptedMutation, EncryptedObjectChunk, EncryptedObjectManifest } from "@student-center/contracts";
import { createHash } from "node:crypto";

export type RegisteredDevice=DeviceRegistration&{accountId:string;revoked:boolean;authorized:boolean};
export type StoredMutation=EncryptedMutation&{sequence:number};
export type SyncAuth={accountId:string;accessToken:string};

export interface SyncRepository{
  registerDevice(auth:SyncAuth,input:DeviceRegistration):Promise<{created:boolean;authorized:boolean}>;
  getDevice(auth:SyncAuth,deviceId:string):Promise<RegisteredDevice|null>;
  listDevices(auth:SyncAuth):Promise<RegisteredDevice[]>;
  authorizeDevice(auth:SyncAuth,deviceId:string):Promise<void>;
  revokeDevice(auth:SyncAuth,deviceId:string):Promise<void>;
  saveDeviceEnvelope(auth:SyncAuth,envelope:DeviceEnvelope):Promise<void>;
  listDeviceEnvelopes(auth:SyncAuth,targetDeviceId:string):Promise<DeviceEnvelope[]>;
  pushMutations(auth:SyncAuth,mutations:EncryptedMutation[]):Promise<{accepted:number;cursor:string}>;
  pullMutations(auth:SyncAuth,cursor:number,limit:number):Promise<{cursor:string;mutations:EncryptedMutation[];hasMore:boolean}>;
  initiateObject(auth:SyncAuth,manifest:EncryptedObjectManifest):Promise<number[]>;
  putObjectChunk(auth:SyncAuth,chunk:EncryptedObjectChunk):Promise<void>;
  completeObject(auth:SyncAuth,documentId:string):Promise<void>;
  downloadObject(auth:SyncAuth,documentId:string):Promise<{manifest:EncryptedObjectManifest;chunks:EncryptedObjectChunk[]}|null>;
}

export class RepositoryConflict extends Error{}
export class RepositoryForbidden extends Error{}

export class MemorySyncRepository implements SyncRepository{
  readonly devices=new Map<string,RegisteredDevice>();
  readonly mutations:StoredMutation[]=[];
  readonly envelopes:Array<DeviceEnvelope&{accountId:string}>=[];
  readonly objects=new Map<string,{manifest:EncryptedObjectManifest;chunks:Map<number,EncryptedObjectChunk>;completed:boolean}>();
  #nextSequence=1;

  #deviceKey(accountId:string,deviceId:string){return `${accountId}:${deviceId}`;}

  async registerDevice(auth:SyncAuth,input:DeviceRegistration){
    const key=this.#deviceKey(auth.accountId,input.deviceId);
    const current=this.devices.get(key);
    if(current&&(current.publicKey!==input.publicKey||current.signingPublicKey!==input.signingPublicKey))throw new RepositoryConflict("device ID is already bound to another key");
    if(current)return {created:false,authorized:current.authorized};
    const authorized=!input.requestApproval&&![...this.devices.values()].some(device=>device.accountId===auth.accountId&&!device.revoked);
    this.devices.set(key,{...input,accountId:auth.accountId,revoked:false,authorized});
    return {created:true,authorized};
  }

  async getDevice(auth:SyncAuth,deviceId:string){return this.devices.get(this.#deviceKey(auth.accountId,deviceId))??null;}
  async listDevices(auth:SyncAuth){return [...this.devices.values()].filter(device=>device.accountId===auth.accountId);}
  async authorizeDevice(auth:SyncAuth,deviceId:string){const device=await this.getDevice(auth,deviceId);if(!device||device.revoked)throw new RepositoryForbidden("device is unavailable");device.authorized=true;}
  async revokeDevice(auth:SyncAuth,deviceId:string){const device=await this.getDevice(auth,deviceId);if(!device)throw new RepositoryForbidden("device is unavailable");device.revoked=true;device.authorized=false;}

  async saveDeviceEnvelope(auth:SyncAuth,envelope:DeviceEnvelope){
    this.envelopes.push({...envelope,accountId:auth.accountId});
  }
  async listDeviceEnvelopes(auth:SyncAuth,targetDeviceId:string){return this.envelopes.filter(envelope=>envelope.accountId===auth.accountId&&envelope.targetDeviceId===targetDeviceId&&Date.parse(envelope.expiresAt)>Date.now()).map(({accountId:_,...envelope})=>envelope);}

  async pushMutations(auth:SyncAuth,mutations:EncryptedMutation[]){
    let accepted=0;
    for(const mutation of mutations){
      if(mutation.accountId!==auth.accountId)throw new RepositoryForbidden("mutation account does not match the authenticated account");
      const device=await this.getDevice(auth,mutation.deviceId);
      if(!device||device.revoked||!device.authorized)throw new RepositoryForbidden("mutation device is not authorized");
      const current=this.mutations.find(item=>item.mutationId===mutation.mutationId);
      if(current){
        const {sequence:_,...currentMutation}=current;
        if(JSON.stringify(currentMutation)!==JSON.stringify(mutation))throw new RepositoryConflict("mutation ID was reused with different ciphertext");
        continue;
      }
      this.mutations.push({...mutation,sequence:this.#nextSequence++});
      accepted+=1;
    }
    const cursor=Math.max(0,...this.mutations.filter(item=>item.accountId===auth.accountId).map(item=>item.sequence));
    return {accepted,cursor:String(cursor)};
  }

  async pullMutations(auth:SyncAuth,cursor:number,limit:number){
    const rows=this.mutations.filter(item=>item.accountId===auth.accountId&&item.sequence>cursor).sort((a,b)=>a.sequence-b.sequence);
    const page=rows.slice(0,limit);
    const nextCursor=page.at(-1)?.sequence??cursor;
    return {cursor:String(nextCursor),mutations:page.map(({sequence:_,...mutation})=>mutation),hasMore:rows.length>page.length};
  }
  async initiateObject(auth:SyncAuth,manifest:EncryptedObjectManifest){const key=`${auth.accountId}:${manifest.documentId}`;const current=this.objects.get(key);if(current&&JSON.stringify(current.manifest)!==JSON.stringify(manifest))throw new RepositoryConflict("object ID is already bound to another encrypted manifest");if(!current)this.objects.set(key,{manifest,chunks:new Map(),completed:false});const object=this.objects.get(key)!;return manifest.chunkHashes.map((_,index)=>index).filter(index=>!object.chunks.has(index));}
  async putObjectChunk(auth:SyncAuth,chunk:EncryptedObjectChunk){const object=this.objects.get(`${auth.accountId}:${chunk.documentId}`);if(!object)throw new RepositoryForbidden("object upload was not initiated");object.chunks.set(chunk.index,chunk);}
  async completeObject(auth:SyncAuth,documentId:string){const object=this.objects.get(`${auth.accountId}:${documentId}`);if(!object)throw new RepositoryForbidden("object upload was not initiated");if(object.chunks.size!==object.manifest.chunkHashes.length||object.manifest.chunkHashes.some((hash,index)=>object.chunks.get(index)?.sha256!==hash))throw new RepositoryConflict("object chunks are incomplete or do not match the manifest");object.completed=true;}
  async downloadObject(auth:SyncAuth,documentId:string){const object=this.objects.get(`${auth.accountId}:${documentId}`);return object?.completed?{manifest:object.manifest,chunks:[...object.chunks.values()].sort((a,b)=>a.index-b.index)}:null;}
}

type SupabaseRow=Record<string,unknown>;

export class SupabaseRestSyncRepository implements SyncRepository{
  readonly origin:string;
  constructor(supabaseUrl:string,readonly publishableKey:string){
    const url=new URL(supabaseUrl);
    if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new Error("SUPABASE_URL must be an HTTPS origin");
    if(publishableKey.length<20)throw new Error("SUPABASE_PUBLISHABLE_KEY is missing or invalid");
    this.origin=url.origin;
  }

  async #request(auth:SyncAuth,path:string,init:RequestInit={}){
    const response=await fetch(`${this.origin}/rest/v1/${path}`,{...init,headers:{apikey:this.publishableKey,Authorization:`Bearer ${auth.accessToken}`,"Content-Type":"application/json",...(init.headers??{})}});
    if(!response.ok){
      const detail=(await response.text()).slice(0,500);
      if(response.status===409)throw new RepositoryConflict(detail||"repository conflict");
      if(response.status===401||response.status===403)throw new RepositoryForbidden("repository authorization failed");
      throw new Error(`Supabase repository request failed (${response.status}): ${detail}`);
    }
    return response;
  }

  async registerDevice(auth:SyncAuth,input:DeviceRegistration){
    const current=await this.getDevice(auth,input.deviceId);
    if(current&&(current.publicKey!==input.publicKey||current.signingPublicKey!==input.signingPublicKey))throw new RepositoryConflict("device ID is already bound to another key");
    if(current)return {created:false,authorized:current.authorized};
    const devices=await this.listDevices(auth);
    const authorized=!input.requestApproval&&!devices.some(device=>device.authorized&&!device.revoked);
    await this.#request(auth,"student_center_devices",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({account_id:auth.accountId,id:input.deviceId,public_key:input.publicKey,signing_public_key:input.signingPublicKey,display_name:input.displayName,platform:input.platform,approved_at:authorized?new Date().toISOString():null})});
    return {created:true,authorized};
  }

  async getDevice(auth:SyncAuth,deviceId:string){
    const response=await this.#request(auth,`student_center_devices?select=id,account_id,public_key,signing_public_key,display_name,platform,approved_at,revoked_at&id=eq.${encodeURIComponent(deviceId)}&limit=1`);
    const [row]=(await response.json()) as SupabaseRow[];
    return row?{deviceId:String(row.id),accountId:String(row.account_id),publicKey:String(row.public_key),signingPublicKey:String(row.signing_public_key),displayName:String(row.display_name),platform:row.platform as DeviceRegistration["platform"],requestApproval:false,authorized:row.approved_at!==null,revoked:row.revoked_at!==null}:null;
  }

  async listDevices(auth:SyncAuth){
    const response=await this.#request(auth,"student_center_devices?select=id,account_id,public_key,signing_public_key,display_name,platform,approved_at,revoked_at&order=created_at.asc");
    return ((await response.json()) as SupabaseRow[]).map(row=>({deviceId:String(row.id),accountId:String(row.account_id),publicKey:String(row.public_key),signingPublicKey:String(row.signing_public_key),displayName:String(row.display_name),platform:row.platform as DeviceRegistration["platform"],requestApproval:false,authorized:row.approved_at!==null,revoked:row.revoked_at!==null}));
  }

  async authorizeDevice(auth:SyncAuth,deviceId:string){await this.#request(auth,`student_center_devices?account_id=eq.${encodeURIComponent(auth.accountId)}&id=eq.${encodeURIComponent(deviceId)}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({approved_at:new Date().toISOString(),revoked_at:null})});}
  async revokeDevice(auth:SyncAuth,deviceId:string){await this.#request(auth,`student_center_devices?account_id=eq.${encodeURIComponent(auth.accountId)}&id=eq.${encodeURIComponent(deviceId)}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({revoked_at:new Date().toISOString()})});}

  async saveDeviceEnvelope(auth:SyncAuth,envelope:DeviceEnvelope){
    await this.#request(auth,"student_center_device_envelopes",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({account_id:auth.accountId,envelope_id:envelope.envelopeId,target_device_id:envelope.targetDeviceId,sender_device_id:envelope.senderDeviceId,encrypted_account_key:envelope.encryptedAccountKey,signature:envelope.signature,created_at:envelope.createdAt,expires_at:envelope.expiresAt})});
  }
  async listDeviceEnvelopes(auth:SyncAuth,targetDeviceId:string){const response=await this.#request(auth,`student_center_device_envelopes?select=envelope_id,target_device_id,sender_device_id,encrypted_account_key,signature,created_at,expires_at&target_device_id=eq.${encodeURIComponent(targetDeviceId)}&consumed_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&order=created_at.desc`);return ((await response.json()) as SupabaseRow[]).map(row=>({envelopeId:String(row.envelope_id),targetDeviceId:String(row.target_device_id),senderDeviceId:String(row.sender_device_id),encryptedAccountKey:String(row.encrypted_account_key),signature:String(row.signature),createdAt:String(row.created_at),expiresAt:String(row.expires_at)}));}

  async pushMutations(auth:SyncAuth,mutations:EncryptedMutation[]){
    const body=mutations.map(mutation=>({mutation_id:mutation.mutationId,account_id:auth.accountId,device_id:mutation.deviceId,logical_timestamp:mutation.logicalTimestamp,entity_id:mutation.entityId,entity_type:mutation.entityType,nonce:mutation.nonce,ciphertext:mutation.ciphertext,schema_version:mutation.schemaVersion,tombstone:mutation.tombstone}));
    const response=await this.#request(auth,"student_center_encrypted_mutations?on_conflict=mutation_id",{method:"POST",headers:{Prefer:"resolution=ignore-duplicates,return=representation"},body:JSON.stringify(body)});
    const inserted=(await response.json()) as SupabaseRow[];
    const latest=await this.#request(auth,"student_center_encrypted_mutations?select=sequence&order=sequence.desc&limit=1");
    const [row]=(await latest.json()) as SupabaseRow[];
    return {accepted:inserted.length,cursor:String(row?.sequence??0)};
  }

  async pullMutations(auth:SyncAuth,cursor:number,limit:number){
    const response=await this.#request(auth,`student_center_encrypted_mutations?select=sequence,mutation_id,account_id,device_id,logical_timestamp,entity_id,entity_type,nonce,ciphertext,schema_version,tombstone&sequence=gt.${cursor}&order=sequence.asc&limit=${limit+1}`);
    const rows=(await response.json()) as SupabaseRow[];
    const page=rows.slice(0,limit);
    const mutations=page.map(row=>({mutationId:String(row.mutation_id),accountId:String(row.account_id),deviceId:String(row.device_id),logicalTimestamp:String(row.logical_timestamp),entityId:String(row.entity_id),entityType:String(row.entity_type),nonce:String(row.nonce),ciphertext:String(row.ciphertext),schemaVersion:2 as const,tombstone:Boolean(row.tombstone)}));
    return {cursor:String(page.at(-1)?.sequence??cursor),mutations,hasMore:rows.length>limit};
  }
  async initiateObject(auth:SyncAuth,manifest:EncryptedObjectManifest){const lookup=await this.#request(auth,`student_center_encrypted_objects?select=document_id,encrypted_metadata,wrapped_object_key,chunk_hashes,version&document_id=eq.${encodeURIComponent(manifest.documentId)}&limit=1`);const [row]=(await lookup.json()) as SupabaseRow[];if(row){const existing={documentId:String(row.document_id),encryptedMetadata:String(row.encrypted_metadata),wrappedObjectKey:String(row.wrapped_object_key),chunkHashes:row.chunk_hashes as string[],version:Number(row.version)};if(JSON.stringify(existing)!==JSON.stringify(manifest))throw new RepositoryConflict("object ID is already bound to another encrypted manifest");}else{await this.#request(auth,"student_center_encrypted_objects",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({account_id:auth.accountId,document_id:manifest.documentId,encrypted_metadata:manifest.encryptedMetadata,wrapped_object_key:manifest.wrappedObjectKey,chunk_hashes:manifest.chunkHashes,version:manifest.version,completed_at:null,updated_at:new Date().toISOString()})});}const missing=[] as number[];for(let index=0;index<manifest.chunkHashes.length;index++){const response=await fetch(`${this.origin}/storage/v1/object/student-center-encrypted-objects/${auth.accountId}/${manifest.documentId}/${index}`,{method:"HEAD",headers:{apikey:this.publishableKey,Authorization:`Bearer ${auth.accessToken}`}});if(response.status===404)missing.push(index);else if(!response.ok)throw new Error(`encrypted chunk status failed (${response.status})`);}return missing;}
  async putObjectChunk(auth:SyncAuth,chunk:EncryptedObjectChunk){const bytes=Buffer.from(chunk.ciphertext,"base64url");const response=await fetch(`${this.origin}/storage/v1/object/student-center-encrypted-objects/${auth.accountId}/${chunk.documentId}/${chunk.index}`,{method:"POST",headers:{apikey:this.publishableKey,Authorization:`Bearer ${auth.accessToken}`,"Content-Type":"application/octet-stream","x-upsert":"true"},body:bytes});if(!response.ok)throw new Error(`encrypted chunk upload failed (${response.status})`);}
  async completeObject(auth:SyncAuth,documentId:string){const lookup=await this.#request(auth,`student_center_encrypted_objects?select=chunk_hashes&document_id=eq.${encodeURIComponent(documentId)}&limit=1`);const [row]=(await lookup.json()) as SupabaseRow[];if(!row)throw new RepositoryForbidden("object upload was not initiated");const hashes=row.chunk_hashes as string[];for(let index=0;index<hashes.length;index++){const response=await fetch(`${this.origin}/storage/v1/object/student-center-encrypted-objects/${auth.accountId}/${documentId}/${index}`,{headers:{apikey:this.publishableKey,Authorization:`Bearer ${auth.accessToken}`}});if(!response.ok)throw new RepositoryConflict("object chunks are incomplete");const hash=createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");if(hash!==hashes[index])throw new RepositoryConflict("object chunk hash does not match the manifest");}await this.#request(auth,`student_center_encrypted_objects?account_id=eq.${encodeURIComponent(auth.accountId)}&document_id=eq.${encodeURIComponent(documentId)}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({completed_at:new Date().toISOString(),updated_at:new Date().toISOString()})});}
  async downloadObject(auth:SyncAuth,documentId:string){const response=await this.#request(auth,`student_center_encrypted_objects?select=document_id,encrypted_metadata,wrapped_object_key,chunk_hashes,version,completed_at&document_id=eq.${encodeURIComponent(documentId)}&limit=1`);const [row]=(await response.json()) as SupabaseRow[];if(!row||row.completed_at===null)return null;const manifest={documentId:String(row.document_id),encryptedMetadata:String(row.encrypted_metadata),wrappedObjectKey:String(row.wrapped_object_key),chunkHashes:row.chunk_hashes as string[],version:Number(row.version)};const chunks=[] as EncryptedObjectChunk[];for(let index=0;index<manifest.chunkHashes.length;index++){const chunkResponse=await fetch(`${this.origin}/storage/v1/object/student-center-encrypted-objects/${auth.accountId}/${documentId}/${index}`,{headers:{apikey:this.publishableKey,Authorization:`Bearer ${auth.accessToken}`}});if(!chunkResponse.ok)throw new Error(`encrypted chunk download failed (${chunkResponse.status})`);chunks.push({documentId,index,ciphertext:Buffer.from(await chunkResponse.arrayBuffer()).toString("base64url"),sha256:manifest.chunkHashes[index]!});}return {manifest,chunks};}
}
