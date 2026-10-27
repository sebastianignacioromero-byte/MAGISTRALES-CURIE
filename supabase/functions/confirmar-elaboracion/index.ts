/* Recibe los webhooks de Zoho Mail con las respuestas del recetario al correo
   "COTIZACION RECETA "<PACIENTE>" ...":

   - ?tipo=cotizacion — correo con la tabla de precios: llena en la receta (en Cotizado) el
     costo = "Precio Final s/IVA" y el monto (venta) = "Precio Lista c/IVA".
   - sin tipo — "acuso recibo para su elaboración": marca la receta (en Pagado) con
     `elaboracion_confirmada_at`.

   La app lo muestra al instante porque ya escucha los cambios de `recetas` por realtime.
   Cada aviso queda registrado en `confirmaciones_elaboracion`; los que no se pudieron asociar a
   una receta (0 o varias coincidencias) aparecen en la vista Cotizado o Pagado para revisarlos
   a mano.

   Seguridad: la URL lleva ?token=<CONFIRMACION_TOKEN> (secreto de la función). Se despliega con
   verify_jwt = false (ver supabase/config.toml) porque Zoho Mail no manda el JWT de Supabase.

   Todo va en este único archivo para poder pegarlo tal cual en el editor de Edge Functions del
   panel de Supabase. La parte de lógica pura se prueba con
   `node --experimental-strip-types --test supabase/functions/confirmar-elaboracion/index.test.ts` (en Node no
   existe `Deno`, así que el servidor no arranca). */

/* ---------------- lógica pura ---------------- */

export type RecetaCandidata = {
  id: string;
  paciente_nombre: string;
  recetario: string;
  estado: string;
  elaboracion_confirmada_at?: string | null;
  monto?: number | null;
  costo?: number | null;
};

export type Criterio = {
  estado: string;
  pendiente: (r: RecetaCandidata) => boolean;
};

/* Elaboración: recetas en Pagado aún sin confirmar. */
export const CRITERIO_ELABORACION: Criterio = {
  estado: "PAGADO",
  pendiente: (r) => !r.elaboracion_confirmada_at,
};

/* Cotización: recetas en Cotizado sin monto ni costo (no se pisa lo que ya se escribió). */
export const CRITERIO_COTIZACION: Criterio = {
  estado: "COTIZADO",
  pendiente: (r) => !(Number(r.monto) > 0) && !(Number(r.costo) > 0),
};

export type Resultado =
  | { tipo: "MARCADA"; receta: RecetaCandidata }
  | { tipo: "YA_MARCADA"; receta: RecetaCandidata }
  | { tipo: "SIN_COINCIDENCIA" }
  | { tipo: "VARIAS_COINCIDENCIAS"; ids: string[] };

/* Dominio del remitente -> valor de `recetas.recetario` en la plataforma. */
const RECETARIO_POR_DOMINIO: Record<string, string> = {
  "sb.cl": "Salcobrand",
};

/* Texto que debe traer el cuerpo para considerarlo una confirmación de elaboración
   ("Buenos días estimados, acuso recibo para su elaboración."). */
const FRASES_CONFIRMACION = ["acuso recibo", "para su elaboracion"];

