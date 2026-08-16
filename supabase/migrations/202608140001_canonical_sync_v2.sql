alter table public.student_center_devices
  add column if not exists signing_public_key text,
  add column if not exists approved_at timestamptz;

update public.student_center_devices
set signing_public_key = public_key,
    approved_at = coalesce(approved_at, created_at)
where signing_public_key is null;

alter table public.student_center_devices
  alter column signing_public_key set not null;

alter table public.student_center_encrypted_mutations
  drop constraint if exists student_center_encrypted_mutations_schema_version_check;

alter table public.student_center_encrypted_mutations
  add constraint student_center_encrypted_mutations_schema_version_check
  check (schema_version = 2) not valid;

create index if not exists student_center_pending_devices
  on public.student_center_devices(account_id, created_at)
  where approved_at is null and revoked_at is null;
