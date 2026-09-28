-- Schema Supabase per la lega MTG Draft. Si esegue nel SQL Editor del progetto; è rieseguibile
-- (dopo un aggiornamento dell'app basta rilanciarlo tutto: i dati restano).
--
-- Modello: ogni lega ha un PIN. I documenti (giocatori e tornei) sono JSON in league_docs; il torneo in
-- corso sta in league_live.
-- - Lettura: libera con la chiave pubblica (anon/publishable) — sono risultati di tornei tra amici, e URL e
--   chiave sono comunque dentro l'app (js/config.js).
-- - Scrittura: solo tramite league_push / league_live_push, che verificano il PIN. Nessuna policy di
--   insert/update/delete, quindi con la sola chiave pubblica non si può modificare né cancellare niente.
-- - PIN: dopo 10 tentativi sbagliati in 15 minuti la lega rifiuta le scritture per 15 minuti (anti forza bruta).
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

create table if not exists public.league_live (
  league_id uuid primary key references public.leagues(id) on delete cascade,
  data jsonb,
  updated_at bigint not null
);

create table if not exists public.league_pin_failures (
  league_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists league_pin_failures_recent on public.league_pin_failures (league_id, at);

-- RLS ovunque. leagues e league_pin_failures non hanno policy: invisibili al client (pin_hash compreso).
alter table public.leagues enable row level security;
alter table public.league_docs enable row level security;
alter table public.league_live enable row level security;
alter table public.league_pin_failures enable row level security;

-- Permessi espliciti: i progetti nuovi possono avere disattivata l'esposizione automatica delle tabelle
grant select on public.league_docs to anon, authenticated;
grant select on public.league_live to anon, authenticated;

drop policy if exists "lettura documenti lega" on public.league_docs;
create policy "lettura documenti lega" on public.league_docs
  for select to anon, authenticated using (true);
drop policy if exists "lettura torneo live" on public.league_live;
create policy "lettura torneo live" on public.league_live
  for select to anon, authenticated using (true);

-- ── Verifica del PIN con limite di tentativi ──
-- Restituisce null se il PIN è giusto, altrimenti il messaggio d'errore. Non solleva eccezioni:
-- un'eccezione annullerebbe anche la registrazione del tentativo fallito.
create or replace function public.league_check_pin(p_league uuid, p_pin text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if (select count(*) from league_pin_failures
      where league_id = p_league and at > now() - interval '15 minutes') >= 10 then
    return 'Troppi PIN sbagliati: riprova tra 15 minuti';
  end if;
  if exists (select 1 from leagues where id = p_league and pin_hash = crypt(coalesce(p_pin, ''), pin_hash)) then
    return null;
  end if;
  insert into league_pin_failures (league_id) values (p_league);
  delete from league_pin_failures where at < now() - interval '1 day';
  return 'PIN non valido';
end;
$$;
revoke all on function public.league_check_pin(uuid, text) from public, anon, authenticated;

-- ── Scrittura dei documenti (giocatori e tornei) ──
-- Le versioni precedenti restituivano integer: si ricrea con il nuovo tipo di ritorno.
drop function if exists public.league_push(uuid, text, jsonb);
create function public.league_push(p_league uuid, p_pin text, p_docs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  err text;
  n integer;
begin
  err := league_check_pin(p_league, p_pin);
  if err is not null then
    return jsonb_build_object('error', err);
  end if;

  insert into league_docs (league_id, id, kind, data, updated_at)
  select p_league, d->>'id', d->>'kind', d->'data', (d->>'updated_at')::bigint
  from jsonb_array_elements(coalesce(p_docs, '[]'::jsonb)) as d
  on conflict (league_id, id) do update
    set kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at
    where league_docs.updated_at < excluded.updated_at;

  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'written', n);
end;
$$;
revoke all on function public.league_push(uuid, text, jsonb) from public;
grant execute on function public.league_push(uuid, text, jsonb) to anon, authenticated;

-- ── Torneo live ──
drop function if exists public.league_live_push(uuid, text, jsonb, bigint);
create function public.league_live_push(p_league uuid, p_pin text, p_data jsonb, p_updated_at bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  err text;
begin
  err := league_check_pin(p_league, p_pin);
  if err is not null then
    return jsonb_build_object('error', err);
  end if;

  insert into league_live (league_id, data, updated_at)
  values (p_league, p_data, p_updated_at)
  on conflict (league_id) do update
    set data = excluded.data, updated_at = excluded.updated_at
    where league_live.updated_at < excluded.updated_at;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.league_live_push(uuid, text, jsonb, bigint) from public;
grant execute on function public.league_live_push(uuid, text, jsonb, bigint) to anon, authenticated;

-- Realtime: i telefoni collegati ricevono ogni modifica del torneo live all'istante
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'league_live') then
    alter publication supabase_realtime add table public.league_live;
  end if;
end;
$$;

-- ── Creazione della lega ──
-- Cambia nome e PIN, esegui, e copia l'id restituito in js/config.js.
-- Il PIN protegge la scrittura: meglio almeno 6 caratteri, non solo 4 cifre.
--
-- insert into public.leagues (name, pin_hash)
-- values ('Draft del giovedì', extensions.crypt('il-tuo-pin', extensions.gen_salt('bf')))
-- returning id;
--
-- Per cambiare PIN:
-- update public.leagues set pin_hash = extensions.crypt('nuovo-pin', extensions.gen_salt('bf')) where id = '...';