export function normalizar(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* "RE: COTIZACION RECETA "JAVIERA CUETO" (CONVENIO 180002538) FARMACIA CURIE" -> "JAVIERA CUETO" */
export function extraerPaciente(asunto: string | null | undefined): string | null {
  if (!asunto) return null;
  const m = String(asunto).match(/COTIZACI[OÓ]N\s+RECETA\s+["“”'«]\s*([^"“”'»]+?)\s*["“”'»]/i);
  return m ? m[1].trim() : null;
}

export function recetarioDesdeRemitente(remitente: string | null | undefined): string | null {
  const dom = String(remitente || "").toLowerCase().match(/@([a-z0-9.-]+)/);
  if (!dom) return null;
  for (const [sufijo, recetario] of Object.entries(RECETARIO_POR_DOMINIO)) {
    if (dom[1] === sufijo || dom[1].endsWith("." + sufijo)) return recetario;
  }
  return null;
}

/* HTML (o texto) del correo -> texto plano, sin el mensaje citado de más abajo
   ("-------- Mensaje original --------", "De: ...", "El ... escribió:"), para no leer la
   tabla de precios o el "acuso recibo" de un correo anterior del mismo hilo. */
export function textoPropio(cuerpo: string | null | undefined): string {
  if (!cuerpo) return "";
  const texto = String(cuerpo)
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
  const cita = texto.search(
    /-{3,}\s*(mensaje original|original message)|^\s*(de|from)\s*:|-{3,}\s*(el|on)\s[^\n]*(escribi|wrote)|^\s*(el|on)\s[^\n]*(escribi[oó]|wrote)\s*:/im,
  );
  return cita >= 0 ? texto.slice(0, cita) : texto;
}

/* Si el aviso no trae el cuerpo del correo, se confía en la regla de Zoho Mail (que ya filtra
   por "acuso recibo"); si lo trae, debe contener la frase. */
export function esConfirmacion(cuerpo: string | null | undefined): boolean {
  if (!cuerpo) return true;
  const t = normalizar(textoPropio(cuerpo));
  return FRASES_CONFIRMACION.some((f) => t.includes(f));
}

/* "16090", "16.090", "$16.090", "9654,5" -> número entero de pesos */
function aNumero(s: string): number {
  const limpio = s.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Math.round(parseFloat(limpio));
  return isNaN(n) ? 0 : n;
}

function valoresDe(texto: string, etiqueta: RegExp): number[] {
  const re = new RegExp(etiqueta.source + "[^0-9\\n]{0,15}\\$?\\s*([0-9][0-9.,]*)", "gi");
  return [...texto.matchAll(re)].map((m) => aNumero(m[1]));
}

export type Precios = { monto: number; costo: number };

/* Tabla del recetario:
     Precio Lista c/IVA   16090   -> monto (venta al paciente)
     Precio Final s/IVA    8113   -> costo
   Devuelve null si falta alguno, o si hay más de una tabla (varios productos): eso queda para
   revisarlo a mano. */
export function leerPrecios(cuerpo: string | null | undefined): Precios | null {
  const texto = textoPropio(cuerpo).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const listas = valoresDe(texto, /precio\s*lista\s*c\s*\/?\s*iva/);
  const finales = valoresDe(texto, /precio\s*final\s*s\s*\/?\s*iva/);
  if (listas.length !== 1 || finales.length !== 1) return null;
  if (!(listas[0] > 0) || !(finales[0] > 0)) return null;
  return { monto: listas[0], costo: finales[0] };
}

/* Todas las palabras del nombre del asunto deben estar en el nombre guardado
   ("JAVIERA CUETO" calza con "Javiera Cueto Pérez"). */
function calzaNombre(nombreAsunto: string, nombreGuardado: string): boolean {
  const buscadas = normalizar(nombreAsunto).split(" ").filter(Boolean);
  const guardadas = new Set(normalizar(nombreGuardado).split(" ").filter(Boolean));
  return buscadas.length > 0 && buscadas.every((p) => guardadas.has(p));
}

/* Solo recetas en el estado del criterio (Pagado para elaboración, Cotizado para cotización) y,
   si se conoce el recetario por el remitente, solo de ese recetario. Se marca solo si hay
   exactamente una pendiente. */
export function buscarReceta(
  recetas: RecetaCandidata[],
  paciente: string,
  recetario: string | null,
  criterio: Criterio = CRITERIO_ELABORACION,
): Resultado {
  const candidatas = recetas.filter((r) =>
    r.estado === criterio.estado &&
    (!recetario || r.recetario === recetario) &&
    calzaNombre(paciente, r.paciente_nombre)
  );
  const pendientes = candidatas.filter(criterio.pendiente);
  if (pendientes.length === 1) return { tipo: "MARCADA", receta: pendientes[0] };
  if (pendientes.length > 1) return { tipo: "VARIAS_COINCIDENCIAS", ids: pendientes.map((r) => r.id) };
  // correo repetido (Zoho reintenta, o llegó dos veces): no es un error
  if (candidatas.length === 1) return { tipo: "YA_MARCADA", receta: candidatas[0] };
  if (candidatas.length > 1) return { tipo: "VARIAS_COINCIDENCIAS", ids: candidatas.map((r) => r.id) };
  return { tipo: "SIN_COINCIDENCIA" };
}

/* Zoho Mail puede mandar JSON o formulario y los nombres de campo varían; se toma el primero
   que exista. */
export function campo(payload: Record<string, unknown>, nombres: string[]): string {
  for (const n of nombres) {
    const v = payload[n];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).address === "string") {
      return (v as Record<string, string>).address;
    }
  }
  return "";
}

