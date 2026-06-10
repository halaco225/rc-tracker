create table if not exists follow_ups (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  assigned_to text,
  status text not null default 'open',
  source text not null default 'manual',
  due_date date,
  notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists follow_ups_status_idx on follow_ups(status);
create index if not exists follow_ups_created_at_idx on follow_ups(created_at desc);
