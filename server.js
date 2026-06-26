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
// MÓDULO PÁGINAS AMARILLAS — scraping real con Puppeteer
// ═══════════════════════════════════════════════════════════
// El sitio renderiza listado y fichas con JavaScript (Next.js),
// así que un fetch simple no alcanza. Usamos un Chrome headless
// (Puppeteer) que carga la página como lo haría una persona.
//
// Requiere que "puppeteer" esté en package.json como dependencia.
// Si no está instalado, lo detectamos y devolvemos vacío sin romper
// el servidor (la ruta /buscar-empresas cae a IA automáticamente).
//
// Tope conservador (PA_MAX) pensado para el plan Starter de Render
// (512 MB RAM): evita quedarse sin memoria y evita que una sola
// búsqueda tarde tanto que se corte por timeout.

let puppeteer = null;
try {
  puppeteer = require('puppeteer');
} catch {
  console.warn('⚠️  Puppeteer no está instalado (falta en package.json). La fuente "Páginas Amarillas" usará el respaldo de IA.');
}

const PA_BASE = 'https://www.paginasamarillas.com.ar';
const PA_MAX_POR_BUSQUEDA = 30; // tope de seguridad — plan Starter 512MB
const PA_CONCURRENCY = 2;       // pestañas simultáneas dentro del mismo navegador

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--single-process',
  '--no-zygote',
];

function slugify(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // sin tildes
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

async function extraerFichaConPuppeteer(browser, url, rubro, ciudadFallback) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      // Bloqueamos imágenes/fuentes/css para que cargue más rápido y liviano
      if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 600)); // deja asentar el render inicial

    // Si hay un botón "Ver Teléfono", lo clickeamos para revelar el número.
    // Reintentamos un par de veces porque a veces el botón tarda en montarse.
    for (let intento = 0; intento < 3; intento++) {
      const clickeo = await page.evaluate(() => {
        const candidatos = [...document.querySelectorAll('button, a, span, div')];
        const boton = candidatos.find(b => /ver tel[eé]fono/i.test(b.textContent || '') && b.offsetParent !== null);
        if (boton) { boton.click(); return true; }
        return false;
      }).catch(() => false);
      await new Promise(r => setTimeout(r, 700));
      if (clickeo) break;
    }

    const nombre = (await page.title()).split(' en ')[0].split(' - ')[0].trim();
    const texto = await page.evaluate(() => document.body.innerText || '');

    // Teléfono: primero buscamos un link tel:, que es más confiable que el texto
    let telefono = await page.evaluate(() => {
      const a = document.querySelector('a[href^="tel:"]');
      return a ? a.getAttribute('href').replace('tel:', '').trim() : '';
    }).catch(() => '');
    if (!telefono) {
      const telMatch = texto.match(/Tel[eé]fono[^0-9+]*([+0-9][0-9()\-\s]{6,20})/i);
      telefono = telMatch ? telMatch[1].trim() : '';
    }

    const dirMatch = texto.match(/Direcci[oó]n[^A-Za-zÁÉÍÓÚñÑ]*([^\n]{5,90})/i);

    const email = await page.evaluate(() => {
      const a = document.querySelector('a[href^="mailto:"]');
      return a ? a.getAttribute('href').replace('mailto:', '').split('?')[0] : '';
    }).catch(() => '');

    // Web real de la empresa: descartamos paginasamarillas y dominios
    // que son banners/publicidad propia del sitio (gurusoluciones,
    // "anuncia-con-nosotros", google, facebook genéricos sin ruta, etc.)
    const web = await page.evaluate(() => {
    const excluidos = /paginasamarillas|amarillas\.(cl|com|net)|gurusoluciones|anuncia-con-nosotros|google\.com|doubleclick|facebook\.com\/paginasamarillas/i;
      const a = [...document.querySelectorAll('a[href^="http"]')].find(a => !excluidos.test(a.href));
      return a ? a.href : '';
    }).catch(() => '');

    if (!telefono && !dirMatch && !email && !web) return null;

    return {
      nombre,
      rubro,
      telefono: telefono || '',
      direccion: (dirMatch ? dirMatch[1].trim() : '') || ciudadFallback,
      email: email || '',
      web: web || '',
    };
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function buscarPaginasAmarillas(rubro, ciudad, cantidad) {
  if (!puppeteer) return []; // no instalado todavía → ruta llamadora cae a IA

  const max = Math.min(cantidad, PA_MAX_POR_BUSQUEDA);
  const rubroSlug = slugify(rubro);
  const ciudadSlug = slugify(ciudad);
  const listadoUrl = `${PA_BASE}/b/${rubroSlug}/${ciudadSlug}`;

  let browser;
  const empresas = [];
  try {
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_ARGS });

    const listPage = await browser.newPage();
    await listPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    await listPage.goto(listadoUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    try { await listPage.waitForSelector('a[href*="/fichas/"]', { timeout: 8000 }); } catch {}

    const fichas = await listPage.$$eval('a[href*="/fichas/"]', (as) => [...new Set(as.map(a => a.href))]).catch(() => []);
    await listPage.close().catch(() => {});

    const fichasLimitadas = fichas.slice(0, max);

    for (let i = 0; i < fichasLimitadas.length && empresas.length < max; i += PA_CONCURRENCY) {
      const lote = fichasLimitadas.slice(i, i + PA_CONCURRENCY);
      const resultados = await Promise.all(
        lote.map(url => extraerFichaConPuppeteer(browser, url, rubro, ciudad))
      );
      resultados.forEach(r => { if (r) empresas.push(r); });
    }
  } catch (e) {
    console.error('Error Puppeteer Páginas Amarillas:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return empresas.slice(0, max);
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

// Búsquedas con Puppeteer pueden tardar más que una request normal.
// Subimos estos valores para que no se corten antes de tiempo.
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;
