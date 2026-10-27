/* Lógica pura (sin Supabase ni red) para reconocer el correo del recetario que confirma la
   elaboración de una receta y encontrar a qué receta corresponde. Separada de index.ts para
   poder probarla con `node --experimental-strip-types --test`. */

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
