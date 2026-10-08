// ═══════════ ROBOT DE ESTADISTICAS REALES (OP3) ═══════════
// Corre en GitHub Actions una vez al dia. Para cada show (repo con feed.xml):
//   1. lee el feed y la duracion de cada episodio
//   2. baja de OP3 las descargas REALES de los ultimos 60 dias, una por una.
//      OP3 cuenta TODAS las plataformas (Spotify, Apple, YouTube Music,
//      Pocket Casts, navegador...) porque cada audio pasa por op3.dev/e/
//   3. horas = suma de (descarga x duracion de ESE episodio)
//   4. guarda stats_op3.json (lo lee el panel) y suma el dia a
//      historial_op3.json, que nunca se borra (aunque OP3 cambie o se caiga).
// Uso local:  OP3_TOKEN=xxxx node scripts/op3_stats.mjs
import { readFile, writeFile } from "node:fs/promises";

const USER = process.env.GITHUB_USER || "rabmeireliyahu";
const TOKEN = process.env.OP3_TOKEN || "preview07ce";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const DIAS = 60;
const API = "https://op3.dev/api/1";
const ES_ROBOT = /bot|crawl|spider|research|downloader|curl|wget|python|go-http|node-fetch|headless/i;
const IGNORAR = new Set(["panel", "charts", "torre-autenta", "midot"]);

