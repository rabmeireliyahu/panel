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
const SP_DC = ((process.env.SPOTIFY_SP_DC || "").trim() || sacarCookie(SP_COOKIE, "sp_dc")).replace(/^sp_dc=/, "");
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
  const r1 = await pedir(u, { headers: { Cookie: `sp_dc=${sp_dc}; sp_key=${sp_key}`, "User-Agent": "Mozilla/5.0" } });
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
      if (r.status === 401) throw new CookiesVencidas(`Spotify 401 en ${path}`);
      if (r.status === 403) throw new Error(`sin permiso en Spotify para ${path} (¿el show es de otra cuenta?)`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Spotify ${r.status} en ${path}`);
      return r.json();
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

async function porDiaShow(api, showId, desde, hasta) {
  // detailedStreams por tramos de 30 dias → { dia: starts }
  const dias = {};
  for (let t = Date.parse(desde); t <= Date.parse(hasta); t += 30 * diaMs) {
    const fin = Math.min(t + 29 * diaMs, Date.parse(hasta));
    const r = await api(`/shows/${showId}/detailedStreams`, { start: iso(t), end: iso(fin) });
    for (const d of r?.detailedStreams || []) dias[d.date] = (d.starts ?? d.streams ?? 0);
  }
  return dias;
}

export async function procesarShow(api, showId, ahora, desdeHist) {
  const hoy0 = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate());
  const ayer = iso(hoy0 - diaMs);
  const U = [iso(hoy0 - 30 * diaMs), ayer], P = [iso(hoy0 - 60 * diaMs), iso(hoy0 - 31 * diaMs)];
  const meta = (await api(`/shows/${showId}/metadata`)) || {};
  const [eU, eP] = [await episodiosEnRango(api, showId, ...U), await episodiosEnRango(api, showId, ...P)];

  // retencion de cada episodio que tuvo plays en los ultimos 60 dias
  const oido = new Map(); let conCurva = 0;
  const ids = [...new Set([...eU, ...eP].filter((e) => (e.starts || 0) > 0).map((e) => e.id))];
  const durPorId = new Map([...eU, ...eP].map((e) => [e.id, durEnSeg(e.duration)]));
  for (const id of ids) {
    let perf = null;
    try { perf = await api(`/episodes/${id}/performance`); } catch (e) { if (e instanceof CookiesVencidas) throw e; }
    const seg = segundosOidos(perf, durPorId.get(id));
    if (seg) { oido.set(id, seg); conCurva++; }
    await espera(120);
  }
  // promedio del show (ponderado por plays) para episodios sin curva
  let sumSeg = 0, sumDur = 0, sumStarts = 0;
  for (const e of [...eU, ...eP]) {
    const s = oido.get(e.id); if (!s || !e.starts) continue;
    sumSeg += s * e.starts; sumDur += (durPorId.get(e.id) || s) * e.starts; sumStarts += e.starts;
  }
  const fraccion = sumDur ? Math.min(1, sumSeg / sumDur) : null;
  const segPorPlay = sumStarts ? sumSeg / sumStarts : null;
  const horas = (eps) => eps.reduce((a, e) => {
    const st = e.starts || 0; if (!st) return a;
    const s = oido.get(e.id) ?? (fraccion != null ? fraccion * (durPorId.get(e.id) || 0) : 0);
    return a + st * s;
  }, 0) / 3600;
  const suma = (eps, k) => eps.reduce((a, e) => a + (e[k] || 0), 0);

  // seguidores (ultimo valor)
  const fol = await api(`/shows/${showId}/followers`, { start: iso(hoy0 - 7 * diaMs), end: ayer });
  const ultimoFol = (fol?.counts || []).filter((c) => c.count != null).slice(-1)[0]?.count;

  // serie diaria (plays por dia) desde donde falte historial; horas/dia ≈ plays × seg promedio
  const dias = await porDiaShow(api, showId, desdeHist, ayer);
  const seg = segPorPlay || 0;
  const diasH = Object.fromEntries(Object.entries(dias).map(([d, n]) => [d, [n, +(n * seg / 3600).toFixed(1)]]));

  return {
    spotifyId: showId, nombre: meta.name || "", seguidores: ultimoFol ?? meta.followers ?? null,
    playsTotalCreators: meta.starts ?? null, episodiosSpotify: meta.totalEpisodes ?? null,
    plays30: suma(eU, "starts"), streams30: suma(eU, "streams"), playsPrev30: suma(eP, "starts"),
    horas30: Math.round(horas(eU)), horasPrev30: Math.round(horas(eP)),
    fraccionOida: fraccion != null ? +fraccion.toFixed(3) : null,
    minutosPorPlay: segPorPlay ? +(segPorPlay / 60).toFixed(1) : null,
    episodiosConCurva: conCurva, dias: diasH,
  };
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
  if (!SP_DC || !SP_KEY) {
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

  hist._diasShow = hist._diasShow || {};
  const shows = {}; const sinRepo = [];
  const ids = new Set([...cuenta.map((s) => s.id)]);
  for (const id of Object.keys(SPOTIFY_IDS)) ids.add(id); // por si el catalogo no los lista todos
  for (const id of ids) {
    const nombreCuenta = cuenta.find((s) => s.id === id)?.nombre || "";
    const repo = SPOTIFY_IDS[id] || porNombre.get(normal(nombreCuenta));
    if (!repo) { sinRepo.push(nombreCuenta || id); continue; }
    if (shows[repo]) continue;
    // historial: si el show ya tiene dias guardados, solo bajar los ultimos 60; si no, desde el corte
    const h = hist._diasShow[repo] || (hist._diasShow[repo] = {});
    const desde = Object.keys(h).length ? iso(Date.parse(hoyISO) - DIAS * diaMs) : CORTE;
    try {
      const s = await procesarShow(api, id, ahora, desde);
      for (const [d, v] of Object.entries(s.dias)) if (d >= CORTE && d < hoyISO) h[d] = v;
      const v = Object.values(h).reduce((a, x) => [a[0] + x[0], a[1] + x[1]], [0, 0]);
      s.playsCorte = v[0]; s.horasCorte = Math.round(v[1]);
      // el panel solo necesita los ultimos 60 dias
      const lim = iso(Date.parse(hoyISO) - DIAS * diaMs);
      s.dias = Object.fromEntries(Object.entries(s.dias).filter(([d]) => d >= lim));
      shows[repo] = s;
      console.log(`✓ ${repo.padEnd(18)} plays30 ${String(s.plays30).padStart(6)} (antes ${s.playsPrev30}) · ${String(s.horas30).padStart(5)} h (antes ${s.horasPrev30} h) · oyen ${s.fraccionOida != null ? Math.round(s.fraccionOida * 100) + "%" : "–"} (${s.minutosPorPlay ?? "–"} min/play) · seguidores ${s.seguidores ?? "–"} · desde corte ${s.horasCorte} h`);
    } catch (e) {
      if (e instanceof CookiesVencidas) { await guardarError("Las cookies de Spotify vencieron: hay que copiarlas de nuevo"); process.exitCode = 2; return; }
      console.log(`✗ ${repo}: ${e.message}`);
      if (previo?.shows?.[repo]) shows[repo] = { ...previo.shows[repo], viejo: true };
    }
    await espera(500);
  }
  if (sinRepo.length) console.log("Shows de Spotify sin repo en el panel: " + sinRepo.join(", "));

  const T = { plays30: 0, playsPrev30: 0, horas30: 0, horasPrev30: 0, seguidores: 0, playsCorte: 0, horasCorte: 0, dias: {} };
  for (const s of Object.values(shows)) {
    for (const k of ["plays30", "playsPrev30", "horas30", "horasPrev30", "seguidores", "playsCorte", "horasCorte"]) T[k] += s[k] || 0;
    for (const [d, [n, h]] of Object.entries(s.dias || {})) {
      const x = T.dias[d] || (T.dias[d] = [0, 0]); x[0] += n; x[1] = +(x[1] + h).toFixed(1);
    }
  }
  T.cambioPct = T.horasPrev30 ? Math.round((T.horas30 / T.horasPrev30 - 1) * 100) : null;
  console.log(`\nSPOTIFY 30 dias: ${T.plays30} plays · ${T.horas30} h | 30 dias antes: ${T.playsPrev30} plays · ${T.horasPrev30} h (${T.cambioPct ?? "–"}%) | desde corte ${T.horasCorte} h`);

  await writeFile("stats_spotify.json", JSON.stringify({ generado: ahora.toISOString(), fecha: hoyISO, corte: CORTE, total: T, shows, sinRepo }));
  await writeFile("historial_spotify.json", JSON.stringify(hist, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("Spotify: " + e.message); process.exit(1); });
}
