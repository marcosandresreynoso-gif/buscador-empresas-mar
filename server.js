// server.js — M-AR & Asociados — Buscador de Empresas
// Rota automáticamente entre GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3, GROQ_API_KEY_4
// Fuentes: Google Maps (paginación hasta 500) | Páginas Amarillas (scraping de fichas) | IA (Groq)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const CONTACTOS_FILE = path.join(__dirname, 'contactos-enviados.json');
if (!fs.existsSync(CONTACTOS_FILE)) {
  fs.writeFileSync(CONTACTOS_FILE, JSON.stringify({ whatsapp: [], email: [] }, null, 2));
}

// ═══════════════════════════════════════════════════════════
// ROTACIÓN DE KEYS GROQ
// ═══════════════════════════════════════════════════════════

const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
].filter(Boolean);

let keyIndex = 0;

function nextGroqKey() {
  const key = GROQ_KEYS[keyIndex % GROQ_KEYS.length];
  keyIndex++;
  return key;
}

async function llamarGroq(payload, intentos = GROQ_KEYS.length) {
  if (GROQ_KEYS.length === 0) throw new Error('No hay ninguna GROQ_API_KEY configurada.');
  for (let i = 0; i < intentos; i++) {
    const key = nextGroqKey();
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
      if (r.status === 429) continue;
      const d = await r.json();
      return d;
    } catch (e) {
      if (i === intentos - 1) throw e;
    }
  }
  throw new Error('Todas las keys de Groq están al límite. Intentá en unos minutos.');
}

// ═══════════════════════════════════════════════════════════
// MÓDULO IA — genera empresas realistas con Groq
// ═══════════════════════════════════════════════════════════

const SYSTEM_IA = `Sos un generador de bases de datos comerciales argentinas. 
Generás empresas REALES y VEROSÍMILES en JSON puro, sin texto adicional, sin markdown.
Formato exacto:
{"empresas":[
  {"nombre":"Nombre Real SRL","rubro":"Contabilidad","direccion":"Av. San Martín 456, ciudad, Buenos Aires","telefono":"02396-421234","email":"info@nombrereal.com.ar","web":"www.nombrereal.com.ar"},
  ...
]}
REGLAS:
- Nombres de empresas argentinas reales y creíbles para la zona
- Teléfonos con código de área correcto para la ciudad
- Emails con dominios .com.ar cuando posible
- Webs sin https://, solo el dominio
- Algunos sin email ni web (realismo)
- Direcciones con calles y números verosímiles de esa ciudad
- Solo JSON, nada más`;

async function generarEmpresasIA(ciudad, rubro, cantidad) {
  const lote = 10;
  const tandas = Math.ceil(cantidad / lote);
  const empresas = [];

  for (let i = 0; i < tandas; i++) {
    const n = Math.min(lote, cantidad - i * lote);
    const prompt = `Generá exactamente ${n} empresas del rubro "${rubro}" en ${ciudad}, Argentina.
Lote ${i + 1} de ${tandas}. Empresas diferentes a las anteriores.
Códigos de área típicos de ${ciudad}. Devolvé solo el JSON.`;

    try {
      const d = await llamarGroq({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 0.7,
        messages: [
          { role: 'system', content: SYSTEM_IA },
          { role: 'user', content: prompt }
        ]
      });
      const text = d.choices?.[0]?.message?.content || '';
      const clean = text.replace(/```json|```/g, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed.empresas) empresas.push(...parsed.empresas);
      }
    } catch (e) {
      console.error('Error IA lote', i, e.message);
    }

    if (i < tandas - 1) await new Promise(r => setTimeout(r, 300));
  }

  return empresas.slice(0, cantidad);
}

// ═══════════════════════════════════════════════════════════
// MÓDULO GOOGLE MAPS — hasta 500 resultados con paginación
// ═══════════════════════════════════════════════════════════

