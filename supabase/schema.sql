-- Schema Supabase per la lega MTG Draft. Si esegue nel SQL Editor del progetto; è rieseguibile
-- (dopo un aggiornamento dell'app basta rilanciarlo tutto: i dati restano).
--
-- Modello: ogni lega ha un PIN. I documenti (giocatori e tornei) sono JSON in league_docs; il torneo in
-- corso sta in league_live.
-- - Lettura: libera con la chiave pubblica (anon/publishable) — sono risultati di tornei tra amici, e URL e
--   chiave sono comunque dentro l'app (js/config.js).
-- - Scrittura: solo tramite league_push / league_live_sync, che verificano il PIN. Nessuna policy di
--   insert/update/delete, quindi con la sola chiave pubblica non si può modificare né cancellare niente.
-- - PIN: dopo 10 tentativi sbagliati in 15 minuti la lega rifiuta le scritture per 15 minuti (anti forza bruta).
-- - Conflitti: vince il documento con updated_at più recente (last-write-wins, come nell'app).
-- - Torneo live: più telefoni con il PIN lo gestiscono insieme. Ogni scrittura dichiara la revisione da cui
--   parte (compare-and-swap): se nel frattempo un altro telefono ha scritto, league_live_sync rifiuta e
--   restituisce lo stato attuale, e l'app riapplica sopra le sue modifiche (vedi js/live.js).
-- - Cronologia: ogni versione del torneo live resta in league_live_history per 14 giorni (ripristinabile dall'app).
-- - PIN master (facoltativo): sblocca nell'app ripristini, correzioni e eliminazioni. Il server lo verifica
--   (league_verify_master) ma il blocco è solo nell'app: protegge dagli errori, non da chi ha già il PIN normale.

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
-- seq: numero assegnato dal server a ogni scrittura, sempre crescente. L'app scarica "da seq in poi": con
-- updated_at (l'orologio del telefono che ha scritto) una modifica caricata in ritardo andava persa.
create sequence if not exists public.league_docs_seq;
alter table public.league_docs add column if not exists seq bigint;
update public.league_docs set seq = nextval('public.league_docs_seq') where seq is null;
alter table public.league_docs alter column seq set default nextval('public.league_docs_seq');
alter table public.league_docs alter column seq set not null;
create index if not exists league_docs_seq_idx on public.league_docs (league_id, seq);

create table if not exists public.league_live (
  league_id uuid primary key references public.leagues(id) on delete cascade,
  data jsonb,
  updated_at bigint not null,
  rev bigint not null default 0
);
-- Leghe create prima del torneo condiviso
alter table public.league_live add column if not exists rev bigint not null default 0;
-- PIN master facoltativo (vedi in fondo come impostarlo)
alter table public.leagues add column if not exists admin_pin_hash text;

create table if not exists public.league_live_history (
  league_id uuid not null references public.leagues(id) on delete cascade,
  rev bigint not null,
  data jsonb not null,
  updated_at bigint not null,
  at timestamptz not null default now(),
  primary key (league_id, rev)
);
create index if not exists league_live_history_at on public.league_live_history (league_id, at);

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
alter table public.league_live_history enable row level security;

-- Permessi espliciti: i progetti nuovi possono avere disattivata l'esposizione automatica delle tabelle
grant select on public.league_docs to anon, authenticated;
grant select on public.league_live to anon, authenticated;
grant select on public.league_live_history to anon, authenticated;

drop policy if exists "lettura documenti lega" on public.league_docs;
create policy "lettura documenti lega" on public.league_docs
  for select to anon, authenticated using (true);
drop policy if exists "lettura torneo live" on public.league_live;
create policy "lettura torneo live" on public.league_live
  for select to anon, authenticated using (true);
drop policy if exists "lettura cronologia live" on public.league_live_history;
create policy "lettura cronologia live" on public.league_live_history
  for select to anon, authenticated using (true);

-- ── Verifica del PIN con limite di tentativi ──
-- Restituisce null se il PIN è giusto, altrimenti il messaggio d'errore. Non solleva eccezioni:
-- un'eccezione annullerebbe anche la registrazione del tentativo fallito.
-- Il lock (per lega, fino alla fine della transazione) mette in fila le scritture: il conteggio dei tentativi non
-- si aggira con richieste in parallelo, e i seq di league_docs diventano visibili nello stesso ordine in cui
-- sono assegnati (altrimenti chi scarica "da seq in poi" potrebbe saltarne uno ancora da confermare).
create or replace function public.league_check_pin(p_league uuid, p_pin text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('league:' || p_league::text, 0));
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
    set kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at, seq = nextval('league_docs_seq')
    where league_docs.updated_at < excluded.updated_at;

  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'written', n);
end;
$$;
revoke all on function public.league_push(uuid, text, jsonb) from public;
grant execute on function public.league_push(uuid, text, jsonb) to anon, authenticated;

-- ── Torneo live ──
-- Scrittura a revisioni. p_rev = revisione su cui si basa lo stato inviato (null = crea o sostituisce il torneo
-- live). p_data null = chiude il torneo live, ma solo se è ancora quello con id p_id. Ogni scrittura incrementa
-- rev; updated_at resta crescente anche se gli orologi dei telefoni non sono allineati.
drop function if exists public.league_live_sync(uuid, text, text, jsonb, bigint, bigint);
create function public.league_live_sync(p_league uuid, p_pin text, p_id text, p_data jsonb, p_rev bigint, p_updated_at bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  err text;
  cur public.league_live%rowtype;
begin
  err := league_check_pin(p_league, p_pin);
  if err is not null then
    return jsonb_build_object('error', err);
  end if;

  -- La riga esiste sempre prima del lock: due telefoni non possono crearla insieme
  insert into league_live (league_id, data, updated_at, rev) values (p_league, null, 0, 0)
  on conflict (league_id) do nothing;
  select * into cur from league_live where league_id = p_league for update;

  if p_data is null then
    if cur.data is null or cur.data->>'id' is distinct from p_id then
      return jsonb_build_object('ok', true, 'cleared', false, 'rev', cur.rev);
    end if;
  elsif p_rev is not null and cur.rev <> p_rev then
    return jsonb_build_object('conflict', true, 'rev', cur.rev, 'data', cur.data, 'updated_at', cur.updated_at);
  end if;

  update league_live
    set data = p_data, rev = cur.rev + 1, updated_at = greatest(p_updated_at, cur.updated_at + 1)
    where league_id = p_league;
  return jsonb_build_object('ok', true, 'cleared', p_data is null, 'rev', cur.rev + 1);
end;
$$;
revoke all on function public.league_live_sync(uuid, text, text, jsonb, bigint, bigint) from public;
grant execute on function public.league_live_sync(uuid, text, text, jsonb, bigint, bigint) to anon, authenticated;

-- Versione precedente (ultima scrittura vince), per le app non ancora aggiornate: incrementa anche rev,
-- così i telefoni aggiornati si accorgono della scrittura
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

  insert into league_live (league_id, data, updated_at, rev)
  values (p_league, p_data, p_updated_at, 1)
  on conflict (league_id) do update
    set data = excluded.data, updated_at = excluded.updated_at, rev = league_live.rev + 1
    where league_live.updated_at < excluded.updated_at;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.league_live_push(uuid, text, jsonb, bigint) from public;
grant execute on function public.league_live_push(uuid, text, jsonb, bigint) to anon, authenticated;

-- Cronologia: ogni nuova revisione del torneo live viene copiata in league_live_history
create or replace function public.league_live_log()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.data is not null and (tg_op = 'INSERT' or new.rev is distinct from old.rev) then
    insert into league_live_history (league_id, rev, data, updated_at)
    values (new.league_id, new.rev, new.data, new.updated_at)
    on conflict (league_id, rev) do update set data = excluded.data, updated_at = excluded.updated_at, at = now();
    delete from league_live_history where league_id = new.league_id and at < now() - interval '14 days';
  end if;
  return new;
end;
$$;
revoke all on function public.league_live_log() from public, anon, authenticated;
drop trigger if exists league_live_log on public.league_live;
create trigger league_live_log after insert or update on public.league_live
  for each row execute function public.league_live_log();

-- ── PIN master ──
-- La lega ha un PIN master? Dice solo se esiste, mai quale sia. now = ora del server in millisecondi: l'app la usa
-- per contare il timer condiviso sullo stesso orologio anche se un telefono ha l'ora sbagliata.
create or replace function public.league_info(p_league uuid)
returns jsonb
language sql
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object('master', admin_pin_hash is not null,
                            'now', (extract(epoch from clock_timestamp()) * 1000)::bigint)
  from leagues where id = p_league;
$$;
revoke all on function public.league_info(uuid) from public;
grant execute on function public.league_info(uuid) to anon, authenticated;

-- Verifica del PIN master, con lo stesso limite di tentativi del PIN normale
create or replace function public.league_verify_master(p_league uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('league:' || p_league::text, 0));
  if (select count(*) from league_pin_failures
      where league_id = p_league and at > now() - interval '15 minutes') >= 10 then
    return jsonb_build_object('error', 'Troppi PIN sbagliati: riprova tra 15 minuti');
  end if;
  if not exists (select 1 from leagues where id = p_league and admin_pin_hash is not null) then
    return jsonb_build_object('error', 'Questa lega non ha un PIN master (vedi supabase/schema.sql)');
  end if;
  if exists (select 1 from leagues where id = p_league and admin_pin_hash = crypt(coalesce(p_pin, ''), admin_pin_hash)) then
    return jsonb_build_object('ok', true);
  end if;
  insert into league_pin_failures (league_id) values (p_league);
  return jsonb_build_object('error', 'PIN master errato');
end;
$$;
revoke all on function public.league_verify_master(uuid, text) from public;
grant execute on function public.league_verify_master(uuid, text) to anon, authenticated;

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
--
-- PIN master (facoltativo, diverso dal PIN normale; null = nessun PIN master, tutto sbloccato per chi ha il PIN):
-- update public.leagues set admin_pin_hash = extensions.crypt('pin-master', extensions.gen_salt('bf')) where id = '...';
