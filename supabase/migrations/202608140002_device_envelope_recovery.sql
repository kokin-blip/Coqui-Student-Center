alter table public.student_center_device_envelopes
  add column if not exists envelope_id uuid;

update public.student_center_device_envelopes
set envelope_id = gen_random_uuid()
where envelope_id is null;

alter table public.student_center_device_envelopes
  alter column envelope_id set not null;

create unique index if not exists student_center_device_envelope_ids
  on public.student_center_device_envelopes(account_id, envelope_id);
