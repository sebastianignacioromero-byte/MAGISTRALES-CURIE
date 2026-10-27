// Ejecutar: node --experimental-strip-types --test supabase/functions/confirmar-elaboracion/index.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buscarReceta,
  CRITERIO_COTIZACION,
  leerPrecios,
  textoPropio,
  campo,
  compararSeguro,
  esConfirmacion,
  extraerPaciente,
  recetarioDesdeRemitente,
  type RecetaCandidata,
} from "./index.ts";

const ASUNTO = 'RE: COTIZACION RECETA "JAVIERA CUETO" (CONVENIO 180002538) FARMACIA CURIE';

function receta(p: Partial<RecetaCandidata>): RecetaCandidata {
  return {
    id: "r1",
    paciente_nombre: "Javiera Cueto",
    recetario: "Salcobrand",
    estado: "PAGADO",
    elaboracion_confirmada_at: null,
    ...p,
  };
}

test("extrae el paciente del asunto", () => {
  assert.equal(extraerPaciente(ASUNTO), "JAVIERA CUETO");
  assert.equal(extraerPaciente("RE: Cotización receta “María José Peña” (CONVENIO 1)"), "María José Peña");
  assert.equal(extraerPaciente("RE: otra cosa"), null);
  assert.equal(extraerPaciente(""), null);
});

test("recetario según dominio del remitente", () => {
  assert.equal(recetarioDesdeRemitente("ventasrecetario@sb.cl"), "Salcobrand");
  assert.equal(recetarioDesdeRemitente("Recetario <noreply@mail.sb.cl>"), "Salcobrand");
  assert.equal(recetarioDesdeRemitente("noreply@zoho.com"), null);
  assert.equal(recetarioDesdeRemitente(""), null);
});

test("reconoce la frase de confirmación", () => {
  assert.ok(esConfirmacion("Buenos días estimados, acuso recibo para su elaboración."));
  assert.ok(esConfirmacion("<p>ACUSO RECIBO</p>"));
  assert.ok(!esConfirmacion("Adjunto cotización, quedamos atentos."));
  assert.ok(esConfirmacion("")); // sin cuerpo: se confía en la regla de Zoho
});

test("marca la única receta pagada que calza", () => {
  const r = buscarReceta([
    receta({ id: "a" }),
    receta({ id: "b", estado: "COTIZADO" }),
    receta({ id: "c", paciente_nombre: "Pedro Soto" }),
  ], "JAVIERA CUETO", "Salcobrand");
  assert.equal(r.tipo, "MARCADA");
  assert.equal(r.tipo === "MARCADA" && r.receta.id, "a");
});

test("calza con nombre guardado más largo y con tildes", () => {
  const r = buscarReceta([receta({ paciente_nombre: "Javiera Cueto Pérez" })], "JAVIERA CUETO", "Salcobrand");
  assert.equal(r.tipo, "MARCADA");
  const r2 = buscarReceta([receta({ paciente_nombre: "José Peña" })], "JOSE PENA", null);
  assert.equal(r2.tipo, "MARCADA"); // el correo puede perder tildes y la ñ
});

test("no marca si hay dos candidatas", () => {
  const r = buscarReceta([receta({ id: "a" }), receta({ id: "b" })], "JAVIERA CUETO", "Salcobrand");
  assert.deepEqual(r, { tipo: "VARIAS_COINCIDENCIAS", ids: ["a", "b"] });
});

test("filtra por recetario cuando se conoce", () => {
  const r = buscarReceta([receta({ recetario: "Pharma 93" })], "JAVIERA CUETO", "Salcobrand");
  assert.equal(r.tipo, "SIN_COINCIDENCIA");
  const r2 = buscarReceta([receta({ recetario: "Pharma 93" })], "JAVIERA CUETO", null);
  assert.equal(r2.tipo, "MARCADA");
});

test("correo repetido no vuelve a marcar", () => {
  const r = buscarReceta([receta({ elaboracion_confirmada_at: "2026-10-27T12:00:00Z" })], "JAVIERA CUETO", "Salcobrand");
  assert.equal(r.tipo, "YA_MARCADA");
});

