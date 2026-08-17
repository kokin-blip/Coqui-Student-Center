import type { DeviceEnvelope, DeviceRegistration, EncryptedMutation, EncryptedObjectChunk, EncryptedObjectManifest } from "@student-center/contracts";
import { RepositoryForbidden, type RegisteredDevice, type SyncAuth, type SyncRepository } from "./sync-repository.js";

/**
 * The single implementation of "only an authorized device may write to the mutation log".
 *
 * This rule previously lived inside MemorySyncRepository alone, so the contract tests passed
 * while the production Supabase adapter accepted mutations from pending and revoked devices.
 * Wrapping every repository keeps the rule in one place: a new adapter cannot forget it.
 *
 * The whole batch is validated before any of it is delegated, which also matches PostgREST's
 * atomic array insert — a batch containing one unauthorized mutation must store none of it.
 */
export class AuthorizingSyncRepository implements SyncRepository{
  constructor(private readonly inner:SyncRepository){}

  async pushMutations(auth:SyncAuth,mutations:EncryptedMutation[]){
    const checked=new Map<string,RegisteredDevice|null>();
    for(const mutation of mutations){
      if(mutation.accountId!==auth.accountId)throw new RepositoryForbidden("mutation account does not match the authenticated account");
      if(!checked.has(mutation.deviceId))checked.set(mutation.deviceId,await this.inner.getDevice(auth,mutation.deviceId));
      const device=checked.get(mutation.deviceId);
      if(!device||device.revoked||!device.authorized)throw new RepositoryForbidden("mutation device is not authorized");
    }
    return this.inner.pushMutations(auth,mutations);
  }

  registerDevice(auth:SyncAuth,input:DeviceRegistration){return this.inner.registerDevice(auth,input);}
  getDevice(auth:SyncAuth,deviceId:string){return this.inner.getDevice(auth,deviceId);}
  listDevices(auth:SyncAuth){return this.inner.listDevices(auth);}
  authorizeDevice(auth:SyncAuth,deviceId:string){return this.inner.authorizeDevice(auth,deviceId);}
  revokeDevice(auth:SyncAuth,deviceId:string){return this.inner.revokeDevice(auth,deviceId);}
  saveDeviceEnvelope(auth:SyncAuth,envelope:DeviceEnvelope){return this.inner.saveDeviceEnvelope(auth,envelope);}
  listDeviceEnvelopes(auth:SyncAuth,targetDeviceId:string){return this.inner.listDeviceEnvelopes(auth,targetDeviceId);}
  markDeviceEnvelopeConsumed(auth:SyncAuth,targetDeviceId:string,envelopeId:string){return this.inner.markDeviceEnvelopeConsumed(auth,targetDeviceId,envelopeId);}
  pullMutations(auth:SyncAuth,cursor:number,limit:number){return this.inner.pullMutations(auth,cursor,limit);}
  initiateObject(auth:SyncAuth,manifest:EncryptedObjectManifest){return this.inner.initiateObject(auth,manifest);}
  putObjectChunk(auth:SyncAuth,chunk:EncryptedObjectChunk){return this.inner.putObjectChunk(auth,chunk);}
  completeObject(auth:SyncAuth,documentId:string){return this.inner.completeObject(auth,documentId);}
  downloadObject(auth:SyncAuth,documentId:string){return this.inner.downloadObject(auth,documentId);}
}
