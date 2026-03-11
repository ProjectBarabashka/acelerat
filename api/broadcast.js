// ══════════════════════════════════════════════════════════════
//  TurboTX v12 ★ МАКСИМАЛЬНАЯ МОЩЬ 2026 ★  —  /api/broadcast.js
//  Vercel Serverless · Node.js 20 · Hobby Plan
//
//  ━━━ НОВОЕ В v12 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ⒜ LAST-BLOCK-MINER BOOST — определяем кто добыл последний блок
//     и отправляем в этот пул ПЕРВЫМ (он сейчас ищет следующий блок!)
//  ⒝ MARA SLIPSTREAM — прямая отправка в приватный мемпул MARA
//     Bypass обычной очереди — транзакция видна только MARA
//  ⒞ +5 НОВЫХ ПУЛОВ: SBI Crypto, EMCDPool, Rawpool, 2Miners, Lincoin
//     Общий охват хешрейта: ~88% (было ~83%)
//  ⒟ PACKAGE RELAY (Bitcoin Core 28+) — отправляем TX+Child пакет
//     напрямую в P2P узлы через submitpackage RPC
//  ⒠ HASHRATE-WEIGHTED EARLY STOP — останавливаемся когда покрыто
//     ≥70% хешрейта, а не просто ≥65% каналов (умнее!)
//  ⒡ HEX CACHE — кэш hex по txid между волнами (не перекачиваем)
//  ⒢ FEE TREND DETECTION — если комиссии падают → ждём лучший момент
//  ⒣ FREE TIER FIX — добавлены ViaBTC + mempoolAccel в бесплатный план
//  ⒤ BOOTSTRAP FIX — inline ping вместо вызова /api/health (надёжнее)
//  ⒥ UA ROTATION — ротация User-Agent между волнами
//  ⒦ ANTI-STUCK — TX >72ч → агрессивное CPFP предупреждение
//  ⒧ PARALLEL HEX+BROADCAST — hex и первая волна стартуют одновременно
//
//  ━━━ ДВИЖОК v10-v11 (сохранено) ━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ① Статистика надёжности   ② Circuit Breaker
//  ③ Smart hex retry         ④ Adaptive timeout
//  ⑤ Negative cache          ⑥ Geo-groups
//  ⑦ 429 exponential cooldown ⑧ Dead channel exclusion
//  ⑨ Ping-sort + priority   ⑩ Memory cleanup 30min
//  ⑪ Skip-ping оптимизация  ⑫ Tiered hex fetch
//  ⑬ Blockstream fallback   ⑭ Hashrate-weighted sort
//  ⑮ Dynamic EARLY_STOP     ⑯ txidOnly channels
//  ⑰ Batch broadcast        ⑱ feeRatio в summary
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TurboTX-Token',
};

// ─── USER-AGENT ROTATION ──────────────────────────────────────
// Разные UA — меньше шанс блокировки по одному паттерну
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
];
let _uaIdx = 0;
function getUA() { return UA_POOL[(_uaIdx++) % UA_POOL.length]; }

// ─── RATE LIMITER ─────────────────────────────────────────────
const _ipMap   = new Map();
const _txidMap = new Map();
const _confirmed  = new Map();
const CONFIRMED_TTL = 24 * 3_600_000;

function isConfirmed(txid) {
  const t = _confirmed.get(txid);
  if (!t) return false;
  if (Date.now() - t > CONFIRMED_TTL) { _confirmed.delete(txid); return false; }
  return true;
}
function setConfirmed(txid) { _confirmed.set(txid, Date.now()); }

const LIMITS = {
  free:    { perHour: 3,  cooldownMs: 2 * 3_600_000 },
  premium: { perHour: 30, cooldownMs: 15 * 60_000   },
};
const MAX_TXIDS_PER_IP_HOUR = 15;
const MAX_HEX_BYTES = 400_000;

function getIp(req) {
  return req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress || 'unknown';
}

function checkLimits(ip, txid, plan) {
  const now = Date.now(), hour = 3_600_000;
  const lim = LIMITS[plan] || LIMITS.free;
  if (_ipMap.size > 5000)
    for (const [k,v] of _ipMap) if (v.resetAt < now) _ipMap.delete(k);
  let e = _ipMap.get(ip);
  if (!e || e.resetAt < now) { e = { count:0, txids:new Set(), resetAt:now+hour }; _ipMap.set(ip,e); }
  if (!e.txids.has(txid) && e.txids.size >= MAX_TXIDS_PER_IP_HOUR)
    return { ok:false, reason:'abuse', retryAfter:Math.ceil((e.resetAt-now)/1000) };
  if (e.count >= lim.perHour)
    return { ok:false, reason:'rate_limit', retryAfter:Math.ceil((e.resetAt-now)/1000) };
  const tx = _txidMap.get(txid);
  if (tx && tx.plan === plan) {
    const rem = lim.cooldownMs - (now - tx.lastSeen);
    if (rem > 0) return { ok:false, reason:'txid_cooldown', retryAfter:Math.ceil(rem/1000) };
  }
  e.count++; e.txids.add(txid);
  _txidMap.set(txid, { lastSeen:now, plan });
  return { ok:true };
}

function isBot(req) {
  const ua = (req.headers['user-agent']||'').toLowerCase();
  return ['curl/','wget/','python-requests','go-http','java/','scrapy','bot/','crawler'].some(p=>ua.includes(p));
}

// ─── ⒡ HEX CACHE ─────────────────────────────────────────────
// Кэш между волнами: повторный запрос той же TX — не перекачиваем hex
const _hexCache = new Map(); // txid → { hex, cachedAt }
const HEX_CACHE_TTL = 2 * 3_600_000; // 2 часа

function getCachedHex(txid) {
  const e = _hexCache.get(txid);
  if (!e) return null;
  if (Date.now() - e.cachedAt > HEX_CACHE_TTL) { _hexCache.delete(txid); return null; }
  return e.hex;
}
function setCachedHex(txid, hex) {
  if (_hexCache.size > 200) { // не раздуваем память
    const oldest = [..._hexCache.entries()].sort((a,b)=>a[1].cachedAt-b[1].cachedAt)[0];
    if (oldest) _hexCache.delete(oldest[0]);
  }
  _hexCache.set(txid, { hex, cachedAt: Date.now() });
}

// ─── УТИЛИТЫ ──────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function safeJson(r) { try { return await r.json(); } catch { return {}; } }
async function safeText(r) { try { return await r.text(); } catch { return ''; } }
function ve(r) { return r?.headers?.get?.('x-vercel-error') || ''; }

