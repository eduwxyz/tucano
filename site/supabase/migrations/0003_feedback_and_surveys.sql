-- Feedback from the app ("Enviar feedback") and the small surveys it shows in the sidebar's foot.
-- Same rule as the waitlist: only the site worker writes or reads these, with the secret key.
-- Row level security is on with no policy and the public roles have no grant, so the
-- project's public key opens none of it. The app never talks to Supabase: it talks to tucano.sh.

-- ---------- feedback ----------

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('bug', 'idea', 'other')),
  message text not null check (length(message) between 1 and 5000),
  image_path text check (image_path is null or image_path ~ '^[0-9a-f-]{36}\.(png|jpg)$'), -- in the private "feedback" bucket
  app_version text check (length(app_version) <= 40),
  os text check (length(os) <= 40),
  lang text check (lang in ('pt', 'en')),
  created_at timestamptz not null default now(),
  -- Triage, by hand.
  status text not null default 'new' check (status in ('new', 'seen', 'done')),
  notes text
);

comment on table public.feedback is 'Feedback sent from the Tucano app, through the site worker. RLS on, no policies.';

alter table public.feedback enable row level security;
revoke all on table public.feedback from anon, authenticated;
create index feedback_by_status on public.feedback (status, created_at desc);

-- The window's picture, when the person leaves it checked. Private: no policy on storage.objects
-- opens it, so only the secret key reads it (the dashboard does). PNG or JPEG, up to 3 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback', 'feedback', false, 3145728, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

-- ---------- surveys ----------

-- One row per survey. To run one, add a row and turn "active" on; to end it, turn it off.
-- options: [{"id": "new", "pt": "A nova", "en": "The new one"}, ...], 2 to 6 of them.
-- The audience columns are optional: empty means everyone.
create table public.surveys (
  id text primary key check (id ~ '^[a-z0-9-]{1,60}$'),
  question_pt text not null check (length(question_pt) between 1 and 200),
  question_en text not null check (length(question_en) between 1 and 200),
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 6),
  follow_up_pt text check (length(follow_up_pt) <= 200),     -- the optional "why?" after a choice
  follow_up_en text check (length(follow_up_en) <= 200),
  active boolean not null default false,
  min_version text check (min_version ~ '^\d+\.\d+\.\d+$'),               -- shown from this app version on
  first_version_before text check (first_version_before ~ '^\d+\.\d+\.\d+$'), -- only installs that started before this version
  platforms text[] check (platforms <@ array['mac', 'windows', 'linux']),
  langs text[] check (langs <@ array['pt', 'en']),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.surveys is 'Surveys the Tucano app shows. Add a row and turn active on. RLS on, no policies.';

-- One answer per install and survey: answering again replaces it. install_id is a random id the
-- app makes once; it carries no name, email or account.
create table public.survey_answers (
  survey_id text not null references public.surveys (id) on delete cascade,
  install_id uuid not null,
  choice text not null check (length(choice) between 1 and 60),
  comment text check (length(comment) <= 2000),
  app_version text check (length(app_version) <= 40),
  first_version text check (length(first_version) <= 40),
  os text check (length(os) <= 40),
  lang text check (lang in ('pt', 'en')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (survey_id, install_id)
);

comment on table public.survey_answers is 'Answers to the app''s surveys, one per install. RLS on, no policies.';

-- A choice must be one of the survey's options.
create function public.survey_answer_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.surveys s, jsonb_array_elements(s.options) o
    where s.id = new.survey_id and o ->> 'id' = new.choice
  ) then
    raise exception 'unknown choice % for survey %', new.choice, new.survey_id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function public.survey_answer_check() from anon, authenticated, public;

create trigger survey_answer_check before insert or update on public.survey_answers
for each row execute function public.survey_answer_check();

alter table public.surveys enable row level security;
alter table public.survey_answers enable row level security;
revoke all on table public.surveys from anon, authenticated;
revoke all on table public.survey_answers from anon, authenticated;

-- The count, per survey and option. security_invoker: the view reads with the caller's rights, so
-- it can't open what the tables keep closed; and the public roles get no grant on it either.
create view public.survey_results with (security_invoker = true) as
select
  s.id as survey,
  o.ord as position,
  o.value ->> 'id' as choice,
  o.value ->> 'pt' as label,
  count(a.install_id) as answers,
  round(100.0 * count(a.install_id) / nullif(sum(count(a.install_id)) over (partition by s.id), 0), 1) as percent,
  count(a.comment) as comments
from public.surveys s
cross join lateral jsonb_array_elements(s.options) with ordinality as o (value, ord)
left join public.survey_answers a on a.survey_id = s.id and a.choice = o.value ->> 'id'
group by s.id, o.ord, o.value;

revoke all on table public.survey_results from anon, authenticated;
