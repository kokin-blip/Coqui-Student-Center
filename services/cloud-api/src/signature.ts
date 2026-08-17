import { createPublicKey, verify as verifySignature } from "node:crypto";

/** DER SubjectPublicKeyInfo prefix for a raw Ed25519 public key. */
const ED25519_SPKI_PREFIX=Buffer.from("302a300506032b6570032100","hex");

/**
 * Verify a raw Ed25519 signature against a raw 32-byte public key, both base64url encoded.
 *
 * Returns false rather than throwing for any malformed input, so callers can treat an unusable key
 * or signature the same as a wrong one and answer with a single, non-revealing rejection.
 */
export function verifyEd25519(publicKeyBase64Url:string,message:Buffer,signatureBase64Url:string):boolean{
  try{
    const raw=Buffer.from(publicKeyBase64Url,"base64url");
    if(raw.length!==32)return false;
    const signature=Buffer.from(signatureBase64Url,"base64url");
    if(signature.length!==64)return false;
    const key=createPublicKey({key:Buffer.concat([ED25519_SPKI_PREFIX,raw]),format:"der",type:"spki"});
    return verifySignature(null,message,key,signature);
  }catch{return false;}
}