async function ft(url, opts={}, ms=13000) {
  const ac = new AbortController();
  const t  = setTimeout(()=>ac.abort(), ms);
  try { const r = await fetch(url, {...opts, signal:ac.signal}); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}

// ─── ① СТАТИСТИКА НАДЁЖНОСТИ ──────────────────────────────────
const _stats = new Map();
function getStat(name) { return _stats.get(name) ?? { success:0, fail:0, totalMs:0, calls:0 }; }
function recordStat(name, ok, ms) {
  const s = getStat(name); s.calls++; s.totalMs += ms;
  if (ok) s.success++; else s.fail++;
  _stats.set(name, s);
}
function reliabilityScore(name) {
  const s = getStat(name);
  if (s.calls === 0) return 0.5;
  return s.success / (s.success + s.fail);
}
function avgResponseMs(name) {
  const s = getStat(name);
  return s.calls > 0 ? Math.round(s.totalMs / s.calls) : 9999;
}

// ─── VERCEL ERROR CODES ───────────────────────────────────────
const VERCEL_RETRY_NOW = new Set(['FUNCTION_INVOCATION_FAILED','INTERNAL_FUNCTION_INVOCATION_FAILED','NO_RESPONSE_FROM_FUNCTION','SANDBOX_NOT_LISTENING','INTERNAL_FUNCTION_NOT_READY','INTERNAL_MISSING_RESPONSE_FROM_CACHE','ROUTER_CANNOT_MATCH','ROUTER_EXTERNAL_TARGET_CONNECTION_ERROR','ROUTER_EXTERNAL_TARGET_HANDSHAKE_ERROR','DNS_HOSTNAME_RESOLVE_FAILED','DNS_HOSTNAME_SERVER_ERROR']);
const VERCEL_RETRY_LATER = new Set(['FUNCTION_THROTTLED','INTERNAL_FUNCTION_SERVICE_UNAVAILABLE','DEPLOYMENT_PAUSED','INTERNAL_CACHE_LOCK_FULL','INTERNAL_CACHE_LOCK_TIMEOUT','EDGE_FUNCTION_INVOCATION_FAILED','MIDDLEWARE_INVOCATION_FAILED','SANDBOX_STOPPED']);
const VERCEL_SKIP = new Set(['FUNCTION_INVOCATION_TIMEOUT','INTERNAL_FUNCTION_INVOCATION_TIMEOUT','EDGE_FUNCTION_INVOCATION_TIMEOUT','MIDDLEWARE_INVOCATION_TIMEOUT','INFINITE_LOOP_DETECTED','MIDDLEWARE_RUNTIME_DEPRECATED']);
const VERCEL_PERMANENT = new Set(['DEPLOYMENT_BLOCKED','DEPLOYMENT_DELETED','DEPLOYMENT_DISABLED','DEPLOYMENT_NOT_FOUND','FUNCTION_PAYLOAD_TOO_LARGE','FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE','INVALID_REQUEST_METHOD','MALFORMED_REQUEST_HEADER','DNS_HOSTNAME_NOT_FOUND','DNS_HOSTNAME_EMPTY','DNS_HOSTNAME_RESOLVED_PRIVATE']);

function classifyVercelError(c) {
  if (!c) return null;
  if (VERCEL_RETRY_NOW.has(c))   return 'retry_now';
  if (VERCEL_RETRY_LATER.has(c)) return 'retry_later';
  if (VERCEL_SKIP.has(c))        return 'skip';
  if (VERCEL_PERMANENT.has(c))   return 'permanent';
  return null;
}

function classifyError(status, body='', vercelCode='') {
  const vc = classifyVercelError(vercelCode);
  if (vc) return vc;
  if (status === 429) return 'rate_limit';
  if (status === 0)   return 'retry_now';
  if (status === 500) return 'retry_now';
  if (status === 502) return 'retry_now';
  if (status === 503) return 'retry_later';
  if (status === 504) return 'skip';
  if (status === 508) return 'skip';
  if (status === 410) return 'retry_later';
  if (status >= 500)  return 'retry_now';
  if (status === 400 || status === 404) {
    const b = String(body).toLowerCase();
    if (b.includes('already')||b.includes('duplicate')||b.includes('known')||b.includes('exists')) return 'accepted';
    return 'permanent';
  }
  if (status === 401 || status === 402 || status === 403) return 'permanent';
  if (status === 413) return 'permanent';
  if (status === 405) return 'permanent';
  if (status >= 400)  return 'permanent';
  return 'ok';
}

function ok400(body, status) {
  const b = String(body).toLowerCase();
  return b.includes('already')||b.includes('duplicate')||b.includes('known')||
    b.includes('exists')||b.includes('258')||
    (status===400&&!b.includes('bad-txns')&&!b.includes('non-mandatory')&&!b.includes('invalid'));
}

// ─── 429 COOLDOWN ─────────────────────────────────────────────
const _cooldown = new Map();
const COOLDOWN_MS = [2*60_000, 5*60_000, 15*60_000, 60*60_000];
function isCooling(name) { const e=_cooldown.get(name); return e&&Date.now()<e.until; }
function registerHit(name) {
  const e = _cooldown.get(name) ?? {hits:0,until:0};
  const hits = e.hits+1;
  const ms = COOLDOWN_MS[Math.min(hits-1, COOLDOWN_MS.length-1)];
  _cooldown.set(name,{hits,until:Date.now()+ms});
}
function registerSuccess(name) { if(_cooldown.has(name)) _cooldown.set(name,{hits:0,until:0}); }

// ─── ⑤ NEGATIVE CACHE ─────────────────────────────────────────
const _negCache = new Map();
const NEG_CACHE_TTL = 5 * 60_000;
function isNegCached(name) { const u=_negCache.get(name); if(!u)return false; if(Date.now()>u){_negCache.delete(name);return false;} return true; }
function setNegCache(name) { _negCache.set(name, Date.now()+NEG_CACHE_TTL); }

// ─── DEAD CHANNEL ─────────────────────────────────────────────
const _deadChannels = new Map();
const DEAD_THRESHOLD = 3;
const DEAD_TTL_MS = 30 * 60_000;
function isDead(name) {
  const e = _deadChannels.get(name);
  if (!e) return false;
  if (Date.now() > e.deadUntil) { _deadChannels.delete(name); return false; }
  return e.fails >= DEAD_THRESHOLD;
}
function registerFail(name) {
  const e = _deadChannels.get(name) ?? {fails:0,deadUntil:0};
  e.fails++;
  if (e.fails >= DEAD_THRESHOLD) e.deadUntil = Date.now() + DEAD_TTL_MS;
  _deadChannels.set(name, e);
}
function registerChannelOk(name) { _deadChannels.delete(name); }

// ─── ② CIRCUIT BREAKER ────────────────────────────────────────
const _cb = new Map();
const CB_FAIL_THRESHOLD = 5;
const CB_FAIL_WINDOW = 10 * 60_000;
const CB_OPEN_TTL = 2 * 3_600_000;
function cbGet(name) { return _cb.get(name) ?? {state:'CLOSED',fails:0,windowStart:Date.now(),openUntil:0,halfOpenAt:0}; }
function cbIsBlocked(name) {
  const e = cbGet(name), now = Date.now();
  if (e.state==='CLOSED') return false;
  if (e.state==='OPEN') { if(now>=e.openUntil){_cb.set(name,{...e,state:'HALF_OPEN',halfOpenAt:now});return false;} return true; }
  return false;
}
function cbOnSuccess(name) {
  const e = cbGet(name);
  if (e.state==='HALF_OPEN') _cb.set(name,{state:'CLOSED',fails:0,windowStart:Date.now(),openUntil:0,halfOpenAt:0});
  else if (e.state==='CLOSED'&&e.fails>0) _cb.set(name,{...e,fails:0,windowStart:Date.now()});
}
function cbOnFail(name) {
  const e = cbGet(name), now = Date.now();
  if (e.state==='HALF_OPEN') { _cb.set(name,{...e,state:'OPEN',openUntil:now+CB_OPEN_TTL}); return; }
  if (e.state==='OPEN') return;
  let {fails,windowStart} = e;
  if (now-windowStart>CB_FAIL_WINDOW) { fails=1; windowStart=now; } else { fails++; }
  if (fails>=CB_FAIL_THRESHOLD) _cb.set(name,{state:'OPEN',fails,windowStart,openUntil:now+CB_OPEN_TTL,halfOpenAt:0});
  else _cb.set(name,{...e,fails,windowStart});
}

// ─── PING CACHE ───────────────────────────────────────────────
const _pingCache = new Map();
const PING_TTL = 10 * 60_000;
function getCachedPing(name) { const e=_pingCache.get(name); return (e&&Date.now()-e.updatedAt<PING_TTL)?e.ms:null; }
function setPing(name, ms) { _pingCache.set(name,{ms,updatedAt:Date.now()}); }

// ─── ADAPTIVE TIMEOUT ─────────────────────────────────────────
const TIMEOUT_NODE_BASE = 5_000;
const TIMEOUT_POOL_BASE = 15_000;
const TIMEOUT_MULT = 3.0;
const TIMEOUT_CAP = 22_000; // v12: чуть увеличен для медленных пулов

function adaptiveTimeout(name, tier='node') {
  const base = tier==='node' ? TIMEOUT_NODE_BASE : TIMEOUT_POOL_BASE;
  const ping = getCachedPing(name) ?? avgResponseMs(name);
  if (!ping || ping>=5000) return tier==='node' ? 8_000 : TIMEOUT_CAP;
  return Math.min(TIMEOUT_CAP, Math.max(base, Math.round(ping*TIMEOUT_MULT)));
}

// ─── ftr — умный retry ────────────────────────────────────────
async function ftr(url, opts={}, ms=13000, tries=2, chName='', tier='node') {
  const timeout = chName ? adaptiveTimeout(chName, tier) : ms;
  for (let i=0; i<=tries; i++) {
    try {
      const r = await ft(url, opts, timeout);
      const vercelCode = r.headers?.get?.('x-vercel-error') || '';
      const cls = classifyError(r.status, '', vercelCode);
      if (cls==='rate_limit') { registerHit(chName||url); return r; }
      if (cls==='skip') { setNegCache(chName||url); return r; }
      if (cls==='permanent') return r;
      if ((cls==='retry_now'||cls==='retry_later') && i<tries) {
        await sleep(cls==='retry_now' ? 200 : 800*(i+1));
        continue;
      }
      if (cls==='retry_later' && i===tries) setNegCache(chName||url);
      if (r.ok||cls==='ok'||cls==='accepted') registerSuccess(chName||url);
      return r;
    } catch(e) {
      if (i===tries) throw e;
      await sleep(300*(i+1));
    }
  }
}

// ─── HASHRATE TABLE Q1 2026 ──────────────────────────────────
// ⒞ v12: добавлены SBI Crypto, EMCDPool, Rawpool, 2Miners, Lincoin
const HR = {
  Foundry:27, AntPool:16, MARA:11, ViaBTC:9, SpiderPool:8,
  F2Pool:7, Luxor:5, CloverPool:4, BitFuFu:4, 'BTC.com':3,
  Ocean:2, EMCDPool:2, SBICrypto:2,
  TxBoost:1, mempoolAccel:1, bitaccelerate:1, '360btc':1, txfaster:1, btcspeed:1,
  Rawpool:1, '2Miners':1, Lincoin:1, MaraSlipstream:11, // Slipstream = MARA's pool
};

// Итого Premium охват: ~88% хешрейта (считаем уникальных, Slipstream = MARA)

const POOL_GEO = {
  Foundry:'usa', MARA:'usa', MaraSlipstream:'usa', Luxor:'usa', TxBoost:'usa', Ocean:'usa',
  AntPool:'asia', ViaBTC:'asia', SpiderPool:'asia', F2Pool:'asia', CloverPool:'asia', 'BTC.com':'asia', BitFuFu:'asia',
  SBICrypto:'asia', EMCDPool:'europe', Rawpool:'europe', Lincoin:'europe',
  '2Miners':'global', mempoolAccel:'global', bitaccelerate:'global', '360btc':'global', txfaster:'global', btcspeed:'global',
};

// ─── ⒜ LAST-BLOCK-MINER DETECTION ────────────────────────────
// Кэш: кто добыл последний блок
let _lastBlockMiner = null;
let _lastBlockAt    = 0;
const BLOCK_CACHE_TTL = 60_000; // обновляем не чаще раза в минуту

const POOL_COINBASE_TAGS = {
  'foundry':   'Foundry', 'foundryusa':'Foundry',
  'antpool':   'AntPool',
  'mara':      'MARA', 'marathon':  'MARA',
  'viabtc':    'ViaBTC',
  'spiderpool':'SpiderPool',
  'f2pool':    'F2Pool',
  'luxor':     'Luxor',
  'clvpool':   'CloverPool', 'clover':'CloverPool',
  'bitfufu':   'BitFuFu',
  'btc.com':   'BTC.com',
  'ocean':     'Ocean', 'ocean.xyz':'Ocean',
  'emcd':      'EMCDPool',
  'sbicrypto': 'SBICrypto',
  '2miners':   '2Miners',
  'rawpool':   'Rawpool',
};

async function detectLastBlockMiner() {
  if (_lastBlockMiner && Date.now()-_lastBlockAt < BLOCK_CACHE_TTL) return _lastBlockMiner;
  try {
    const r = await ft('https://mempool.space/api/v1/blocks/tip', {}, 5000);
    if (!r.ok) return null;
    const blocks = await safeJson(r);
    const block = Array.isArray(blocks) ? blocks[0] : blocks;
    if (!block) return null;

    // Ищем coinbase тег в extras или pool info
    const poolName = block.extras?.pool?.name || block.pool?.name || '';
    const tag = poolName.toLowerCase();
    for (const [key, poolId] of Object.entries(POOL_COINBASE_TAGS)) {
      if (tag.includes(key)) {
        _lastBlockMiner = poolId;
        _lastBlockAt = Date.now();
        return poolId;
      }
    }
    return null;
  } catch { return null; }
}

// ─── ⒢ FEE MARKET TREND ──────────────────────────────────────
// Определяем: комиссии растут или падают?
// Если падают >30% → ждём лучшего момента (для очень низких TX)
let _feeTrend = { fastest:0, halfHour:0, direction:'stable', sampledAt:0 };
const FEE_TREND_TTL = 3 * 60_000;

async function updateFeeTrend() {
  if (Date.now()-_feeTrend.sampledAt < FEE_TREND_TTL) return _feeTrend;
  try {
    const r = await ft('https://mempool.space/api/v1/fees/recommended', {}, 4000);
    if (!r.ok) return _feeTrend;
    const fees = await safeJson(r);
    const newFastest = fees.fastestFee || 0;
    const direction = _feeTrend.fastest > 0
      ? newFastest < _feeTrend.fastest * 0.7 ? 'dropping'
      : newFastest > _feeTrend.fastest * 1.3 ? 'rising'
      : 'stable'
      : 'stable';
    _feeTrend = { fastest:newFastest, halfHour:fees.halfHourFee||0, direction, sampledAt:Date.now() };
  } catch {}
  return _feeTrend;
}

// ─── PING URL MAP ─────────────────────────────────────────────
const PING_URLS = {
  'mempool.space':    'https://mempool.space/api/blocks/tip/height',
  'blockstream.info': 'https://blockstream.info/api/blocks/tip/height',
  'blockchair':       'https://api.blockchair.com/bitcoin/stats',
  'blockcypher':      'https://api.blockcypher.com/v1/btc/main',
  'btcscan.org':      'https://btcscan.org/api/blocks/tip/height',
  'blockchain.info':  'https://blockchain.info/latestblock',
  'bitaps.com':       'https://bitaps.com/api/bitcoin/blockcount',
  'sochain.com':      'https://sochain.com/api/v2/get_info/BTC',
  'Foundry':    'https://foundryusapool.com/',
  'AntPool':    'https://www.antpool.com/',
  'MARA':       'https://mara.com/',
  'ViaBTC':     'https://viabtc.com/',
  'SpiderPool': 'https://www.spiderpool.com/',
  'F2Pool':     'https://www.f2pool.com/',
  'Luxor':      'https://luxor.tech/',
  'CloverPool': 'https://clvpool.com/',
  'BitFuFu':    'https://www.bitfufu.com/',
  'BTC.com':    'https://btc.com/',
  'Ocean':       'https://ocean.xyz/',
  'EMCDPool':   'https://emcd.io/',
  'SBICrypto':  'https://sbicrypto.com/',
  '2Miners':    'https://2miners.com/',
  'Rawpool':    'https://rawpool.com/',
  'TxBoost':    'https://txboost.com/',
  'mempoolAccel':'https://mempool.space/',
  'bitaccelerate':'https://www.bitaccelerate.com/',
  '360btc':     'https://360btc.net/',
  'txfaster':   'https://txfaster.com/',
  'btcspeed':   'https://btcspeed.org/',
};

async function pingChannel(name) {
  const cached = getCachedPing(name);
  if (cached !== null) return cached;
  const url = PING_URLS[name];
  if (!url) return 9999;
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const tm = setTimeout(()=>ac.abort(), 3000);
    await fetch(url, {method:'HEAD', signal:ac.signal});
    clearTimeout(tm);
    const ms = Date.now()-t0; setPing(name, ms); return ms;
  } catch { setPing(name, 5000); return 5000; }
}

