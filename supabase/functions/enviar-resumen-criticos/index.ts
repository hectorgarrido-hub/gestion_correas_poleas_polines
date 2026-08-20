// @ts-nocheck
// Edge Function: enviar-resumen-criticos
// Runtime: Deno (Supabase Edge Functions)
// Envía resumen visual de hallazgos críticos activos via Gmail SMTP

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.9";

const GMAIL_USER    = Deno.env.get("GMAIL_USER")!;
const GMAIL_PASS    = Deno.env.get("GMAIL_PASS")!;
const DESTINATARIOS = Deno.env.get("EMAIL_DESTINATARIOS")?.split(",") ?? [GMAIL_USER];
const CRON_SECRET   = Deno.env.get("CRON_SECRET") ?? "";
const SB_URL        = Deno.env.get("SUPABASE_URL")!;
const SB_KEY        = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PROC_LABEL: Record<string, string> = {
  magnetita: "Magnetita", cnn: "CNN", embarque: "Embarque",
};
const PROC_DOT: Record<string, string> = {
  magnetita: "#3B82F6", cnn: "#22C55E", embarque: "#F97316",
};
// Normaliza el campo proc a clave en minúsculas
function normProc(p: string): string { return (p ?? "").toLowerCase().trim(); }
const CRIT_META: Record<string, { col: string; bg: string; icon: string }> = {
  "Muy Alta": { col: "#b91c1c", bg: "#fff0f0", icon: "🔴" },
  "Alta":     { col: "#c2410c", bg: "#fff6f0", icon: "🟠" },
  "Media":    { col: "#b45309", bg: "#fffbea", icon: "🟡" },
};
const COLS = ["Muy Alta", "Alta", "Media"];

// ── Nombres de correa por proceso+tag ────────────────────────
const PROC_TAG_NOMBRE: Record<string, Record<string, string>> = {
  magnetita: {
    FS24210:"Correa 10 Reversible", FS23210:"Correa 1",
    FS23230:"Correa 3",             FS23240:"Correa 5",
    FS23220:"Correa 2",             FS23235:"Apilador Magnetita",
  },
  cnn: {
    FS24211:"Correa 11", FS24213:"Correa 13", FS24235:"Apilador CNN",
    FS24215:"Correa 15", FS24214:"Correa 14", FS24212:"Correa 12",
  },
  embarque: {
    FS24416:"Correa 16",             FS23450:"Correa 7",
    FS23460:"Correa 8",              FS23470:"Correa 9",
    FS24417:"Correa 17",             FS25420:"Correa 20",
    FS25421:"Correa 21",             FS23445:"Correa 6",
    "FS23485-B":"Correa 10 Cargador Barco",
  },
};
// Familias de feeders (igual lógica que la app)
const FEED_FAM: Record<string, string> = { '23455':'MAG', '24491':'CNN', '25455':'CU' };
function tagNombre(tag: string, proc?: string): string {
  if (proc) { const n = PROC_TAG_NOMBRE[proc]?.[tag]; if (n) return n; }
  for (const p of Object.values(PROC_TAG_NOMBRE)) { if (p[tag]) return p[tag]; }
  // Feeder dinámico: FS23455-1 → "Feeder 01 MAG"
  const m = String(tag).match(/^FS(\d+)-(\d+)$/);
  if (m) { const fam = FEED_FAM[m[1]]; const num = String(+m[2]).padStart(2,'0'); return 'Feeder ' + num + (fam ? ' ' + fam : ''); }
  return tag;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-cron-secret",
};

