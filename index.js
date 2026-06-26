'use strict';

/**
 * Nuvio Mega Bridge — Stremio Addon
 *
 * Merges providers from 6 Nuvio repos into one Stremio addon.
 * Deduplicates by provider ID, using repo priority order.
 *
 * Repos (in priority order — first one wins for duplicate IDs):
 *   1. All-in-One-Nuvio   (D3adlyRocket)
 *   2. Asura Synthesis     (PirateZoro9)
 *   3. Yoru's Repo         (yoruix)
 *   4. Phisher's Repo      (phisher98)
 *   5. Michat88 Repo       (michat88)
 *   6. Ray's Plugins       (hihihihihiiray)
 *
 * Deploy to Railway / Render, then add to Stremio:
 *   https://your-app.railway.app/manifest.json
 */

const http  = require('http');
const https = require('https');
const vm    = require('vm');

const PORT = process.env.PORT || 3000;

// ─── Source repos (priority order — first wins on duplicate IDs) ──────────────
const REPOS = [
  {
    name : "All-in-One-Nuvio",
    base : "https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main",
    manifestUrl: "https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json",
  },
  {
    name : "Asura Synthesis",
    base : "https://raw.githubusercontent.com/PirateZoro9/asura-providers/refs/heads/main",
    manifestUrl: "https://raw.githubusercontent.com/PirateZoro9/asura-providers/refs/heads/main/manifest.json",
  },
  {
    name : "Yoru's Repo",
    base : "https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main",
    manifestUrl: "https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json",
  },
  {
    name : "Phisher's Repo",
    base : "https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/refs/heads/main",
    manifestUrl: "https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/refs/heads/main/manifest.json",
  },
  {
    name : "Michat88 Repo",
    base : "https://raw.githubusercontent.com/michat88/nuvio-providers/refs/heads/main",
    manifestUrl: "https://raw.githubusercontent.com/michat88/nuvio-providers/refs/heads/main/manifest.json",
  },
  {
    name : "Ray's Plugins",
    base : "https://raw.githubusercontent.com/hihihihihiiray/plugins/refs/heads/main",
    manifestUrl: "https://raw.githubusercontent.com/hihihihihiiray/plugins/refs/heads/main/manifest.json",
  },
];

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── State ────────────────────────────────────────────────────────────────────
let providers    = null;
let stremioMeta  = null;
let lastLoad     = 0;
let loadPromise  = null;

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpGet(url, headers = {}, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const lib  = url.startsWith('https') ? https : http;
    const req  = lib.get(url, { headers, timeout: timeoutMs }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return httpGet(res.headers.location, headers, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
      }
      const buf = [];
      res.on('data',  c => buf.push(c));
      res.on('end',   () => resolve(Buffer.concat(buf).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout — ${url}`)); });
    req.on('error', reject);
  });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

// ─── Module shims ─────────────────────────────────────────────────────────────
const CHEERIO_SHIM = (() => {
  const empty = () => {
    const node = () => node;
    Object.assign(node, {
      text: () => '', html: () => '', attr: () => null, val: () => null,
      find: () => node, first: () => node, last: () => node, eq: () => node,
      filter: () => node, children: () => node, parent: () => node, parents: () => node,
      closest: () => node, next: () => node, prev: () => node, siblings: () => node,
      each: (_fn) => node, map: (_fn) => ({ get: () => [] }), toArray: () => [],
      is: () => false, hasClass: () => false, length: 0,
      toString: () => '',
    });
    return node;
  };
  const load = (_html) => {
    const $ = (sel) => empty();
    $.load = load;
    return $;
  };
  return { load };
})();

const CRYPTOJS_SHIM = (() => {
  const nodeCrypto = require('crypto');

  function wordsToBuffer(wordArray) {
    const words  = wordArray.words || [];
    const bytes  = wordArray.sigBytes != null ? wordArray.sigBytes : words.length * 4;
    const buf    = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i++) {
      buf[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    }
    return buf;
  }

  function toBuffer(val, encoding = 'utf8') {
    if (!val) return Buffer.alloc(16);
    if (Buffer.isBuffer(val)) return val;
    if (typeof val === 'string') return Buffer.from(val, encoding);
    if (val.words) return wordsToBuffer(val);
    return Buffer.from(String(val));
  }

  const enc = {
    Utf8  : { stringify: (w) => wordsToBuffer(w).toString('utf8'),   parse: (s) => { const b = Buffer.from(s,'utf8');   return { words: [...b].reduce((a,v,i) => { if(i%4===0)a.push(0); a[a.length-1]|=(v<<(24-i%4*8)); return a; },[]), sigBytes:b.length }; } },
    Base64: { stringify: (w) => wordsToBuffer(w).toString('base64'), parse: (s) => { const b = Buffer.from(s,'base64'); return { words: [...b].reduce((a,v,i) => { if(i%4===0)a.push(0); a[a.length-1]|=(v<<(24-i%4*8)); return a; },[]), sigBytes:b.length }; } },
    Hex   : { stringify: (w) => wordsToBuffer(w).toString('hex'),    parse: (s) => { const b = Buffer.from(s,'hex');    return { words: [...b].reduce((a,v,i) => { if(i%4===0)a.push(0); a[a.length-1]|=(v<<(24-i%4*8)); return a; },[]), sigBytes:b.length }; } },
    Latin1: { stringify: (w) => wordsToBuffer(w).toString('latin1'), parse: (s) => { const b = Buffer.from(s,'latin1'); return { words: [...b].reduce((a,v,i) => { if(i%4===0)a.push(0); a[a.length-1]|=(v<<(24-i%4*8)); return a; },[]), sigBytes:b.length }; } },
  };

  const wordResult = (buf) => {
    const words = [];
    for (let i = 0; i < buf.length; i += 4) words.push(buf.readUInt32BE(i));
    return { words, sigBytes: buf.length, toString: (e) => (e||enc.Hex).stringify({ words, sigBytes: buf.length }) };
  };

  const tryAes = (algo, keyBuf, ivBuf, dataBuf, decrypt = true) => {
    try {
      const fn = decrypt
        ? nodeCrypto.createDecipheriv(algo, keyBuf, ivBuf)
        : nodeCrypto.createCipheriv(algo, keyBuf, ivBuf);
      fn.setAutoPadding(true);
      return wordResult(Buffer.concat([fn.update(dataBuf), fn.final()]));
    } catch (_) {
      return wordResult(Buffer.alloc(0));
    }
  };

  return {
    enc,
    lib: { WordArray: { create: (arr, sigBytes) => ({ words: arr||[], sigBytes: sigBytes||0, toString: (e) => (e||enc.Hex).stringify({words:arr||[],sigBytes:sigBytes||0}) }) } },
    AES: {
      decrypt: (ciphertext, key, opts = {}) => {
        try {
          const algo    = 'aes-256-cbc';
          const keyBuf  = toBuffer(key).slice(0,32).length < 32
                          ? Buffer.concat([toBuffer(key), Buffer.alloc(32)]).slice(0,32)
                          : toBuffer(key).slice(0,32);
          const ivBuf   = opts.iv ? toBuffer(opts.iv).slice(0,16) : Buffer.alloc(16);
          const rawData = typeof ciphertext === 'string'
                          ? Buffer.from(ciphertext,'base64')
                          : (ciphertext.ciphertext ? toBuffer(ciphertext.ciphertext) : toBuffer(ciphertext));
          const result  = tryAes(algo, keyBuf, ivBuf, rawData, true);
          return result;
        } catch (_) { return wordResult(Buffer.alloc(0)); }
      },
      encrypt: (msg, key, opts = {}) => {
        try {
          const keyBuf  = Buffer.concat([toBuffer(key), Buffer.alloc(32)]).slice(0,32);
          const ivBuf   = opts.iv ? toBuffer(opts.iv).slice(0,16) : nodeCrypto.randomBytes(16);
          const result  = tryAes('aes-256-cbc', keyBuf, ivBuf, toBuffer(msg), false);
          return { ciphertext: result, toString: () => result.toString(enc.Base64) };
        } catch (_) { return { toString: () => '' }; }
      },
    },
    MD5    : (s) => wordResult(Buffer.from(nodeCrypto.createHash('md5').update(toBuffer(s)).digest())),
    SHA256 : (s) => wordResult(Buffer.from(nodeCrypto.createHash('sha256').update(toBuffer(s)).digest())),
    SHA1   : (s) => wordResult(Buffer.from(nodeCrypto.createHash('sha1').update(toBuffer(s)).digest())),
    SHA512 : (s) => wordResult(Buffer.from(nodeCrypto.createHash('sha512').update(toBuffer(s)).digest())),
    HmacMD5   : (msg, key) => wordResult(Buffer.from(nodeCrypto.createHmac('md5',   toBuffer(key)).update(toBuffer(msg)).digest())),
    HmacSHA256: (msg, key) => wordResult(Buffer.from(nodeCrypto.createHmac('sha256',toBuffer(key)).update(toBuffer(msg)).digest())),
    HmacSHA512: (msg, key) => wordResult(Buffer.from(nodeCrypto.createHmac('sha512',toBuffer(key)).update(toBuffer(msg)).digest())),
    RC4: { encrypt: () => ({ toString: () => '' }), decrypt: () => wordResult(Buffer.alloc(0)) },
    pad: { Pkcs7: {}, NoPadding: {} },
    mode: { CBC: {}, ECB: {}, CTR: {} },
  };
})();

const AXIOS_SHIM = (() => {
  const request = async (config) => {
    const url    = typeof config === 'string' ? config : (config.url || '');
    const method = (config?.method || 'GET').toUpperCase();
    const hdrs   = config?.headers || {};
    const tout   = config?.timeout || 25000;

    if (method === 'GET') {
      const text = await httpGet(url, hdrs, tout);
      return { data: safeJson(text) ?? text, status: 200, headers: {}, statusText: 'OK' };
    }

    // POST/PUT/etc
    const text = await new Promise((resolve, reject) => {
      const u   = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const body = config?.data
        ? (typeof config.data === 'string' ? config.data : JSON.stringify(config.data))
        : '';
      const opts = {
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method,
        headers: { 'Content-Type':'application/json','Content-Length':Buffer.byteLength(body), ...hdrs },
        timeout: tout,
      };
      const req = lib.request(opts, (res) => {
        const buf = [];
        res.on('data', c => buf.push(c));
        res.on('end', () => resolve(Buffer.concat(buf).toString('utf-8')));
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

    return { data: safeJson(text) ?? text, status: 200, headers: {}, statusText: 'OK' };
  };

  const ax = (cfg) => request(cfg);
  ax.get     = (url, cfg) => request({ url, method:'GET',    ...(cfg||{}) });
  ax.post    = (url, data, cfg) => request({ url, method:'POST',   data, ...(cfg||{}) });
  ax.put     = (url, data, cfg) => request({ url, method:'PUT',    data, ...(cfg||{}) });
  ax.delete  = (url, cfg) => request({ url, method:'DELETE', ...(cfg||{}) });
  ax.patch   = (url, data, cfg) => request({ url, method:'PATCH',  data, ...(cfg||{}) });
  ax.head    = (url, cfg) => request({ url, method:'HEAD',   ...(cfg||{}) });
  ax.create  = (defaults) => {
    const inst = (cfg) => request({ ...defaults, ...cfg, url: (defaults?.baseURL||'') + (cfg?.url||'') });
    Object.assign(inst, ax);
    inst.defaults = { ...ax.defaults, ...defaults };
    return inst;
  };
  ax.defaults     = { baseURL:'', headers:{ common:{} } };
  ax.interceptors = { request:{ use:()=>{} }, response:{ use:()=>{} } };
  ax.isAxiosError = () => false;
  ax.CanceledError = class CanceledError extends Error {};
  ax.all     = Promise.all.bind(Promise);
  ax.spread  = (fn) => (arr) => fn(...arr);
  return ax;
})();

// ─── Load a provider in a sandboxed vm ───────────────────────────────────────
function loadProvider(code, id) {
  const fakeRequire = (mod) => {
    const map = {
      'cheerio-without-node-native': CHEERIO_SHIM,
      'react-native-cheerio':        CHEERIO_SHIM,
      'cheerio':                     CHEERIO_SHIM,
      'crypto-js':                   CRYPTOJS_SHIM,
      'axios':                       AXIOS_SHIM,
    };
    if (map[mod]) return map[mod];
    try { return require(mod); } catch (_) {}
    return {};
  };

  const exports = {};
  const module_ = { exports };

  vm.runInContext(code, vm.createContext({
    require: fakeRequire,
    module:  module_,
    exports,
    console,
    fetch,
    Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Buffer, process,
    URL, URLSearchParams,
    TextEncoder, TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    global: {},
  }), { filename: `${id}.js`, timeout: 8000 });

  return module_.exports;
}

// ─── Fetch & deduplicate providers from all repos ─────────────────────────────
async function loadAll() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Loading providers from all repos...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Fetch all manifests in parallel
  const manifests = await Promise.allSettled(
    REPOS.map(repo =>
      httpGet(repo.manifestUrl)
        .then(text => ({ repo, parsed: safeJson(text) }))
    )
  );

  // Deduplicate: first repo to claim an ID wins
  const seen      = new Map();  // normalised id → { meta, repo }
  const loadQueue = [];         // { meta, repo, normId }

  for (const result of manifests) {
    if (result.status === 'rejected') {
      console.warn(`  ⚠️  Failed to fetch manifest:`, result.reason?.message);
      continue;
    }
    const { repo, parsed } = result.value;
    if (!parsed) { console.warn(`  ⚠️  Bad JSON from ${repo.name}`); continue; }

    const scrapers = Array.isArray(parsed) ? parsed : (parsed.scrapers || []);
    let added = 0, skipped = 0;

    for (const entry of scrapers) {
      if (!entry.enabled) continue;
      const normId = (entry.id || '').toLowerCase().trim();
      if (!normId) continue;

      if (seen.has(normId)) {
        skipped++;
      } else {
        seen.set(normId, { meta: entry, repo });
        loadQueue.push({ meta: entry, repo, normId });
        added++;
      }
    }
    console.log(`  📋  ${repo.name}: ${added} unique, ${skipped} duplicate(s) skipped`);
  }

  console.log(`\n  🔄  Loading ${loadQueue.length} unique providers...\n`);

  // Fetch & vm-load in batches of 6
  const loaded = [];

  for (let i = 0; i < loadQueue.length; i += 6) {
    const batch = loadQueue.slice(i, i + 6);
    await Promise.all(batch.map(async ({ meta, repo, normId }) => {
      const fileUrl = `${repo.base}/${meta.filename}`;
      try {
        const code = await httpGet(fileUrl, {}, 20000);
        const mod  = loadProvider(code, normId);
        if (typeof mod.getStreams !== 'function') {
          console.warn(`  ⚠️  ${meta.name} [${repo.name}]: no getStreams()`);
          return;
        }
        loaded.push({ meta, repo, getStreams: mod.getStreams });
        console.log(`  ✅  ${meta.name.padEnd(24)} [${repo.name}]`);
      } catch (e) {
        console.error(`  ❌  ${meta.name} [${repo.name}]: ${e.message}`);
      }
    }));
  }

  console.log(`\n  🎬  ${loaded.length} providers ready\n`);

  // Build Stremio manifest
  const types = [...new Set(
    loaded.flatMap(p => (p.meta.supportedTypes || ['movie','tv'])
      .map(t => t === 'tv' || t === 'anime' ? 'series' : t)
      .filter(t => ['movie','series'].includes(t))
    )
  )];

  const meta = {
    id          : 'community.nuvio.mega.bridge',
    version     : '1.0.0',
    name        : 'Nuvio Mega Bridge',
    description : `${loaded.length} providers from 6 repos: ${REPOS.map(r=>r.name).join(', ')}`,
    logo        : 'https://raw.githubusercontent.com/yoruix/nuvio-providers/main/Assets/Logo-2.png',
    resources   : ['stream'],
    types       : types.length ? types : ['movie','series'],
    idPrefixes  : ['tt','tmdb:'],
    catalogs    : [],
    behaviorHints: { configurable:false, configurationRequired:false },
  };

  return { loaded, meta };
}

// ─── Cache management ─────────────────────────────────────────────────────────
async function ensureProviders() {
  if (providers && (Date.now() - lastLoad) < CACHE_TTL_MS) return;
  if (loadPromise) return loadPromise;

  loadPromise = loadAll()
    .then(({ loaded, meta }) => {
      providers   = loaded;
      stremioMeta = meta;
      lastLoad    = Date.now();
      loadPromise = null;
    })
    .catch((e) => {
      console.error('Fatal load error:', e.message);
      if (!providers) providers = [];
      loadPromise = null;
    });

  return loadPromise;
}

// ─── Parse Stremio ID ─────────────────────────────────────────────────────────
function parseId(type, id) {
  const parts = id.split(':');
  let tmdbId, season = null, episode = null;

  if (type === 'series') {
    if (parts[0] === 'tmdb') {
      tmdbId  = parts[1];
      season  = parseInt(parts[2], 10);
      episode = parseInt(parts[3], 10);
    } else {
      tmdbId  = parts[0];
      season  = parseInt(parts[1], 10);
      episode = parseInt(parts[2], 10);
    }
  } else {
    tmdbId = parts[0] === 'tmdb' ? parts[1] : parts[0];
  }

  return { tmdbId, mediaType: type === 'series' ? 'tv' : 'movie', season, episode };
}

// ─── Query providers ──────────────────────────────────────────────────────────
async function getStreams(type, id) {
  const { tmdbId, mediaType, season, episode } = parseId(type, id);
  console.log(`🔍  ${mediaType} | ${tmdbId} | S${season??'-'}E${episode??'-'} | ${providers.length} providers`);

  const results = await Promise.allSettled(
    providers.map(p =>
      Promise.race([
        p.getStreams(tmdbId, mediaType, season, episode),
        new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
      ])
    )
  );

  const streams = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') continue;
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
  res.writeHead(status, {
    'Content-Type'                : 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,OPTIONS' });
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  if (url === '/') {
    res.writeHead(200, { 'Content-Type':'text/plain' });
    res.end('Nuvio Mega Bridge — add /manifest.json to Stremio');
    return;
  }

  if (url === '/manifest.json') {
    await ensureProviders();
    if (!stremioMeta) { json(res, 503, { error:'Loading providers, retry in 30s' }); return; }
    json(res, 200, stremioMeta);
    return;
  }

  const m = url.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
  if (m) {
    await ensureProviders();
    if (!providers?.length) { json(res, 200, { streams:[] }); return; }
    try {
      json(res, 200, { streams: await getStreams(m[1], decodeURIComponent(m[2])) });
    } catch (e) {
      console.error('Stream error:', e.message);
      json(res, 200, { streams:[] });
    }
    return;
  }

  json(res, 404, { error:'Not found' });
});

server.listen(PORT, async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🎬  Nuvio Mega Bridge — Stremio Addon');
  console.log(`  📡  Port ${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  await ensureProviders();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅  Add to Stremio:');
  console.log('  https://<your-railway-app>.up.railway.app/manifest.json');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`❌  Port ${PORT} in use`);
  else console.error('Server error:', e);
  process.exit(1);
});
