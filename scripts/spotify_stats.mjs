// ═══════════ ROBOT DE SPOTIFY FOR CREATORS ═══════════
// Spotify NO pasa por op3.dev/e/ (guarda su copia del audio), asi que sus
// escuchas solo las sabe Spotify. Este robot entra a Spotify for Creators con
// las cookies de tu sesion (secrets SPOTIFY_SP_DC y SPOTIFY_SP_KEY) y baja,
// para cada show de tu cuenta:
//   · plays (starts), oyentes y seguidores
//   · cuanto oye REALMENTE la gente de cada episodio (curva de retencion)
//   → horas reales = cada play × lo que en promedio se oye de ESE episodio
// Guarda stats_spotify.json (lo lee el panel y el robot de OP3) y
// historial_spotify.json (dia por dia desde el corte, nunca se borra).
// Es la misma API que usa Spotify for Creators en el navegador (no oficial),
// igual que el proyecto Open Podcast: github.com/openpodcast/spotify-connector
// Uso local:  SPOTIFY_SP_DC=... SPOTIFY_SP_KEY=... node scripts/spotify_stats.mjs
// IMPORTANTE: el repo es publico → nunca imprimir cookies ni tokens.
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

// Se aceptan las dos cookies por separado (SPOTIFY_SP_DC / SPOTIFY_SP_KEY) o, mas facil,
// la linea "cookie:" completa copiada de la pestaña Network (secret SPOTIFY_COOKIE).
export function sacarCookie(linea, nombre) {
  const m = (linea || "").replace(/^\s*cookie\s*:\s*/i, "").match(new RegExp("(?:^|;)\\s*" + nombre + "=([^;\\s]+)"));
  return m ? m[1].trim() : "";
}
const SP_COOKIE = process.env.SPOTIFY_COOKIE || "";
// si SPOTIFY_COOKIE trae solo el valor suelto de sp_dc (copiado con Cookie-Editor), tambien sirve
const soloValor = /^[A-Za-z0-9_\-]{60,}$/.test(SP_COOKIE.trim()) ? SP_COOKIE.trim() : "";
const SP_DC = ((process.env.SPOTIFY_SP_DC || "").trim() || sacarCookie(SP_COOKIE, "sp_dc") || soloValor).replace(/^sp_dc=/, "");
const SP_KEY = ((process.env.SPOTIFY_SP_KEY || "").trim() || sacarCookie(SP_COOKIE, "sp_key")).replace(/^sp_key=/, "");
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "05a1371ee5194c27860b3ff3ff3979d2";
const BASE = process.env.SPOTIFY_BASE_URL || "https://generic.wg.spotify.com/podcasters/v0";
const CORTE = "2026-07-17";
const DIAS = 60;
const diaMs = 86400000;

// show de Spotify → repo del panel (mismo mapa que SPOTIFY_MAP en index.html).
// Los shows de tu cuenta que no esten aqui se emparejan por nombre con los feeds.
const SPOTIFY_IDS = {
  "79x4PVsbPAnLZ0mUr1Oa5j": "ravmeir",
  "6iRarANnjovh39suhYLemM": "musar",
  "5cSJFLJ1IvapcH5L9i4CSU": "yechavedaat",
  "06h5PQpd2N5lwUTNHMpRDD": "ravmutzafi",
  "3dNq8BgToKoChJjKw2XCkK": "ravyitzchakyosef",
  "6WduLqEwPHFfddsQYC7qoe": "yakobov",
  "0GX6Bc4S6BHSWlamYgrAb2": "abergel",
  "1YDvt19tObIvqsaptHK0zK": "podcast",
  "1mQHhjvlSUJUrAGQbWTIdD": "ravshmueli",
  "033fyjMvhujvDj4I9z69hG": "torahanytime",
  "5QoEze3h1lRPgsdUOGLOQP": "peretz",
  "7IIbVOhwAcSkPnWO5GXsJG": "ravasherweiss",
  "033XnfqUvY5NTtUx68kaWP": "bensoussan",
  "033Xn7o4U4umJiIWMcwDDl": "musayof",
  "033Xnc9ELU8FF1ibMhiyrL": "abuhatzeira",
};

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const b64url = (buf) => buf.toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
const normal = (s) => (s || "").normalize("NFKD").replace(/[֑-ׇ̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9א-ת]+/g, " ").trim();