// ── Resumen "Estado Poleas & TBO" ────────────────────────────
// Recibe las filas ya calculadas por la app (una por correa) y arma el correo.
async function enviarResumenPoleas(body: any): Promise<Response> {
  const hoy  = new Date().toLocaleDateString("es-CL", { dateStyle: "long" });
  const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
  const procLabel = body?.proc && body.proc !== "todos" ? String(body.proc) : "Todos los procesos";
  const esc = (v: any) => (v == null || v === "" ? "—" : String(v)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const num = (v: any) => (v == null ? null : Number(v));

  // KPIs (consolidados) — usa los mismos que muestra la app; si no llegan, los calcula.
  const k = body?.kpis ?? {};
  const totCorreas   = k.correas   ?? rows.length;
  const totPoleas    = k.poleas    ?? rows.reduce((s, r) => s + (num(r.total) ?? 0), 0);
  const totConCambio = k.conCambio ?? rows.reduce((s, r) => s + (num(r.conCambio) ?? 0), 0);
  const totSinCambio = k.sinCambio ?? rows.reduce((s, r) => s + (num(r.sinCambio) ?? 0), 0);
  const tboVenc      = k.tboVenc   ?? rows.filter((r) => r.tboVenc).length;
  const tboProx      = k.tboProx   ?? rows.filter((r) => !r.tboVenc && num(r.tboDias) != null && (num(r.tboDias) as number) <= 90).length;
  const procSub = procLabel === "Todos los procesos" ? "todos los procesos" : procLabel;

  const kpi = (label: string, value: number | string, color: string, sub: string) => `<td width="14.28%" style="padding:0 3px;vertical-align:top">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #dde2ec;border-top:3px solid ${color}">
      <tr><td style="padding:7px 8px">
        <div style="font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px;line-height:1.25;min-height:20px">${label}</div>
        <div style="font-size:20px;font-weight:700;color:#111;line-height:1.05">${value}</div>
        <div style="font-size:8px;color:#aaa;margin-top:2px;line-height:1.2">${sub}</div>
      </td></tr>
    </table></td>`;

  const totFeeders = k.feeders ?? 0;
  const kpisHtml = [
    kpi("Correas totales", totCorreas, "#3B82F6", `en ${procSub}`),
    kpi("Feeders (Embarque)", totFeeders, "#3B82F6", "alimentadores"),
    kpi("TBO Correas vencidos", `${tboVenc > 0 ? "▲ " : ""}${tboVenc}`, tboVenc > 0 ? "#b91c1c" : "#16a34a", "requieren revisión"),
    kpi("TBO Correas próximos", tboProx, "#d9a441", "≤ 90 días"),
    kpi("Poleas totales", totPoleas, "#3B82F6", `en ${totCorreas} correa${totCorreas !== 1 ? "s" : ""}`),
    kpi("Poleas con cambio", totConCambio, "#16a34a", "con fecha registrada"),
    kpi("Poleas sin cambio", `${totSinCambio > 0 ? "▲ " : ""}${totSinCambio}`, totSinCambio > 0 ? "#b91c1c" : "#16a34a", "nunca cambiadas"),
  ].join("");

  const bodyRows = rows.map((r, i) => {
    const bg = i % 2 === 0 ? "#f8f8f8" : "#fff";
    const scN = num(r.sinCambio) ?? 0;
    const scCol = scN > 0 ? "#b91c1c" : "#15803d";
    const scBg  = scN > 0 ? "#fdecec" : "#e9f7ef";
    const td = num(r.tboDias);
    const tboTxt = r.tboVenc ? "▲ VENCIDO" : (td != null && td <= 90 ? `◆ ${td}d` : (td != null ? `● ${td}d` : "—"));
    const tboCol = r.tboVenc ? "#b91c1c" : (td != null && td <= 90 ? "#b45309" : "#15803d");
    const tboBg  = r.tboVenc ? "#fdecec" : (td != null && td <= 90 ? "#fdf3e2" : "#e9f7ef");
    const leftBar = r.tboVenc ? "#b91c1c" : (td != null && td <= 90 ? "#d9a441" : "#16a34a");
    return `<tr style="background:${bg}">
      <td style="padding:5px 10px;font-weight:600;font-size:11px;border-left:3px solid ${leftBar}">${esc(r.nombre)}</td>
      <td style="padding:5px 8px;font-size:10px;color:#666">${esc(r.proc)}</td>
      <td style="padding:5px 8px;text-align:center;font-size:11px;font-family:monospace">${esc(r.total)}</td>
      <td style="padding:5px 8px;text-align:center"><span style="display:inline-block;min-width:22px;padding:1px 8px;border-radius:3px;background:${scBg};color:${scCol};border:1px solid ${scCol}44;font-weight:700;font-size:11px">${esc(r.sinCambio)}</span></td>
      <td style="padding:5px 8px;text-align:center"><span style="display:inline-block;min-width:22px;padding:1px 8px;border-radius:3px;background:#e9f7ef;color:#15803d;border:1px solid #15803d44;font-weight:700;font-size:11px">${esc(r.conCambio)}</span></td>
      <td style="padding:5px 8px;text-align:center;font-size:10px;font-family:monospace;color:#555">${esc(r.tboEff)}</td>
      <td style="padding:5px 8px;text-align:center"><span style="display:inline-block;padding:1px 8px;border-radius:3px;background:${tboBg};color:${tboCol};border:1px solid ${tboCol}44;font-weight:700;font-size:10px;white-space:nowrap">${tboTxt}</span></td>
      <td style="padding:5px 8px;font-size:10px;font-family:monospace;color:#777;white-space:nowrap">${esc(r.ultima)}</td>
    </tr>`;
  }).join("");

  const thBase = "padding:6px 8px;font-size:9px;text-transform:uppercase;letter-spacing:.05em;font-weight:700";
  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#eef0f5;margin:0;padding:20px 0">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:0 8px">
<table width="820" cellpadding="0" cellspacing="0" style="max-width:820px;width:100%">
  <tr><td style="background:#071840;padding:16px 22px;border-radius:6px 6px 0 0">
    <div style="color:#fff;font-size:16px;font-weight:700">Estado de Poleas &amp; TBO Correas</div>
    <div style="color:#A9C6EB;font-size:11px;margin-top:2px">${procLabel} · ${hoy}</div>
  </td></tr>
  <tr><td style="background:#fff;border:1px solid #dde2ec;border-top:none;padding:14px 15px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>${kpisHtml}</tr></table>
  </td></tr>
  <tr><td style="background:#fff;border:1px solid #dde2ec;border-top:none;padding:0 0 4px">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <thead><tr style="background:#f0f2f7">
        <th style="text-align:left;color:#888;${thBase}">Correa</th>
        <th style="text-align:left;color:#888;${thBase}">Proceso</th>
        <th style="text-align:center;color:#888;${thBase}">Total Poleas</th>
        <th style="text-align:center;color:#b91c1c;${thBase}">▲ Poleas Sin Cambio</th>
        <th style="text-align:center;color:#15803d;${thBase}">● Poleas Cambiadas</th>
        <th style="text-align:center;color:#888;${thBase}">TBO Correa</th>
        <th style="text-align:center;color:#888;${thBase}">Estado TBO Correa</th>
        <th style="text-align:left;color:#888;${thBase}">Últ. Cambio Polea</th>
      </tr></thead>
      <tbody>${bodyRows || `<tr><td colspan="8" style="padding:24px;text-align:center;color:#aaa;font-size:12px">Sin correas con poleas</td></tr>`}</tbody>
    </table>
  </td></tr>
  <tr><td style="padding:10px 4px;color:#9aa0aa;font-size:10px;text-align:center">
    Generado automáticamente por el tablero CMP · Gestión de Correas, Poleas y Polines
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  try {
    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
    const info = await transporter.sendMail({
      from:    `"CMP Dashboard" <${GMAIL_USER}>`,
      to:      DESTINATARIOS.join(", "),
      subject: `[CMP] Estado de Poleas & TBO Correas (${procLabel}) — ${hoy}`,
      html:    htmlBody,
    });
    return new Response(JSON.stringify({ ok: true, messageId: info.messageId, correas: totCorreas }),
      { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  }
}

Deno.serve(async (req) => {
  // ── CORS preflight ──────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── Auth ────────────────────────────────────────────────────
  const isCron = req.headers.get("x-cron-secret") === CRON_SECRET && CRON_SECRET !== "";
  const isUser = req.headers.get("Authorization")?.startsWith("Bearer ");
  if (!isCron && !isUser) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS_HEADERS });
  }

  // ── Modo "poleas": resumen de Estado Poleas & TBO enviado desde la app ──
  let reqBody: any = {};
  try { reqBody = await req.json(); } catch { /* sin cuerpo */ }
  if (reqBody && reqBody.report === "poleas") {
    return await enviarResumenPoleas(reqBody);
  }

  // ── Datos ───────────────────────────────────────────────────
  const sb = createClient(SB_URL, SB_KEY);
  const { data, error } = await sb
    .from("polines_hallazgos")
    .select("*")
    .eq("est_cond", "Activo")
    .in("crit", ["Muy Alta", "Alta", "Media"])
    .order("fecha", { ascending: false });

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });

  // ── Deduplicación (misma lógica que la app: identidad SIN fecha, conserva el más reciente) ──
  // Los datos vienen ordenados por fecha desc, así que el primero de cada clave es el más reciente.
  const normT = (v: any) => (v ?? "").toString().trim().toLowerCase();
  const seenKeys = new Set<string>();
  const hallazgos = (data ?? []).filter((h: any) => {
    const k = [normProc(h.proc), h.tag, normT(h.npolin), normT(h.ident), normT(h.pos), normT(h.cond), h.crit, normT(h.aviso)].join("|");
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });
  const total     = hallazgos.length;
  const hoy       = new Date().toLocaleDateString("es-CL", { dateStyle: "long" });

  // ── Mapa de calor por correa ────────────────────────────────
  const byTag: Record<string, any> = {};
  hallazgos.forEach((h: any) => {
    const procKey = normProc(h.proc);
    const k = procKey + "|" + h.tag;
    if (!byTag[k]) byTag[k] = { proc: procKey, tag: h.tag, nombre: tagNombre(h.tag, procKey), counts: {}, ultima: "" };
    byTag[k].counts[h.crit] = (byTag[k].counts[h.crit] ?? 0) + 1;
    if (!byTag[k].ultima || h.fecha > byTag[k].ultima) byTag[k].ultima = h.fecha;
  });
  const heatRows = Object.values(byTag).sort((a: any, b: any) => {
    const rank = (r: any) => (r.counts["Muy Alta"] ?? 0) * 100 + (r.counts["Alta"] ?? 0) * 10 + (r.counts["Media"] ?? 0);
    return rank(b) - rank(a);
  });

  // ── KPI cards por proceso ───────────────────────────────────
  const kpiCards = Object.entries(PROC_LABEL).map(([proc, label]) => {
    const n      = hallazgos.filter((h: any) => normProc(h.proc) === proc).length;
    const correas = new Set(hallazgos.filter((h: any) => normProc(h.proc) === proc).map((h: any) => h.tag)).size;
    const dot    = PROC_DOT[proc] ?? "#888";
    return `<td width="25%" style="padding:0 0 0 8px">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #dde2ec;border-top:3px solid ${dot}">
        <tr><td style="padding:8px 10px">
          <div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">${label}</div>
          <div style="font-size:22px;font-weight:700;color:${n > 0 ? "#111" : "#ccc"};line-height:1.1">${n}</div>
          <div style="font-size:9px;color:#aaa;margin-top:2px">${correas} correa${correas !== 1 ? "s" : ""}</div>
        </td></tr>
      </table></td>`;
  }).join("");

  // ── Mapa de calor HTML ──────────────────────────────────────
  const heatHeaderCells = COLS.map(c =>
    `<th style="text-align:center;padding:5px 10px;font-size:9px;font-weight:700;color:${CRIT_META[c].col};white-space:nowrap">${CRIT_META[c].icon} ${c}</th>`
  ).join("");

  const heatBodyRows = heatRows.map((row: any, i: number) => {
    const tot  = Object.values(row.counts).reduce((s: number, n: any) => s + n, 0);
    const bg   = i % 2 === 0 ? "#f8f8f8" : "#fff";
    const topC = COLS.find(c => row.counts[c]) ?? "Media";
    const cells = COLS.map(c => {
      const n = row.counts[c] ?? 0;
      return n > 0
        ? `<td style="text-align:center;padding:4px 8px;background:${bg}"><span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${CRIT_META[c].bg};color:${CRIT_META[c].col};font-weight:700;font-size:11px;border:1px solid ${CRIT_META[c].col}55">${n}</span></td>`
        : `<td style="text-align:center;padding:4px 8px;background:${bg}"><span style="display:inline-block;width:22px;height:16px;background:#e8e8e8;border-radius:2px"></span></td>`;
    }).join("");
    return `<tr>
      <td style="padding:4px 10px;font-weight:600;font-size:11px;background:${bg};border-left:3px solid ${CRIT_META[topC]?.col ?? "#ccc"}">${row.nombre}</td>
      <td style="padding:4px 8px;font-size:10px;background:${bg}">
        <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${PROC_DOT[row.proc] ?? "#888"};margin-right:4px;vertical-align:middle"></span>
        <span style="color:#666;vertical-align:middle">${PROC_LABEL[row.proc] ?? row.proc}</span>
      </td>
      ${cells}
      <td style="text-align:center;padding:4px 8px;font-weight:700;font-size:12px;background:${bg};color:${CRIT_META[topC]?.col ?? "#333"}">${tot}</td>
      <td style="padding:4px 8px;font-size:10px;color:#888;font-family:monospace;background:${bg}">${row.ultima ?? "—"}</td>
    </tr>`;
  }).join("");

  // ── Tabla detalle (ordenado por criticidad: Muy Alta → Alta → Media) ──────
  const CRIT_RANK: Record<string, number> = { "Muy Alta": 0, "Alta": 1, "Media": 2 };
  const hallazgosOrdenados = [...hallazgos].sort((a: any, b: any) =>
    (CRIT_RANK[a.crit] ?? 9) - (CRIT_RANK[b.crit] ?? 9)
  );
  const detalleRows = hallazgosOrdenados.map((h: any) => {
    const cm = CRIT_META[h.crit] ?? { col: "#888", bg: "#f5f5f5", icon: "○" };
    const pk = normProc(h.proc);
    return `<tr style="background:${cm.bg}">
      <td style="padding:4px 4px 4px 8px;font-weight:600;font-size:11px;border-left:3px solid ${cm.col}">${tagNombre(h.tag, normProc(h.proc))}</td>
      <td style="padding:4px 8px;font-size:10px;color:#555">${h.tag}</td>
      <td style="padding:4px 8px;font-size:10px;color:#666">
        <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${PROC_DOT[pk] ?? "#888"};margin-right:3px;vertical-align:middle"></span>
        <span style="vertical-align:middle">${PROC_LABEL[pk] ?? h.proc}</span>
      </td>
      <td style="padding:4px 8px;text-align:center;font-size:11px;font-family:monospace">${h.npolin ?? "—"}</td>
      <td style="padding:4px 8px;font-size:11px">${h.ident ?? "—"}</td>
      <td style="padding:4px 8px;font-size:11px">${h.pos ?? "—"}</td>
      <td style="padding:4px 8px;font-size:11px">${h.cond ?? "—"}</td>
      <td style="padding:4px 8px;font-size:11px">${h.accion ?? "—"}</td>
      <td style="padding:4px 8px;white-space:nowrap">
        <span style="display:inline-block;padding:2px 7px;border-radius:3px;background:${cm.col}22;color:${cm.col};font-weight:700;font-size:10px;border:1px solid ${cm.col}44">${cm.icon} ${h.crit}</span>
      </td>
      <td style="padding:4px 8px;font-size:10px;font-family:monospace;color:#666">${h.aviso ?? "—"}</td>
      <td style="padding:4px 8px;font-size:10px;font-family:monospace;color:#666;white-space:nowrap">${h.fecha ?? "—"}</td>
    </tr>`;
  }).join("");

  // ── Bloque "sin hallazgos" ──────────────────────────────────
  const sinHallazgos = `
  <tr><td style="background:#fff;padding:32px 24px;border:1px solid #dde2ec;border-top:none;text-align:center;border-radius:0 0 6px 6px">
    <div style="font-size:32px;margin-bottom:8px">✅</div>
    <div style="font-size:14px;font-weight:700;color:#16a34a">Sin hallazgos críticos activos</div>
    <div style="font-size:11px;color:#aaa;margin-top:4px">No se requiere acción en este momento.</div>
  </td></tr>`;

  // ── HTML final ──────────────────────────────────────────────
  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#eef0f5;margin:0;padding:20px 0">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:0 8px">