const ahora = new Date();
const hoyISO = ahora.toISOString().slice(0, 10);
const diaMs = 86400000;
// corte de Spotify for Creators: desde aqui todo lo nuevo lo mide OP3
const CORTE = "2026-07-17";
let inicio = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()) - DIAS * diaMs);

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function pedir(url, opts = {}, intentos = 5) {
  for (let i = 0; i < intentos; i++) {
    let r;
    try { r = await fetch(url, opts); } catch (e) { if (i === intentos - 1) throw e; await espera(2000 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { await espera(3000 * 2 ** i); continue; }
    return r;
  }
  throw new Error("sin respuesta: " + url);
}
async function op3(path, params = {}) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, v);
  u.searchParams.set("token", TOKEN);
  const r = await pedir(u, { headers: { Accept: "application/json", Authorization: "Bearer " + TOKEN } });
  if (!r.ok) throw new Error(`op3 ${r.status} ${path} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── feed ──
const quitarCdata = (s) => s.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
const desEsc = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
function dur2seg(t) {
  if (!t) return 0; t = t.trim();
  if (/^\d+$/.test(t)) return +t;
  const p = t.split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : 0;
}
// llave comun para comparar la URL del feed con la URL que registra OP3
function llaveAudio(url) {
  let u = (url || "").trim().replace(/^https?:\/\/op3\.dev\/e(,[^/]*)?\//i, "");
  u = u.replace(/^https?:\/\//i, "").split("?")[0];
  try { u = decodeURIComponent(u); } catch { /* deja como esta */ }
  return u.toLowerCase();
}
function leerFeed(xml) {
  const nombre = desEsc(quitarCdata((xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/) || [])[1] || ""));
  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([it]) => {
    const url = desEsc((it.match(/<enclosure[^>]*url="([^"]*)"/) || [])[1] || "");
    return {
      titulo: desEsc(quitarCdata((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "")),
      url, seg: dur2seg((it.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/) || [])[1] || ""),
      op3: /^https?:\/\/op3\.dev\/e/i.test(url),
    };
  });
  return { nombre, items };
}

async function listarRepos() {
  const h = { Accept: "application/vnd.github+json" };
  if (GH_TOKEN) h.Authorization = "Bearer " + GH_TOKEN;
  const r = await pedir(`https://api.github.com/users/${USER}/repos?per_page=100`, { headers: h });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("GitHub: " + JSON.stringify(j).slice(0, 200));
  return j.filter((x) => !x.private && !IGNORAR.has(x.name)).map((x) => x.name).sort();
}

async function procesarShow(repo) {
  const feedURL = `https://${USER}.github.io/${repo}/feed.xml`;
  const res = { repo, feed: feedURL };
  const rf = await pedir(feedURL + "?nc=" + Date.now());
  if (!rf.ok) return { ...res, sinFeed: true };
  const xml = await rf.text();
  const { nombre, items } = leerFeed(xml);
  if (!items.length && !nombre) return { ...res, sinFeed: true };
  const segTot = items.reduce((a, e) => a + e.seg, 0);
  const conDur = items.filter((e) => e.seg > 0);
  const durProm = conDur.length ? conDur.reduce((a, e) => a + e.seg, 0) / conDur.length : 1800;
  const durPorAudio = new Map(items.map((e) => [llaveAudio(e.url), e.seg || durProm]));
  const durPorTitulo = new Map(items.map((e) => [e.titulo.trim(), e.seg || durProm]));
  Object.assign(res, {
    nombre, episodios: items.length, horasContenido: Math.round(segTot / 3600),
    durProm: Math.round(durProm), sinOp3: items.filter((e) => e.url && !e.op3).length,
  });

  // 1. el show en OP3
  let info;
  try { info = await op3(`/shows/${b64url(feedURL)}`); }
  catch (e) { return { ...res, errorOp3: "OP3 no conoce este feed todavia (" + e.message.slice(0, 80) + ")" }; }
  res.showUuid = info.showUuid;
  res.statsURL = info.statsPageUrl || `https://op3.dev/show/${info.showUuid}`;

  // 2. totales historicos por episodio (all-time)
  try {
    const ep = await op3("/queries/episode-download-counts", { showUuid: info.showUuid });
    let dlsAll = 0, segAll = 0;
    for (const e of ep.episodes || []) {
      const d = e.downloadsAll || 0;
      dlsAll += d; segAll += d * (durPorTitulo.get((e.title || "").trim()) || durProm);
    }
    res.dlsAll = dlsAll; res.horasAll = Math.round(segAll / 3600);
    res.desdeOp3 = ep.minDownloadHour || null;
  } catch (e) { res.errorTotales = e.message.slice(0, 120); }

  // 3. descargas una por una desde el inicio → por dia, por app, horas exactas
  // OP3 ya entrega cada descarga depurada (misma persona + mismo episodio no se repite).
  // Aqui ademas se quitan:
  //   · robots declarados (agentType bot, "crawler", "downloader"...)
  //   · DESCARGAS MASIVAS: un mismo navegador/programa que en un solo dia baja
  //     20+ episodios distintos con menos de 3 bajadas por episodio. Eso es alguien
  //     (o un robot) jalando el archivo completo, no gente escuchando.
  //     Un shiur compartido por WhatsApp que muchos abren NO cae aqui (es 1 episodio).
  const filasOk = []; const tipos = {}; const refs = {};
  let token, paginas = 0, filas = 0, sinMatch = 0, robots = 0;
  do {
    const p = await op3(`/downloads/show/${info.showUuid}`, {
      format: "json", start: inicio.toISOString(), limit: 20000, continuationToken: token,
    });
    const rows = p.rows || [];
    for (const d of rows) {
      const dia = (d.time || "").slice(0, 10); if (!dia) continue;
      const tipo = d.agentType || "?"; tipos[tipo] = (tipos[tipo] || 0) + 1;
      if (tipo === "bot" || ES_ROBOT.test(d.agentName || "")) { robots++; continue; }
      const ep = llaveAudio(d.url);
      let seg = durPorAudio.get(ep);
      if (seg === undefined) { seg = durProm; sinMatch++; }
      const ref = d.referrerName || d.referrerType; if (ref) refs[ref] = (refs[ref] || 0) + 1;
      filasOk.push({ dia, ep, seg, tipo, app: d.agentName || d.agentType || "Desconocido", aud: d.audienceId, pais: d.countryCode });
    }
    filas += rows.length; token = p.continuationToken; paginas++;
    if (!rows.length) break;
  } while (token && paginas < 100);

  const grupos = {};
  for (const f of filasOk) {
    if (f.tipo === "app") continue; // apps de podcast: siempre cuentan
    const g = grupos[f.dia + "|" + f.app] || (grupos[f.dia + "|" + f.app] = { n: 0, eps: new Set() });
    g.n++; g.eps.add(f.ep);
  }
  const masivo = new Set(Object.entries(grupos).filter(([, g]) => g.eps.size >= 20 && g.n / g.eps.size < 3).map(([k]) => k));

  const porDia = {}; const apps = {}; const paises = {}; const oyentes30 = new Set(); const picos = {};
  const hoy0 = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate());
  let masivas = 0;
  for (const f of filasOk) {
    const x = porDia[f.dia] || (porDia[f.dia] = { d: 0, s: 0, sApp: 0, sWeb: 0, sMas: 0 });
    if (masivo.has(f.dia + "|" + f.app)) { x.sMas += f.seg; masivas++; continue; }
    x.d++; x.s += f.seg; if (f.tipo === "app") x.sApp += f.seg; else x.sWeb += f.seg;
    apps[f.app] = (apps[f.app] || 0) + 1;
    if (f.pais) paises[f.pais] = (paises[f.pais] || 0) + 1;
    const pk = f.dia + " " + f.app; picos[pk] = (picos[pk] || 0) + 1;
    if (Date.parse(f.dia + "T00:00:00Z") >= hoy0 - 30 * diaMs && f.aud) oyentes30.add(f.aud);
  }

  const dias = {};
  for (const [k, v] of Object.entries(porDia)) dias[k] = { descargas: v.d, horas: +(v.s / 3600).toFixed(1),
    hApp: +(v.sApp / 3600).toFixed(1), hWeb: +(v.sWeb / 3600).toFixed(1), hMasiva: +(v.sMas / 3600).toFixed(1) };
  const sumaK = (k, desde, hasta) => Object.entries(porDia).reduce((a, [d, v]) => {
    const t = Date.parse(d + "T00:00:00Z"); return t >= desde && t < hasta ? a + v[k] : a; }, 0);
  const U = [hoy0 - 30 * diaMs, hoy0 + diaMs], P = [hoy0 - 60 * diaMs, hoy0 - 30 * diaMs];
  const h = (k, r) => Math.round(sumaK(k, ...r) / 3600);
  Object.assign(res, {
    dls30: sumaK("d", ...U), horas30: h("s", U),
    dlsPrev30: sumaK("d", ...P), horasPrev30: h("s", P),
    horasApp30: h("sApp", U), horasWeb30: h("sWeb", U), horasMasiva30: h("sMas", U),
    horasAppPrev30: h("sApp", P), horasWebPrev30: h("sWeb", P), horasMasivaPrev30: h("sMas", P),
    picos: Object.entries(picos).sort((a, b) => b[1] - a[1]).slice(0, 5),
    masivas, refs, oyentes30: oyentes30.size, dias, apps, paises, tipos, filas, robots, sinMatch,
  });
  return res;
}