class CookiesVencidas extends Error {}

// ── login: el mismo flujo PKCE que hace la pagina de Creators ──
export async function autenticar(sp_dc, sp_key, pedir = fetch) {
  // sp_key a veces ya no existe en las cuentas nuevas: se manda solo si la hay
  const galleta = sp_key ? `sp_dc=${sp_dc}; sp_key=${sp_key}` : `sp_dc=${sp_dc}`;
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const u = new URL("https://accounts.spotify.com/oauth2/v2/auth");
  Object.entries({
    response_type: "code", client_id: CLIENT_ID,
    scope: "streaming ugc-image-upload user-read-email user-read-private",
    redirect_uri: "https://podcasters.spotify.com", code_challenge: challenge,
    code_challenge_method: "S256", state, response_mode: "web_message", prompt: "none",
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r1 = await pedir(u, { headers: { Cookie: galleta, "User-Agent": "Mozilla/5.0" } });
  const html = await r1.text();
  if (!r1.ok) throw new Error("Spotify login HTTP " + r1.status);
  if (/login_required/.test(html)) throw new CookiesVencidas("Spotify pide iniciar sesion: las cookies vencieron");
  const bloque = (html.match(/const authorizationResponse\s*=\s*([\s\S]*?);/) || [])[1] || "";
  const code = (bloque.match(/["']?code["']?\s*:\s*["']([^"']+)["']/) || [])[1];
  const st = (bloque.match(/["']?state["']?\s*:\s*["']([^"']+)["']/) || [])[1];
  if (!code) throw new Error("Spotify no devolvio codigo de autorizacion (cambio el login?)");
  if (st !== state) throw new Error("Spotify devolvio un state distinto");
  const r2 = await pedir("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code,
      redirect_uri: "https://podcasters.spotify.com", code_verifier: verifier }),
  });
  if (!r2.ok) throw new Error("Spotify token HTTP " + r2.status);
  const j = await r2.json();
  if (!j.access_token) throw new Error("Spotify no entrego token");
  return j.access_token;
}

// diagnostico: que contesta Spotify en cada ruta (codigo HTTP y forma de la respuesta,
// sin tokens ni cookies) → se imprime al final para poder ajustar si Spotify cambia algo
export const DIAG = {};
function forma(x, prof = 0) {
  if (Array.isArray(x)) return x.length ? `[${x.length}× ${forma(x[0], prof + 1)}]` : "[]";
  if (x && typeof x === "object") {
    if (prof > 2) return "{…}";
    return "{" + Object.entries(x).slice(0, 25).map(([k, v]) => `${k}:${typeof v === "number" ? v : typeof v === "string" ? JSON.stringify(v.slice(0, 24)) : forma(v, prof + 1)}`).join(", ") + "}";
  }
  return String(x);
}
function anotar(path, status, cuerpo) {
  const tipo = path.replace(/\/(shows|episodes)\/[A-Za-z0-9]+/g, "/$1/:id");
  const d = DIAG[tipo] || (DIAG[tipo] = { codigos: {}, muestra: null });
  d.codigos[status] = (d.codigos[status] || 0) + 1;
  if (cuerpo !== undefined && !d.muestra) d.muestra = forma(cuerpo).slice(0, 700);
}
export function crearApi(token, pedir = fetch) {
  return async function api(path, params = {}, intentos = 6) {
    const u = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, v);
    let pausa = 2000;
    for (let i = 0; i < intentos; i++) {
      let r;
      try { r = await pedir(u, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } }); }
      catch (e) { if (i === intentos - 1) throw e; await espera(pausa *= 2); continue; }
      if ([429, 500, 502, 503, 504].includes(r.status)) { await espera(pausa *= 2); continue; }
      if (!r.ok) anotar(path, r.status);
      if (r.status === 401) throw new CookiesVencidas(`Spotify 401 en ${path}`);
      if (r.status === 403) throw new Error(`sin permiso en Spotify para ${path} (¿el show es de otra cuenta?)`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Spotify ${r.status} en ${path}`);
      const j = await r.json();
      anotar(path, r.status, j);
      return j;
    }
    throw new Error("Spotify no respondio: " + path);
  };
}

// ── cuanto se oye de un episodio, a partir de su curva de retencion ──
// samples[i] = cuantos siguen oyendo en el segundo i×sampleRate; el area bajo
// la curva / los que empezaron = segundos promedio que oye cada play.
export function segundosOidos(perf, durSeg) {
  if (!perf) return null;
  const s = Array.isArray(perf.samples) ? perf.samples : [];
  const paso = (perf.sampleRate || 1000) / 1000;
  const inicio = Math.max(perf.max || 0, s[0] || 0);
  if (s.length && inicio > 0) {
    const area = s.reduce((a, x) => a + (x > 0 ? x : 0), 0) * paso;
    const seg = area / inicio;
    if (Number.isFinite(seg) && seg > 0) return durSeg ? Math.min(seg, durSeg) : seg;
  }
  const med = perf.medianCompletion?.seconds;
  return Number.isFinite(med) && med > 0 ? med : null;
}
const durEnSeg = (d) => (!d ? 0 : d > 36000 ? d / 1000 : d); // Spotify la da en ms

async function episodiosEnRango(api, showId, start, end) {
  const lista = [];
  for (let page = 1; page <= 100; page++) {
    const r = await api(`/shows/${showId}/episodes`, { start, end, page, size: 50, sortBy: "releaseDate", sortOrder: "descending", filter: "" });
    if (!r) break;
    lista.push(...(r.episodes || []));
    if (!r.totalPages || page >= r.totalPages) break;
  }
  return lista;
}

// ── LO INFALIBLE: plays TOTALES de Creators, foto diaria ──
// Spotify da en /metadata los plays acumulados de toda la vida del show (es la misma
// cifra de Creators). Guardando esa foto cada dia, los plays de cualquier periodo son
// una simple resta. Si un dia el robot no puede entrar (cookies vencidas), no se pierde
// nada: la siguiente foto buena trae todo lo acumulado y la resta lo recupera.
// Base: los plays reales de Creators al corte (17/jul/2026), los mismos de SPOTIFY_STATS.
export const BASE_CORTE = { ravmeir: 731300, musar: 45046, yechavedaat: 36815, ravmutzafi: 22509,
  ravyitzchakyosef: 6235, podcast: 5899, yakobov: 5262, abergel: 2856, ravshmueli: 2302, torahanytime: 356, peretz: 62 };
// minutos que en promedio se oyen por play, segun Creators en julio (horas30×60 / plays30)
export const MIN_POR_PLAY_JULIO = { ravmeir: 19.0, musar: 17.0, yechavedaat: 8.5, ravmutzafi: 17.2, ravyitzchakyosef: 18.5,
  podcast: 7.9, yakobov: 21.6, abergel: 17.7, ravshmueli: 13.9, torahanytime: 4.1, peretz: 18.4 };
export const MIN_POR_PLAY_DEFECTO = 17.2; // mediana de los de arriba

// totales = { "YYYY-MM-DD": plays acumulados }; hoyISO = dia de la ultima foto
export function calcularDesdeTotales(totales, hoyISO) {
  const fechas = Object.keys(totales).filter((d) => totales[d] != null).sort();
  if (!fechas.length) return null;
  const ult = fechas[fechas.length - 1], tUlt = Date.parse(ult), vUlt = totales[ult];
  const dias = (a, b) => (Date.parse(b) - Date.parse(a)) / diaMs;
  // foto mas cercana a una fecha objetivo (dentro de ±tol dias)
  const cerca = (obj, tol) => {
    let mejor = null;
    for (const d of fechas) { const dd = Math.abs(dias(d, obj)); if (dd <= tol && (!mejor || dd < mejor.dd)) mejor = { d, dd }; }
    return mejor?.d || null;
  };
  const hace = (n) => new Date(tUlt - n * diaMs).toISOString().slice(0, 10);
  // ultimos 30 dias: resta exacta si hay foto de hace ~30 dias; si no, ritmo desde la foto mas vieja
  let plays30, exacto = true;
  const r30 = cerca(hace(30), 3);
  if (r30 && r30 !== ult) plays30 = (vUlt - totales[r30]) * 30 / dias(r30, ult);
  else {
    const prim = fechas[0];
    exacto = false;
    plays30 = prim !== ult ? (vUlt - totales[prim]) * 30 / dias(prim, ult) : null;
  }
  // 30 dias anteriores: solo si hay fotos de hace ~30 y ~60 dias
  const r60 = cerca(hace(60), 3);
  const playsPrev30 = r30 && r60 && r30 !== r60 ? (totales[r30] - totales[r60]) * 30 / dias(r60, r30) : null;
  // serie diaria: lo que crecio entre fotos, repartido parejo en esos dias
  const porDia = {};
  for (let i = 1; i < fechas.length; i++) {
    const a = fechas[i - 1], b = fechas[i], n = Math.round(dias(a, b)), inc = Math.max(0, totales[b] - totales[a]);
    for (let k = 0; k < n; k++) {
      const d = new Date(Date.parse(a) + k * diaMs).toISOString().slice(0, 10);
      porDia[d] = (porDia[d] || 0) + inc / n;
    }
  }
  return { total: vUlt, ultimaFoto: ult, plays30: plays30 != null ? Math.max(0, Math.round(plays30)) : null,
    playsPrev30: playsPrev30 != null ? Math.max(0, Math.round(playsPrev30)) : null, exacto30: exacto, porDia };
}

// plays por dia (ruta detailedStreams), por tramos de 30 dias → { dia: plays }
async function porDiaShow(api, showId, desde, hasta) {
  const dias = {};
  for (let t = Date.parse(desde); t <= Date.parse(hasta); t += 30 * diaMs) {
    const fin = Math.min(t + 29 * diaMs, Date.parse(hasta));
    const r = await api(`/shows/${showId}/detailedStreams`, { start: iso(t), end: iso(fin) });
    for (const d of r?.detailedStreams || []) dias[d.date] = (d.starts ?? d.streams ?? 0);
  }
  return dias;
}

export async function procesarShow(api, showId, ahora, desdeDias) {
  const hoy0 = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate());
  const ayer = iso(hoy0 - diaMs);
  const meta = (await api(`/shows/${showId}/metadata`)) || {};
  const fol = await api(`/shows/${showId}/followers`, { start: iso(hoy0 - 7 * diaMs), end: ayer }).catch(() => null);
  const ultimoFol = (fol?.counts || []).filter((c) => c.count != null).slice(-1)[0]?.count;

  // Extra (si Spotify lo da): minutos que realmente se oyen, de las curvas de retencion
  // de los episodios con plays en los ultimos 30 dias. Si no hay curvas, se usa el dato de julio.
  let segPorPlay = null, conCurva = 0;
  try {
    const eps = (await episodiosEnRango(api, showId, iso(hoy0 - 30 * diaMs), ayer)).filter((e) => (e.starts || 0) > 0)
      .sort((x, y) => y.starts - x.starts).slice(0, 40);
    let sumSeg = 0, sumStarts = 0;
    for (const e of eps) {
      const seg = segundosOidos(await api(`/episodes/${e.id}/performance`), durEnSeg(e.duration));
      if (seg) { sumSeg += seg * e.starts; sumStarts += e.starts; conCurva++; }
      await espera(120);
    }
    if (sumStarts) segPorPlay = sumSeg / sumStarts;
  } catch (e) { if (e instanceof CookiesVencidas) throw e; }

  // plays reales de cada dia, desde donde falte (si un dia fallo, aqui se recupera)
  const diasPlays = desdeDias ? await porDiaShow(api, showId, desdeDias, ayer) : {};

  return {
    diasPlays,
    spotifyId: showId, nombre: meta.name || "", seguidores: ultimoFol ?? meta.followers ?? null,
    playsTotalCreators: meta.starts ?? null, streamsTotalCreators: meta.streams ?? null,
    episodiosSpotify: meta.totalEpisodes ?? null,
    minutosPorPlayCurvas: segPorPlay ? +(segPorPlay / 60).toFixed(1) : null, episodiosConCurva: conCurva,
  };
}

// Calcula plays/horas de 30 dias, 30 dias previos y desde el corte, a partir del historial
// (dias reales; si no hay, resta de fotos de plays totales). Sirve con o sin conexion.
export function completarShow(s, repo, hist, hoyISO) {
  const hoy0 = Date.parse(hoyISO);
  const lim = iso(hoy0 - DIAS * diaMs);
  const sumaDias = (d, desde, hasta) => Object.entries(d).reduce((a, [k, n]) => (k >= desde && k <= hasta ? a + n : a), 0);
  const dPrev = hist.dias[repo] || {};
  const fotos = hist.totales[repo] || (hist.totales[repo] = {});
  if (BASE_CORTE[repo] != null && fotos[CORTE] == null) fotos[CORTE] = BASE_CORTE[repo];
  if (s.playsTotalCreators != null) fotos[hoyISO] = s.playsTotalCreators;
  // minutos por play: curvas de retencion de hoy si hay suficientes; si no, el real de julio
  const min = (s.episodiosConCurva >= 3 && s.minutosPorPlayCurvas) || MIN_POR_PLAY_JULIO[repo] || MIN_POR_PLAY_DEFECTO;
  const h = (n) => (n == null ? null : Math.round(n * min / 60));
  const ayer = iso(hoy0 - diaMs);
  let plays30, playsPrev30, playsCorte, porDia, fuente;
  if (Object.keys(dPrev).length) {
    // fuente principal: plays reales dia por dia. Las ventanas terminan en el ultimo dia que
    // Spotify ya reporto (tarda 1-2 dias), para no comparar un mes completo contra uno cortado.
    fuente = "dias";
    const fin = Object.keys(dPrev).filter((d) => d <= ayer).sort().pop() || ayer;
    const tFin = Date.parse(fin);
    plays30 = sumaDias(dPrev, iso(tFin - 29 * diaMs), fin);
    playsPrev30 = sumaDias(dPrev, iso(tFin - 59 * diaMs), iso(tFin - 30 * diaMs));
    playsCorte = sumaDias(dPrev, CORTE, fin);
    porDia = dPrev;
  } else {
    // respaldo: resta de plays totales entre fotos
    fuente = "totales";
    const c = calcularDesdeTotales(fotos, hoyISO);
    const base = fotos[CORTE] ?? fotos[Object.keys(fotos).sort()[0]];
    plays30 = c?.plays30 ?? null; playsPrev30 = c?.playsPrev30 ?? null;
    playsCorte = c ? Math.max(0, c.total - base) : 0; porDia = c?.porDia || {};
  }
  Object.assign(s, {
    plays30, playsPrev30, horas30: h(plays30), horasPrev30: h(playsPrev30), minutosPorPlay: min, fuente,
    fuenteMinutos: s.episodiosConCurva >= 3 && s.minutosPorPlayCurvas ? "curvas" : MIN_POR_PLAY_JULIO[repo] ? "julio" : "mediana",
    playsCorte, horasCorte: h(playsCorte),
    dias: Object.fromEntries(Object.entries(porDia).filter(([d]) => d >= lim)
      .map(([d, n]) => [d, [Math.round(n), +(n * min / 60).toFixed(1)]])),
  });
  return s;
}

function prepararHist(hist) {
  hist.totales = hist.totales || {};
  hist.dias = hist.dias || {};
  // formato anterior: _diasShow[repo][dia] = [plays, horas] → se pasa a dias[repo][dia] = plays
  for (const [k, v] of Object.entries(hist._diasShow || {})) {
    const d = hist.dias[k] || (hist.dias[k] = {});
    for (const [dia, x] of Object.entries(v)) if (d[dia] == null) d[dia] = Array.isArray(x) ? x[0] : x;
  }
  delete hist._diasShow;
}

function totalesDe(shows) {
  const T = { plays30: 0, playsPrev30: 0, horas30: 0, horasPrev30: 0, seguidores: 0, playsCorte: 0, horasCorte: 0, dias: {} };
  for (const s of Object.values(shows)) {
    for (const k of ["plays30", "playsPrev30", "horas30", "horasPrev30", "seguidores", "playsCorte", "horasCorte"]) T[k] += s[k] || 0;
    for (const [d, [n, h]] of Object.entries(s.dias || {})) {
      const x = T.dias[d] || (T.dias[d] = [0, 0]); x[0] += n; x[1] = +(x[1] + h).toFixed(1);
    }
  }
  T.cambioPct = T.horasPrev30 ? Math.round((T.horas30 / T.horasPrev30 - 1) * 100) : null;
  return T;
}

async function guardarTodo(shows, sinRepo, hist, ahora, extra = {}) {
  const T = totalesDe(shows);
  console.log(`\nSPOTIFY 30 dias: ${T.plays30} plays · ${T.horas30} h | 30 dias antes: ${T.playsPrev30} plays · ${T.horasPrev30} h (${T.cambioPct ?? "–"}%) | desde corte ${T.playsCorte} plays = ${T.horasCorte} h`);
  await writeFile("stats_spotify.json", JSON.stringify({ generado: ahora.toISOString(), fecha: iso(ahora), corte: CORTE, ...extra, total: T, shows, sinRepo }));
  await writeFile("historial_spotify.json", JSON.stringify(hist, null, 1));
}

// Rehace stats_spotify.json solo con el historial guardado (sin entrar a Spotify).
// Uso: SPOTIFY_OFFLINE=1 node scripts/spotify_stats.mjs
async function recalcularSinConexion(previo, hist, ahora) {
  prepararHist(hist);
  const hoyISO = iso(ahora);
  const repos = new Set([...Object.keys(hist.dias), ...Object.keys(hist.totales), ...Object.keys(previo?.shows || {})]);
  const shows = {};
  for (const repo of repos) {
    const p = previo?.shows?.[repo] || {};
    const s = { spotifyId: p.spotifyId, nombre: p.nombre || "", seguidores: p.seguidores ?? null,
      episodiosSpotify: p.episodiosSpotify ?? null, episodiosConCurva: 0 };
    completarShow(s, repo, hist, hoyISO);
    s.playsTotalCreators = p.playsTotalCreators ?? null;
    shows[repo] = s;
    console.log(`· ${repo.padEnd(18)} plays30 ${s.plays30} (antes ${s.playsPrev30}) · ${s.horas30} h (antes ${s.horasPrev30} h) · ${s.minutosPorPlay} min/play · desde corte ${s.playsCorte} plays = ${s.horasCorte} h`);
  }
  await guardarTodo(shows, previo?.sinRepo || [], hist, ahora, { recalculadoSinConexion: true });
}

async function main() {
  const ahora = new Date();
  const hoyISO = iso(ahora);
  let previo = null, hist = {};
  try { previo = JSON.parse(await readFile("stats_spotify.json", "utf8")); } catch { /* primera vez */ }
  try { hist = JSON.parse(await readFile("historial_spotify.json", "utf8")); } catch { /* primera vez */ }

  const guardarError = async (msg) => {
    // no se borra lo ultimo bueno: solo se anota el error (el panel avisa si ya esta viejo)
    const salida = { ...(previo || { shows: {} }), ultimoIntento: ahora.toISOString(), error: msg };
    await writeFile("stats_spotify.json", JSON.stringify(salida));
    console.log("⚠ " + msg);
  };
  if (SP_COOKIE) {
    // diagnostico SIN valores: solo nombres de cookies y largo (el repo es publico)
    const nombres = SP_COOKIE.replace(/^\s*cookie\s*:\s*/i, "").split(";").map((c) => c.split("=")[0].trim()).filter(Boolean);
    console.log(`SPOTIFY_COOKIE: ${SP_COOKIE.length} caracteres · cookies: ${nombres.join(", ") || "(ninguna con formato nombre=valor)"}`);
  }
  if (process.env.SPOTIFY_OFFLINE) return await recalcularSinConexion(previo, hist, ahora);
  if (!SP_DC) {
    console.log(SP_COOKIE ? "Spotify: el secret SPOTIFY_COOKIE no trae sp_dc y sp_key (¿se copio la linea completa?). Se omite."
      : "Spotify: falta el secret SPOTIFY_COOKIE (o SPOTIFY_SP_DC / SPOTIFY_SP_KEY) en GitHub. Se omite.");
    if (previo) await guardarError("Faltan las cookies de Spotify (secret SPOTIFY_COOKIE)");
    return;
  }

  let token;
  try { token = await autenticar(SP_DC, SP_KEY); }
  catch (e) {
    await guardarError(e instanceof CookiesVencidas ? "Las cookies de Spotify vencieron: hay que copiarlas de nuevo" : "No pude entrar a Spotify: " + e.message);
    process.exitCode = e instanceof CookiesVencidas ? 2 : 1;
    return;
  }
  const api = crearApi(token);

  // shows de la cuenta
  const cat = await api("/user/shows", { page: 1, size: 200, sortBy: "name", sortOrder: "ascending",
    start: iso(Date.now() - 30 * diaMs), end: hoyISO });
  const cuenta = (cat?.shows || cat?.items || []).map((s) => ({ id: s.id || s.showUri?.split(":").pop(), nombre: s.name || s.title || "" })).filter((s) => s.id);
  console.log(`Spotify: ${cuenta.length} shows en la cuenta`);

  // nombres de los feeds para emparejar shows que no estan en el mapa
  let porNombre = new Map();
  try {
    const op3 = JSON.parse(await readFile("stats_op3.json", "utf8"));
    porNombre = new Map(Object.entries(op3.shows || {}).filter(([, s]) => s.nombre).map(([k, s]) => [normal(s.nombre), k]));
  } catch { /* sin datos de OP3 todavia */ }

  prepararHist(hist);
  const hoy0 = Date.parse(hoyISO);
  const shows = {}; const sinRepo = [];
  const ids = new Set([...cuenta.map((s) => s.id)]);
  for (const id of Object.keys(SPOTIFY_IDS)) ids.add(id); // por si el catalogo no los lista todos
  for (const id of ids) {
    const nombreCuenta = cuenta.find((s) => s.id === id)?.nombre || "";
    const repo = SPOTIFY_IDS[id] || porNombre.get(normal(nombreCuenta));
    if (!repo) { sinRepo.push(nombreCuenta || id); continue; }
    if (shows[repo]) continue;
    try {
      const dPrev = hist.dias[repo] || (hist.dias[repo] = {});
      // desde donde bajar dias: si hay historial, desde 3 dias antes del ultimo guardado (o 60 dias,
      // lo que sea mas viejo) para corregir dias que Spotify termina de contar tarde y rellenar huecos
      const ultimo = Object.keys(dPrev).sort().pop();
      const desde = !ultimo ? CORTE : iso(Math.min(Date.parse(ultimo) - 3 * diaMs, hoy0 - DIAS * diaMs));
      const s = await procesarShow(api, id, ahora, desde < CORTE ? CORTE : desde);
      for (const [d, n] of Object.entries(s.diasPlays)) if (d >= CORTE && d < hoyISO) dPrev[d] = n;
      delete s.diasPlays;
      completarShow(s, repo, hist, hoyISO);
      shows[repo] = s;
      console.log(`✓ ${repo.padEnd(18)} total Creators ${String(s.playsTotalCreators ?? "–").padStart(7)} · plays30 ${String(s.plays30 ?? "–").padStart(6)} [${s.fuente}] (antes ${s.playsPrev30 ?? "–"}) · ${String(s.horas30 ?? "–").padStart(5)} h · ${min} min/play (${s.fuenteMinutos}) · seguidores ${s.seguidores ?? "–"} · desde corte ${s.playsCorte} plays = ${s.horasCorte} h`);
    } catch (e) {
      if (e instanceof CookiesVencidas) { await guardarError("Las cookies de Spotify vencieron: hay que copiarlas de nuevo"); process.exitCode = 2; return; }
      console.log(`✗ ${repo}: ${e.message}`);
      if (previo?.shows?.[repo]) shows[repo] = { ...previo.shows[repo], viejo: true };
    }
    await espera(500);
  }
  if (sinRepo.length) console.log("Shows de Spotify sin repo en el panel: " + sinRepo.join(", "));
  console.log("\nDiagnostico de rutas de Spotify (codigo HTTP → veces · forma de la respuesta):");
  for (const [t, d] of Object.entries(DIAG)) console.log(`  ${t} ${JSON.stringify(d.codigos)} ${d.muestra || ""}`);

  // Si entro pero TODO viene en cero, Spotify cambio algo en su respuesta: no se guardan
  // ceros como si fueran reales (el panel avisaria "0 h en Spotify"); se queda lo ultimo bueno.
  if (Object.keys(shows).length && !Object.values(shows).some((x) => x.playsTotalCreators)) {
    console.log("\nDiagnostico de rutas de Spotify:");
    for (const [t, d] of Object.entries(DIAG)) console.log(`  ${t} ${JSON.stringify(d.codigos)} ${d.muestra || ""}`);
    await guardarError("Spotify contesto pero sin plays totales (cambio su formato): se conserva el ultimo dato bueno");
    process.exitCode = 1;
    return;
  }
  await guardarTodo(shows, sinRepo, hist, ahora);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("Spotify: " + e.message); process.exit(1); });
}
