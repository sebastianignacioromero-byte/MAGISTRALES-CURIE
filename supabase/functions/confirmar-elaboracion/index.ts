/* Recibe el webhook de Zoho Mail cuando llega la respuesta del recetario "acuso recibo para su
   elaboración" y marca la receta (en estado Pagado) con `elaboracion_confirmada_at`.
   La app la muestra al instante porque ya escucha los cambios de `recetas` por realtime.

   Cada aviso queda registrado en `confirmaciones_elaboracion`; los que no se pudieron asociar a
   una receta (0 o varias coincidencias) aparecen en la vista Pagado para revisarlos a mano.

   Seguridad: la URL lleva ?token=<CONFIRMACION_TOKEN> (secreto de la función). Se despliega con
   verify_jwt = false (ver supabase/config.toml) porque Zoho Mail no manda el JWT de Supabase. */
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buscarReceta,
  campo,
  compararSeguro,
  esConfirmacion,
  extraerPaciente,
  recetarioDesdeRemitente,
  type RecetaCandidata,
} from "./logica.ts";

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
