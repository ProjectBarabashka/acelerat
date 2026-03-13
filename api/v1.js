// ══════════════════════════════════════════════════════════════
//  TurboTX PUBLIC API v1  —  /api/v1.js
//  Vercel Serverless · Node.js 20
//
//  Единый публичный endpoint для партнёров и интеграторов.
//  Аутентификация: Bearer API key в заголовке Authorization
//                  или query param ?apikey=ttx_...
//
//  Endpoints (через query ?method=...):
//    GET  /api/v1?method=status&txid=<64hex>        — статус TX
//    GET  /api/v1?method=mempool                    — состояние сети
//    GET  /api/v1?method=fees                       — рекомендуемые fee
//    GET  /api/v1?method=price                      — цена ускорения
//    GET  /api/v1?method=acceleration&txid=<64hex>  — умный советник
//    POST /api/v1?method=accelerate                 — отправить TX на ускорение
//    GET  /api/v1?method=health                     — здоровье сервиса
//    GET  /api/v1?method=ping                       — проверка ключа
//
//  Rate limits по тарифу:
//    free:    30 req/мин, 500 req/день
//    basic:   100 req/мин, 5000 req/день
//    pro:     500 req/мин, 50000 req/день
//    partner: unlimited
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 30 };

import { CORS_API as CORS, ft, getIp, sj } from './_shared.js';

// ─── API KEY STORE (env-driven) ────────────────────────────────
// В продакшне замените на KV / Firebase / Postgres
// ENV: TURBOTX_API_KEYS=ttx_live_xxx:pro:PartnerName,ttx_live_yyy:basic:DevName
function loadApiKeys() {
  const raw = process.env.TURBOTX_API_KEYS || '';
  const map = new Map();
  // Системный ключ для тестов из env
  const testKey = process.env.TURBOTX_TEST_KEY;
  if (testKey) map.set(testKey, { tier: 'pro', name: 'Internal', createdAt: Date.now() });

  raw.split(',').forEach(entry => {
    const [key, tier, name] = entry.trim().split(':');
    if (key && key.startsWith('ttx_')) {
      map.set(key, { tier: tier || 'basic', name: name || 'Partner', createdAt: Date.now() });
    }
  });
  return map;
}

const API_KEYS = loadApiKeys();

const TIER_LIMITS = {
  free:    { perMin: 30,  perDay: 500   },
  basic:   { perMin: 100, perDay: 5000  },
  pro:     { perMin: 500, perDay: 50000 },
  partner: { perMin: Infinity, perDay: Infinity },
};

// ─── IN-MEMORY RATE LIMITER ────────────────────────────────────
const _rl = new Map();
function checkRateLimit(apiKey, tier) {
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.free;
  const now = Date.now();
  const minKey = `${apiKey}:min:${Math.floor(now / 60000)}`;
  const dayKey = `${apiKey}:day:${Math.floor(now / 86400000)}`;

  // Cleanup
  if (_rl.size > 10000) {
    for (const [k, v] of _rl) if (v.expires < now) _rl.delete(k);
  }

  let min = _rl.get(minKey) || { count: 0, expires: now + 60000 };
  let day = _rl.get(dayKey) || { count: 0, expires: now + 86400000 };

  if (min.count >= limits.perMin) return { ok: false, reason: 'per_minute', limit: limits.perMin, reset: min.expires };
  if (day.count >= limits.perDay) return { ok: false, reason: 'per_day',    limit: limits.perDay, reset: day.expires };

  min.count++; day.count++;
  _rl.set(minKey, min);
  _rl.set(dayKey, day);

  return {
    ok: true,
    remaining: { perMin: limits.perMin - min.count, perDay: limits.perDay - day.count },
    limits,
  };
}

// ─── AUTH ──────────────────────────────────────────────────────
function authenticate(req) {
  // Priority: Authorization: Bearer ttx_... > X-API-Key > ?apikey=
  let key = null;

  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ttx_')) key = auth.slice(7);
  else if (req.headers['x-api-key']?.startsWith('ttx_')) key = req.headers['x-api-key'];
  else if (req.query?.apikey?.startsWith('ttx_')) key = req.query.apikey;

  if (!key) return { ok: false, error: 'API key required. Pass Authorization: Bearer ttx_...' };
  const info = API_KEYS.get(key);
  if (!info) return { ok: false, error: 'Invalid API key' };

  return { ok: true, key, ...info };
}

// ─── FETCH UTILS — из _shared.js ────────────────────────────

