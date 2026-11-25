-- Bahnstrecken: gefahrene Zugfahrten.
-- Liegt im Supabase-Projekt der Zugsammlung (wmoljumtqipsjmegubuj),
-- neben den Tabellen trains, sightings und leaderboard.
-- Einmal im SQL-Editor von Supabase ausführen.
--
-- Zugang ohne Konto: Jedes Passwort gehört zu einem Bereich (rail_spaces)
-- mit eigenen Fahrten. Die App schickt das Passwort bei jeder Anfrage im
-- Header „x-zugang“ mit; die Policies unten lassen nur die Fahrten des
-- Bereichs durch, zu dem das Passwort passt. Gespeichert wird nur ein
-- bcrypt-Hash, kein Passwort.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.rail_spaces (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  password_hash text not null
);

-- Niemand außer dem SQL-Editor kommt an die Tabelle heran.
alter table public.rail_spaces enable row level security;
revoke all on public.rail_spaces from anon, authenticated;

-- Bereich zum Passwort im Header, sonst null.
create or replace function public.rail_space_id() returns uuid
language sql stable security definer set search_path = ''
as $$
  select s.id
  from public.rail_spaces s,
       lateral (select coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-zugang', '') as pw) h
  where h.pw <> '' and s.password_hash = extensions.crypt(h.pw, s.password_hash)
  limit 1
$$;

-- Für den Passwort-Dialog der App: Name des Bereichs oder null.
create or replace function public.rail_space_name() returns text
language sql stable security definer set search_path = ''
as $$
  select name from public.rail_spaces where id = public.rail_space_id()
$$;

revoke all on function public.rail_space_id() from public;
revoke all on function public.rail_space_name() from public;
grant execute on function public.rail_space_id() to anon;
grant execute on function public.rail_space_name() to anon;

create table if not exists public.rail_trips (
  id          uuid primary key default gen_random_uuid(),
  space_id    uuid not null default public.rail_space_id() references public.rail_spaces (id) on delete cascade,
  -- Die App fragt nur das Jahr ab und speichert den 1. Januar dieses Jahres.
  travel_date date not null default current_date,
  train       text,
  note        text,
  -- Freier Trip-Name, z. B. „Dreiländereck mit Max“. Leer = ohne Trip.
  trip_group  text,
  -- Halte in Reihenfolge: [{ "name": "Bremen Hbf", "lon": 8.81, "lat": 53.08 }, …]
  stops       jsonb not null,
  -- Streckenverlauf auf den Gleisen als [[lon, lat], …] (vereinfacht, 5 Nachkommastellen)
  geometry    jsonb not null,
  length_m    integer not null check (length_m >= 0),
  created_at  timestamptz not null default now()
);

create index if not exists rail_trips_space_date on public.rail_trips (space_id, travel_date desc);

alter table public.rail_trips enable row level security;

-- (select …) sorgt dafür, dass das Passwort nur einmal pro Anfrage geprüft wird.
create policy "rail_trips mit Passwort" on public.rail_trips
  for all to anon
  using (space_id = (select public.rail_space_id()))
  with check (space_id = (select public.rail_space_id()));

-- Rechte für die Daten-API: Supabase vergibt sie für neue Tabellen nicht mehr
-- automatisch.
revoke all on public.rail_trips from anon, authenticated;
grant select, insert, update, delete on public.rail_trips to anon;
grant all on public.rail_trips to service_role;
grant all on public.rail_spaces to service_role;

-- Bereiche anlegen – Passwörter nur hier im SQL-Editor eintippen, nie ins Repo:
--   insert into public.rail_spaces (name, password_hash)
--   values ('Name', extensions.crypt('passwort', extensions.gen_salt('bf')));
-- Passwort ändern:
--   update public.rail_spaces set password_hash = extensions.crypt('neu', extensions.gen_salt('bf'))
--   where name = 'Name';
