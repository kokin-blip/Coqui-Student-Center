-- Encrypted mutations become authorized-device-only and Ed25519-signed.
--
-- Before this migration the insert policy checked only that the row's account matched the caller,
-- so any device holding a valid session token -- including one still pending approval, or one that
-- had been revoked -- could write into the append-only mutation log. The application-layer check
-- existed only in the in-memory test adapter, so the production PostgREST path had no gate at all.
--
-- Sync has never been released, so the protocol is bumped in place rather than migrated: existing
-- rows are unsigned v2 envelopes that no current client can verify.

delete from public.student_center_encrypted_mutations;

alter table public.student_center_encrypted_mutations
  add column signature text not null check (octet_length(signature) = 86);

alter table public.student_center_encrypted_mutations
  drop constraint if exists student_center_encrypted_mutations_schema_version_check;

alter table public.student_center_encrypted_mutations
  add constraint student_center_encrypted_mutations_schema_version_check
  check (schema_version = 3);

-- The substitution guard must cover the signature too, or a mutation ID could be re-inserted with
-- identical ciphertext under a different signature.
create or replace function public.student_center_reject_mutation_substitution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  existing public.student_center_encrypted_mutations;
begin
  select * into existing
  from public.student_center_encrypted_mutations
  where mutation_id = new.mutation_id;

  if found and (
    existing.account_id is distinct from new.account_id
    or existing.device_id is distinct from new.device_id
    or existing.logical_timestamp is distinct from new.logical_timestamp
    or existing.entity_id is distinct from new.entity_id
    or existing.entity_type is distinct from new.entity_type
    or existing.nonce is distinct from new.nonce
    or existing.ciphertext is distinct from new.ciphertext
    or existing.schema_version is distinct from new.schema_version
    or existing.tombstone is distinct from new.tombstone
    or existing.signature is distinct from new.signature
  ) then
    raise exception 'mutation ID cannot be reused with different ciphertext' using errcode = '23505';
  end if;
  return new;
end;
$$;

-- Only an approved, unrevoked device of the authenticated account may append to the log.
--
-- This policy cannot stop a compromised device from inserting a row bearing a SIBLING device's ID
-- within the same account: every device of an account is approved, so the subquery still passes.
-- Authorship within an account is established by the Ed25519 signature, which the API verifies
-- against the pushing device's registered signing key.
drop policy if exists "student center mutations accept only the current account"
  on public.student_center_encrypted_mutations;

create policy "student center mutations accept only authorized devices"
  on public.student_center_encrypted_mutations for insert to authenticated
  with check (
    (select auth.uid()) = account_id
    and exists (
      select 1
      from public.student_center_devices device
      where device.account_id = student_center_encrypted_mutations.account_id
        and device.id = student_center_encrypted_mutations.device_id
        and device.approved_at is not null
        and device.revoked_at is null
    )
  );
