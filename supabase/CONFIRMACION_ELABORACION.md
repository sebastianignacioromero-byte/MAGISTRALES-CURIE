# Confirmación automática de elaboración (correo del recetario → plataforma)

Cuando el recetario responde el correo de cotización con **"acuso recibo para su elaboración"**,
la receta queda marcada con ✅ en la columna **Elaboración** de la vista **Pagado**, sin hacer nada.

```
Zoho Mail (regla) ──webhook──▶ Supabase Edge Function "confirmar-elaboracion" ──▶ recetas.elaboracion_confirmada_at
                                                                   └──▶ confirmaciones_elaboracion (registro)
```

## Cómo encuentra la receta

1. Saca el paciente del asunto: `RE: COTIZACION RECETA "JAVIERA CUETO" (CONVENIO …)` → `JAVIERA CUETO`.
2. Busca recetas en estado **Pagado** cuyo nombre contenga todas esas palabras (sin importar
   mayúsculas ni tildes). Si el remitente es `@sb.cl`, solo entre recetas de **Salcobrand**.
3. Si hay **exactamente una** pendiente, la marca. Si hay 0 o varias, no marca nada y el aviso
   aparece en la vista Pagado para resolverlo a mano ("Ya lo revisé" lo oculta).

## Instalación (una sola vez)

1. **Base de datos** — Supabase › SQL Editor › pegar y ejecutar
   `supabase/migrations/20261027000000_elaboracion_confirmada.sql`.
2. **Función** — con la CLI de Supabase, desde la raíz del repo:
   ```bash
   supabase login
   supabase link --project-ref ufcjxcwwosmznjgjealo
   supabase secrets set CONFIRMACION_TOKEN=<una clave larga al azar>
   supabase functions deploy confirmar-elaboracion --no-verify-jwt
   ```
   URL resultante:
   `https://ufcjxcwwosmznjgjealo.supabase.co/functions/v1/confirmar-elaboracion?token=<CONFIRMACION_TOKEN>`
3. **Zoho Mail** — crear un *Outgoing Webhook* (Configuración › Developer Space › Outgoing Webhooks;
   el nombre del menú puede variar) con método **POST** a la URL anterior y condición:
   - Asunto contiene `COTIZACION RECETA`, **y**
   - Contenido contiene `acuso recibo`.

   Si tu plan de Zoho Mail no tiene webhooks salientes, lo mismo se arma en **Zoho Flow**:
   disparador "Zoho Mail › Nuevo correo" con ese filtro → acción "Webhook / HTTP POST" a la URL,
   enviando `subject`, `fromAddress` y `summary`.

## Probar

```bash
curl -X POST "https://ufcjxcwwosmznjgjealo.supabase.co/functions/v1/confirmar-elaboracion?token=<TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"subject":"RE: COTIZACION RECETA \"JAVIERA CUETO\" (CONVENIO 180002538) FARMACIA CURIE","fromAddress":"ventasrecetario@sb.cl","summary":"Buenos días estimados, acuso recibo para su elaboración."}'
```

Respuesta: `{"resultado":"MARCADA","receta_id":"…"}` (o `SIN_COINCIDENCIA`, `VARIAS_COINCIDENCIAS`,
`YA_MARCADA`, `IGNORADO`). Cada aviso queda en la tabla `confirmaciones_elaboracion`, con el
`payload` recibido, para revisar qué manda Zoho si algo no calza.

Tests de la lógica: `node --experimental-strip-types --test supabase/functions/confirmar-elaboracion/logica.test.ts`

## Seguridad

- La función usa la *service role key*, que Supabase le inyecta solo a ella: **nunca** va en `index.html`
  (este repo es público).
- Sin el `?token=` correcto responde 401. Si el token se filtra, cambiarlo con `supabase secrets set`
  y actualizar la URL en Zoho.