async function buscarGoogleMaps(query, location, cantidad) {
  let empresas = [];
  let pageToken = null;
  const max = Math.min(cantidad, 500); // hasta 500

  while (empresas.length < max) {
    let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query + ' ' + location)}&key=${MAPS_KEY}&language=es`;
    if (pageToken) url += `&pagetoken=${pageToken}`;

    const r = await fetch(url);
    const d = await r.json();

    if (d.status === 'REQUEST_DENIED' || d.status === 'INVALID_REQUEST') {
      throw new Error('MAPS_DENIED');
    }

    if (d.results) {
      for (const p of d.results) {
        if (empresas.length >= max) break;
        const detUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.place_id}&fields=name,formatted_address,formatted_phone_number,website,types&key=${MAPS_KEY}&language=es`;
        const detR = await fetch(detUrl);
        const detD = await detR.json();
        const det = detD.result || {};
        empresas.push({
          nombre: det.name || p.name || '',
          rubro: query,
          direccion: det.formatted_address || p.formatted_address || '',
          telefono: det.formatted_phone_number || '',
          email: '',
          web: det.website || '',
        });
      }
    }

    pageToken = d.next_page_token;
    if (!pageToken || empresas.length >= max) break;
    // Google requiere esperar 2s antes de usar el next_page_token
    await new Promise(r => setTimeout(r, 2000));
  }

  return empresas;
}

// ═══════════════════════════════════════════════════════════
// MÓDULO PÁGINAS AMARILLAS — scraping vía fichas individuales
// ═══════════════════════════════════════════════════════════
// El listado (/b/{rubro}/{ciudad}) se renderiza con JS y no trae
// datos en el HTML plano. Las fichas individuales (/fichas/...)
// sí exponen teléfono/dirección en texto. Estrategia:
//   1) Pedimos el listado igual (a veces incluye nombres en metadatos
//      y enlaces a fichas en el HTML server-rendered).
//   2) Para cada ficha encontrada, hacemos fetch y extraemos los datos.
//   3) Si el listado no trae nada usable, devolvemos vacío sin romper
//      el flujo general (la fuente queda disponible para cuando el
//      sitio cambie de tecnología o se sume soporte con navegador real).

const PA_BASE = 'https://www.paginasamarillas.com.ar';

function slugify(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin tildes
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

async function fetchHtmlPA(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extraerFichasDelListado(html) {
  // Busca enlaces a /fichas/{slug}_{id}
  if (!html) return [];
  const set = new Set();
  for (const m of html.matchAll(/href="(\/fichas\/[a-z0-9-]+_\d+)\/?"/gi)) {
    set.add(PA_BASE + m[1]);
  }
  return [...set];
}

function extraerDatosFicha(html, fallbackNombre) {
  if (!html) return null;
  // Nombre: del <title> o de un h1
  let nombre = fallbackNombre || '';
  const tituloMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (tituloMatch) {
    nombre = tituloMatch[1].split(' en ')[0].split(' - ')[0].trim();
  }
  // Teléfono: patrones tipo "+ (03388) 42 - 1503" o similares en texto plano
  let telefono = '';
  const telMatch = html.match(/Tel[eé]fono[^0-9+]*([+0-9][0-9()\-\s]{6,20})/i);
  if (telMatch) telefono = telMatch[1].replace(/\s{2,}/g, ' ').trim();
  // Dirección
  let direccion = '';
  const dirMatch = html.match(/Direcci[oó]n[^A-Za-zÁÉÍÓÚñÑ]*([^<\n]{5,90})/i);
  if (dirMatch) direccion = dirMatch[1].trim();
  // Email visible (mailto o texto)
  let email = '';
  const mailMatch = html.match(/href="mailto:([^"?]+)"/i) || html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (mailMatch) email = (mailMatch[1] || mailMatch[0] || '').toLowerCase();
  // Web (si la ficha linkea un sitio externo propio, no de paginasamarillas)
  let web = '';
  const webMatch = html.match(/href="(https?:\/\/(?!www\.paginasamarillas)[^"]+)"[^>]*>\s*(?:Visitar sitio|Sitio web|Web)/i);
  if (webMatch) web = webMatch[1];

  if (!telefono && !direccion && !email && !web) return null; // ficha sin datos útiles
  return { nombre, telefono, direccion, email, web };
}