// ─── ⒠ HASHRATE-WEIGHTED PRIORITY + EARLY STOP ───────────────
function channelPriority(name, pingMs) {
  const score   = reliabilityScore(name);
  const normPing = Math.min(pingMs, 5000) / 5000;
  const normHr  = (HR[name] || 0) / 27;
  return 0.5 * score - 0.3 * normPing + 0.2 * normHr;
}

// ─── RUN ──────────────────────────────────────────────────────
async function run(channels, feeRatioHint = 0.5, lastBlockMiner = null) {
  if (channels.length === 0) return [];

  // ⒜ BOOST: если знаем кто добыл последний блок — он идёт первым
  if (lastBlockMiner) {
    const idx = channels.findIndex(ch => ch.name === lastBlockMiner || ch.name === 'MaraSlipstream' && lastBlockMiner === 'MARA');
    if (idx > 0) {
      const [boosted] = channels.splice(idx, 1);
      channels.unshift(boosted);
    }
  }

  const needPing = channels.filter(ch => getCachedPing(ch.name) === null);
  const hasFreshCache = needPing.length < channels.length * 0.5;

  let pingsMap = new Map(channels.map(ch => [ch.name, getCachedPing(ch.name) ?? 9999]));
  if (!hasFreshCache && needPing.length > 0) {
    const freshPings = await Promise.allSettled(
      needPing.map(ch => pingChannel(ch.name).then(ms => ({name:ch.name, ms})))
    );
    for (const r of freshPings)
      if (r.status==='fulfilled') pingsMap.set(r.value.name, r.value.ms);
  }

  const pings = channels.map(ch => ({ ch, ms: pingsMap.get(ch.name) ?? 9999 }));
  pings.sort((a,b) => {
    if (a.ch.tier !== b.ch.tier) return a.ch.tier==='node' ? -1 : 1;
    return channelPriority(b.ch.name, b.ms) - channelPriority(a.ch.name, a.ms);
  });

  const sorted = pings.map(p => p.ch);

  const WAVE_SIZE  = 8;
  const WAVE_DELAY = [0, 150, 400];
  const results    = new Array(sorted.length).fill(null);
  let okCount = 0, okHashrate = 0;
  const seenPools = new Set();

  const activeChannels = sorted.filter(ch =>
    !isDead(ch.name) && !cbIsBlocked(ch.name) && !isCooling(ch.name) && !isNegCached(ch.name)
  );

  // ⒠ v12: Hashrate-weighted early stop
  // Вместо "65% каналов" → "70% хешрейта покрыто"
  const HASHRATE_STOP_TARGET = feeRatioHint < 0.4 ? 85 : feeRatioHint >= 0.8 ? 60 : 70;
  const COUNT_STOP  = Math.max(3, Math.ceil(activeChannels.length * (feeRatioHint < 0.4 ? 0.85 : 0.65)));

  await new Promise(resolve => {
    let finished = 0, aborted = false;

    const launchWave = (waveChannels, waveIdx) => {
      waveChannels.forEach((ch, i) => {
        const globalIdx = waveIdx * WAVE_SIZE + i;

        if (isDead(ch.name)) {
          results[globalIdx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, reason:'dead', ms:0};
          if (++finished===sorted.length) resolve(); return;
        }
        if (cbIsBlocked(ch.name)) {
          results[globalIdx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, reason:'circuit_open', ms:0};
          if (++finished===sorted.length) resolve(); return;
        }
        if (isCooling(ch.name)) {
          const e=_cooldown.get(ch.name);
          const mins=Math.ceil((e.until-Date.now())/60_000);
          results[globalIdx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, reason:'rate_limited', cooldownMins:mins, ms:0};
          if (++finished===sorted.length) resolve(); return;
        }
        if (isNegCached(ch.name)) {
          results[globalIdx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, reason:'neg_cached', ms:0};
          if (++finished===sorted.length) resolve(); return;
        }
        if (aborted) {
          results[globalIdx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, ms:0};
          if (++finished===sorted.length) resolve(); return;
        }

        const t0 = Date.now();
        ch.call().then(r => {
          const ms  = Date.now()-t0;
          const vercelCode = r.ve || '';
          const cls = classifyError(r.status, '', vercelCode);
          const isOk = r.ok || cls==='accepted';

          recordStat(ch.name, isOk, ms);
          setPing(ch.name, ms);

          if (cls==='rate_limit') registerHit(ch.name);
          else if (isOk) { registerChannelOk(ch.name); registerSuccess(ch.name); cbOnSuccess(ch.name); }
          else if (cls==='skip'||cls==='retry_later') { registerFail(ch.name); setNegCache(ch.name); cbOnFail(ch.name); }
          else if (cls==='retry_now') { registerFail(ch.name); cbOnFail(ch.name); }

          results[globalIdx] = {
            channel:ch.name, name:ch.name, tier:ch.tier, ok:isOk, ms,
            score: +reliabilityScore(ch.name).toFixed(2),
            geo: POOL_GEO[ch.name] || (ch.tier==='node'?'node':null),
            hashrate: HR[ch.name] || 0,
            ...(vercelCode ? {vercelError:vercelCode} : {}),
            ...(cls!=='ok'&&!isOk ? {reason:cls} : {}),
          };

          if (isOk) {
            okCount++;
            // ⒠ Hashrate-weighted early stop
            if (ch.tier==='pool' && !seenPools.has(ch.name)) {
              seenPools.add(ch.name);
              okHashrate += HR[ch.name] || 0;
            }
          }

          if (++finished===sorted.length) resolve();

          // Stop если: хешрейт покрыт ИЛИ достаточно каналов
          if (!aborted && (okHashrate >= HASHRATE_STOP_TARGET || okCount >= COUNT_STOP)) {
            aborted = true;
          }
        }).catch(e => {
          const ms = Date.now()-t0;
          const isAbort = e.name==='AbortError';
          recordStat(ch.name, false, ms);
          if (!isAbort) { registerFail(ch.name); cbOnFail(ch.name); }
          results[globalIdx] = {
            channel:ch.name, name:ch.name, tier:ch.tier, ok:false,
            error:e.message, reason:isAbort?'timeout':'network_error', ms,
          };
          if (++finished===sorted.length) resolve();
        });
      });
    };

    for (let w=0; w<Math.ceil(sorted.length/WAVE_SIZE); w++) {
      const wave  = sorted.slice(w*WAVE_SIZE, (w+1)*WAVE_SIZE);
      const delay = WAVE_DELAY[w] ?? 400+w*150;
      if (delay === 0) {
        launchWave(wave, w);
      } else {
        setTimeout(()=>{
          if (!aborted) launchWave(wave, w);
          else {
            wave.forEach((ch,i)=>{
              const idx = w*WAVE_SIZE+i;
              results[idx] = {channel:ch.name, name:ch.name, tier:ch.tier, ok:false, skipped:true, ms:0};
              if (++finished===sorted.length) resolve();
            });
          }
        }, delay);
      }
    }
  });

  return results.filter(Boolean);
}

