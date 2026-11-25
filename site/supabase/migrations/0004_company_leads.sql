-- Companies asking about Tucano for a team of more than 15 (the "Fale com a gente" form on the home
-- page and on /pro/). Same rule as the waitlist: only the site worker writes or reads it, with the
-- secret key. Row level security is on with no policy and the public roles have no grant.
create table public.company_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  company text not null check (length(company) between 1 and 120),
  size text not null check (size in ('2-15', '16-25', '26-50', '51+')),  -- how many people will use it
  use_case text check (length(use_case) <= 1000),                         -- what for, in their words
  lang text not null default 'pt' check (lang in ('pt', 'en')),
  source text check (length(source) <= 200),                              -- the page the form was on
  created_at timestamptz not null default now(),
  -- Follow-up, by hand.
  status text not null default 'new' check (status in ('new', 'answered', 'won', 'lost')),
  notes text
);

comment on table public.company_leads is 'Company contact requests from tucano.sh, written by the site worker with the secret key. RLS on, no policies.';

alter table public.company_leads enable row level security;
revoke all on table public.company_leads from anon, authenticated;

create index company_leads_by_status on public.company_leads (status, created_at desc);