async function buscarPaginasAmarillas(rubro, ciudad, cantidad, concurrency = 3) {
  const rubroSlug = slugify(rubro);
  const ciudadSlug = slugify(ciudad);
  const listadoUrl = `${PA_BASE}/b/${rubroSlug}/${ciudadSlug}`;
  const htmlListado = await fetchHtmlPA(listadoUrl);
  const fichas = extraerFichasDelListado(htmlListado).slice(0, Math.min(cantidad, 200));

  if (!fichas.length) {
    // No pudimos extraer fichas del listado (probable render 100% client-side).
    // Devolvemos vacío para que el llamador pueda decidir un fallback.
    return [];
  }

  const empresas = [];
  for (let i = 0; i < fichas.length; i += concurrency) {
    const lote = fichas.slice(i, i + concurrency);
    const resultados = await Promise.all(lote.map(async (url) => {
      const html = await fetchHtmlPA(url);
      const datos = extraerDatosFicha(html);
      if (!datos) return null;
      return { ...datos, rubro, direccion: datos.direccion || ciudad };
    }));
    resultados.forEach(r => { if (r) empresas.push(r); });
    if (empresas.length >= cantidad) break;
  }

  return empresas.slice(0, cantidad);
}

// ═══════════════════════════════════════════════════════════
// ENRIQUECIMIENTO WEB (común a las 3 fuentes)
// ═══════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (compatible; MAR-LeadBot/1.0)';
const TIMEOUT_MS = 8000;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const JUNK_EMAIL = /(noreply|no-reply|mailer|sentry|wixpress|example\.|tudominio|yourdomain|sitename|\.(png|jpg|gif|svg|css|js)$)/i;

function normalizeUrl(raw) {
  if (!raw) return null;
  let u = String(raw).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).toString(); } catch { return null; }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 1_500_000) return null;
    return Buffer.from(buf).toString('utf8');
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function extractEmails(html) {
  if (!html) return [];
  let t = html.replace(/\s*[\[\(]\s*(?:at|arroba)\s*[\]\)]\s*/gi, '@').replace(/\s*[\[\(]\s*(?:dot|punto)\s*[\]\)]\s*/gi, '.');
  const mailtos = [...(t.matchAll(/href="mailto:([^"?]+)/gi))].map(m => m[1].toLowerCase());
  const plain = (t.match(EMAIL_RE) || []).map(e => e.toLowerCase());
  return [...new Set([...mailtos, ...plain])].filter(e => !JUNK_EMAIL.test(e));
}

function extractWhatsApp(html) {
  if (!html) return [];
  const nums = new Set();
  [...(html.matchAll(/(?:wa\.me|api\.whatsapp\.com\/send[?&]phone=)[\/?]?(\d{8,15})/gi))].forEach(m => nums.add('+' + m[1]));
  return [...nums];
}

