# Confirmación automática de elaboración (correo del recetario → plataforma)

Cuando el recetario responde el correo de cotización con **"acuso recibo para su elaboración"**,
la receta queda marcada con ✅ en la columna **Elaboración** de la vista **Pagado**.

```
Zoho Mail (regla) ──aviso──▶ Supabase "confirmar-elaboracion" ──▶ marca la receta
```

## Instalación paso a paso (todo desde el navegador, una sola vez)

Necesitas entrar a <https://supabase.com/dashboard> con la cuenta dueña del proyecto de la
plataforma (`ufcjxcwwosmznjgjealo`).

### Paso 1 — Agregar la columna nueva (2 min)

1. En el menú izquierdo de Supabase: **SQL Editor** → **New query**.
2. Abre [`supabase/migrations/20261027000000_elaboracion_confirmada.sql`](migrations/20261027000000_elaboracion_confirmada.sql),
   copia **todo** el texto y pégalo.
3. Botón **Run**. Debe decir *Success. No rows returned*.

### Paso 2 — Crear la clave secreta (1 min)

Es una contraseña que solo conocerán Supabase y Zoho, para que nadie más pueda marcar recetas.

1. Inventa una clave larga sin espacios, por ejemplo `curie-elab-8f3k29dmx71qpz`. Anótala.
2. Menú izquierdo: **Edge Functions** → **Secrets** → **Add new secret**.
   - Name: `CONFIRMACION_TOKEN`
   - Value: la clave que inventaste
3. **Save**.

### Paso 3 — Crear la función (3 min)

1. Menú izquierdo: **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Nombre de la función: `confirmar-elaboracion` (exactamente así).
3. Borra el código de ejemplo. Abre
   [`supabase/functions/confirmar-elaboracion/index.ts`](functions/confirmar-elaboracion/index.ts),
   botón **Raw**, copia **todo** y pégalo en el editor.
4. **Deploy function**.
5. Ya creada, entra a la función → **Details** (o **Settings**) → desactiva
   **Enforce JWT verification** (Verify JWT) → **Save**.
   *(Zoho no sabe enviar la llave de Supabase; por eso la protege la clave del paso 2.)*

Tu dirección queda así (reemplaza `TU_CLAVE`):

```
https://ufcjxcwwosmznjgjealo.supabase.co/functions/v1/confirmar-elaboracion?token=TU_CLAVE
```

**Comprobar:** pega esa dirección en el navegador. Debe mostrar `{"ok":true}`.
Si muestra `token inválido`, la clave no coincide con la del paso 2.

### Paso 4 — Avisar desde Zoho Mail (5 min)

En Zoho Mail: ⚙ **Configuración** → **Developer Space** (o **Integraciones**) → **Outgoing Webhooks**
→ **Crear / Add**:

- URL: la dirección del paso 3 (con `?token=TU_CLAVE`)
- Método: **POST**
- Condiciones (todas deben cumplirse):
  - **Asunto** contiene `COTIZACION RECETA`
  - **Contenido** contiene `acuso recibo`
- Guardar.

> Si no encuentras "Outgoing Webhooks" (depende del plan de Zoho), se hace igual en **Zoho Flow**:
> disparador *Zoho Mail → New email* con esas condiciones → acción *Webhook (POST)* a la misma
> dirección, enviando `subject`, `fromAddress` y `summary`.

### Paso 5 — Probar con un correo real

Cuando llegue la próxima confirmación del recetario, la receta (si está en **Pagado**) debe quedar
con ✅ sola. Si no se marca, en Supabase → **Table Editor** → `confirmaciones_elaboracion` se ve
qué llegó y por qué no calzó.

## Cómo encuentra la receta

1. Saca el paciente del asunto: `RE: COTIZACION RECETA "JAVIERA CUETO" (CONVENIO …)` → `JAVIERA CUETO`.
2. Busca recetas en **Pagado** cuyo nombre contenga esas palabras (sin importar mayúsculas ni tildes).
   Si el remitente es `@sb.cl`, solo entre recetas de **Salcobrand**.
3. Si hay **exactamente una** sin confirmar, la marca. Si hay 0 o varias, no marca nada y el aviso
   aparece arriba en la vista Pagado para resolverlo a mano ("Ya lo revisé" lo oculta).

## Para desarrolladores

- Prueba manual: `curl -X POST "<dirección con token>" -H "Content-Type: application/json" -d '{"subject":"RE: COTIZACION RECETA \"JAVIERA CUETO\" (CONVENIO 180002538) FARMACIA CURIE","fromAddress":"ventasrecetario@sb.cl","summary":"acuso recibo para su elaboración"}'`
  → `{"resultado":"MARCADA", ...}` / `SIN_COINCIDENCIA` / `VARIAS_COINCIDENCIAS` / `YA_MARCADA` / `IGNORADO`.
- Tests: `node --experimental-strip-types --test supabase/functions/confirmar-elaboracion/index.test.ts`
- Con la CLI en vez del panel: `supabase functions deploy confirmar-elaboracion --no-verify-jwt`.
- La *service role key* la usa solo la función (Supabase se la entrega); **nunca** va en `index.html`,
  que es público. Si la clave del paso 2 se filtra, cámbiala en Secrets y en Zoho.