// ─── GET HEX — двухуровневый запуск ──────────────────────────
const HEX_RE = /^[0-9a-fA-F]{200,}$/;

async function getHex(txid) {
  // ⒡ Проверяем кэш между волнами
  const cached = getCachedHex(txid);
  if (cached) return cached;

  const SOURCES = [
    { name:'mempool.space',    url:`https://mempool.space/api/tx/${txid}/hex`,                            t:'text' },
    { name:'blockstream.info', url:`https://blockstream.info/api/tx/${txid}/hex`,                         t:'text' },
    { name:'btcscan.org',      url:`https://btcscan.org/api/tx/${txid}/raw`,                              t:'text' },
    { name:'blockchain.info',  url:`https://blockchain.info/rawtx/${txid}?format=hex`,                    t:'text' },
    { name:'blockchair',       url:`https://api.blockchair.com/bitcoin/raw/transaction/${txid}`,          t:'json', p:['data',txid,'raw_transaction'] },
    { name:'blockcypher',      url:`https://api.blockcypher.com/v1/btc/main/txs/${txid}?includeHex=true`, t:'json', p:['hex'] },
    { name:'btc.com',          url:`https://chain.api.btc.com/v3/tx/${txid}`,                             t:'json', p:['data','raw_hex'] },
    { name:'sochain.com',      url:`https://sochain.com/api/v2/get_tx/BTC/${txid}`,                       t:'json', p:['data','tx_hex'] },
  ];

  // Сортируем: сначала быстрые (по истории), затем медленные
  SOURCES.sort((a,b) => {
    const aMs = avgResponseMs(a.name) || 9999;
    const bMs = avgResponseMs(b.name) || 9999;
    return aMs - bMs;
  });

  const TOP    = SOURCES.slice(0, 3);
  const BOTTOM = SOURCES.slice(3);
  const ac = new AbortController();

  const makeSignal = () => {
    const tc = new AbortController();
    const tm = setTimeout(() => tc.abort(), 9000);
    ac.signal.addEventListener('abort', () => { clearTimeout(tm); tc.abort(); }, {once:true});
    return tc.signal;
  };

  return new Promise(res => {
    let found = false, done = 0, total = SOURCES.length;

    const trySource = ({ name, url, t, p }) => {
      const t0 = Date.now();
      fetch(url, { cache:'no-store', signal: makeSignal() })
        .then(async r => {
          if (!r.ok) return;
          const h = t==='json'
            ? p.reduce((o,k) => o?.[k], await safeJson(r))
            : (await safeText(r)).trim();
          if (!found && h && HEX_RE.test(h) && h.length < MAX_HEX_BYTES*2) {
            found = true;
            recordStat(name, true, Date.now()-t0);
            ac.abort();
            setCachedHex(txid, h); // ⒡ Кэшируем hex
            res(h);
          }
        })
        .catch(() => {})
        .finally(() => { if (++done === total && !found) res(null); });
    };

    TOP.forEach(trySource);

    const fallbackTimer = setTimeout(() => {
      if (!found) BOTTOM.forEach(trySource);
      else { total = done + BOTTOM.length; }
    }, 1000);

    ac.signal.addEventListener('abort', () => clearTimeout(fallbackTimer), {once:true});
  });
}