async function main() {
  let hist = {};
  try { hist = JSON.parse(await readFile("historial_op3.json", "utf8")); } catch { /* primera vez */ }
  // si todavia no hay historial desde el corte, la primera vez se baja todo desde el corte
  const diaAntes = new Date(inicio.getTime() - diaMs).toISOString().slice(0, 10);
  if (!hist._diasShow || (diaAntes >= CORTE && !Object.values(hist._diasShow).some((x) => x[diaAntes]))) {
    inicio = new Date(CORTE + "T00:00:00Z");
    console.log("Primera vez: bajando todo desde el corte " + CORTE);
  }
  const repos = await listarRepos();
  console.log(`Shows encontrados: ${repos.length} · token ${TOKEN === "preview07ce" ? "PREVIEW (compartido)" : "propio"}`);
  const shows = {}; const vistos = new Map();
  for (const repo of repos) {
    try {
      const s = await procesarShow(repo);
      if (s.sinFeed) { console.log(`· ${repo}: sin feed.xml, se ignora`); continue; }
      if (s.showUuid && vistos.has(s.showUuid)) { s.duplicadoDe = vistos.get(s.showUuid); }
      else if (s.showUuid) vistos.set(s.showUuid, repo);
      shows[repo] = s;
      if (s.picos?.length) console.log(`    picos (dia app = descargas): ${s.picos.map(([k, n]) => k + "=" + n).join(" · ")} | refs ${JSON.stringify(s.refs)}`);
      console.log(`✓ ${repo.padEnd(18)} oyentes30 ${String(s.oyentes30 ?? "–").padStart(5)} · peticiones ${s.filas ?? "–"} (robots ${s.robots ?? "–"}, masivas ${s.masivas ?? "–"}) · 30d: ${String(s.dls30 ?? "–").padStart(6)} desc · ${String(s.horas30 ?? "–").padStart(5)} h | 30d previos: ${String(s.dlsPrev30 ?? "–").padStart(6)} desc · ${String(s.horasPrev30 ?? "–").padStart(5)} h | total ${s.dlsAll ?? "–"} desc · ${s.horasAll ?? "–"} h${s.sinOp3 ? ` | ⚠ ${s.sinOp3} episodios SIN op3` : ""}${s.errorOp3 ? " | ⚠ " + s.errorOp3 : ""}${s.duplicadoDe ? " | duplicado de " + s.duplicadoDe : ""}`);
    } catch (e) {
      shows[repo] = { repo, error: e.message.slice(0, 200) };
      console.log(`✗ ${repo}: ${e.message}`);
    }
    await espera(400);
  }

  // totales (sin contar duplicados)
  const SUMAR = ["oyentes30", "dls30", "horas30", "dlsPrev30", "horasPrev30", "dlsAll", "horasAll",
    "horasApp30", "horasWeb30", "horasAppPrev30", "horasWebPrev30", "horasMasiva30", "horasMasivaPrev30"];
  const T = { apps: {}, dias: {} }; for (const k of SUMAR) T[k] = 0;
  for (const s of Object.values(shows)) {
    if (s.duplicadoDe || !s.showUuid) continue;
    for (const k of SUMAR) T[k] += s[k] || 0;
    for (const [a, n] of Object.entries(s.apps || {})) T.apps[a] = (T.apps[a] || 0) + n;
    for (const [d, v] of Object.entries(s.dias || {})) {
      const x = T.dias[d] || (T.dias[d] = { descargas: 0, horas: 0, hApp: 0, hWeb: 0, hMasiva: 0 });
      x.descargas += v.descargas;
      for (const k of ["horas", "hApp", "hWeb", "hMasiva"]) x[k] = +(x[k] + v[k]).toFixed(1);
    }
  }
  const cambio = T.horasPrev30 ? Math.round((T.horas30 / T.horasPrev30 - 1) * 100) : null;
  console.log(`\nTOTAL ultimos 30 dias: ${T.dls30} descargas · ${T.horas30} horas`);
  console.log(`TOTAL 30 dias previos: ${T.dlsPrev30} descargas · ${T.horasPrev30} horas  (cambio ${cambio ?? "–"}%)`);
  console.log(`TOTAL historico OP3:   ${T.dlsAll} descargas · ${T.horasAll} horas`);
  const tiposT = {}; for (const x of Object.values(shows)) for (const [k, n] of Object.entries(x.tipos || {})) tiposT[k] = (tiposT[k] || 0) + n;
  console.log("Tipos de peticion 60d:", JSON.stringify(tiposT), "· oyentes unicos 30d (suma por show):", T.oyentes30);
  console.log("Plataformas 60d:", Object.entries(T.apps).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([a, n]) => `${a}=${n}`).join(", "));

  const salida = { generado: ahora.toISOString(), fecha: hoyISO, ventanaDias: DIAS,
    token: TOKEN === "preview07ce" ? "preview" : "propio", total: { ...T, cambioPct: cambio }, shows };
  console.log(`Apps de podcast 30d: ${T.horasApp30} h (antes ${T.horasAppPrev30} h) · Navegador 30d: ${T.horasWeb30} h (antes ${T.horasWebPrev30} h) · Masivas filtradas 30d: ${T.horasMasiva30} h (antes ${T.horasMasivaPrev30} h)`);

  // historial permanente: un renglon por dia, nunca se borra
  hist[hoyISO] = { dls30: T.dls30, horas30: T.horas30, dlsAll: T.dlsAll, horasAll: T.horasAll,
    shows: Object.fromEntries(Object.entries(shows).filter(([, s]) => s.showUuid && !s.duplicadoDe)
      .map(([k, s]) => [k, { dls30: s.dls30, horas30: s.horas30, dlsAll: s.dlsAll, horasAll: s.horasAll }])) };
  // tambien guarda cada dia ya cerrado (descargas/horas reales de ese dia)
  hist._dias = Object.assign(hist._dias || {}, Object.fromEntries(
    Object.entries(T.dias).filter(([d]) => d < hoyISO)));
  // por show y por dia, permanente: con esto se suma TODO lo oido desde el corte
  hist._diasShow = hist._diasShow || {};
  for (const [k, sh] of Object.entries(shows)) {
    if (!sh.showUuid || sh.duplicadoDe) continue;
    const h = hist._diasShow[k] || (hist._diasShow[k] = {});
    for (const [d, v] of Object.entries(sh.dias || {})) if (d < hoyISO && d >= CORTE) h[d] = [v.descargas, v.horas];
  }
  // total desde el corte por show (lo usa el panel para la historia)
  for (const [k, sh] of Object.entries(shows)) {
    const h = hist._diasShow[k]; if (!h) continue;
    const v = Object.entries(h).filter(([d]) => d >= CORTE).reduce((a, [, x]) => [a[0] + x[0], a[1] + x[1]], [0, 0]);
    sh.dlsCorte = v[0]; sh.horasCorte = Math.round(v[1]);
    delete sh.dias; // el detalle diario ya vive en el historial; aqui solo el total
  }
  salida.corte = CORTE;
  const limite = new Date(Date.parse(hoyISO) - DIAS * diaMs).toISOString().slice(0, 10);
  salida.total.dias = Object.fromEntries(Object.entries(T.dias).filter(([d]) => d >= limite));
  salida.total.dlsCorte = Object.values(shows).reduce((a, x) => a + (x.duplicadoDe ? 0 : x.dlsCorte || 0), 0);
  salida.total.horasCorte = Object.values(shows).reduce((a, x) => a + (x.duplicadoDe ? 0 : x.horasCorte || 0), 0);
  console.log(`Desde el corte ${CORTE}: ${salida.total.dlsCorte} descargas · ${salida.total.horasCorte} h`);
  await writeFile("stats_op3.json", JSON.stringify(salida));
  await writeFile("historial_op3.json", JSON.stringify(hist, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
