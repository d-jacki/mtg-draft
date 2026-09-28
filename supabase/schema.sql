-- Schema Supabase per la lega MTG Draft. Da eseguire una volta nel SQL Editor del progetto.
--
-- Modello: ogni lega ha un PIN. I documenti (giocatori e tornei) sono JSON in league_docs.
-- - Lettura: libera con la chiave pubblica (anon/publishable) — sono risultati di tornei tra amici.
-- - Scrittura: solo tramite la funzione league_push, che verifica il PIN. Nessuna policy di insert/update/delete,
--   quindi con la sola chiave pubblica non si può modificare né cancellare niente.
-- - Conflitti: vince il documento con updated_at più recente (last-write-wins, come nell'app).

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pin_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.league_docs (
  league_id uuid not null references public.leagues(id) on delete cascade,
  id text not null,
  kind text not null check (kind in ('player', 'tournament')),
  data jsonb not null,
  updated_at bigint not null,
  primary key (league_id, id)
);
create index if not exists league_docs_updated on public.league_docs (league_id, updated_at);

-- leagues: RLS attiva e nessuna policy → il pin_hash non è leggibile dal client
alter table public.leagues enable row level security;
alter table public.league_docs enable row level security;

-- Permesso esplicito: i progetti nuovi possono avere disattivata l'esposizione automatica delle tabelle
grant select on public.league_docs to anon, authenticated;

drop policy if exists "lettura documenti lega" on public.league_docs;
create policy "lettura documenti lega" on public.league_docs
  for select to anon, authenticated using (true);

create or replace function public.league_push(p_league uuid, p_pin text, p_docs jsonb)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  n integer;
begin
  if not exists (select 1 from leagues where id = p_league and pin_hash = crypt(p_pin, pin_hash)) then
    raise exception 'PIN non valido' using errcode = '28P01';
  end if;

  insert into league_docs (league_id, id, kind, data, updated_at)
  select p_league, d->>'id', d->>'kind', d->'data', (d->>'updated_at')::bigint
  from jsonb_array_elements(p_docs) as d
  on conflict (league_id, id) do update
    set kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at
    where league_docs.updated_at < excluded.updated_at;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.league_push(uuid, text, jsonb) from public;
grant execute on function public.league_push(uuid, text, jsonb) to anon, authenticated;

-- ── Creazione della lega ──
-- Cambia nome e PIN, esegui, e copia l'id restituito: va inserito nell'app (Lega → Dati e sync).
--
-- insert into public.leagues (name, pin_hash)
-- values ('Draft del giovedì', extensions.crypt('1234', extensions.gen_salt('bf')))
-- returning id;
--
-- Per cambiare PIN:
-- update public.leagues set pin_hash = extensions.crypt('nuovo-pin', extensions.gen_salt('bf')) where id = '...';