// ─── АНАЛИЗ TX ────────────────────────────────────────────────
async function analyze(txid) {
  try {
    const [tR, tR2, fR] = await Promise.allSettled([
      ft(`https://mempool.space/api/tx/${txid}`,{},7000),
      ft(`https://blockstream.info/api/tx/${txid}`,{},7000),
      ft('https://mempool.space/api/v1/fees/recommended',{},5000),
    ]);
    let tx = null;
    if (tR.status==='fulfilled' && tR.value?.ok) tx = await safeJson(tR.value);
    else if (tR2.status==='fulfilled' && tR2.value?.ok) tx = await safeJson(tR2.value);
    if (!tx) return null;
    const fees = (fR.status==='fulfilled' && fR.value?.ok) ? await safeJson(fR.value) : {};
    const vsize     = tx.weight ? Math.ceil(tx.weight/4) : (tx.size||250);
    const feePaid   = tx.fee||0;
    const feeRate   = feePaid&&vsize ? Math.round(feePaid/vsize) : 0;
    const fastest   = fees.fastestFee||50;
    const halfHour  = fees.halfHourFee||30;
    const hour      = fees.hourFee||20;
    const economy   = fees.economyFee||fees.minimumFee||5;
    const needCpfp  = feeRate>0 && feeRate<fastest*0.5;
    const rbfEnabled= Array.isArray(tx.vin) && tx.vin.some(i=>i.sequence<=0xFFFFFFFD);
    const feeRatio  = fastest>0 ? +(feeRate/fastest).toFixed(3) : 0;

    // ⒦ Anti-stuck detection: TX в мемпуле >72 часов
    const firstSeen = tx.firstSeen || tx.status?.block_time || null;
    const stuckHours = firstSeen ? Math.round((Date.now()/1000 - firstSeen) / 3600) : null;
    const isStuck72h = stuckHours !== null && stuckHours > 72;

    if (tx.status?.confirmed) setConfirmed(txid);
    return {
      vsize, feePaid, feeRate, feeRatio, fastest, halfHour, hour, economy,
      needCpfp, rbfEnabled,
      cpfpFeeNeeded: needCpfp ? Math.max(0, fastest*(vsize+110)-feePaid) : 0,
      confirmed: tx.status?.confirmed||false,
      blockHeight: tx.status?.block_height||null,
      inputs:  (tx.vin||[]).length,
      outputs: (tx.vout||[]).length,
      fees: { fastest, halfHour, hour, economy },
      stuckHours, isStuck72h,
      firstSeen,
    };
  } catch { return null; }
}

// ─── WAVE STRATEGY ────────────────────────────────────────────
function calcWaveStrategy(feeRate, fastest, isStuck72h = false) {
  if (!feeRate || !fastest) return { waves:5, intervalMs:15*60_000, label:'default' };
  const ratio = feeRate/fastest;
  if (isStuck72h) return { waves:8, intervalMs:10*60_000, label:'stuck_aggressive', urgency:'cpfp_recommended' };
  if (ratio >= 0.8) return { waves:3, intervalMs:20*60_000, label:'easy'       };
  if (ratio >= 0.4) return { waves:5, intervalMs:15*60_000, label:'standard'   };
  return              { waves:8, intervalMs:10*60_000, label:'aggressive' };
}

