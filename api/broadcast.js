// ══════════════════════════════════════════════════════════════
//  TurboTX v10 ★ MAXIMUM POWER ★  —  /api/broadcast.js
//  Vercel Serverless · Node.js 20 · Hobby Plan
//
//  НОВОЕ v10:
//  ⑪ Skip-ping оптимизация — если >50% кэша свежие, стартуем НЕМЕДЛЕННО (-2с)
//  ⑫ Tiered hex fetch — топ-3 сразу, остальные через 1с (экономия трафика)
//  ⑬ analyze() с blockstream fallback — не падаем если mempool.space лежит
//  ⑭ Hashrate-weighted sort — Foundry(27%) идёт раньше btcspeed(1%)
//  ⑮ Dynamic EARLY_STOP — агрессивные TX ждут 85% каналов вместо 65%
//  ⑯ txidOnlyChannels — шлём в пулы даже без hex (hex не нашли → не сдаёмся)
//  ⑰ Batch broadcast — POST { txids: [...] } — до 5 Free / 20 Premium
//  ⑱ feeRatio в summary и в логике Early stop
//
//  ДВИЖОК v9 (сохранено):
//  ① Статистика надёжности · ② Circuit Breaker · ③ Smart hex retry
//  ④ Adaptive timeout · ⑤ Negative cache · ⑥ Geo-groups
//  ⑦ 429 exponential cooldown · ⑧ Dead channel exclusion
//  ⑨ Ping-sort + priority score · ⑩ Memory cleanup 30min
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TurboTX-Token',
};

// ─── RATE LIMITER ─────────────────────────────────────────────
const _ipMap     = new Map();
const _txidMap   = new Map();
// Confirmed TX cache with TTL (prevents Set growing forever)
const _confirmed = new Map(); // txid → confirmedAt timestamp
const CONFIRMED_TTL = 24 * 3_600_000; // 24 hours
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
    return { ok:false, reason:'abuse',        retryAfter:Math.ceil((e.resetAt-now)/1000) };
  if (e.count >= lim.perHour)
    return { ok:false, reason:'rate_limit',   retryAfter:Math.ceil((e.resetAt-now)/1000) };
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

// ─── УТИЛИТЫ ─────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function safeJson(r) { try { return await r.json(); } catch { return {}; } }
async function safeText(r) { try { return await r.text(); } catch { return ''; } }
// Извлекает x-vercel-error из Response (пусто если нет)
function ve(r) { return r?.headers?.get?.('x-vercel-error') || ''; }

