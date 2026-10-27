-- Precios desde el correo de cotización del recetario (función confirmar-elaboracion?tipo=cotizacion).
-- Ejecutar una vez en Supabase > SQL Editor (después de 20261027000000_elaboracion_confirmada.sql).

alter table public.confirmaciones_elaboracion
  add column if not exists tipo text not null default 'ELABORACION',  -- ELABORACION | COTIZACION
  add column if not exists monto integer,                             -- Precio Lista c/IVA leído del correo
  add column if not exists costo integer;                             -- Precio Final s/IVA leído del correo