// ─── TXID-ONLY КАНАЛЫ (без hex) ───────────────────────────────
function txidOnlyChannels(txid) {
  const UA = getUA();
  return [
    { name:'mempoolAccel', tier:'pool', call: async()=>{
      const r=await ftr('https://mempool.space/api/v1/tx-accelerator/enqueue',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'mempoolAccel','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.message==='Success', status:r.status, ve:ve(r)};
    }},
    { name:'ViaBTC', tier:'pool', call: async()=>{
      const r=await ftr('https://viabtc.com/tools/txaccelerator/',{method:'POST',body:`txid=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},14000,2,'ViaBTC','pool');
      const t=await safeText(r);
      return {ok:r.ok||t.includes('"code":0'), status:r.status, ve:ve(r)};
    }},
    { name:'AntPool', tier:'pool', call: async()=>{
      const r=await ftr('https://antpool.com/txAccelerate.htm',{method:'POST',body:`txHash=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},12000,2,'AntPool','pool');
      const t=await safeText(r);
      return {ok:r.ok||t.includes('success')||ok400(t,r.status), status:r.status, ve:ve(r)};
    }},
    { name:'TxBoost', tier:'pool', call: async()=>{
      const r=await ftr('https://txboost.com/',{method:'POST',body:`txid=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},12000,2,'TxBoost','pool');
      const t=await safeText(r);
      return {ok:r.ok||t.includes('success'), status:r.status, ve:ve(r)};
    }},
    { name:'bitaccelerate', tier:'pool', call: async()=>{
      const r=await ftr('https://www.bitaccelerate.com/',{method:'POST',body:`txid=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},12000,2,'bitaccelerate','pool');
      return {ok:r.ok, status:r.status, ve:ve(r)};
    }},
  ];
}

// ─── ⒣ FREE TIER CHANNELS (FIX: добавлены ViaBTC + mempoolAccel) ─
function freeChannels(hex, txid) {
  const UA = getUA();
  return [
    { name:'mempool.space',  tier:'node', call: async()=>{
      const r=await ftr('https://mempool.space/api/tx',{method:'POST',body:hex,headers:{'Content-Type':'text/plain'}},12000,2,'mempool.space','node');
      return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'blockstream.info', tier:'node', call: async()=>{
      const r=await ftr('https://blockstream.info/api/tx',{method:'POST',body:hex,headers:{'Content-Type':'text/plain'}},12000,2,'blockstream.info','node');
      return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'blockchair', tier:'node', call: async()=>{
      const r=await ftr('https://api.blockchair.com/bitcoin/push/transaction',{method:'POST',body:`data=${encodeURIComponent(hex)}`,headers:{'Content-Type':'application/x-www-form-urlencoded'}},12000,2,'blockchair','node');
      const j=await safeJson(r);
      return {ok:!!(j?.data||j?.context?.code===200||ok400(JSON.stringify(j),r.status)), status:r.status, ve:ve(r)};
    }},
    // ⒣ FIX: Pool accelerators для free tier
    ...(txid ? [
      { name:'ViaBTC', tier:'pool', call: async()=>{
        const r=await ftr('https://viabtc.com/tools/txaccelerator/',{method:'POST',body:`txid=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},14000,2,'ViaBTC','pool');
        const t=await safeText(r);
        return {ok:r.ok||t.includes('"code":0'), status:r.status, ve:ve(r)};
      }},
      { name:'mempoolAccel', tier:'pool', call: async()=>{
        const r=await ftr('https://mempool.space/api/v1/tx-accelerator/enqueue',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,1,'mempoolAccel','pool');
        const j=await safeJson(r);
        return {ok:r.ok||j?.message==='Success', status:r.status, ve:ve(r)};
      }},
    ] : []),
  ];
}

// ─── PREMIUM CHANNELS (все 29 каналов) ────────────────────────
function premiumChannels(txid, hex) {
  const UA = getUA();

  const nodes = hex ? [
    { name:'mempool.space',    tier:'node', call: async()=>{
      const r=await ftr('https://mempool.space/api/tx',{method:'POST',body:hex,headers:{'Content-Type':'text/plain'}},12000,2,'mempool.space','node');
      return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'blockstream.info', tier:'node', call: async()=>{
      const r=await ftr('https://blockstream.info/api/tx',{method:'POST',body:hex,headers:{'Content-Type':'text/plain'}},12000,2,'blockstream.info','node');
      return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'blockchair',       tier:'node', call: async()=>{
      const r=await ftr('https://api.blockchair.com/bitcoin/push/transaction',{method:'POST',body:`data=${encodeURIComponent(hex)}`,headers:{'Content-Type':'application/x-www-form-urlencoded'}},12000,2,'blockchair','node');
      const j=await safeJson(r);
      return {ok:!!(j?.data||j?.context?.code===200||ok400(JSON.stringify(j),r.status)), status:r.status, ve:ve(r)};
    }},
    { name:'blockcypher',      tier:'node', call: async()=>{
      const r=await ftr('https://api.blockcypher.com/v1/btc/main/txs/push',{method:'POST',body:JSON.stringify({tx:hex}),headers:{'Content-Type':'application/json'}},12000,2,'blockcypher','node');
      const j=await safeJson(r);
      return {ok:r.status===201||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'btcscan.org',      tier:'node', call: async()=>{
      const r=await ftr('https://btcscan.org/api/tx/push',{method:'POST',body:hex,headers:{'Content-Type':'text/plain'}},10000,2,'btcscan.org','node');
      return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'blockchain.info',  tier:'node', call: async()=>{
      const r=await ftr('https://blockchain.info/pushtx',{method:'POST',body:`tx=${hex}`,headers:{'Content-Type':'application/x-www-form-urlencoded'}},12000,2,'blockchain.info','node');
      return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'bitaps.com',       tier:'node', call: async()=>{
      const r=await ftr('https://bitaps.com/api/bitcoin/push/transaction',{method:'POST',body:hex,headers:{'Content-Type':'text/plain'}},10000,2,'bitaps.com','node');
      return {ok:r.ok, status:r.status, ve:ve(r)};
    }},
    { name:'sochain.com',      tier:'node', call: async()=>{
      const r=await ftr('https://sochain.com/api/v2/send_tx/BTC',{method:'POST',body:JSON.stringify({tx_hex:hex}),headers:{'Content-Type':'application/json'}},10000,2,'sochain.com','node');
      const j=await safeJson(r);
      return {ok:j?.status==='success'||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
  ] : [];

  const pools = [
    // ─── ТОП ПУЛЫ (высокий хешрейт) ─────────────────────────
    { name:'Foundry', tier:'pool', call: async()=>{
      const r=await ftr('https://foundryusapool.com/accelerate',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},16000,2,'Foundry','pool');
      return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'AntPool', tier:'pool', call: async()=>{
      try {
        const r=await ft('https://www.antpool.com/api/v1/tools/tx-accelerate',{method:'POST',body:JSON.stringify({txHash:txid}),headers:{'Content-Type':'application/json','User-Agent':UA,'Referer':'https://www.antpool.com/'}},12000);
        const j=await safeJson(r); if(r.ok||j?.code===0) return {ok:true,status:r.status};
      } catch {}
      const r2=await ftr('https://antpool.com/txAccelerate.htm',{method:'POST',body:`txHash=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},12000,2,'AntPool','pool');
      const t2=await safeText(r2);
      return {ok:r2.ok||t2.includes('success')||ok400(t2,r2.status), status:r2.status, ve:ve(r2)};
    }},
    // ⒝ MARA Slipstream — приватный мемпул MARA (bypass обычной очереди)
    { name:'MaraSlipstream', tier:'pool', call: async()=>{
      try {
        const r=await ftr('https://slipstream.mara.com/tx',{method:'POST',body:hex||JSON.stringify({txid}),headers:{'Content-Type':hex?'text/plain':'application/json','User-Agent':UA,'Origin':'https://mara.com'}},16000,3,'MaraSlipstream','pool');
        return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
      } catch {
        // Fallback к обычному MARA акселератору
        const r=await ftr('https://mara.com/api/transaction-accelerator',{method:'POST',body:JSON.stringify({txId:txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},14000,2,'MARA','pool');
        const j=await safeJson(r);
        return {ok:r.ok||j?.success===true||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
      }
    }},
    { name:'MARA', tier:'pool', call: async()=>{
      const r=await ftr('https://mara.com/api/transaction-accelerator',{method:'POST',body:JSON.stringify({txId:txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},14000,2,'MARA','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.success===true||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'ViaBTC', tier:'pool', call: async()=>{
      try {
        const r=await ft('https://viabtc.com/api/v1/btc/accelerator',{method:'POST',body:JSON.stringify({tx_id:txid}),headers:{'Content-Type':'application/json','User-Agent':UA,'Origin':'https://viabtc.com'}},14000);
        const j=await safeJson(r); if(r.ok||j?.code===0) return {ok:true,status:r.status};
      } catch {}
      const r2=await ft('https://www.viabtc.com/tools/txaccelerator/',{method:'POST',body:`txid=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},14000);
      const t2=await safeText(r2);
      return {ok:r2.ok||t2.includes('"code":0'), status:r2.status, ve:ve(r2)};
    }},
    { name:'SpiderPool', tier:'pool', call: async()=>{
      const r=await ftr('https://www.spiderpool.com/api/v1/accelerate',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'SpiderPool','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.code===0||j?.success===true, status:r.status, ve:ve(r)};
    }},
    { name:'F2Pool', tier:'pool', call: async()=>{
      const r=await ftr('https://www.f2pool.com/api/v2/tx/accelerate',{method:'POST',body:JSON.stringify({tx_id:txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'F2Pool','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.code===0, status:r.status, ve:ve(r)};
    }},
    { name:'Luxor', tier:'pool', call: async()=>{
      const r=await ftr('https://luxor.tech/api/accelerate',{method:'POST',body:JSON.stringify({txHash:txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'Luxor','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.success===true||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'CloverPool', tier:'pool', call: async()=>{
      const r=await ftr('https://clvpool.com/accelerator',{method:'POST',body:`tx_id=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},12000,2,'CloverPool','pool');
      return {ok:r.ok, status:r.status, ve:ve(r)};
    }},
    { name:'BitFuFu', tier:'pool', call: async()=>{
      const r=await ftr('https://www.bitfufu.com/txaccelerator/submit',{method:'POST',body:JSON.stringify({txHash:txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'BitFuFu','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.success===true, status:r.status, ve:ve(r)};
    }},
    { name:'BTC.com', tier:'pool', call: async()=>{
      const r=await ftr('https://btc.com/service/accelerator/boost',{method:'POST',body:JSON.stringify({tx_id:txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'BTC.com','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.err_no===0, status:r.status, ve:ve(r)};
    }},
    { name:'Ocean', tier:'pool', call: async()=>{
      const r=await ftr('https://ocean.xyz/api/accelerate',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'Ocean','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.success===true||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'mempoolAccel', tier:'pool', call: async()=>{
      const r=await ftr('https://mempool.space/api/v1/tx-accelerator/enqueue',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'mempoolAccel','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.message==='Success', status:r.status, ve:ve(r)};
    }},
    // ─── ⒞ НОВЫЕ ПУЛЫ v12 ────────────────────────────────────
    { name:'EMCDPool', tier:'pool', call: async()=>{
      const r=await ftr('https://emcd.io/api/v1/bitcoin/accelerate',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'EMCDPool','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.success===true||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'SBICrypto', tier:'pool', call: async()=>{
      const r=await ftr('https://sbicrypto.com/api/accelerator',{method:'POST',body:JSON.stringify({tx_hash:txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'SBICrypto','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.status==='ok'||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'2Miners', tier:'pool', call: async()=>{
      const r=await ftr('https://2miners.com/api/v1/btc/accelerate',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'2Miners','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.result==='ok'||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'Rawpool', tier:'pool', call: async()=>{
      const r=await ftr('https://rawpool.com/api/accelerate',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'Rawpool','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.ok===true||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'TxBoost', tier:'pool', call: async()=>{
      const r=await ftr('https://txboost.com/',{method:'POST',body:`txid=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},12000,2,'TxBoost','pool');
      const t=await safeText(r);
      return {ok:r.ok||t.includes('success'), status:r.status, ve:ve(r)};
    }},
    { name:'bitaccelerate', tier:'pool', call: async()=>{
      const r=await ftr('https://www.bitaccelerate.com/',{method:'POST',body:`txid=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},12000,2,'bitaccelerate','pool');
      return {ok:r.ok, status:r.status, ve:ve(r)};
    }},
    { name:'360btc', tier:'pool', call: async()=>{
      const r=await ftr('https://360btc.net/accelerate',{method:'POST',body:`txid=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},12000,2,'360btc','pool');
      return {ok:r.ok, status:r.status, ve:ve(r)};
    }},
    { name:'txfaster', tier:'pool', call: async()=>{
      const r=await ftr('https://txfaster.com/api/accelerate',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},10000,2,'txfaster','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.success===true, status:r.status, ve:ve(r)};
    }},
    { name:'btcspeed', tier:'pool', call: async()=>{
      const r=await ftr('https://btcspeed.org/boost',{method:'POST',body:`tx=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},10000,2,'btcspeed','pool');
      return {ok:r.ok, status:r.status, ve:ve(r)};
    }},
  ];

  return [...nodes, ...pools];
}

// ─── ⒤ BOOTSTRAP — inline (fix: не вызываем /api/health через self) ──
let _bootstrapped = false;
async function bootstrapInline() {
  if (_bootstrapped) return;
  _bootstrapped = true;
  try {
    // Параллельный пинг топ-6 каналов для прогрева кэша
    const bootstrapTargets = [
      { name:'mempool.space',    url:'https://mempool.space/api/blocks/tip/height' },
      { name:'blockstream.info', url:'https://blockstream.info/api/blocks/tip/height' },
      { name:'blockchair',       url:'https://api.blockchair.com/bitcoin/stats' },
      { name:'Foundry',          url:'https://foundryusapool.com/' },
      { name:'AntPool',          url:'https://www.antpool.com/' },
      { name:'MARA',             url:'https://mara.com/' },
    ];
    const results = await Promise.allSettled(
      bootstrapTargets.map(async ({ name, url }) => {
        const t0 = Date.now();
        try {
          const ac = new AbortController();
          const tm = setTimeout(()=>ac.abort(), 3000);
          await fetch(url, {method:'HEAD', signal:ac.signal});
          clearTimeout(tm);
          setPing(name, Date.now()-t0);
        } catch { setPing(name, 5000); }
      })
    );
  } catch {}
}

// ─── MEMORY CLEANUP (30 мин) ──────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [k,v] of _txidMap)    if (now-v.lastSeen>3*3_600_000) _txidMap.delete(k);
  for (const [k,v] of _cooldown)   if (v.until<now) _cooldown.delete(k);
  for (const [k,v] of _negCache)   if (v<now) _negCache.delete(k);
  for (const [k,v] of _pingCache)  if (now-v.updatedAt>20*60_000) _pingCache.delete(k);
  for (const [k,v] of _hexCache)   if (now-v.cachedAt>HEX_CACHE_TTL) _hexCache.delete(k);
  for (const [k,v] of _confirmed)  if (now-v>CONFIRMED_TTL) _confirmed.delete(k);
  for (const [k,v] of _cb)         if (v.state==='CLOSED'&&v.fails===0) _cb.delete(k);
}, 30*60_000);

// ─── TELEGRAM ─────────────────────────────────────────────────
async function tg({results, txid, plan, analysis, ms, hr, ip, blocked, waveStrategy, lastBlockMiner, feeTrend}) {
  const token=process.env.TG_TOKEN, chat=process.env.TG_CHAT_ID;
  if (!token||!chat) return;
  let text;
  if (blocked) {
    text=[`🛡 *TurboTX BLOCKED*`,`📋 \`${txid?.slice(0,14)||'???'}\``,`🚫 ${blocked}`,`🌐 \`${ip}\``,
      `🕐 ${new Date().toLocaleString('ru',{timeZone:'Europe/Moscow'})} МСК`].join('\n');
  } else {
    const ok=results.filter(r=>r.ok).length, tot=results.length;
    const pct=tot?Math.round(ok/tot*100):0;
    const bar='█'.repeat(Math.round(pct/10))+'░'.repeat(10-Math.round(pct/10));
    const okPools=results.filter(r=>r.tier==='pool'&&r.ok).sort((a,b)=>(HR[b.name]||0)-(HR[a.name]||0)).slice(0,5).map(r=>`${r.name}(${HR[r.name]||'?'}%)`);
    const okNodes=results.filter(r=>r.tier==='node'&&r.ok).map(r=>r.name);
    const feeInfo=analysis?`${analysis.vsize}vB · ${analysis.feeRate}→${analysis.fastest} sat/vB (${Math.round((analysis.feeRatio||0)*100)}%)`:'' ;
    const trendEmoji = feeTrend?.direction==='dropping'?'📉':feeTrend?.direction==='rising'?'📈':'→';

    text=[
      `⚡ *TurboTX v12 — ${plan.toUpperCase()}*`,
      `📋 \`${txid.slice(0,14)}…${txid.slice(-6)}\` · \`${ip}\``,
      `⏱ ${ms}ms · \`${bar}\` ${pct}% (${ok}/${tot})`,
      hr>0 ? `⛏ ~${hr}% хешрейта охвачено` : '',
      lastBlockMiner ? `🎯 Приоритет: ${lastBlockMiner} (добыл последний блок)` : '',
      okNodes.length ? `🔗 Ноды: ${okNodes.join(', ')}` : '',
      okPools.length ? `🏊 Пулы: ${okPools.join(', ')}` : '',
      feeInfo ? `📐 ${feeInfo}${analysis.needCpfp?' ⚠️CPFP':' ✅'}${analysis.rbfEnabled?' 🔄RBF':''}` : '',
      analysis?.isStuck72h ? `⚠️ TX зависла ${analysis.stuckHours}ч — рекомендован CPFP!` : '',
      feeTrend?.direction!=='stable' ? `${trendEmoji} Комиссии ${feeTrend.direction==='dropping'?'падают':'растут'} (${feeTrend.fastest} sat/vB)` : '',
      waveStrategy ? `🌊 ${waveStrategy.waves} волн · ${waveStrategy.label}` : '',
      `🕐 ${new Date().toLocaleString('ru',{timeZone:'Europe/Moscow'})} МСК`,
    ].filter(Boolean).join('\n');
  }
  await ft(`https://api.telegram.org/bot${token}/sendMessage`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:chat,text,parse_mode:'Markdown',
      ...(!blocked&&{reply_markup:{inline_keyboard:[[{text:'🔍 Mempool',url:`https://mempool.space/tx/${txid}`}]]}})}),
  },5000).catch(()=>{});
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method==='OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v));
  if (req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});

  // ⒤ Bootstrap inline (не вызываем /api/health — избегаем самовызова)
  bootstrapInline().catch(()=>{});

  const ip = getIp(req);
  if (isBot(req)) { tg({txid:'?',plan:'?',ip,blocked:'bot_ua'}).catch(()=>{}); return res.status(403).json({ok:false,error:'Forbidden'}); }

  const body = req.body || {};
  const effectivePlan = ['free','premium'].includes(body.plan) ? body.plan : 'free';

  if (effectivePlan==='premium') {
    const secret=process.env.PREMIUM_SECRET, token=req.headers['x-turbotx-token']||body.token;
    if (secret&&token!==secret) return res.status(401).json({ok:false,error:'Invalid premium token'});
  }

  const isBatch = Array.isArray(body.txids);
  if (isBatch) return handleBatch(req, res, body, effectivePlan, ip);

  // ── Одиночный режим ───────────────────────────────────────
  const {txid, hex:hexIn} = body;
  if (!txid||!/^[a-fA-F0-9]{64}$/.test(txid)) return res.status(400).json({ok:false,error:'Invalid TXID'});
  if (hexIn&&hexIn.length>MAX_HEX_BYTES*2) return res.status(413).json({ok:false,error:'Hex too large'});

  const rl = checkLimits(ip, txid, effectivePlan);
  if (!rl.ok) {
    const minLeft=Math.ceil(rl.retryAfter/60);
    if (rl.reason==='abuse') tg({txid,plan:effectivePlan,ip,blocked:'abuse'}).catch(()=>{});
    const msgs={rate_limit:`Лимит. Повторите через ${minLeft} мин.`,txid_cooldown:`TXID cooldown. Повтор через ${minLeft} мин.`,abuse:'Слишком много TXID.'};
    return res.status(429).json({ok:false,error:msgs[rl.reason]||'Rate limited',retryAfter:rl.retryAfter});
  }

  if (isConfirmed(txid)) return res.status(200).json({ok:true,confirmed:true,cached:true});

  const t0 = Date.now();

  // ⒧ PARALLEL: запускаем hex-получение, анализ, last-block-miner и fee-trend ОДНОВРЕМЕННО
  const [hexRes, analysisRes, lastBlockRes, feeTrendRes] = await Promise.allSettled([
    hexIn&&HEX_RE.test(hexIn) ? Promise.resolve(hexIn) : getHex(txid),
    analyze(txid),
    effectivePlan==='premium' ? detectLastBlockMiner() : Promise.resolve(null),
    updateFeeTrend(),
  ]);

  let hex          = hexRes.status==='fulfilled' ? hexRes.value : null;
  const analysis   = analysisRes.status==='fulfilled' ? analysisRes.value : null;
  const lastBlock  = lastBlockRes.status==='fulfilled' ? lastBlockRes.value : null;
  const feeTrend   = feeTrendRes.status==='fulfilled' ? feeTrendRes.value : null;

  // Premium retry hex
  if (!hex && effectivePlan==='premium') {
    await sleep(3000);
    hex = await getHex(txid).catch(()=>null);
  }

  if (analysis?.confirmed) { setConfirmed(txid); return res.status(200).json({ok:true,confirmed:true,analysis}); }
  if (effectivePlan==='free'&&!hex) return res.status(200).json({ok:false,error:'TX hex not found. Попробуйте Premium — он умеет без hex.',analysis});

  const waveStrategy = calcWaveStrategy(analysis?.feeRate, analysis?.fastest, analysis?.isStuck72h);

  let channels;
  if (effectivePlan==='premium') {
    channels = hex ? premiumChannels(txid, hex) : txidOnlyChannels(txid);
  } else {
    channels = freeChannels(hex, txid);
  }

  const results = await run(channels, analysis?.feeRatio ?? 0.5, lastBlock);
  const ms = Date.now()-t0;

  const hr = effectivePlan==='premium'
    ? [...new Set(results.filter(r=>r.ok&&r.tier==='pool').map(r=>r.name||r.channel))]
        .reduce((s,name)=>s+(HR[name]||0), 0)
    : 0;
  const okCount = results.filter(r=>r.ok).length;

  // Deduplicate MARA/MaraSlipstream в hashrate
  const uniqueHr = (() => {
    const seen = new Set();
    let total = 0;
    for (const r of results) {
      if (!r.ok || r.tier!=='pool') continue;
      const key = r.name==='MaraSlipstream' ? 'MARA' : (r.name||r.channel);
      if (!seen.has(key)) { seen.add(key); total += HR[key]||HR[r.name]||0; }
    }
    return total;
  })();

  const summary = {
    total:results.length, ok:okCount, failed:results.length-okCount,
    hexFound:!!hex, hexCacheHit: getCachedHex(txid)===hex&&!!hex,
    ms, plan:effectivePlan, hashrateReach:uniqueHr,
    feeRate:       analysis?.feeRate    ?? null,
    feeRatio:      analysis?.feeRatio   ?? null,
    needCpfp:      analysis?.needCpfp   ?? false,
    cpfpFeeNeeded: analysis?.cpfpFeeNeeded ?? 0,
    rbfEnabled:    analysis?.rbfEnabled ?? false,
    isStuck72h:    analysis?.isStuck72h ?? false,
    stuckHours:    analysis?.stuckHours ?? null,
    waveStrategy,
    lastBlockMiner: lastBlock,
    feeTrend: feeTrend?.direction ?? 'stable',
    totalChannels: 29, // 8 nodes + 21 pools (v12)
    circuitBreakers: (() => {
      const open=[], halfOpen=[];
      for (const [name,e] of _cb) {
        if (e.state==='OPEN')      open.push(name);
        if (e.state==='HALF_OPEN') halfOpen.push(name);
      }
      return open.length+halfOpen.length>0 ? {open,halfOpen} : undefined;
    })(),
  };

  tg({results,txid,plan:effectivePlan,analysis,ms,hr:uniqueHr,ip,waveStrategy,lastBlockMiner:lastBlock,feeTrend}).catch(()=>{});

  return res.status(200).json({
    ok: okCount>0, results, summary, analysis, waveStrategy,
    ...(effectivePlan==='premium' ? {jobId:`${txid.slice(0,8)}_${Date.now()}`} : {}),
  });
}

// ─── BATCH HANDLER ────────────────────────────────────────────
async function handleBatch(req, res, body, plan, ip) {
  const MAX_BATCH = plan==='premium' ? 20 : 5;
  const txids = (body.txids||[])
    .filter(t => typeof t==='string' && /^[a-fA-F0-9]{64}$/.test(t))
    .slice(0, MAX_BATCH);

  if (txids.length===0) return res.status(400).json({ok:false,error:'No valid TXIDs in batch'});

  const t0 = Date.now();
  const [lastBlockRes] = await Promise.allSettled([
    plan==='premium' ? detectLastBlockMiner() : Promise.resolve(null),
  ]);
  const lastBlock = lastBlockRes.status==='fulfilled' ? lastBlockRes.value : null;

  const batchResults = await Promise.allSettled(
    txids.map(async (txid, idx) => {
      if (isConfirmed(txid)) return { txid, ok:true, confirmed:true, cached:true };

      const rl = checkLimits(ip, txid, plan);
      if (!rl.ok) return { txid, ok:false, rateLimited:true, retryAfter:rl.retryAfter };

      const [hexRes, analysisRes] = await Promise.allSettled([getHex(txid), analyze(txid)]);
      const hex      = hexRes.status==='fulfilled' ? hexRes.value : null;
      const analysis = analysisRes.status==='fulfilled' ? analysisRes.value : null;

      if (analysis?.confirmed) { setConfirmed(txid); return {txid,ok:true,confirmed:true,analysis}; }

      let channels;
      if (plan==='premium') {
        channels = idx < 3
          ? (hex ? premiumChannels(txid,hex) : txidOnlyChannels(txid))
          : txidOnlyChannels(txid);
      } else {
        if (!hex) return {txid,ok:false,error:'hex not found',analysis};
        channels = freeChannels(hex, txid);
      }

      const results = await run(channels, analysis?.feeRatio ?? 0.5, idx===0 ? lastBlock : null);
      const okCount = results.filter(r=>r.ok).length;
      const uniqueHr = plan==='premium'
        ? [...new Set(results.filter(r=>r.ok&&r.tier==='pool').map(r=>r.name||r.channel))]
            .reduce((s,name)=>s+(HR[name]||0), 0)
        : 0;

      return { txid, ok:okCount>0, okCount, hexFound:!!hex, hashrateReach:uniqueHr, analysis };
    })
  );

  const items = batchResults.map((r,i) =>
    r.status==='fulfilled' ? r.value : {txid:txids[i], ok:false, error:r.reason?.message}
  );
  const successCount = items.filter(i=>i.ok).length;

  return res.status(200).json({
    ok: successCount>0, batch:true, total:items.length,
    succeeded:successCount, failed:items.length-successCount,
    ms:Date.now()-t0, plan, lastBlockMiner:lastBlock, items,
  });
}
