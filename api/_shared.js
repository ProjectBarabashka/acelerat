// ═══════════════════════════════════════════════════════════════
//  api/_shared.js  —  общие утилиты TurboTX v14
//  Импортируются всеми файлами api/ вместо локальных копий
// ═══════════════════════════════════════════════════════════════

// ─── CORS ──────────────────────────────────────────────────────
// Единые заголовки для всех эндпоинтов.
// v1.js добавляет к ним Authorization и X-API-Key своим CORS_V1.
export const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TurboTX-Token',
};

// Расширенный CORS для Public API (v1.js) — добавляет ключи аутентификации
export const CORS_API = {
  ...CORS,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-TurboTX-Token',
};

// ─── FETCH С ТАЙМАУТОМ ─────────────────────────────────────────
// ms по умолчанию = 10000. Передавай явно если нужно другое:
//   broadcast: ftr() оборачивает ft() с нужным ms
//   router:    передаёт 7000 явно
export async function ft(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─── SAFE JSON ─────────────────────────────────────────────────
export async function sj(r) {
  try { return await r.json(); } catch { return {}; }
}

// ─── SLEEP ─────────────────────────────────────────────────────
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── GET IP ────────────────────────────────────────────────────
export function getIp(req) {
  return req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress || 'unknown';
}

// ─── IP RATE LIMITER FACTORY ───────────────────────────────────
// Использование:
//   const checkRl = makeRl(30, 3_600_000); // 30 запросов / час
//   if (!checkRl(ip)) return res.status(429)...
//
// Каждый вызов makeRl() создаёт отдельную Map — изолированно на файл.
export function makeRl(max, windowMs = 3_600_000) {
  const map = new Map();
  return function checkRl(ip) {
    const now = Date.now();
    if (map.size > 2000) for (const [k, v] of map) if (v.r < now) map.delete(k);
    let e = map.get(ip);
    if (!e || e.r < now) { e = { c: 0, r: now + windowMs }; map.set(ip, e); }
    return ++e.c <= max;
  };
}
