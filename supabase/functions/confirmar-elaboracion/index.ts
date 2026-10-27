/* Recibe el webhook de Zoho Mail cuando llega la respuesta del recetario "acuso recibo para su
   elaboración" y marca la receta (en estado Pagado) con `elaboracion_confirmada_at`.
   La app la muestra al instante porque ya escucha los cambios de `recetas` por realtime.

   Cada aviso queda registrado en `confirmaciones_elaboracion`; los que no se pudieron asociar a
   una receta (0 o varias coincidencias) aparecen en la vista Pagado para revisarlos a mano.

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
  elaboracion_confirmada_at: string | null;
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
    .replace(/[̀-ͯ]/g, "")
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

/* Si el aviso no trae el cuerpo del correo, se confía en la regla de Zoho Mail (que ya filtra
   por "acuso recibo"); si lo trae, debe contener la frase. */
export function esConfirmacion(cuerpo: string | null | undefined): boolean {
  if (!cuerpo) return true;
  const t = normalizar(cuerpo);
  return FRASES_CONFIRMACION.some((f) => t.includes(f));
}

/* Todas las palabras del nombre del asunto deben estar en el nombre guardado
   ("JAVIERA CUETO" calza con "Javiera Cueto Pérez"). */
function calzaNombre(nombreAsunto: string, nombreGuardado: string): boolean {
  const buscadas = normalizar(nombreAsunto).split(" ").filter(Boolean);
  const guardadas = new Set(normalizar(nombreGuardado).split(" ").filter(Boolean));
  return buscadas.length > 0 && buscadas.every((p) => guardadas.has(p));
}

/* Solo recetas en "Pagado" (la elaboración se confirma después del pago) y, si se conoce el
   recetario por el remitente, solo de ese recetario. Se marca solo si hay exactamente una. */
export function buscarReceta(
  recetas: RecetaCandidata[],
  paciente: string,
  recetario: string | null,
): Resultado {
  const candidatas = recetas.filter((r) =>
    r.estado === "PAGADO" &&
    (!recetario || r.recetario === recetario) &&
    calzaNombre(paciente, r.paciente_nombre)
  );
  const pendientes = candidatas.filter((r) => !r.elaboracion_confirmada_at);
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

  Deno.serve(async (req) => {
    const url = new URL(req.url);
    if (!compararSeguro(url.searchParams.get("token") || "", TOKEN)) {
      return responder(401, { error: "token inválido" });
    }
    // Zoho Mail valida la URL con una petición GET/HEAD al guardar el webhook
    if (req.method !== "POST") return responder(200, { ok: true });

    const payload = await leerPayload(req);
    const asunto = campo(payload, ["subject", "Subject", "mailSubject"]);
    const remitente = campo(payload, ["fromAddress", "sender", "from", "From"]);
    const cuerpo = campo(payload, ["summary", "content", "html", "body", "textContent"]);
    const paciente = extraerPaciente(asunto);
    const base = {
      asunto: asunto.slice(0, 500),
      remitente: remitente.slice(0, 200),
      paciente_extraido: paciente,
      // se guarda recortado para poder revisar qué manda Zoho si algo no calza
      payload: JSON.parse(JSON.stringify(payload, (_k, v) => typeof v === "string" ? v.slice(0, 2000) : v)),
    };

    if (!paciente || !esConfirmacion(cuerpo)) {
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

    const res = buscarReceta((data || []) as RecetaCandidata[], paciente, recetarioDesdeRemitente(remitente));

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
      await registrar({ ...base, resultado: "MARCADA", receta_id: res.receta.id, revisada: true });
      return responder(200, { resultado: "MARCADA", receta_id: res.receta.id });
    }

    if (res.tipo === "YA_MARCADA") {
      await registrar({ ...base, resultado: "YA_MARCADA", receta_id: res.receta.id, revisada: true });
      return responder(200, { resultado: "YA_MARCADA", receta_id: res.receta.id });
    }

    await registrar({
      ...base,
      resultado: res.tipo,
      candidatas: res.tipo === "VARIAS_COINCIDENCIAS" ? res.ids : null,
      revisada: false,
    });
    return responder(200, { resultado: res.tipo });
  });
}
