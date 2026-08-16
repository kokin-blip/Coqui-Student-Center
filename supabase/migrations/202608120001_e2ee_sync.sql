create table public.student_center_devices (
  account_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  public_key text not null check (octet_length(public_key) between 32 and 2048),
  signing_public_key text not null check (octet_length(signing_public_key) between 32 and 2048),
  display_name text not null check (char_length(display_name) between 1 and 100),
  platform text not null check (platform in ('windows-x64', 'macos-arm64')),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (account_id, id)
);

create table public.student_center_encrypted_mutations (
  sequence bigint generated always as identity primary key,
  mutation_id uuid not null unique,
  account_id uuid not null,
  device_id uuid not null,
  logical_timestamp text not null check (char_length(logical_timestamp) between 1 and 128),
  entity_id uuid not null,
  entity_type text not null check (entity_type ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  nonce text not null check (octet_length(nonce) between 32 and 128),
  ciphertext text not null check (octet_length(ciphertext) between 32 and 16000000),
  schema_version integer not null check (schema_version between 1 and 10000),
  tombstone boolean not null default false,
  received_at timestamptz not null default now(),
  foreign key (account_id, device_id) references public.student_center_devices(account_id, id) on delete restrict
);

create index student_center_mutations_account_sequence
  on public.student_center_encrypted_mutations(account_id, sequence);
create index student_center_mutations_account_entity
  on public.student_center_encrypted_mutations(account_id, entity_type, entity_id);

create function public.student_center_reject_mutation_substitution()
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
  ) then
    raise exception 'mutation ID cannot be reused with different ciphertext' using errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger student_center_reject_mutation_substitution
before insert on public.student_center_encrypted_mutations
for each row execute function public.student_center_reject_mutation_substitution();

create table public.student_center_device_envelopes (
  id bigint generated always as identity primary key,
  envelope_id uuid not null unique,
  account_id uuid not null,
  target_device_id uuid not null,
  sender_device_id uuid not null,
  encrypted_account_key text not null check (octet_length(encrypted_account_key) between 32 and 4096),
  signature text not null check (octet_length(signature) between 32 and 4096),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (account_id, target_device_id) references public.student_center_devices(account_id, id) on delete cascade,
  foreign key (account_id, sender_device_id) references public.student_center_devices(account_id, id) on delete cascade,
  check (target_device_id <> sender_device_id)
);

create index student_center_envelopes_target
  on public.student_center_device_envelopes(account_id, target_device_id, expires_at desc);

create table public.student_center_encrypted_objects (
  account_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null,
  encrypted_metadata text not null check (octet_length(encrypted_metadata) between 32 and 16000000),
  wrapped_object_key text not null check (octet_length(wrapped_object_key) between 32 and 4096),
  chunk_hashes jsonb not null check (jsonb_typeof(chunk_hashes) = 'array'),
  version integer not null check (version between 1 and 10000),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, document_id)
);

alter table public.student_center_devices enable row level security;
alter table public.student_center_encrypted_mutations enable row level security;
alter table public.student_center_device_envelopes enable row level security;
alter table public.student_center_encrypted_objects enable row level security;

grant select, insert, update, delete on public.student_center_devices to authenticated;
grant select, insert on public.student_center_encrypted_mutations to authenticated;
grant select, insert, update, delete on public.student_center_device_envelopes to authenticated;
grant select, insert, update, delete on public.student_center_encrypted_objects to authenticated;
grant usage, select on all sequences in schema public to authenticated;

create policy "student center devices are account isolated"
  on public.student_center_devices for all to authenticated
  using ((select auth.uid()) = account_id)
  with check ((select auth.uid()) = account_id);

create policy "student center mutations are account isolated"
  on public.student_center_encrypted_mutations for select to authenticated
  using ((select auth.uid()) = account_id);
create policy "student center mutations accept only the current account"
  on public.student_center_encrypted_mutations for insert to authenticated
  with check ((select auth.uid()) = account_id);

create policy "student center envelopes are account isolated"
  on public.student_center_device_envelopes for all to authenticated
  using ((select auth.uid()) = account_id)
  with check ((select auth.uid()) = account_id);

create policy "student center objects are account isolated"
  on public.student_center_encrypted_objects for all to authenticated
  using ((select auth.uid()) = account_id)
  with check ((select auth.uid()) = account_id);

insert into storage.buckets (id, name, public)
values ('student-center-encrypted-objects', 'student-center-encrypted-objects', false)
on conflict (id) do update set public = false;

create policy "student center encrypted chunks are account isolated"
  on storage.objects for all to authenticated
  using (
    bucket_id = 'student-center-encrypted-objects'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'student-center-encrypted-objects'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