export function compararSeguro(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------- servidor (solo en Supabase / Deno) ---------------- */

declare const Deno: any;

if (typeof Deno !== "undefined") {
  const { createClient } = await import("npm:@supabase/supabase-js@2");
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const TOKEN = Deno.env.get("CONFIRMACION_TOKEN") || "";

  function responder(status: number, cuerpo: Record<string, unknown>): Response {
    return new Response(JSON.stringify(cuerpo), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function leerPayload(req: Request): Promise<Record<string, unknown>> {
    const texto = await req.text();
    if (!texto) return {};
    try {
      return JSON.parse(texto);
    } catch {
      // formulario (application/x-www-form-urlencoded)
      return Object.fromEntries(new URLSearchParams(texto));
    }
  }

  async function registrar(fila: Record<string, unknown>): Promise<void> {
    const { error } = await sb.from("confirmaciones_elaboracion").insert(fila);
    if (error) console.error("No se pudo registrar el aviso:", error.message);
  }

  type Base = Record<string, unknown>;

  async function procesarElaboracion(base: Base, paciente: string, recetario: string | null, cuerpo: string) {
    if (!esConfirmacion(cuerpo)) {
      await registrar({ ...base, resultado: "IGNORADO", revisada: true });
      return responder(200, { resultado: "IGNORADO" });
    }
    const { data, error } = await sb
      .from("recetas")
      .select("id, paciente_nombre, recetario, estado, elaboracion_confirmada_at")
      .eq("estado", "PAGADO");
    if (error) {
      console.error(error);
      return responder(500, { error: error.message }); // Zoho reintenta
    }
    const res = buscarReceta((data || []) as RecetaCandidata[], paciente, recetario, CRITERIO_ELABORACION);
    if (res.tipo === "MARCADA") {
      const ahora = new Date().toISOString();
      const { error: errUpd } = await sb
        .from("recetas")
        .update({ elaboracion_confirmada_at: ahora, updated_at: ahora })
        .eq("id", res.receta.id)
        .is("elaboracion_confirmada_at", null);
      if (errUpd) {
        console.error(errUpd);
        return responder(500, { error: errUpd.message });
      }
    }
    return await cerrar(base, res);
  }

  async function procesarCotizacion(base: Base, paciente: string, recetario: string | null, cuerpo: string) {
    // la respuesta "acuso recibo" cita más abajo el correo con precios: no es una cotización
    if (cuerpo && esConfirmacion(cuerpo)) {
      await registrar({ ...base, resultado: "IGNORADO", revisada: true });
      return responder(200, { resultado: "IGNORADO" });
    }
    const precios = leerPrecios(cuerpo);
    if (!precios) {
      // queda visible en Cotizado: el correo pasó el filtro de Zoho pero no se pudo leer la tabla
      // (varios productos, otro formato, o Zoho no mandó el contenido)
      await registrar({ ...base, resultado: "SIN_PRECIOS", revisada: false });
      return responder(200, { resultado: "SIN_PRECIOS" });
    }
    const { data, error } = await sb
      .from("recetas")
      .select("id, paciente_nombre, recetario, estado, monto, costo")
      .eq("estado", "COTIZADO");
    if (error) {
      console.error(error);
      return responder(500, { error: error.message });
    }
    const res = buscarReceta((data || []) as RecetaCandidata[], paciente, recetario, CRITERIO_COTIZACION);
    if (res.tipo === "MARCADA") {
      const ahora = new Date().toISOString();
      const { error: errUpd } = await sb
        .from("recetas")
        .update({ monto: precios.monto, costo: precios.costo, updated_at: ahora })
        .eq("id", res.receta.id)
        .eq("monto", 0)
        .eq("costo", 0);
      if (errUpd) {
        console.error(errUpd);
        return responder(500, { error: errUpd.message });
      }
    }
    return await cerrar({ ...base, monto: precios.monto, costo: precios.costo }, res);
  }

  async function cerrar(base: Base, res: ReturnType<typeof buscarReceta>) {
    if (res.tipo === "MARCADA" || res.tipo === "YA_MARCADA") {
      await registrar({ ...base, resultado: res.tipo, receta_id: res.receta.id, revisada: true });
      return responder(200, { resultado: res.tipo, receta_id: res.receta.id });
    }
    await registrar({
      ...base,
      resultado: res.tipo,
      candidatas: res.tipo === "VARIAS_COINCIDENCIAS" ? res.ids : null,
      revisada: false,
    });
    return responder(200, { resultado: res.tipo });
  }

  Deno.serve(async (req) => {
    const url = new URL(req.url);
    if (!compararSeguro(url.searchParams.get("token") || "", TOKEN)) {
      return responder(401, { error: "token inválido" });
    }
    // Zoho Mail valida la URL con una petición GET/HEAD al guardar el webhook
    if (req.method !== "POST") return responder(200, { ok: true });

    const tipo = (url.searchParams.get("tipo") || "").toLowerCase() === "cotizacion" ? "COTIZACION" : "ELABORACION";
    const payload = await leerPayload(req);
    const asunto = campo(payload, ["subject", "Subject", "mailSubject"]);
    const remitente = campo(payload, ["fromAddress", "sender", "from", "From"]);
    const cuerpo = campo(payload, ["html", "content", "body", "textContent", "summary"]);
    const paciente = extraerPaciente(asunto);
    const base: Base = {
      tipo,
      asunto: asunto.slice(0, 500),
      remitente: remitente.slice(0, 200),
      paciente_extraido: paciente,
      // se guarda recortado para poder revisar qué manda Zoho si algo no calza
      payload: JSON.parse(JSON.stringify(payload, (_k, v) => typeof v === "string" ? v.slice(0, 4000) : v)),
    };

    if (!paciente) {
      await registrar({ ...base, resultado: "IGNORADO", revisada: true });
      return responder(200, { resultado: "IGNORADO" });
    }
    const recetario = recetarioDesdeRemitente(remitente);
    return tipo === "COTIZACION"
      ? await procesarCotizacion(base, paciente, recetario, cuerpo)
      : await procesarElaboracion(base, paciente, recetario, cuerpo);
  });
}