<table width="720" cellpadding="0" cellspacing="0" style="max-width:720px">

  <!-- HEADER -->
  <tr><td style="background:#071840;padding:16px 24px;border-radius:6px 6px 0 0">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td>
        <div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:3px">🔴 Hallazgos Críticos Activos — Polines</div>
        <div style="font-size:11px;color:#8899cc">${hoy}</div>
      </td>
      <td align="right">
        <img src="data:image/jpeg;base64,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" alt="CMP Logo" width="160" height="54" style="display:block;border-radius:3px">
      </td>
    </tr></table>
  </td></tr>

  <!-- RESUMEN -->
  <tr><td style="background:#f0f3f9;padding:10px 24px;border-left:1px solid #dde2ec;border-right:1px solid #dde2ec">
    <div style="font-size:12px;color:#444;line-height:1.5">
      Se encontraron <strong style="color:#b91c1c">${total} hallazgo${total !== 1 ? "s" : ""} activo${total !== 1 ? "s" : ""} en polines</strong>
      con criticidad ${CRIT_META["Muy Alta"].icon} <strong>Muy Alta</strong>,
      ${CRIT_META["Alta"].icon} <strong>Alta</strong> y
      ${CRIT_META["Media"].icon} <strong>Media</strong>.
    </div>
  </td></tr>

  <!-- KPI CARDS -->
  <tr><td style="background:#f4f6fb;padding:12px 24px;border:1px solid #dde2ec;border-top:none">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="25%" style="padding:0">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #dde2ec;border-top:3px solid #b91c1c">
          <tr><td style="padding:8px 10px">
            <div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">Total críticos</div>
            <div style="font-size:26px;font-weight:900;color:${total > 0 ? "#b91c1c" : "#ccc"};line-height:1.1">${total}</div>
            <div style="font-size:9px;color:#aaa;margin-top:2px">${heatRows.length} correa${heatRows.length !== 1 ? "s" : ""} afectadas</div>
          </td></tr>
        </table>
      </td>
      ${kpiCards}
    </tr></table>
  </td></tr>

  ${total === 0 ? sinHallazgos : `
  <!-- MAPA DE CALOR -->
  <tr><td style="background:#fff;padding:14px 24px 0;border:1px solid #dde2ec;border-top:none">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#071840;border-bottom:2px solid #071840;padding-bottom:5px">Mapa de Calor — por Correa / Feeder</td>
        <td align="right" style="font-size:10px;color:#aaa;border-bottom:2px solid #071840;padding-bottom:5px">${heatRows.length} equipo${heatRows.length !== 1 ? "s" : ""} afectado${heatRows.length !== 1 ? "s" : ""}</td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="background:#fff;padding:6px 24px 16px;border-left:1px solid #dde2ec;border-right:1px solid #dde2ec">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <thead><tr style="background:#071840">
        <th style="text-align:left;padding:5px 10px;font-size:9px;color:#aabbdd;font-weight:600;white-space:nowrap">Correa / Feeder</th>
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd;font-weight:600">Proceso</th>
        ${heatHeaderCells}
        <th style="text-align:center;padding:5px 8px;font-size:9px;color:#aabbdd;font-weight:600">Total</th>
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd;font-weight:600;white-space:nowrap">Últ. insp.</th>
      </tr></thead>
      <tbody>${heatBodyRows}</tbody>
    </table>
  </td></tr>

  <!-- DETALLE -->
  <tr><td style="background:#fff;padding:14px 24px 0;border-left:1px solid #dde2ec;border-right:1px solid #dde2ec;border-top:1px solid #eee">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#071840;border-bottom:2px solid #071840;padding-bottom:5px">Detalle de Hallazgos</td>
        <td align="right" style="font-size:10px;color:#aaa;border-bottom:2px solid #071840;padding-bottom:5px">${total} hallazgo${total !== 1 ? "s" : ""}</td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="background:#fff;padding:6px 24px 16px;border-left:1px solid #dde2ec;border-right:1px solid #dde2ec">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <thead><tr style="background:#071840">
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd;white-space:nowrap">Correa</th>
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd">TAG</th>
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd">Proceso</th>
        <th style="text-align:center;padding:5px 8px;font-size:9px;color:#aabbdd;white-space:nowrap">N° Pol.</th>
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd">Ident.</th>
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd">Posición</th>
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd">Condición</th>
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd">Acción</th>
        <th style="text-align:center;padding:5px 8px;font-size:9px;color:#aabbdd">Criticidad</th>
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd;white-space:nowrap">N° Aviso</th>
        <th style="text-align:left;padding:5px 8px;font-size:9px;color:#aabbdd">Fecha</th>
      </tr></thead>
      <tbody>${detalleRows}</tbody>
    </table>
  </td></tr>`}

  <!-- FOOTER -->
  <tr><td style="background:#071840;padding:10px 24px;border-radius:0 0 6px 6px">
    <div style="font-size:10px;color:#5566aa">Generado automáticamente · CMP Dashboard — Gestión de Correas, Poleas y Polines</div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  // ── Enviar via Gmail SMTP ───────────────────────────────────
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });
    const info = await transporter.sendMail({
      from:    `"CMP Dashboard" <${GMAIL_USER}>`,
      to:      DESTINATARIOS.join(", "),
      subject: `[CMP] ${total} Hallazgo${total !== 1 ? "s" : ""} Crítico${total !== 1 ? "s" : ""} Activo${total !== 1 ? "s" : ""} en Polines — ${hoy}`,
      html:    htmlBody,
    });
    return new Response(
      JSON.stringify({ ok: true, messageId: info.messageId, total }),
      { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  }
});
