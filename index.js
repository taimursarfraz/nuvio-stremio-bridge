'use strict';

/**
 * Nuvio → Stremio Cloud Bridge
 *
 * Deploy this to Render / Railway / any Node host.
 * Then paste https://your-app.onrender.com/manifest.json into Stremio.
 *
 * Works from any device including iOS — no local server needed.
 */

const http  = require('http');
const https = require('https');
const vm    = require('vm');

const PORT = process.env.PORT || 3000;

const NUVIO_BASE     = 'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main';
const MANIFEST_URL   = `${NUVIO_BASE}/manifest.json`;
const CACHE_TTL_MS   = 6 * 60 * 60 * 1000; // re-fetch providers every 6 hours

// ─── In-memory cache ──────────────────────────────────────────────────────────
let providers     = null;   // loaded provider list
let stremioMeta   = null;   // manifest sent to Stremio
let lastLoadTime  = 0;
let loading       = false;
let loadPromise   = null;

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpGet(url, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const options = { headers, timeout: timeoutMs };

    const req = lib.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return httpGet(res.headers.location, headers, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data',  c => chunks.push(c));
      res.on('end',   () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on('error', reject);
  });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

// ─── Shims for modules Nuvio providers require() ──────────────────────────────
// These run server-side in Node, so cheerio-without-node-native isn't available.
// We provide Node's built-in crypto plus light shims for the rest.

const CHEERIO_SHIM = (() => {
  // Tiny structural stub — providers that need real HTML parsing will get empty
  // results, but most providers use fetch() directly and don't need cheerio.
  const empty = () => Object.assign(() => empty(), {
    text: () => '', attr: () => null, val: () => null,
    find: () => empty(), first: () => empty(), last: () => empty(),
    filter: () => empty(), children: () => empty(), parent: () => empty(),
    each: () => {}, map: () => ({ get: () => [] }), toArray: () => [],
    length: 0,
  });
  const load = (html) => {
    const $ = (sel, ctx) => empty();
    $.load = load;
    return $;
  };
  return { load };
})();

const CRYPTOJS_SHIM = {
  AES: {
    decrypt: (cipher, key, opts) => {
      try {
        // Attempt real AES-CBC via Node crypto
        const nodeCrypto = require('crypto');
        const k   = typeof key === 'string'
                      ? Buffer.from(key.padEnd(32, '\0').slice(0, 32))
                      : Buffer.from(key.words ? key.words.flatMap(w => [(w>>>24)&0xff,(w>>>16)&0xff,(w>>>8)&0xff,w&0xff]) : key, 'hex');
        const iv  = opts?.iv?.words
                      ? Buffer.from(opts.iv.words.flatMap(w => [(w>>>24)&0xff,(w>>>16)&0xff,(w>>>8)&0xff,w&0xff]))
                      : Buffer.alloc(16);
        const data = typeof cipher === 'string' ? Buffer.from(cipher, 'base64') : Buffer.from(cipher);
        const dec  = nodeCrypto.createDecipheriv('aes-256-cbc', k, iv);
        dec.setAutoPadding(true);
        const plain = Buffer.concat([dec.update(data), dec.final()]).toString('utf-8');
        return { toString: (enc) => plain, words: [] };
      } catch (_) {
        return { toString: () => '', words: [] };
      }
    },
    encrypt: (msg, key, opts) => ({ toString: () => '' }),
  },
  enc: {
    Utf8   : { stringify: (w) => '', parse: (s) => ({ words: [], sigBytes: 0 }) },
    Base64 : { stringify: (w) => '', parse: (s) => ({ words: [], sigBytes: 0 }) },
    Hex    : { stringify: (w) => '', parse: (s) => ({ words: [], sigBytes: 0 }) },
    Latin1 : { stringify: (w) => '', parse: (s) => ({ words: [], sigBytes: 0 }) },
  },
  lib: { WordArray: { create: () => ({ words: [], sigBytes: 0 }) } },
  MD5  : (s) => ({ toString: () => require('crypto').createHash('md5').update(s).digest('hex') }),
  SHA256: (s) => ({ toString: () => require('crypto').createHash('sha256').update(s).digest('hex') }),
  SHA1 : (s) => ({ toString: () => require('crypto').createHash('sha1').update(s).digest('hex') }),
  HmacMD5   : (msg, key) => ({ toString: () => require('crypto').createHmac('md5', key).update(msg).digest('hex') }),
  HmacSHA256: (msg, key) => ({ toString: () => require('crypto').createHmac('sha256', key).update(msg).digest('hex') }),
};

const AXIOS_SHIM = (() => {
  const request = async (config) => {
    const url     = typeof config === 'string' ? config : (config.url || '');
    const method  = (config.method || 'GET').toUpperCase();
    const headers = config.headers || {};
    const body    = config.data ? JSON.stringify(config.data) : undefined;

    let text;
    if (method === 'GET') {
      text = await httpGet(url, headers, config.timeout || 20000);
    } else {
      // POST via https.request
      text = await new Promise((resolve, reject) => {
        const u   = new URL(url);
        const lib = u.protocol === 'https:' ? https : http;
        const opts = {
          hostname: u.hostname,
          port    : u.port || (u.protocol === 'https:' ? 443 : 80),
          path    : u.pathname + u.search,
          method,
          headers : { 'Content-Type': 'application/json', ...headers },
          timeout : config.timeout || 20000,
        };
        const req = lib.request(opts, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf-8')));
          res.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    }

    const data = safeJson(text) ?? text;
    return { data, status: 200, headers: {}, statusText: 'OK' };
  };

  const ax          = (config)       => request(config);
  ax.get            = (url, cfg)     => request({ url, method: 'GET',  ...(cfg || {}) });
  ax.post           = (url, data, c) => request({ url, method: 'POST', data, ...(c || {}) });
  ax.put            = (url, data, c) => request({ url, method: 'PUT',  data, ...(c || {}) });
  ax.delete         = (url, cfg)     => request({ url, method: 'DELETE', ...(cfg || {}) });
  ax.create         = (defaults)     => { const inst = (c) => request({ ...defaults, ...c }); Object.assign(inst, ax); return inst; };
  ax.defaults       = { baseURL: '', headers: { common: {} } };
  ax.interceptors   = { request: { use: () => {} }, response: { use: () => {} } };
  ax.isAxiosError   = (e) => false;
  ax.CanceledError  = class CanceledError extends Error {};
  return ax;
})();

// ─── Load a provider JS string in a sandboxed vm ─────────────────────────────
function loadProvider(code, name) {
  const fakeRequire = (mod) => {
    const mods = {
      'cheerio-without-node-native' : CHEERIO_SHIM,
      'react-native-cheerio'        : CHEERIO_SHIM,
      'cheerio'                     : CHEERIO_SHIM,
      'crypto-js'                   : CRYPTOJS_SHIM,
      'axios'                       : AXIOS_SHIM,
    };
    if (mods[mod]) return mods[mod];
    try { return require(mod); } catch (_) {}
    console.warn(`  [${name}] unknown require('${mod}') — returning {}`);
    return {};
  };

  const exports = {};
  const module  = { exports };

  const sandbox = {
    require : fakeRequire,
    module,
    exports,
    console,
    fetch,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    process,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob : (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa : (s) => Buffer.from(s, 'binary').toString('base64'),
    global: {},
  };

  vm.runInContext(code, vm.createContext(sandbox), {
    filename : `${name}.js`,
    timeout  : 8000,
  });

  return module.exports;
}

// ─── Fetch all providers from GitHub ─────────────────────────────────────────
async function loadAllProviders() {
  console.log('📡  Fetching Nuvio manifest...');

  const raw = await httpGet(MANIFEST_URL);
  const parsed = safeJson(raw);
  if (!parsed) throw new Error('Could not parse Nuvio manifest');

  const scrapers = Array.isArray(parsed) ? parsed : (parsed.scrapers || []);
  const repoName = parsed.name || 'Nuvio Providers';

  console.log(`📋  ${scrapers.length} providers found\n`);

  const loaded = [];

  // Load concurrently in batches of 5
  const enabled = scrapers.filter(s => s.enabled);
  for (let i = 0; i < enabled.length; i += 5) {
    const batch = enabled.slice(i, i + 5);
    await Promise.all(batch.map(async (entry) => {
      const fileUrl = `${NUVIO_BASE}/${entry.filename}`;
      try {
        const code = await httpGet(fileUrl);
        const mod  = loadProvider(code, entry.id);
        if (typeof mod.getStreams !== 'function') {
          console.warn(`  ⚠️  ${entry.name}: no getStreams() export`);
          return;
        }
        loaded.push({ meta: entry, getStreams: mod.getStreams });
        console.log(`  ✅  ${entry.name}`);
      } catch (e) {
        console.error(`  ❌  ${entry.name}: ${e.message}`);
      }
    }));
  }

  console.log(`\n🎬  ${loaded.length} provider(s) ready\n`);

  // Build the Stremio manifest
  const types = [...new Set(
    loaded.flatMap(p => (p.meta.supportedTypes || ['movie', 'tv'])
      .map(t => t === 'tv' ? 'series' : t))
  )];

  const meta = {
    id          : 'community.nuvio.stremio.bridge',
    version     : parsed.version || '1.0.0',
    name        : `${repoName} (Stremio)`,
    description : `${loaded.length} providers: ${loaded.map(p => p.meta.name).join(', ')}`,
    logo        : 'https://raw.githubusercontent.com/yoruix/nuvio-providers/main/Assets/Logo-2.png',
    resources   : ['stream'],
    types       : types.length ? types : ['movie', 'series'],
    idPrefixes  : ['tt', 'tmdb:'],
    catalogs    : [],
    behaviorHints: { configurable: false, configurationRequired: false },
  };

  return { loaded, meta };
}

// ─── Ensure providers are loaded (with cache) ─────────────────────────────────
async function ensureProviders() {
  const now = Date.now();
  if (providers && (now - lastLoadTime) < CACHE_TTL_MS) return;
  if (loading) return loadPromise;

  loading     = true;
  loadPromise = loadAllProviders()
    .then(({ loaded, meta }) => {
      providers    = loaded;
      stremioMeta  = meta;
      lastLoadTime = Date.now();
      loading      = false;
    })
    .catch((e) => {
      console.error('❌  Failed to load providers:', e.message);
      loading = false;
      // Keep old providers if we had them
      if (!providers) providers = [];
    });

  return loadPromise;
}

// ─── Parse Stremio ID ─────────────────────────────────────────────────────────
function parseId(type, id) {
  const parts = id.split(':');
  let tmdbId, season = null, episode = null;

  if (type === 'series') {
    if (parts[0] === 'tmdb') {
      [, tmdbId] = parts;
      season     = parseInt(parts[2], 10);
      episode    = parseInt(parts[3], 10);
    } else {
      [tmdbId]   = parts;
      season     = parseInt(parts[1], 10);
      episode    = parseInt(parts[2], 10);
    }
  } else {
    tmdbId = parts[0] === 'tmdb' ? parts[1] : parts[0];
  }

  return { tmdbId, mediaType: type === 'series' ? 'tv' : 'movie', season, episode };
}

// ─── Query all providers ──────────────────────────────────────────────────────
async function queryStreams(type, id) {
  const { tmdbId, mediaType, season, episode } = parseId(type, id);
  console.log(`🔍  ${mediaType} id=${tmdbId} S${season ?? '-'}E${episode ?? '-'}`);

  const results = await Promise.allSettled(
    providers.map(p =>
      Promise.race([
        p.getStreams(tmdbId, mediaType, season, episode),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
      ])
    )
  );

  const streams = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      console.warn(`  ⚠️  ${providers[i].meta.name}: ${r.reason?.message}`);
      continue;
    }
    for (const s of (r.value || [])) {
      if (!s?.url) continue;
      const stream = {
        name  : s.name  || providers[i].meta.name,
        title : [s.title, s.quality, s.size].filter(Boolean).join(' · ') || '',
        url   : s.url,
      };
      if (s.headers && Object.keys(s.headers).length) {
        stream.behaviorHints = {
          notWebReady  : true,
          proxyHeaders : { request: s.headers },
        };
      }
      streams.push(stream);
    }
  }

  console.log(`  → ${streams.length} stream(s)\n`);
  return streams;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type'                : 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // Health check
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Nuvio→Stremio bridge running. Add to Stremio:\nhttps://<your-host>/manifest.json`);
    return;
  }

  // Manifest
  if (url === '/manifest.json') {
    await ensureProviders();
    if (!stremioMeta) { json(res, 503, { error: 'Still loading providers, retry in 30s' }); return; }
    json(res, 200, stremioMeta);
    return;
  }

  // Streams
  const m = url.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
  if (m) {
    await ensureProviders();
    if (!providers?.length) { json(res, 200, { streams: [] }); return; }
    try {
      const streams = await queryStreams(m[1], decodeURIComponent(m[2]));
      json(res, 200, { streams });
    } catch (e) {
      console.error('Stream error:', e.message);
      json(res, 200, { streams: [] });
    }
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🎬  Nuvio → Stremio Bridge (Cloud Edition)');
  console.log(`  📡  Listening on port ${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  await ensureProviders();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅  Ready! Add to Stremio:');
  console.log('  https://<your-render-app>.onrender.com/manifest.json');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`❌  Port ${PORT} already in use`);
  else console.error('Server error:', e);
  process.exit(1);
});
