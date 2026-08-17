import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bearerToken, createSupabaseAccessTokenVerifier } from "../src/auth.js";

test("Supabase authentication accepts only a strict HTTPS project origin",()=>{
  assert.throws(()=>createSupabaseAccessTokenVerifier("http://project.supabase.co/"));
  assert.throws(()=>createSupabaseAccessTokenVerifier("https://project.supabase.co/auth/v1"));
  assert.throws(()=>createSupabaseAccessTokenVerifier("https://user:pass@project.supabase.co/"));
  assert.doesNotThrow(()=>createSupabaseAccessTokenVerifier("https://project.supabase.co/"));
});

test("bearer parsing rejects ambiguous authorization headers",()=>{
  assert.equal(bearerToken("Bearer header.payload.signature"),"header.payload.signature");
  assert.equal(bearerToken("bearer header.payload.signature"),null);
  assert.equal(bearerToken("Bearer one Bearer two"),null);
  assert.equal(bearerToken(undefined),null);
});

test("the durable sync migration enables account RLS and mutation substitution defense",async()=>{
  const sql=await readFile(new URL("../../../supabase/migrations/202608120001_e2ee_sync.sql",import.meta.url),"utf8");
  for(const table of ["student_center_devices","student_center_encrypted_mutations","student_center_device_envelopes","student_center_encrypted_objects"]){
    assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`,"i"));
  }
  assert.match(sql,/\(select auth\.uid\(\)\) = account_id/i);
  assert.match(sql,/student_center_reject_mutation_substitution/i);
  assert.match(sql,/student-center-encrypted-objects/);
  assert.doesNotMatch(sql,/service_role/i);
});

test("canonical sync v2 adds signing approval and rejects legacy mutation schemas",async()=>{
  const sql=await readFile(new URL("../../../supabase/migrations/202608140001_canonical_sync_v2.sql",import.meta.url),"utf8");
  assert.match(sql,/signing_public_key/);
  assert.match(sql,/approved_at/);
  assert.match(sql,/schema_version = 2/);
  assert.match(sql,/student_center_pending_devices/);
});

test("device approval recovery uses stable envelope IDs",async()=>{
  const sql=await readFile(new URL("../../../supabase/migrations/202608140002_device_envelope_recovery.sql",import.meta.url),"utf8");
  assert.match(sql,/envelope_id uuid/i);
  assert.match(sql,/unique index/i);
  assert.doesNotMatch(sql,/service_role/i);
});

// The conformance suite cannot reach RLS or triggers, so the database half of the push gate is
// asserted here as migration text. A live project is still required to prove it actually runs.
test("signed authorized mutations restrict inserts to approved, unrevoked devices",async()=>{
  const sql=await readFile(new URL("../../../supabase/migrations/202608160001_signed_authorized_mutations.sql",import.meta.url),"utf8");
  assert.match(sql,/drop policy if exists "student center mutations accept only the current account"/i,"the permissive insert policy must be removed, not merely supplemented");
  assert.match(sql,/create policy "student center mutations accept only authorized devices"/i);
  assert.match(sql,/device\.approved_at is not null/i);
  assert.match(sql,/device\.revoked_at is null/i);
  assert.match(sql,/add column signature text not null check \(octet_length\(signature\) = 86\)/i);
  assert.match(sql,/check \(schema_version = 3\)/i);
  // A mutation ID must not be reusable with a different signature.
  assert.match(sql,/existing\.signature is distinct from new\.signature/i);
  assert.doesNotMatch(sql,/service_role/i);
});