async function ft(url, opts={}, ms=13000) {
  const ac = new AbortController();
  const t  = setTimeout(()=>ac.abort(), ms);
  try { const r = await fetch(url, {...opts, signal:ac.signal}); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}

// ─── ① СТАТИСТИКА НАДЁЖНОСТИ КАНАЛОВ ─────────────────────────
// successCount, failCount → score = success/(success+fail)
// Каналы сортируются: score DESC × ping ASC (взвешенно)
// Firebase не нужен — достаточно in-memory для одного инстанса
const _stats = new Map(); // name → { success, fail, totalMs, calls }

function getStat(name) {
  return _stats.get(name) ?? { success:0, fail:0, totalMs:0, calls:0 };
}
function recordStat(name, ok, ms) {
  const s = getStat(name);
  s.calls++;
  s.totalMs += ms;
  if (ok) s.success++; else s.fail++;
  _stats.set(name, s);
}
function reliabilityScore(name) {
  const s = getStat(name);
  if (s.calls === 0) return 0.5; // новый канал — нейтральный
  return s.success / (s.success + s.fail);
}
function avgResponseMs(name) {
  const s = getStat(name);
  return s.calls > 0 ? Math.round(s.totalMs / s.calls) : 9999;
}

// ─── КЛАССИФИКАЦИЯ ОШИБОК ────────────────────────────────────
// ─── VERCEL ERROR CODES → КЛАССИФИКАЦИЯ ──────────────────────
// Источник: https://vercel.com/docs/errors
// Разбиваем на 4 категории поведения:
//
//  'retry_now'   — повторить немедленно (transient, не наша вина)
//  'retry_later' — повторить через паузу (временный сбой)
//  'skip'        — пропустить канал совсем в этой волне (throttle/timeout)
//  'permanent'   — не повторять (наша ошибка — плохой запрос)
//  'accepted'    — TX уже принята (200/400 с "known"/"duplicate")
//  'rate_limit'  — cooldown (429)
//  'ok'          — успех

// Vercel error codes которые приходят в заголовке x-vercel-error
const VERCEL_RETRY_NOW = new Set([
  'FUNCTION_INVOCATION_FAILED',       // 500 — мгновенный сбой, стоит повторить
  'INTERNAL_FUNCTION_INVOCATION_FAILED',
  'NO_RESPONSE_FROM_FUNCTION',        // 502 — функция не ответила
  'SANDBOX_NOT_LISTENING',            // 502 — sandbox не готов
  'INTERNAL_FUNCTION_NOT_READY',      // 500 — cold start не завершён
  'INTERNAL_MISSING_RESPONSE_FROM_CACHE',
  'ROUTER_CANNOT_MATCH',              // 502 — роутинг сломан, попробуем снова
  'ROUTER_EXTERNAL_TARGET_CONNECTION_ERROR', // 502 — сетевой сбой к пулу
  'ROUTER_EXTERNAL_TARGET_HANDSHAKE_ERROR',  // 502
  'DNS_HOSTNAME_RESOLVE_FAILED',      // 502 — DNS временно упал
  'DNS_HOSTNAME_SERVER_ERROR',        // 502
]);

const VERCEL_RETRY_LATER = new Set([
  'FUNCTION_THROTTLED',               // 503 — нас throttle-ят, подождать
  'INTERNAL_FUNCTION_SERVICE_UNAVAILABLE', // 500
  'DEPLOYMENT_PAUSED',                // 503 — деплой на паузе
  'INTERNAL_CACHE_LOCK_FULL',         // 500
  'INTERNAL_CACHE_LOCK_TIMEOUT',      // 500
  'EDGE_FUNCTION_INVOCATION_FAILED',  // 500
  'MIDDLEWARE_INVOCATION_FAILED',     // 500
  'SANDBOX_STOPPED',                  // 410 — sandbox перезапускается
]);

const VERCEL_SKIP = new Set([
  'FUNCTION_INVOCATION_TIMEOUT',      // 504 — таймаут, не ждём этот канал
  'INTERNAL_FUNCTION_INVOCATION_TIMEOUT',
  'EDGE_FUNCTION_INVOCATION_TIMEOUT', // 504
  'MIDDLEWARE_INVOCATION_TIMEOUT',    // 504
  'INFINITE_LOOP_DETECTED',           // 508 — не повторять
  'MIDDLEWARE_RUNTIME_DEPRECATED',    // 503 — устаревший runtime
]);

const VERCEL_PERMANENT = new Set([
  'DEPLOYMENT_BLOCKED',               // 403
  'DEPLOYMENT_DELETED',               // 410
  'DEPLOYMENT_DISABLED',              // 402
  'DEPLOYMENT_NOT_FOUND',             // 404
  'FUNCTION_PAYLOAD_TOO_LARGE',       // 413
  'FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE', // 500
  'INVALID_REQUEST_METHOD',           // 405
  'MALFORMED_REQUEST_HEADER',         // 400
  'DNS_HOSTNAME_NOT_FOUND',           // 502 — DNS не существует
  'DNS_HOSTNAME_EMPTY',               // 502
  'DNS_HOSTNAME_RESOLVED_PRIVATE',    // 404
]);

function classifyVercelError(vercelCode) {
  if (!vercelCode) return null;
  if (VERCEL_RETRY_NOW.has(vercelCode))   return 'retry_now';
  if (VERCEL_RETRY_LATER.has(vercelCode)) return 'retry_later';
  if (VERCEL_SKIP.has(vercelCode))        return 'skip';
  if (VERCEL_PERMANENT.has(vercelCode))   return 'permanent';
  return null; // неизвестный код — fallback на статус
}

function classifyError(status, body='', vercelCode='') {
  // Сначала проверяем Vercel-специфичный код (самый точный)
  const vercelCls = classifyVercelError(vercelCode);
  if (vercelCls) return vercelCls;

  if (status === 429) return 'rate_limit';
  if (status === 0)   return 'retry_now';   // network / AbortError — мгновенный retry

  // 5xx — смотрим детальнее
  if (status === 500) return 'retry_now';   // обычный 500 — стоит повторить
  if (status === 502) return 'retry_now';   // bad gateway — upstream упал временно
  if (status === 503) return 'retry_later'; // service unavailable — подождать
  if (status === 504) return 'skip';        // gateway timeout — не ждём этот канал
  if (status === 508) return 'skip';        // loop detected
  if (status === 410) return 'retry_later'; // gone/stopped — может восстановиться
  if (status >= 500)  return 'retry_now';   // прочие 5xx

  // 4xx
  if (status === 400 || status === 404) {
    const b = String(body).toLowerCase();
    if (b.includes('already')||b.includes('duplicate')||b.includes('known')||b.includes('exists'))
      return 'accepted';
    return 'permanent';
  }
  if (status === 401 || status === 402 || status === 403) return 'permanent';
  if (status === 413) return 'permanent'; // payload too large
  if (status === 405) return 'permanent'; // method not allowed
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
  const ms   = COOLDOWN_MS[Math.min(hits-1, COOLDOWN_MS.length-1)];
  _cooldown.set(name,{hits,until:Date.now()+ms});
  console.warn(`[TurboTX] 429: ${name} → ${Math.round(ms/60_000)}мин (hit#${hits})`);
}
function registerSuccess(name) { if(_cooldown.has(name)) _cooldown.set(name,{hits:0,until:0}); }

// ─── ⑤ NEGATIVE CACHE (5xx не долбим) ────────────────────────
// Канал вернул 5xx → пауза 5 мин, не тратим время на него
const _negCache = new Map(); // name → untilMs
const NEG_CACHE_TTL = 5 * 60_000;

function isNegCached(name) {
  const u = _negCache.get(name);
  if (!u) return false;
  if (Date.now() > u) { _negCache.delete(name); return false; }
  return true;
}
function setNegCache(name) {
  _negCache.set(name, Date.now() + NEG_CACHE_TTL);
}

// ─── DEAD CHANNEL REGISTRY ────────────────────────────────────
const _deadChannels = new Map();
const DEAD_THRESHOLD = 3;
const DEAD_TTL_MS    = 30 * 60_000;

function isDead(name) {
  const e = _deadChannels.get(name);
  if (!e) return false;
  if (Date.now() > e.deadUntil) { _deadChannels.delete(name); return false; }
  return e.fails >= DEAD_THRESHOLD;
}
function registerFail(name) {
  const e = _deadChannels.get(name) ?? {fails:0,deadUntil:0};
  e.fails++;
  if (e.fails >= DEAD_THRESHOLD) {
    e.deadUntil = Date.now() + DEAD_TTL_MS;
    console.warn(`[TurboTX] dead: ${name}`);
  }
  _deadChannels.set(name, e);
}
function registerChannelOk(name) { _deadChannels.delete(name); }

// ─── ② CIRCUIT BREAKER ───────────────────────────────────────
// CLOSED  → работает нормально
// OPEN    → выключен на OPEN_TTL (2 часа), не тратим время
// HALF_OPEN → пробуем 1 запрос: ok → CLOSED, fail → OPEN снова
//
// Триггер: 5 провалов за последние 10 минут → OPEN
const _cb = new Map(); // name → { state, fails, windowStart, openUntil, halfOpenAt }
const CB_FAIL_THRESHOLD = 5;
const CB_FAIL_WINDOW    = 10 * 60_000;   // 10 мин наблюдения
const CB_OPEN_TTL       = 2 * 3_600_000; // 2 часа в OPEN
const CB_HALF_OPEN_WAIT = 5 * 60_000;    // 5 мин до пробного запроса

function cbGet(name) {
  return _cb.get(name) ?? { state:'CLOSED', fails:0, windowStart:Date.now(), openUntil:0, halfOpenAt:0 };
}

function cbIsBlocked(name) {
  const e = cbGet(name);
  const now = Date.now();
  if (e.state === 'CLOSED') return false;
  if (e.state === 'OPEN') {
    if (now >= e.openUntil) {
      // Переходим в HALF_OPEN — дадим один шанс
      _cb.set(name, { ...e, state:'HALF_OPEN', halfOpenAt:now });
      return false; // пускаем один запрос
    }
    return true; // ещё заблокирован
  }
  if (e.state === 'HALF_OPEN') {
    // Только один запрос одновременно в HALF_OPEN
    return false;
  }
  return false;
}

function cbOnSuccess(name) {
  const e = cbGet(name);
  if (e.state === 'HALF_OPEN') {
    // Успех в HALF_OPEN → восстанавливаем
    _cb.set(name, { state:'CLOSED', fails:0, windowStart:Date.now(), openUntil:0, halfOpenAt:0 });
    console.log(`[CB] ${name} HALF_OPEN→CLOSED (восстановлен)`);
  } else if (e.state === 'CLOSED') {
    // Сброс счётчика окна при успехе
    if (e.fails > 0) _cb.set(name, { ...e, fails:0, windowStart:Date.now() });
  }
}

function cbOnFail(name) {
  const e = cbGet(name);
  const now = Date.now();
  if (e.state === 'HALF_OPEN') {
    // Провал в HALF_OPEN → снова OPEN
    _cb.set(name, { ...e, state:'OPEN', openUntil:now+CB_OPEN_TTL });
    console.warn(`[CB] ${name} HALF_OPEN→OPEN (провал)`);
    return;
  }
  if (e.state === 'OPEN') return; // уже открыт
  // CLOSED — считаем провалы в окне
  let { fails, windowStart } = e;
  if (now - windowStart > CB_FAIL_WINDOW) {
    // Новое окно
    fails = 1; windowStart = now;
  } else {
    fails++;
  }
  if (fails >= CB_FAIL_THRESHOLD) {
    _cb.set(name, { state:'OPEN', fails, windowStart, openUntil:now+CB_OPEN_TTL, halfOpenAt:0 });
    console.warn(`[CB] ${name} CLOSED→OPEN (${fails} провалов за ${CB_FAIL_WINDOW/60_000}мин)`);
  } else {
    _cb.set(name, { ...e, fails, windowStart });
  }
}


// ─── PING CACHE ───────────────────────────────────────────────
const _pingCache = new Map();
const PING_TTL   = 10 * 60_000;

function getCachedPing(name) {
  const e = _pingCache.get(name);
  return (e && Date.now()-e.updatedAt < PING_TTL) ? e.ms : null;
}
function setPing(name, ms) { _pingCache.set(name,{ms,updatedAt:Date.now()}); }

// ─── ④ АДАПТИВНЫЙ ТАЙМАУТ (узел vs пул + история пинга) ──────
// Узлы: base 5с (они быстрые)
// Пулы: base 15с (они медленные, нельзя обрезать)
const TIMEOUT_NODE_BASE = 5_000;
const TIMEOUT_POOL_BASE = 15_000;
const TIMEOUT_MULT      = 3.0;
const TIMEOUT_CAP       = 20_000;

function adaptiveTimeout(name, tier='node') {
  const base = tier === 'node' ? TIMEOUT_NODE_BASE : TIMEOUT_POOL_BASE;
  const ping = getCachedPing(name) ?? avgResponseMs(name);
  if (!ping || ping >= 5000) return tier === 'node' ? 8_000 : TIMEOUT_CAP;
  return Math.min(TIMEOUT_CAP, Math.max(base, Math.round(ping * TIMEOUT_MULT)));
}

async function ftr(url, opts={}, ms=13000, tries=2, chName='', tier='node') {
  const timeout = chName ? adaptiveTimeout(chName, tier) : ms;
  for (let i=0; i<=tries; i++) {
    try {
      const r = await ft(url, opts, timeout);

      // Читаем Vercel error code из заголовка (есть только у Vercel-хостед пулов)
      const vercelCode = r.headers?.get?.('x-vercel-error') || '';
      const cls = classifyError(r.status, '', vercelCode);

      if (cls === 'rate_limit') {
        registerHit(chName||url);
        return r; // не ретраим 429
      }
      if (cls === 'skip') {
        // 504/508/throttle — не ретраим, сразу возвращаем
        setNegCache(chName||url);
        return r;
      }
      if (cls === 'permanent') {
        return r; // не ретраим permanent ошибки
      }
      if ((cls === 'retry_now' || cls === 'retry_later') && i < tries) {
        const delay = cls === 'retry_now' ? 200 : 800 * (i+1); // retry_now быстро
        await sleep(delay);
        continue;
      }
      if (cls === 'retry_later' && i === tries) {
        setNegCache(chName||url); // исчерпали попытки — neg cache
      }
      if (r.ok || cls === 'ok' || cls === 'accepted') registerSuccess(chName||url);
      return r;
    } catch(e) {
      if (i===tries) throw e;
      await sleep(300*(i+1));
    }
  }
}

// ─── PING URL MAP ─────────────────────────────────────────────
const PING_URLS = {
  'mempool.space':   'https://mempool.space/api/blocks/tip/height',
  'blockstream.info':'https://blockstream.info/api/blocks/tip/height',
  'blockchair':      'https://api.blockchair.com/bitcoin/stats',
  'blockcypher':     'https://api.blockcypher.com/v1/btc/main',
  'btcscan.org':     'https://btcscan.org/api/blocks/tip/height',
  'blockchain.info': 'https://blockchain.info/latestblock',
  'bitaps.com':      'https://bitaps.com/api/bitcoin/blockcount',
  'sochain.com':     'https://sochain.com/api/v2/get_info/BTC',
  'Foundry':    'https://foundryusapool.com/',  'AntPool':   'https://www.antpool.com/',
  'MARA':       'https://mara.com/',            'ViaBTC':    'https://viabtc.com/',
  'SpiderPool': 'https://www.spiderpool.com/',  'F2Pool':    'https://www.f2pool.com/',
  'Luxor':      'https://luxor.tech/',          'CloverPool':'https://clvpool.com/',
  'BitFuFu':    'https://www.bitfufu.com/',     'BTC.com':   'https://btc.com/',
  'Ocean':       'https://ocean.xyz/',
  'TxBoost':    'https://txboost.com/',         'mempoolAccel':'https://mempool.space/',
  'bitaccelerate':'https://www.bitaccelerate.com/', '360btc':'https://360btc.net/',
  'txfaster':   'https://txfaster.com/',        'btcspeed':  'https://btcspeed.org/',
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

// ─── HASHRATE TABLE Q1 2026 ───────────────────────────────────
// Источник: mempool.space/mining — обновлено март 2026
// SBI Crypto и Ocean добавлены как растущие пулы
const HR = {
  Foundry:27, AntPool:16, MARA:11, ViaBTC:9, SpiderPool:8,
  F2Pool:7, Luxor:5, CloverPool:4, BitFuFu:4, 'BTC.com':3,
  Ocean:2, TxBoost:2, mempoolAccel:1, bitaccelerate:1, '360btc':1, txfaster:1, btcspeed:1,
};

// ─── ⑥ ГЕО-ГРУППЫ ПУЛОВ ──────────────────────────────────────
// USA: Foundry, MARA, Luxor, TxBoost
// ASIA: AntPool, ViaBTC, SpiderPool, F2Pool, CloverPool, BTC.com, BitFuFu
// GLOBAL: mempoolAccel, bitaccelerate, 360btc, txfaster, btcspeed
// При сортировке по пингу это автоматически всплывает — 
// Vercel us-east-1 будет ближе к USA пулам.
// Метка используется для логирования и будущего geo-routing.
const POOL_GEO = {
  Foundry:'usa', MARA:'usa', Luxor:'usa', TxBoost:'usa', Ocean:'usa',
  AntPool:'asia', ViaBTC:'asia', SpiderPool:'asia', F2Pool:'asia',
  CloverPool:'asia', 'BTC.com':'asia', BitFuFu:'asia',
  mempoolAccel:'global', bitaccelerate:'global', '360btc':'global',
  txfaster:'global', btcspeed:'global',
};

// ─── ② СОРТИРОВКА КАНАЛОВ (score + ping + hashrate) ──────────
// priority = 0.5×reliability − 0.3×normPing + 0.2×normHashrate
// Foundry (27%) идёт раньше btcspeed (1%) при равном пинге
function channelPriority(name, pingMs) {
  const score    = reliabilityScore(name);
  const normPing = Math.min(pingMs, 5000) / 5000;
  const normHr   = (HR[name] || 0) / 27; // нормируем по Foundry (max ~27%)
  return 0.5 * score - 0.3 * normPing + 0.2 * normHr;
}

// ─── RUN — умный запуск каналов ──────────────────────────────
async function run(channels, feeRatioHint = 0.5) {
  if (channels.length === 0) return [];

  // Пинг только для каналов у которых кэш протух (>10 мин) или не было вообще
  // Если кэш свежий — стартуем НЕМЕДЛЕННО без задержки на пинг
  const needPing = channels.filter(ch => getCachedPing(ch.name) === null);
  const hasFreshCache = needPing.length < channels.length * 0.5; // >50% с кэшем — пропускаем пинг

  let pingsMap = new Map(channels.map(ch => [ch.name, getCachedPing(ch.name) ?? 9999]));

  if (!hasFreshCache && needPing.length > 0) {
    // Пингуем только те что нужно, параллельно
    const freshPings = await Promise.allSettled(
      needPing.map(ch => pingChannel(ch.name).then(ms => ({name: ch.name, ms})))
    );
    for (const r of freshPings)
      if (r.status === 'fulfilled') pingsMap.set(r.value.name, r.value.ms);
  }

  const pings = channels.map(ch => ({ ch, ms: pingsMap.get(ch.name) ?? 9999 }));

  // ② Сортируем по приоритету (score + ping), узлы перед пулами
  pings.sort((a,b) => {
    if (a.ch.tier !== b.ch.tier) return a.ch.tier==='node' ? -1 : 1;
    return channelPriority(b.ch.name, b.ms) - channelPriority(a.ch.name, a.ms);
  });

  const sorted = pings.map(p => p.ch);

  // ④ Разделяем узлы и пулы — у них разные таймауты
  // Узлы: волна сразу (быстрые, 5с таймаут)
  // Пулы: +100мс задержка, потом волнами по 8 (15с таймаут)
  const WAVE_SIZE  = 8;
  const WAVE_DELAY = [0, 150, 400];
  const results    = new Array(sorted.length).fill(null);
  let okCount = 0;
  let attemptCount = 0;
  const activeChannels = sorted.filter(ch =>
    !isDead(ch.name) && !cbIsBlocked(ch.name) && !isCooling(ch.name) && !isNegCached(ch.name)
  );
  // Агрессивная стратегия (ratio < 0.4) — ждём 85% каналов, не останавливаемся рано
  // Лёгкая стратегия (ratio >= 0.8) — 50% достаточно
  const stopRatio  = (feeRatioHint < 0.4) ? 0.85 : (feeRatioHint >= 0.8) ? 0.50 : 0.65;
  const EARLY_STOP = Math.max(3, Math.ceil(activeChannels.length * stopRatio));

  await new Promise(resolve => {
    let finished = 0, aborted = false;

    const launchWave = (waveChannels, waveIdx) => {
      waveChannels.forEach((ch, i) => {
        const globalIdx = waveIdx * WAVE_SIZE + i;

        // Пропускаем заблокированные каналы
        if (isDead(ch.name)) {
          results[globalIdx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, reason:'dead', ms:0};
          if (++finished===sorted.length) resolve(); return;
        }
        if (cbIsBlocked(ch.name)) {  // ② Circuit breaker
          results[globalIdx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, reason:'circuit_open', ms:0};
          if (++finished===sorted.length) resolve(); return;
        }
        if (isCooling(ch.name)) {
          const e=_cooldown.get(ch.name);
          const mins=Math.ceil((e.until-Date.now())/60_000);
          results[globalIdx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, reason:'rate_limited', cooldownMins:mins, ms:0};
          if (++finished===sorted.length) resolve(); return;
        }
        if (isNegCached(ch.name)) { // ⑤
          results[globalIdx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, reason:'neg_cached', ms:0};
          if (++finished===sorted.length) resolve(); return;
        }
        if (aborted) {
          results[globalIdx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, ms:0};
          if (++finished===sorted.length) resolve(); return;
        }

        const t0 = Date.now();
        attemptCount++;
        ch.call().then(r => {
          const ms  = Date.now()-t0;
          const vercelCode = r.ve || '';  // ← канал передаёт ve из Response заголовка
          const cls = classifyError(r.status, '', vercelCode);
          const isOk = r.ok || cls==='accepted';

          // ① Статистика надёжности
          recordStat(ch.name, isOk, ms);
          setPing(ch.name, ms);

          if (cls==='rate_limit')  registerHit(ch.name);
          else if (isOk)         { registerChannelOk(ch.name); registerSuccess(ch.name); cbOnSuccess(ch.name); }
          else if (cls==='skip') { registerFail(ch.name); setNegCache(ch.name); cbOnFail(ch.name); }
          else if (cls==='retry_later') { registerFail(ch.name); setNegCache(ch.name); cbOnFail(ch.name); }
          else if (cls==='retry_now')   { registerFail(ch.name); cbOnFail(ch.name); }

          results[globalIdx] = {
            channel:ch.name, tier:ch.tier, ok:isOk, ms,
            score: +reliabilityScore(ch.name).toFixed(2),
            geo: POOL_GEO[ch.name] || (ch.tier==='node'?'node':null),
            ...(vercelCode ? {vercelError:vercelCode} : {}),
            ...(cls!=='ok'&&!isOk ? {reason:cls} : {}),
          };
          if (isOk) okCount++;
          if (++finished===sorted.length) resolve();
          if (!aborted && okCount >= EARLY_STOP) aborted = true;
        }).catch(e => {
          const ms = Date.now()-t0;
          const isAbort = e.name==='AbortError';
          recordStat(ch.name, false, ms);
          // AbortError = наш таймаут → skip (не засоряем dead counter)
          // Сетевая ошибка → retry_now → registerFail
          if (!isAbort) { registerFail(ch.name); cbOnFail(ch.name); }
          results[globalIdx] = {
            channel:ch.name, tier:ch.tier, ok:false,
            error:e.message, reason: isAbort ? 'skip' : 'retry_now', ms,
          };
          if (++finished===sorted.length) resolve();
        });
      });
    };

    for (let w=0; w<Math.ceil(sorted.length/WAVE_SIZE); w++) {
      const wave  = sorted.slice(w*WAVE_SIZE, (w+1)*WAVE_SIZE);
      const delay = WAVE_DELAY[w] ?? 400+w*150;
      if (delay===0) {
        launchWave(wave, w);
      } else {
        setTimeout(()=>{
          if (!aborted) launchWave(wave, w);
          else {
            wave.forEach((ch,i)=>{
              const idx = w*WAVE_SIZE+i;
              results[idx] = {channel:ch.name, tier:ch.tier, ok:false, skipped:true, ms:0};
              if (++finished===sorted.length) resolve();
            });
          }
        }, delay);
      }
    }
  });

  return results.filter(Boolean);
}

// ─── ⑥ GET HEX — двухуровневый запуск ───────────────────────
// Уровень 1: топ-3 источника по истории скорости — стартуют немедленно
// Уровень 2: оставшиеся 5 — стартуют через 1с если топ-3 не ответили
// Экономим полосу и время — в 80% случаев топ-3 достаточно
const HEX_RE = /^[0-9a-fA-F]{200,}$/;

async function getHex(txid) {
  const SOURCES = [
    { name:'mempool.space',   url:`https://mempool.space/api/tx/${txid}/hex`,                            t:'text' },
    { name:'blockstream.info',url:`https://blockstream.info/api/tx/${txid}/hex`,                         t:'text' },
    { name:'btcscan.org',     url:`https://btcscan.org/api/tx/${txid}/raw`,                              t:'text' },
    { name:'blockchain.info', url:`https://blockchain.info/rawtx/${txid}?format=hex`,                    t:'text' },
    { name:'blockchair',      url:`https://api.blockchair.com/bitcoin/raw/transaction/${txid}`,          t:'json', p:['data',txid,'raw_transaction'] },
    { name:'blockcypher',     url:`https://api.blockcypher.com/v1/btc/main/txs/${txid}?includeHex=true`, t:'json', p:['hex'] },
    { name:'btc.com',         url:`https://chain.api.btc.com/v3/tx/${txid}`,                             t:'json', p:['data','raw_hex'] },
    { name:'sochain.com',     url:`https://sochain.com/api/v2/get_tx/BTC/${txid}`,                       t:'json', p:['data','tx_hex'] },
  ];

  // Сортируем по истории скорости
  SOURCES.sort((a,b) => avgResponseMs(a.name) - avgResponseMs(b.name));

  // Топ-3 стартуют сразу, остальные через 1с (tiered fetch)
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
            res(h);
          }
        })
        .catch(() => {})
        .finally(() => { if (++done === total && !found) res(null); });
    };

    // Уровень 1: топ-3 сразу
    TOP.forEach(trySource);

    // Уровень 2: остальные через 1с если топ-3 не ответили
    const fallbackTimer = setTimeout(() => {
      if (!found) BOTTOM.forEach(trySource);
      else total = done + BOTTOM.length; // корректируем счётчик — они не запустятся
    }, 1000);

    // Если нашли раньше — очищаем таймер
    ac.signal.addEventListener('abort', () => clearTimeout(fallbackTimer), {once:true});
  });
}

