-- The Tucano Pro beta's waitlist (site/worker.js writes it, through /api/lista).
-- Only the server's secret key reads or writes it: row level security is on with no policy,
-- and the public roles have no grant, so the site's visitors can't read the list or write it
-- directly. Each email once (kept lowercase); signing up again changes nothing.
create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  name text not null check (length(name) between 1 and 120),
  use_case text check (length(use_case) <= 1000),          -- what they want it for, in their words
  has_iphone boolean,
  lang text not null default 'pt' check (lang in ('pt', 'en')),
  source text check (length(source) <= 200),               -- where they came from (?ref=, utm_source)
  consent_at timestamptz not null,                          -- agreed to the beta terms and the privacy policy
  created_at timestamptz not null default now(),
  -- The beta, by hand: who was invited, to which Tucano, and how it went.
  status text not null default 'waiting' check (status in ('waiting', 'invited', 'joined', 'declined', 'removed')),
  invited_at timestamptz,
  tucano text,                                              -- the container's name (tucano-ctl)
  notes text
);

comment on table public.waitlist is 'Tucano Pro beta waitlist. Written by the site worker with the secret key; RLS on, no policies.';

alter table public.waitlist enable row level security;
revoke all on table public.waitlist from anon, authenticated;

create index waitlist_by_status on public.waitlist (status, created_at);

-- Supabase's helper that turns RLS on for new tables runs from an event trigger; nobody needs to call it over the API.
revoke execute on function public.rls_auto_enable() from anon, authenticated, public;