test("prefiere la pendiente si otra del mismo paciente ya estaba confirmada", () => {
  const r = buscarReceta([
    receta({ id: "vieja", elaboracion_confirmada_at: "2026-10-01T12:00:00Z" }),
    receta({ id: "nueva" }),
  ], "JAVIERA CUETO", "Salcobrand");
  assert.equal(r.tipo === "MARCADA" && r.receta.id, "nueva");
});

test("lee campos con distintos nombres", () => {
  assert.equal(campo({ Subject: "x" }, ["subject", "Subject"]), "x");
  assert.equal(campo({ fromAddress: { address: "a@sb.cl" } }, ["fromAddress"]), "a@sb.cl");
  assert.equal(campo({ to: ["a@b.cl"] }, ["to"]), "a@b.cl");
  assert.equal(campo({}, ["subject"]), "");
});

test("compara token", () => {
  assert.ok(compararSeguro("abc", "abc"));
  assert.ok(!compararSeguro("abc", "abd"));
  assert.ok(!compararSeguro("", ""));
});

const COTIZACION_HTML = `<div>Buenas tardes estimados, adjunto cotización solicitada, valor por polybase 20 grs:</div>
<table border="1"><tbody>
<tr><td>Precio Lista c/IVA</td><td>16090</td></tr>
<tr><td>Descuento convenio</td><td>40%</td></tr>
<tr><td>Precio Final c/IVA</td><td>9654</td></tr>
<tr><td>Precio Final s/IVA</td><td>8113</td></tr>
</tbody></table><div>Saludos cordiales.</div>`;

test("lee los precios de la tabla del recetario", () => {
  assert.deepEqual(leerPrecios(COTIZACION_HTML), { monto: 16090, costo: 8113 });
});

test("lee precios en texto plano y con puntos de miles", () => {
  const t = "Precio Lista c/IVA: $16.090\nDescuento convenio 40%\nPrecio Final c/IVA $9.654\nPrecio Final s/IVA $8.113";
  assert.deepEqual(leerPrecios(t), { monto: 16090, costo: 8113 });
});

test("no inventa precios si falta alguno o hay dos tablas", () => {
  assert.equal(leerPrecios("Precio Lista c/IVA 16090"), null);
  assert.equal(leerPrecios(COTIZACION_HTML + COTIZACION_HTML), null);
  assert.equal(leerPrecios(""), null);
});

test("ignora el mensaje citado más abajo", () => {
  const acuse = "Buenos días estimados, acuso recibo para su elaboración.<br>Saludos cordiales.<br><br>" +
    "-------------- Mensaje original --------------<br>De: Sebastian Romero<br>confirmo elaboración<br>" + COTIZACION_HTML;
  assert.equal(leerPrecios(acuse), null);
  assert.ok(textoPropio(acuse).includes("acuso recibo"));
  const respuestaMia = "confirmo elaboración<br>De: Recetario Magistral<br>" + COTIZACION_HTML;
  assert.equal(leerPrecios(respuestaMia), null);
  assert.ok(!esConfirmacion("Adjunto cotización<br>-------- Mensaje original --------<br>acuso recibo para su elaboración"));
});

test("cotización: llena la única receta en Cotizado sin precios", () => {
  const r = buscarReceta([
    receta({ id: "a", estado: "COTIZADO", paciente_nombre: "Carolina Martínez", monto: 0, costo: 0 }),
    receta({ id: "b", estado: "PAGADO", paciente_nombre: "Carolina Martínez" }),
  ], "CAROLINA MARTINEZ", "Salcobrand", CRITERIO_COTIZACION);
  assert.equal(r.tipo === "MARCADA" && r.receta.id, "a");
});

test("cotización: no pisa precios ya escritos", () => {
  const r = buscarReceta([
    receta({ estado: "COTIZADO", paciente_nombre: "Carolina Martinez", monto: 15000, costo: 0 }),
  ], "CAROLINA MARTINEZ", "Salcobrand", CRITERIO_COTIZACION);
  assert.equal(r.tipo, "YA_MARCADA");
});