// ─── АНАЛИЗ TX ────────────────────────────────────────────────
// Параллельный запрос mempool.space + blockstream fallback
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
    const vsize      = tx.weight ? Math.ceil(tx.weight/4) : (tx.size||250);
    const feePaid    = tx.fee||0;
    const feeRate    = feePaid&&vsize ? Math.round(feePaid/vsize) : 0;
    const fastest    = fees.fastestFee  || 50;
    const halfHour   = fees.halfHourFee || 30;
    const hour       = fees.hourFee     || 20;
    const economy    = fees.economyFee  || fees.minimumFee || 5;
    const needCpfp   = feeRate>0 && feeRate<fastest*0.5;
    const rbfEnabled = Array.isArray(tx.vin) && tx.vin.some(i=>i.sequence<=0xFFFFFFFD);
    const feeRatio   = fastest>0 ? +(feeRate/fastest).toFixed(3) : 0;
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
    };
  } catch { return null; }
}

// ─── ③ АДАПТИВНОЕ КОЛ-ВО ВОЛН ────────────────────────────────
// feeRatio = txFeeRate / networkFastest
// ratio >= 0.8 → 3 волны (TX хорошая, мало нужно)
// ratio 0.4-0.8 → 5 волн (стандарт)
// ratio < 0.4 → 8 волн с интервалом 10мин (агрессивно)
function calcWaveStrategy(feeRate, fastest) {
  if (!feeRate || !fastest) return { waves:5, intervalMs:15*60_000, label:'default' };
  const ratio = feeRate/fastest;
  if (ratio >= 0.8) return { waves:3, intervalMs:20*60_000, label:'easy'       };
  if (ratio >= 0.4) return { waves:5, intervalMs:15*60_000, label:'standard'   };
  return              { waves:8, intervalMs:10*60_000, label:'aggressive' };
}

