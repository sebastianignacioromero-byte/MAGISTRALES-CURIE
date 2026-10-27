-- Confirmación de elaboración desde el correo del recetario (función confirmar-elaboracion).
-- Ejecutar una vez en Supabase > SQL Editor.

-- 1) Marca en la receta: fecha/hora en que el recetario acusó recibo para su elaboración.
alter table public.recetas
  add column if not exists elaboracion_confirmada_at timestamptz;

-- 2) Registro de cada aviso recibido desde Zoho Mail. Los que no se pudieron asociar a una
--    receta (revisada = false) se muestran en la vista Pagado para resolverlos a mano.
create table if not exists public.confirmaciones_elaboracion (
  id bigint generated always as identity primary key,
  recibido_at timestamptz not null default now(),
  asunto text,
  remitente text,
  paciente_extraido text,
  resultado text not null,          -- MARCADA | YA_MARCADA | SIN_COINCIDENCIA | VARIAS_COINCIDENCIAS | IGNORADO
  receta_id text,
  candidatas text[],
  revisada boolean not null default false,
  payload jsonb
);

create index if not exists confirmaciones_elaboracion_pendientes
  on public.confirmaciones_elaboracion (recibido_at desc) where not revisada;

-- La función escribe con la service role (no pasa por RLS). Los usuarios con sesión en la app
-- solo pueden leer y marcar como revisada.
alter table public.confirmaciones_elaboracion enable row level security;

drop policy if exists "leer confirmaciones" on public.confirmaciones_elaboracion;
create policy "leer confirmaciones" on public.confirmaciones_elaboracion
  for select to authenticated using (true);

drop policy if exists "marcar revisada" on public.confirmaciones_elaboracion;
create policy "marcar revisada" on public.confirmaciones_elaboracion
  for update to authenticated using (true) with check (true);

revoke update on public.confirmaciones_elaboracion from authenticated;
grant select on public.confirmaciones_elaboracion to authenticated;
grant update (revisada) on public.confirmaciones_elaboracion to authenticated;

-- Para que los avisos sin asociar aparezcan en vivo en la app.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'confirmaciones_elaboracion'
  ) then
    alter publication supabase_realtime add table public.confirmaciones_elaboracion;
  end if;
end $$;
