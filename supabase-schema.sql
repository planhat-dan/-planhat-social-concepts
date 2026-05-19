-- Run this in the Supabase SQL editor for your project.

create extension if not exists "pgcrypto";

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  x           numeric not null check (x >= 0 and x <= 100),
  y           numeric not null check (y >= 0 and y <= 100),
  author      text    not null,
  text        text    not null,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists comments_created_at_idx
  on public.comments (created_at);

-- Row Level Security
alter table public.comments enable row level security;

-- Open policies for an internal review tool. Tighten for production.
drop policy if exists "comments_select_all" on public.comments;
create policy "comments_select_all"
  on public.comments for select
  using (true);

drop policy if exists "comments_insert_all" on public.comments;
create policy "comments_insert_all"
  on public.comments for insert
  with check (true);

drop policy if exists "comments_update_all" on public.comments;
create policy "comments_update_all"
  on public.comments for update
  using (true) with check (true);

drop policy if exists "comments_delete_all" on public.comments;
create policy "comments_delete_all"
  on public.comments for delete
  using (true);