// ─── TXID-ONLY ПУЛЫ — работают без hex ───────────────────────
// Некоторые акселераторы принимают просто txid и сами достают hex
// Используем если hex не нашли — хоть что-то лучше чем ничего
function txidOnlyChannels(txid) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
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

// ─── КАНАЛЫ ───────────────────────────────────────────────────
function freeChannels(hex) {
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
  ];
}

function premiumChannels(txid, hex) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  const nodes = hex ? [
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
    { name:'blockcypher', tier:'node', call: async()=>{
      const r=await ftr('https://api.blockcypher.com/v1/btc/main/txs/push',{method:'POST',body:JSON.stringify({tx:hex}),headers:{'Content-Type':'application/json'}},12000,2,'blockcypher','node');
      const j=await safeJson(r);
      return {ok:r.status===201||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'btcscan.org', tier:'node', call: async()=>{
      const r=await ftr('https://btcscan.org/api/tx/push',{method:'POST',body:hex,headers:{'Content-Type':'text/plain'}},10000,2,'btcscan.org','node');
      return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'blockchain.info', tier:'node', call: async()=>{
      const r=await ftr('https://blockchain.info/pushtx',{method:'POST',body:`tx=${hex}`,headers:{'Content-Type':'application/x-www-form-urlencoded'}},12000,2,'blockchain.info','node');
      return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'bitaps.com', tier:'node', call: async()=>{
      const r=await ftr('https://bitaps.com/api/bitcoin/push/transaction',{method:'POST',body:hex,headers:{'Content-Type':'text/plain'}},10000,2,'bitaps.com','node');
      return {ok:r.ok, status:r.status, ve:ve(r)};
    }},
    { name:'sochain.com', tier:'node', call: async()=>{
      const r=await ftr('https://sochain.com/api/v2/send_tx/BTC',{method:'POST',body:JSON.stringify({tx_hex:hex}),headers:{'Content-Type':'application/json'}},10000,2,'sochain.com','node');
      const j=await safeJson(r);
      return {ok:j?.status==='success'||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
    }},
  ] : [];

  const pools = [
    { name:'Foundry', tier:'pool', call: async()=>{
      const r=await ftr('https://foundryusapool.com/accelerate',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},14000,2,'Foundry','pool');
      return {ok:r.ok||ok400(await safeText(r),r.status), status:r.status, ve:ve(r)};
    }},
    { name:'AntPool', tier:'pool', call: async()=>{
      try {
        const r=await ft('https://www.antpool.com/api/v1/tools/tx-accelerate',{method:'POST',body:JSON.stringify({txHash:txid}),headers:{'Content-Type':'application/json','User-Agent':UA,'Referer':'https://www.antpool.com/'}},12000);
        const j=await safeJson(r); if(r.ok||j?.code===0) return {ok:true,status:r.status};
      } catch(_){}
      const r2=await ftr('https://antpool.com/txAccelerate.htm',{method:'POST',body:`txHash=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},12000,2,'AntPool','pool');
      const t2=await safeText(r2);
      return {ok:r2.ok||t2.includes('success')||ok400(t2,r2.status), status:r2.status, ve:ve(r2)};
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
      } catch(_){}
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
    { name:'mempoolAccel', tier:'pool', call: async()=>{
      const r=await ftr('https://mempool.space/api/v1/tx-accelerator/enqueue',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'mempoolAccel','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.message==='Success', status:r.status, ve:ve(r)};
    }},
    { name:'TxBoost', tier:'pool', call: async()=>{
      const r=await ftr('https://txboost.com/',{method:'POST',body:`txid=${txid}`,headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA}},12000,2,'TxBoost','pool');
      const t=await safeText(r);
      return {ok:r.ok||t.includes('success'), status:r.status, ve:ve(r)};
    }},
    { name:'Ocean', tier:'pool', call: async()=>{
      // Ocean.xyz — decentralised pool, growing in 2026
      const r=await ftr('https://ocean.xyz/api/accelerate',{method:'POST',body:JSON.stringify({txid}),headers:{'Content-Type':'application/json','User-Agent':UA}},12000,2,'Ocean','pool');
      const j=await safeJson(r);
      return {ok:r.ok||j?.success===true||ok400(JSON.stringify(j),r.status), status:r.status, ve:ve(r)};
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

// ─── BOOTSTRAP ────────────────────────────────────────────────
let _healthBootstrapped = false;
// Periodic cleanup of stale confirmed entries
setInterval(() => {
  const cutoff = Date.now() - CONFIRMED_TTL;
  for (const [k, v] of _confirmed) if (v < cutoff) _confirmed.delete(k);
}, 3_600_000); // every hour

// ─── ГЛОБАЛЬНАЯ ОЧИСТКА ПАМЯТИ ────────────────────────────────
// Vercel инстанс живёт часами — без чистки Maps растут вечно
// Запускаем каждые 30 мин: удаляем просроченные записи
setInterval(() => {
  const now = Date.now();
  // txidMap: записи старше 3 часов
  for (const [k, v] of _txidMap)
    if (now - v.lastSeen > 3 * 3_600_000) _txidMap.delete(k);
  // cooldown: истёкшие
  for (const [k, v] of _cooldown)
    if (v.until < now) _cooldown.delete(k);
  // negCache: истёкшие
  for (const [k, v] of _negCache)
    if (v < now) _negCache.delete(k);
  // pingCache: старше 20 мин
  for (const [k, v] of _pingCache)
    if (now - v.updatedAt > 20 * 60_000) _pingCache.delete(k);
  // stats: если канал мёртв давно (>24ч без вызовов) — сбрасываем счётчики
  for (const [k, v] of _stats)
    if (v.calls > 0 && !PING_URLS[k]) _stats.delete(k);
  // circuit breaker: CLOSED записи с нулевыми провалами
  for (const [k, v] of _cb)
    if (v.state === 'CLOSED' && v.fails === 0) _cb.delete(k);
}, 30 * 60_000);
function siteBase() {
  return process.env.PRODUCTION_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}

async function bootstrapFromHealth() {
  if (_healthBootstrapped) return;
  _healthBootstrapped = true;
  try {
    const base = siteBase();
    const r = await fetch(`${base}/api/health?verbose=1`, {signal:AbortSignal.timeout(8000)});
    if (!r.ok) return;
    const data = await r.json();
    (data.channels||[]).forEach(ch=>{
      if (!ch.ok && ch.ms>=3000) _deadChannels.set(ch.name,{fails:1,deadUntil:0});
      if (ch.ms>0&&ch.ms<3000) setPing(ch.name, ch.ms);
    });
    console.log(`[TurboTX] bootstrap: ${(data.channels||[]).length} каналов`);
  } catch(_){}
}

// ─── TELEGRAM ─────────────────────────────────────────────────
async function tg({results,txid,plan,analysis,ms,hr,ip,blocked,waveStrategy}) {
  const token=process.env.TG_TOKEN, chat=process.env.TG_CHAT_ID;
  if (!token||!chat) return;
  let text;
  if (blocked) {
    text=[`🛡 *TurboTX BLOCKED*`,`📋 \`${txid?.slice(0,14)||'???'}\``,`🚫 ${blocked}`,`🌐 \`${ip}\``,
      `🕐 ${new Date().toLocaleString('ru',{timeZone:'Europe/Moscow'})} МСК`].join('\n');
  } else {
    const ok=results.filter(r=>r.ok).length, tot=results.length;
    const pct=tot?Math.round(ok/tot*100):0;
    const filled=Math.round(pct/10);
    const bar='█'.repeat(filled)+'░'.repeat(10-filled);

    // Топ успешных пулов с hashrate
    const okPools = results
      .filter(r=>r.tier==='pool'&&r.ok)
      .sort((a,b)=>(HR[b.channel||b.name]||0)-(HR[a.channel||a.name]||0))
      .slice(0,5)
      .map(r=>`${r.channel||r.name}(${HR[r.channel||r.name]||'?'}%)`);

    const okNodes = results.filter(r=>r.tier==='node'&&r.ok).map(r=>r.channel||r.name);

    const feeInfo = analysis
      ? `${analysis.vsize}vB · ${analysis.feeRate}→${analysis.fastest} sat/vB (${Math.round((analysis.feeRatio||0)*100)}%)`
      : '';

    text=[
      `⚡ *TurboTX v10 — ${plan.toUpperCase()}*`,
      `📋 \`${txid.slice(0,14)}…${txid.slice(-6)}\` · \`${ip}\``,
      `⏱ ${ms}ms · \`${bar}\` ${pct}% (${ok}/${tot})`,
      hr>0 ? `⛏ ~${hr}% hashrate охвачено` : '',
      okNodes.length ? `🔗 Ноды: ${okNodes.join(', ')}` : '',
      okPools.length ? `🏊 Пулы: ${okPools.join(', ')}` : '',
      feeInfo ? `📐 ${feeInfo}${analysis.needCpfp?' ⚠️CPFP':' ✅'}${analysis.rbfEnabled?' 🔄RBF':''}` : '',
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

// ─── MAIN ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method==='OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v));
  if (req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});

  bootstrapFromHealth().catch(()=>{});

  const ip = getIp(req);
  if (isBot(req)) { tg({txid:'?',plan:'?',ip,blocked:'bot_ua'}).catch(()=>{}); return res.status(403).json({ok:false,error:'Forbidden'}); }

  const body = req.body || {};
  const effectivePlan = ['free','premium'].includes(body.plan) ? body.plan : 'free';

  // ── Авторизация Premium ──
  if (effectivePlan==='premium') {
    const secret=process.env.PREMIUM_SECRET, token=req.headers['x-turbotx-token']||body.token;
    if (secret&&token!==secret) return res.status(401).json({ok:false,error:'Invalid premium token'});
  }

  // ── Определяем режим: одиночный или batch ──
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
  const [hexRes, analysisRes] = await Promise.allSettled([
    hexIn&&HEX_RE.test(hexIn) ? Promise.resolve(hexIn) : getHex(txid),
    analyze(txid),
  ]);
  let hex      = hexRes.status==='fulfilled' ? hexRes.value : null;
  const analysis = analysisRes.status==='fulfilled' ? analysisRes.value : null;

  if (!hex && effectivePlan==='premium') {
    await sleep(3000);
    hex = await getHex(txid).catch(()=>null);
  }

  if (analysis?.confirmed) { setConfirmed(txid); return res.status(200).json({ok:true,confirmed:true,analysis}); }
  if (effectivePlan==='free'&&!hex) return res.status(200).json({ok:false,error:'TX hex not found.',analysis});

  const waveStrategy = calcWaveStrategy(analysis?.feeRate, analysis?.fastest);

  let channels;
  if (effectivePlan==='premium') {
    channels = hex ? premiumChannels(txid,hex) : txidOnlyChannels(txid);
  } else {
    channels = freeChannels(hex);
  }
  const results = await run(channels, analysis?.feeRatio ?? 0.5);
  const ms      = Date.now()-t0;

  const hr = effectivePlan==='premium'
    ? results.filter(r=>r.ok&&r.tier==='pool').reduce((s,r)=>s+(HR[r.name||r.channel]||0),0) : 0;
  const okCount = results.filter(r=>r.ok).length;

  const summary = {
    total:results.length, ok:okCount, failed:results.length-okCount,
    hexFound:!!hex, ms, plan:effectivePlan, hashrateReach:hr,
    feeRate:       analysis?.feeRate    ?? null,
    feeRatio:      analysis?.feeRatio   ?? null,
    needCpfp:      analysis?.needCpfp   ?? false,
    cpfpFeeNeeded: analysis?.cpfpFeeNeeded ?? 0,
    rbfEnabled:    analysis?.rbfEnabled ?? false,
    waveStrategy,
    totalChannels: 25, // 8 nodes + 17 pools
    circuitBreakers: (() => {
      const open=[], halfOpen=[];
      for (const [name,e] of _cb) {
        if (e.state==='OPEN')      open.push(name);
        if (e.state==='HALF_OPEN') halfOpen.push(name);
      }
      return open.length+halfOpen.length>0 ? {open,halfOpen} : undefined;
    })(),
  };

  tg({results,txid,plan:effectivePlan,analysis,ms,hr,ip,waveStrategy}).catch(()=>{});

  return res.status(200).json({
    ok: okCount>0, results, summary, analysis, waveStrategy,
    ...(effectivePlan==='premium' ? {jobId:`${txid.slice(0,8)}_${Date.now()}`} : {}),
  });
}

// ─── BATCH HANDLER ────────────────────────────────────────────
// POST { txids: ['abc...', 'def...'], plan: 'premium' }
// Конкуренты этого не умеют — обрабатываем пачку транзакций параллельно
async function handleBatch(req, res, body, plan, ip) {
  const MAX_BATCH = plan==='premium' ? 20 : 5;
  const txids = (body.txids||[])
    .filter(t => typeof t==='string' && /^[a-fA-F0-9]{64}$/.test(t))
    .slice(0, MAX_BATCH);

  if (txids.length===0) return res.status(400).json({ok:false,error:'No valid TXIDs in batch'});

  const t0 = Date.now();

  // Обрабатываем параллельно, но делим каналы — не перегружаем пулы
  // Free: каждый TXID получает 3 канала
  // Premium: первые 3 TXID — полный набор, остальные — txidOnly
  const batchResults = await Promise.allSettled(
    txids.map(async (txid, idx) => {
      if (isConfirmed(txid)) return { txid, ok:true, confirmed:true, cached:true };

      const rl = checkLimits(ip, txid, plan);
      if (!rl.ok) return { txid, ok:false, rateLimited:true, retryAfter:rl.retryAfter };

      const [hexRes, analysisRes] = await Promise.allSettled([
        getHex(txid),
        analyze(txid),
      ]);
      const hex      = hexRes.status==='fulfilled' ? hexRes.value : null;
      const analysis = analysisRes.status==='fulfilled' ? analysisRes.value : null;

      if (analysis?.confirmed) { setConfirmed(txid); return {txid,ok:true,confirmed:true,analysis}; }

      let channels;
      if (plan==='premium') {
        // Первые 3 получают полный набор, остальные — txidOnly (экономим ресурсы)
        channels = idx < 3
          ? (hex ? premiumChannels(txid,hex) : txidOnlyChannels(txid))
          : txidOnlyChannels(txid);
      } else {
        if (!hex) return {txid,ok:false,error:'hex not found',analysis};
        channels = freeChannels(hex);
      }

      const results = await run(channels, analysis?.feeRatio ?? 0.5);
      const okCount = results.filter(r=>r.ok).length;
      const hr = plan==='premium'
        ? results.filter(r=>r.ok&&r.tier==='pool').reduce((s,r)=>s+(HR[r.name||r.channel]||0),0) : 0;

      return { txid, ok:okCount>0, okCount, hexFound:!!hex, hashrateReach:hr, analysis };
    })
  );

  const items = batchResults.map((r,i) =>
    r.status==='fulfilled' ? r.value : {txid:txids[i], ok:false, error:r.reason?.message}
  );
  const successCount = items.filter(i=>i.ok).length;

  return res.status(200).json({
    ok:   successCount>0,
    batch: true,
    total: items.length,
    succeeded: successCount,
    failed: items.length - successCount,
    ms: Date.now()-t0,
    plan,
    items,
  });
}
