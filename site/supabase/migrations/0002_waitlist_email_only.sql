-- The form asks only for the email: the name becomes optional.
alter table public.waitlist alter column name drop not null;
alter table public.waitlist drop constraint if exists waitlist_name_check;
alter table public.waitlist add constraint waitlist_name_check check (name is null or length(name) between 1 and 120);