// ─── INTERNAL PROXY TO EXISTING ENDPOINTS ─────────────────────
// Переиспользуем логику из router.js / acceleration.js
// через internal Vercel reuse (no extra network hop on same instance)
async function callInternal(fn, params = {}) {
  const base = process.env.PRODUCTION_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  const qs = new URLSearchParams({ _fn: fn, ...params }).toString();
  try {
    const r = await ft(`${base}/api/router?${qs}`, {}, 15000);
    return r.ok ? await sj(r) : { ok: false, error: `Internal error: ${r.status}` };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

async function callAcceleration(txid) {
  const base = process.env.PRODUCTION_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  try {
    const r = await ft(`${base}/api/acceleration?txid=${txid}`, {}, 15000);
    return r.ok ? await sj(r) : { ok: false, error: `Acceleration error: ${r.status}` };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ─── ACCELERATE (POST /api/v1?method=accelerate) ──────────────
// Основной endpoint — отправить TX на ускорение через TurboTX
async function handleAccelerate(req, auth) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'POST required' } };

  const { txid, plan = 'free', webhookUrl } = req.body || {};
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return { status: 400, body: { ok: false, error: 'Invalid txid' } };

  // pro/partner тариф = premium план по умолчанию
  const effectivePlan = (auth.tier === 'pro' || auth.tier === 'partner') ? 'premium' : plan;

  const base = process.env.PRODUCTION_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  try {
    const r = await ft(`${base}/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TurboTX-Token': process.env.PREMIUM_SECRET || '',
        'X-API-Source': 'public_api_v1',
        'X-API-Key-Tier': auth.tier,
      },
      body: JSON.stringify({ txid, plan: effectivePlan, apiKey: auth.key }),
    }, 55000);

    const data = r.ok ? await sj(r) : { ok: false, error: `Broadcast error: ${r.status}` };

    // Уведомляем webhook если передан
    if (webhookUrl && data.ok) {
      ft(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'acceleration.started', txid, plan: effectivePlan, ...data }),
      }, 5000).catch(() => {});
    }

    return { status: 200, body: { ...data, plan: effectivePlan, apiVersion: 'v1' } };
  } catch(e) {
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

// ─── PING ─────────────────────────────────────────────────────
function handlePing(auth, rl) {
  return {
    status: 200,
    body: {
      ok: true,
      message: 'pong',
      apiVersion: 'v1',
      authenticated: true,
      keyInfo: { tier: auth.tier, name: auth.name },
      rateLimit: rl.limits,
      remaining: rl.remaining,
      timestamp: Date.now(),
    },
  };
}


// ══════════════════════════════════════════════════════════════
//  KEYS — API key management
//  Merged from /api/keys.js to save Vercel function slots
//  POST /api/v1?method=keys&action=create|list|revoke  (admin only)
// ══════════════════════════════════════════════════════════════
// In-memory store (дополняется поверх env-ключей)
const _dynamicKeys = new Map();

function generateKey(tier) {
  const prefix = tier === 'partner' ? 'ttx_partner_' : tier === 'pro' ? 'ttx_pro_' : 'ttx_live_';
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(20)))
    .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  return `${prefix}${rand}`;
}

function checkAdmin(req) {
  const secret = process.env.ADMIN_SECRET || process.env.PREMIUM_SECRET;
  const token = req.headers['x-admin-token'] || req.query?.adminToken;
  return secret && token === secret;
}

async function handleKeys(req, res) {
  if (!checkAdmin(req)) {
    return { status: 401, body: { ok: false, error: 'Unauthorized' } };
  }

  const action = req.query?.action || req.body?.action;

  if (action === 'create' || req.method === 'POST' && !action) {
    const { tier = 'basic', name = 'Partner', note = '', webhookUrl } = req.body || {};
    if (!['free', 'basic', 'pro', 'partner'].includes(tier)) {
      return { status: 400, body: { ok: false, error: 'Invalid tier. Use: free, basic, pro, partner' } };
    }

    const key = generateKey(tier);
    const record = {
      key, tier, name, note,
      webhookUrl: webhookUrl || null,
      createdAt: Date.now(),
      lastUsed: null,
      requestCount: 0,
      active: true,
    };
    _dynamicKeys.set(key, record);

    return { status: 201, body: {
      ok: true,
      apiKey: key,
      tier,
      name,
      limits: {
        free:    '30 req/мин · 500 req/день',
        basic:   '100 req/мин · 5,000 req/день',
        pro:     '500 req/мин · 50,000 req/день',
        partner: 'Unlimited',
      }[tier],
      docsUrl: 'https://acelerat.vercel.app/api-docs',
      note: 'Сохраните ключ — он показывается один раз',
    } }
  }

  if (action === 'list' || req.method === 'GET') {
    // Показываем env-ключи (без значения) + динамические
    const envKeys = (process.env.TURBOTX_API_KEYS || '').split(',')
      .filter(Boolean)
      .map(entry => {
        const [key, tier, name] = entry.trim().split(':');
        return { key: key.slice(0, 12) + '****', tier, name, source: 'env', active: true };
      });

    const dynKeys = Array.from(_dynamicKeys.values()).map(k => ({
      key:   k.key.slice(0, 12) + '****',
      tier:  k.tier,
      name:  k.name,
      note:  k.note,
      createdAt: k.createdAt,
      lastUsed:  k.lastUsed,
      requestCount: k.requestCount,
      active: k.active,
      source: 'dynamic',
    }));

    return { status: 200, body: {
      ok: true,
      total: envKeys.length + dynKeys.length,
      keys: [...envKeys, ...dynKeys],
    } };
  }

  if (action === 'revoke') {
    const { key } = req.body || {};
    if (!key) return { status: 400, body: { ok: false, error: 'key required' } };
    const record = _dynamicKeys.get(key);
    if (!record) return { status: 404, body: { ok: false, error: 'Key not found (env keys cannot be revoked here)' } };
    _dynamicKeys.delete(key);
    return { status: 200, body: { ok: true, message: 'Key revoked', key: key.slice(0, 12) + '****' } };
  }

  return { status: 400, body: { ok: false, error: 'Unknown action', validActions: ['create', 'list', 'revoke'] } };
}

// Экспортируем для использования в v1.js
export function getDynamicKeys() { return _dynamicKeys;
}

// ─── MAIN DISPATCHER ──────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v)); return res.status(204).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  // Rate limit headers helper
  const setRlHeaders = (rl) => {
    if (!rl?.limits) return;
    res.setHeader('X-RateLimit-Limit-Minute', rl.limits.perMin);
    res.setHeader('X-RateLimit-Limit-Day', rl.limits.perDay);
    res.setHeader('X-RateLimit-Remaining-Minute', rl.remaining?.perMin ?? 0);
    res.setHeader('X-RateLimit-Remaining-Day', rl.remaining?.perDay ?? 0);
  };

  res.setHeader('X-API-Version', 'v1');
  res.setHeader('X-Powered-By', 'TurboTX');

  // Auth
  const auth = authenticate(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error, docs: 'https://acelerat.vercel.app/api-docs' });
  }

  // Rate limit
  const rl = checkRateLimit(auth.key, auth.tier);
  setRlHeaders(rl);
  if (!rl.ok) {
    return res.status(429).json({
      ok: false,
      error: `Rate limit exceeded (${rl.reason})`,
      limit: rl.limit,
      resetAt: rl.reset,
      upgradeUrl: 'https://acelerat.vercel.app/api-docs#pricing',
    });
  }

  const method = req.query?.method || req.body?.method;
  const txid   = req.query?.txid   || req.body?.txid;

  let result;

  switch (method) {
    case 'ping':
      result = handlePing(auth, rl);
      break;

    case 'status':
      if (!txid) { result = { status: 400, body: { ok: false, error: 'txid required' } }; break; }
      result = { status: 200, body: await callInternal('status', { txid }) };
      break;

    case 'mempool':
      result = { status: 200, body: await callInternal('mempool', txid ? { txid } : {}) };
      break;

    case 'fees': {
      const data = await callInternal('mempool');
      result = { status: 200, body: {
        ok: true,
        fees: data.fees,
        congestion: data.congestion,
        history24h: data.history24h,
        predictions: data.predictions,
        mempool: data.mempool,
        timestamp: data.timestamp,
      }};
      break;
    }

    case 'price':
      result = { status: 200, body: await callInternal('price') };
      break;

    case 'acceleration':
    case 'advisor':
      if (!txid) { result = { status: 400, body: { ok: false, error: 'txid required' } }; break; }
      result = { status: 200, body: await callAcceleration(txid) };
      break;

    case 'accelerate':
      result = await handleAccelerate(req, auth);
      break;

    case 'health':
      result = { status: 200, body: await callInternal('health', req.query?.verbose === '1' ? { verbose: '1' } : {}) };
      break;

    case 'stats':
      result = { status: 200, body: await callInternal('stats') };
      break;

    case 'cpfp':
      if (!txid) { result = { status: 400, body: { ok: false, error: 'txid required' } }; break; }
      result = { status: 200, body: await callInternal('cpfp', { txid, ...req.query }) };
      break;

    case 'rbf':
      if (!txid) { result = { status: 400, body: { ok: false, error: 'txid required' } }; break; }
      result = { status: 200, body: await callInternal('rbf', { txid, ...req.query }) };
      break;

    case 'keys':
      result = await handleKeys(req, res);
      break;

    default:
      result = {
        status: 400,
        body: {
          ok: false,
          error: `Unknown method: "${method}"`,
          availableMethods: ['ping', 'status', 'mempool', 'fees', 'price', 'acceleration', 'accelerate', 'health', 'stats', 'cpfp', 'rbf'],
          docs: 'https://acelerat.vercel.app/api-docs',
        },
      };
  }

  // Добавляем meta в каждый ответ
  if (result.body && typeof result.body === 'object') {
    result.body._meta = {
      apiVersion: 'v1',
      tier: auth.tier,
      remaining: rl.remaining,
    };
  }

  return res.status(result.status).json(result.body);
}
