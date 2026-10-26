-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Creates the two tables, the "keep the newer edit" rule, row-level security and realtime.

create table public.notes (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '',
  created_at bigint not null,
  updated_at bigint not null,
  deleted boolean not null default false,
  server_updated_at timestamptz not null default now()
);

create table public.entries (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  note_id uuid not null,
  created_at bigint not null,
  updated_at bigint not null,
  text text not null default '',
  images jsonb not null default '[]',
  deleted boolean not null default false,
  server_updated_at timestamptz not null default now()
);

create index on public.notes (user_id, server_updated_at);
create index on public.entries (user_id, server_updated_at);

-- Keep the newer version if two devices edit the same row, and stamp the server time
create or replace function public.keep_newer() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if old.updated_at > new.updated_at then
      return null;
    end if;
  end if;
  new.server_updated_at = now();
  return new;
end $$;

create trigger notes_keep_newer before insert or update on public.notes
  for each row execute function public.keep_newer();
create trigger entries_keep_newer before insert or update on public.entries
  for each row execute function public.keep_newer();

-- Each user can only see and change their own rows
alter table public.notes enable row level security;
alter table public.entries enable row level security;
create policy "own notes" on public.notes for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own entries" on public.entries for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Let devices hear about changes live
alter publication supabase_realtime add table public.notes, public.entries;