function extractPhones(html) {
  if (!html) return [];
  return [...new Set([...(html.matchAll(/href="tel:([^"]+)"/gi))].map(m => m[1].replace(/[^\d+]/g, '')))].filter(p => p.replace(/\D/g, '').length >= 7);
}

function findContactLinks(html, baseUrl) {
  if (!html) return [];
  const links = new Set();
  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    if (/contact|contacto|nosotros|about|quienes/i.test(m[1])) {
      try { links.add(new URL(m[1], baseUrl).toString()); } catch {}
    }
  }
  return [...links].slice(0, 2);
}

async function enrichEmpresa(empresa) {
  const url = normalizeUrl(empresa.web);
  const result = { ...empresa, emailsWeb: empresa.email ? [empresa.email] : [], whatsappWeb: [], phonesWeb: [], webActiva: false };
  if (!url) return result;
  const homeHtml = await fetchHtml(url);
  if (!homeHtml) return result;
  result.webActiva = true;
  const emails = extractEmails(homeHtml);
  emails.forEach(e => { if (!result.emailsWeb.includes(e)) result.emailsWeb.push(e); });
  result.whatsappWeb = extractWhatsApp(homeHtml);
  result.phonesWeb = extractPhones(homeHtml);
  for (const link of findContactLinks(homeHtml, url)) {
    const html2 = await fetchHtml(link);
    if (!html2) continue;
    extractEmails(html2).forEach(e => { if (!result.emailsWeb.includes(e)) result.emailsWeb.push(e); });
    extractWhatsApp(html2).forEach(w => { if (!result.whatsappWeb.includes(w)) result.whatsappWeb.push(w); });
    extractPhones(html2).forEach(p => { if (!result.phonesWeb.includes(p)) result.phonesWeb.push(p); });
  }
  return result;
}

function scoreEmpresa(e) {
  let score = 0;
  if (e.emailsWeb?.length) score += 35;
  if (e.whatsappWeb?.length) score += 30;
  if (e.phonesWeb?.length || e.telefono) score += 15;
  if (e.webActiva) score += 10;
  if ((e.emailsWeb?.length || 0) + (e.whatsappWeb?.length || 0) >= 2) score += 10;
  return { ...e, score: Math.min(100, score), tier: score >= 70 ? 'A' : score >= 45 ? 'B' : 'C' };
}

async function enrichBatch(empresas, concurrency = 3) {
  const out = [];
  for (let i = 0; i < empresas.length; i += concurrency) {
    const enriched = await Promise.all(empresas.slice(i, i + concurrency).map(enrichEmpresa));
    out.push(...enriched);
  }
  return out.map(scoreEmpresa).sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════
// SERVIDOR HTTP
// ═══════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── CHAT (Groq con rotación) ──────────────────────────────
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { system, messages } = JSON.parse(body);
        const d = await llamarGroq({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 1000,
          messages: [{ role: 'system', content: system }, ...messages]
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: d.choices?.[0]?.message?.content || 'Error' }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // ── BUSCAR EMPRESAS (Maps | Páginas Amarillas | IA) ───────
  if (req.method === 'POST' && req.url === '/buscar-empresas') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { query, location, cantidad, fuente } = JSON.parse(body);
        const ciudadLimpia = location.replace(' Argentina', '');
        let empresas = [];
        let fuenteUsada = 'ia';

        if (fuente === 'maps' && MAPS_KEY) {
          try {
            empresas = await buscarGoogleMaps(query, location, cantidad);
            fuenteUsada = 'maps';
          } catch (e) {
            if (e.message === 'MAPS_DENIED') {
              empresas = await generarEmpresasIA(ciudadLimpia, query, cantidad);
              fuenteUsada = 'ia_fallback';
            } else throw e;
          }
        } else if (fuente === 'paginas_amarillas') {
          empresas = await buscarPaginasAmarillas(query, ciudadLimpia, cantidad);
          if (empresas.length) {
            fuenteUsada = 'paginas_amarillas';
          } else {
            // El listado no se pudo leer (render client-side) → fallback a IA
            empresas = await generarEmpresasIA(ciudadLimpia, query, cantidad);
            fuenteUsada = 'ia_fallback_pa';
          }
        } else {
          empresas = await generarEmpresasIA(ciudadLimpia, query, cantidad);
          fuenteUsada = 'ia';
        }

        const leads = await enrichBatch(empresas, 3);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          empresas: leads, fuenteUsada,
          resumen: { total: leads.length, A: leads.filter(l => l.tier === 'A').length, B: leads.filter(l => l.tier === 'B').length, C: leads.filter(l => l.tier === 'C').length }
        }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // ── GUARDAR CONTACTOS ────────────────────────────────────
  if (req.method === 'POST' && req.url === '/guardar-contactos') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { tipo, contactos, mensaje, fecha } = JSON.parse(body);
        const data = JSON.parse(fs.readFileSync(CONTACTOS_FILE, 'utf8'));
        data[tipo] = data[tipo] || [];
        data[tipo].push({ fecha, mensaje, contactos });
        fs.writeFileSync(CONTACTOS_FILE, JSON.stringify(data, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // ── VER CONTACTOS ────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/ver-contactos') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(CONTACTOS_FILE, 'utf8'));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // ── ARCHIVOS ESTÁTICOS ───────────────────────────────────
  if (req.method === 'GET') {
    let urlPath = req.url.split('?')[0];
    let filePath = (urlPath === '/' || urlPath === '/index.html')
      ? path.join(__dirname, 'index.html')
      : path.join(__dirname, urlPath);
    if (!path.extname(filePath)) filePath += '.html';
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`M-AR buscador de empresas en puerto ${PORT} — ${GROQ_KEYS.length} keys Groq cargadas`));
