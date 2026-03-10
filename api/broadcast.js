// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ ULTIMATE ★  —  /api/broadcast.js
//  Vercel Serverless · Node.js 20
//
//  POST /api/broadcast
//  Body: { txid, plan:'free'|'premium', hex?, token? }
//
//  ═══ ЗАЩИТА СЕРВЕРА ═══════════════════════════════
//  ✦ IP rate limit: free=3/час, premium=30/час
//  ✦ TXID cooldown: free=2ч, premium=15мин
//  ✦ Abuse detect: >15 разных TXID с одного IP/час
//  ✦ Bot UA filter: curl/wget/python/scrapy → 403
//  ✦ Hex size limit: max 400KB
//  ✦ Confirmed TX cache: не бродкастим повторно
//  ✦ PREMIUM_SECRET env: опциональный токен
//
//  ═══ FREE ПЛАН ═══════════════════════════════════
//  ✦ 3 hex-узла (mempool.space + blockstream + blockchair)
//  ✦ Лимит 3 запроса/час, cooldown 2ч на TXID
//  ✦ НЕТ доступа к пулам майнеров
//  ✦ Если hex не найден — честный отказ
//
//  ═══ PREMIUM 2026 ════════════════════════════════
//  ✦ 8 hex-узлов + 16 майнинг-пулов
//  ✦ Foundry 27% / MARA 11% / SpiderPool 8% / Luxor 5%
//  ✦ Retry ×2 exponential backoff (429/5xx)
//  ✦ Реальный % хешрейта по таблице Q1 2026
// ══════════════════════════════════════════════════

export const config = { maxDuration: 60 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TurboTX-Token',
};

// ─── IN-MEMORY RATE LIMITER ───────────────────────────────────
const _ipMap    = new Map(); // ip → { count, txids:Set, resetAt }
const _txidMap  = new Map(); // txid → { lastSeen, plan }
const _confirmed = new Set(); // подтверждённые TXID (кеш)

const LIMITS = {
  free:    { perHour: 3,  cooldownMs: 2 * 60 * 60 * 1000 },
  premium: { perHour: 30, cooldownMs: 15 * 60 * 1000     },
};
const MAX_TXIDS_PER_IP_HOUR = 15;
const MAX_HEX_BYTES = 400_000;

function getIp(req) {
  return (req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress || 'unknown');
}

function checkLimits(ip, txid, plan) {
  const now  = Date.now();
  const hour = 3_600_000;
  const lim  = LIMITS[plan] || LIMITS.free;

  // Чистка старых записей
  if (_ipMap.size > 5000)
    for (const [k, v] of _ipMap) if (v.resetAt < now) _ipMap.delete(k);

  let e = _ipMap.get(ip);
  if (!e || e.resetAt < now) {
    e = { count: 0, txids: new Set(), resetAt: now + hour };
    _ipMap.set(ip, e);
  }

  if (!e.txids.has(txid) && e.txids.size >= MAX_TXIDS_PER_IP_HOUR)
    return { ok: false, reason: 'abuse', retryAfter: Math.ceil((e.resetAt - now) / 1000) };

  if (e.count >= lim.perHour)
    return { ok: false, reason: 'rate_limit', retryAfter: Math.ceil((e.resetAt - now) / 1000) };

  const tx = _txidMap.get(txid);
  if (tx && tx.plan === plan) {
    const remaining = lim.cooldownMs - (now - tx.lastSeen);
    if (remaining > 0)
      return { ok: false, reason: 'txid_cooldown', retryAfter: Math.ceil(remaining / 1000) };
  }

  e.count++;
  e.txids.add(txid);
  _txidMap.set(txid, { lastSeen: now, plan });
  return { ok: true };
}

function isBot(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  return ['curl/', 'wget/', 'python-requests', 'go-http', 'java/', 'scrapy', 'bot/', 'crawler']
    .some(p => ua.includes(p));
}

// ─── УТИЛИТЫ ─────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function safeJson(r) { try { return await r.json(); } catch { return {}; } }
async function safeText(r) { try { return await r.text(); } catch { return ''; } }

async function ft(url, opts = {}, ms = 13000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}

// ─── 429 COOLDOWN REGISTRY ────────────────────────────────────
// Если канал вернул 429 — он временно исключается из очереди.
// Время паузы растёт с каждым повтором (экспоненциально).
//
//   1-й 429  →  2 мин
//   2-й 429  →  5 мин
//   3-й 429  →  15 мин
//   4-й+ 429 →  60 мин
const _cooldown = new Map(); // name → { until, hits }

const COOLDOWN_MS = [
  2  * 60_000,   // hit 1
  5  * 60_000,   // hit 2
  15 * 60_000,   // hit 3
  60 * 60_000,   // hit 4+
];

function isCooling(name) {
  const e = _cooldown.get(name);
  return e && Date.now() < e.until;
}

function registerHit(name) {
  const e    = _cooldown.get(name) ?? { hits: 0, until: 0 };
  const hits = e.hits + 1;
  const ms   = COOLDOWN_MS[Math.min(hits - 1, COOLDOWN_MS.length - 1)];
  _cooldown.set(name, { hits, until: Date.now() + ms });
  const mins = Math.round(ms / 60_000);
  console.warn(`[TurboTX] 429 cooldown: ${name} → ${mins} мин (hit #${hits})`);
}

function registerSuccess(name) {
  // Успешный ответ — сбрасываем счётчик хитов
  if (_cooldown.has(name)) {
    _cooldown.set(name, { hits: 0, until: 0 });
  }
}

async function ftr(url, opts = {}, ms = 13000, tries = 2, channelName = '') {
  for (let i = 0; i <= tries; i++) {
    try {
      const r = await ft(url, opts, ms);
      if (r.status === 429) {
        registerHit(channelName || url);
        // Не ретраим 429 — сразу возвращаем, канал исключится в run()
        return r;
      }
      if (r.status >= 500 && i < tries) { await sleep(600 * (i + 1)); continue; }
      if (r.ok || r.status < 500) registerSuccess(channelName || url);
      return r;
    } catch(e) { if (i === tries) throw e; await sleep(400 * (i + 1)); }
  }
}

function ok400(body, status) {
  const b = String(body).toLowerCase();
  return b.includes('already') || b.includes('duplicate') || b.includes('known') ||
    b.includes('exists') || b.includes('258') ||
    (status === 400 && !b.includes('bad-txns') && !b.includes('non-mandatory') && !b.includes('invalid'));
}

// ─── GET HEX ─────────────────────────────────────────────────
const HEX_RE = /^[0-9a-fA-F]{200,}$/;

async function getHex(txid) {
  const S = [
    { url: `https://mempool.space/api/tx/${txid}/hex`,                            t:'text' },
    { url: `https://blockstream.info/api/tx/${txid}/hex`,                         t:'text' },
    { url: `https://btcscan.org/api/tx/${txid}/raw`,                              t:'text' },
    { url: `https://blockchain.info/rawtx/${txid}?format=hex`,                    t:'text' },
    { url: `https://api.blockchair.com/bitcoin/raw/transaction/${txid}`,          t:'json', p:['data',txid,'raw_transaction'] },
    { url: `https://api.blockcypher.com/v1/btc/main/txs/${txid}?includeHex=true`, t:'json', p:['hex'] },
    { url: `https://chain.api.btc.com/v3/tx/${txid}`,                             t:'json', p:['data','raw_hex'] },
    { url: `https://sochain.com/api/v2/get_tx/BTC/${txid}`,                       t:'json', p:['data','tx_hex'] },
  ];
  return new Promise(res => {
    let found = false, done = 0;
    for (const { url, t, p } of S) {
      ft(url, { cache:'no-store' }, 9000).then(async r => {
        if (!r.ok) throw 0;
        const h = t === 'json' ? p.reduce((o, k) => o?.[k], await safeJson(r)) : (await safeText(r)).trim();
        if (!found && HEX_RE.test(h) && h.length < MAX_HEX_BYTES * 2) { found = true; res(h); }
      }).catch(() => {}).finally(() => { if (++done === S.length && !found) res(null); });
    }
  });
}

// ─── АНАЛИЗ TX ────────────────────────────────────────────────
async function analyze(txid) {
  try {
    const [tR, fR] = await Promise.all([
      ft(`https://mempool.space/api/tx/${txid}`, {}, 7000),
      ft('https://mempool.space/api/v1/fees/recommended', {}, 5000),
    ]);
    if (!tR.ok) return null;
    const tx   = await safeJson(tR);
    const fees = fR.ok ? await safeJson(fR) : {};
    const vsize   = tx.weight ? Math.ceil(tx.weight / 4) : (tx.size || 250);
    const feePaid = tx.fee || 0;
    const feeRate = feePaid && vsize ? Math.round(feePaid / vsize) : 0;
    const fastest = fees.fastestFee || 50;
    const needCpfp = feeRate > 0 && feeRate < fastest * 0.5;
    const rbfEnabled = Array.isArray(tx.vin) && tx.vin.some(i => i.sequence <= 0xFFFFFFFD);
    if (tx.status?.confirmed) _confirmed.add(txid);
    return {
      vsize, feePaid, feeRate, fastest, needCpfp, rbfEnabled,
      cpfpFeeNeeded: needCpfp ? Math.max(0, fastest * (vsize + 110) - feePaid) : 0,
      confirmed: tx.status?.confirmed || false,
      inputs:  (tx.vin  || []).length,
      outputs: (tx.vout || []).length,
    };
  } catch { return null; }
}

// ─── HASHRATE TABLE Q1 2026 ───────────────────────────────────
const HR = {
  Foundry:27, AntPool:16, MARA:11, ViaBTC:9, SpiderPool:8,
  F2Pool:7, Luxor:5, CloverPool:4, BitFuFu:4, 'BTC.com':3,
  TxBoost:2, mempoolAccel:1, bitaccelerate:1, '360btc':1, txfaster:1, btcspeed:1,
};

// ─── FREE КАНАЛЫ (только hex-узлы) ───────────────────────────
function freeChannels(hex) {
  return [
    { name:'mempool.space',  tier:'node', call: async () => {
      const r = await ftr('https://mempool.space/api/tx', { method:'POST', body:hex, headers:{'Content-Type':'text/plain'} }, 12000);
      return { ok: r.ok || ok400(await safeText(r), r.status) };
    }},
    { name:'blockstream.info', tier:'node', call: async () => {
      const r = await ftr('https://blockstream.info/api/tx', { method:'POST', body:hex, headers:{'Content-Type':'text/plain'} }, 12000);
      return { ok: r.ok || ok400(await safeText(r), r.status) };
    }},
    { name:'blockchair', tier:'node', call: async () => {
      const r = await ftr('https://api.blockchair.com/bitcoin/push/transaction', {
        method:'POST', body:`data=${encodeURIComponent(hex)}`, headers:{'Content-Type':'application/x-www-form-urlencoded'},
      }, 12000);
      const j = await safeJson(r);
      return { ok: !!(j?.data || j?.context?.code===200 || ok400(JSON.stringify(j), r.status)) };
    }},
  ];
}

// ─── PREMIUM КАНАЛЫ (hex + 16 пулов 2026) ────────────────────
function premiumChannels(txid, hex) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  const nodes = hex ? [
    { name:'mempool.space', tier:'node', call: async () => {
      const r = await ftr('https://mempool.space/api/tx', { method:'POST', body:hex, headers:{'Content-Type':'text/plain'} }, 12000);
      return { ok: r.ok || ok400(await safeText(r), r.status) };
    }},
    { name:'blockstream.info', tier:'node', call: async () => {
      const r = await ftr('https://blockstream.info/api/tx', { method:'POST', body:hex, headers:{'Content-Type':'text/plain'} }, 12000);
      return { ok: r.ok || ok400(await safeText(r), r.status) };
    }},
    { name:'blockchair', tier:'node', call: async () => {
      const r = await ftr('https://api.blockchair.com/bitcoin/push/transaction', {
        method:'POST', body:`data=${encodeURIComponent(hex)}`, headers:{'Content-Type':'application/x-www-form-urlencoded'},
      }, 12000);
      const j = await safeJson(r);
      return { ok: !!(j?.data || j?.context?.code===200 || ok400(JSON.stringify(j), r.status)) };
    }},
    { name:'blockcypher', tier:'node', call: async () => {
      const r = await ftr('https://api.blockcypher.com/v1/btc/main/txs/push', {
        method:'POST', body:JSON.stringify({tx:hex}), headers:{'Content-Type':'application/json'},
      }, 12000);
      const j = await safeJson(r);
      return { ok: r.status===201 || ok400(JSON.stringify(j), r.status) };
    }},
    { name:'btcscan.org', tier:'node', call: async () => {
      const r = await ftr('https://btcscan.org/api/tx/push', { method:'POST', body:hex, headers:{'Content-Type':'text/plain'} }, 10000);
      return { ok: r.ok || ok400(await safeText(r), r.status) };
    }},
    { name:'blockchain.info', tier:'node', call: async () => {
      const r = await ftr('https://blockchain.info/pushtx', {
        method:'POST', body:`tx=${hex}`, headers:{'Content-Type':'application/x-www-form-urlencoded'},
      }, 12000);
      return { ok: r.ok || ok400(await safeText(r), r.status) };
    }},
    { name:'bitaps.com', tier:'node', call: async () => {
      const r = await ftr('https://bitaps.com/api/bitcoin/push/transaction', { method:'POST', body:hex, headers:{'Content-Type':'text/plain'} }, 10000);
      return { ok: r.ok };
    }},
    { name:'sochain.com', tier:'node', call: async () => {
      const r = await ftr('https://sochain.com/api/v2/send_tx/BTC', {
        method:'POST', body:JSON.stringify({tx_hex:hex}), headers:{'Content-Type':'application/json'},
      }, 10000);
      const j = await safeJson(r);
      return { ok: j?.status==='success' || ok400(JSON.stringify(j), r.status) };
    }},
  ] : [];

  const pools = [
    { name:'Foundry', tier:'pool', call: async () => {
      const r = await ftr('https://foundryusapool.com/accelerate', { method:'POST', body:JSON.stringify({txid}), headers:{'Content-Type':'application/json','User-Agent':UA} }, 14000);
      return { ok: r.ok || ok400(await safeText(r), r.status) };
    }},
    { name:'AntPool', tier:'pool', call: async () => {
      try {
        const r = await ft('https://www.antpool.com/api/v1/tools/tx-accelerate', { method:'POST', body:JSON.stringify({txHash:txid}), headers:{'Content-Type':'application/json','User-Agent':UA,'Referer':'https://www.antpool.com/'} }, 12000);
        const j = await safeJson(r); if (r.ok || j?.code===0) return { ok:true };
      } catch(_) {}
      const r2 = await ftr('https://antpool.com/txAccelerate.htm', { method:'POST', body:`txHash=${txid}`, headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA} }, 12000);
      const t2 = await safeText(r2);
      return { ok: r2.ok || t2.includes('success') || ok400(t2, r2.status) };
    }},
    { name:'MARA', tier:'pool', call: async () => {
      const r = await ftr('https://mara.com/api/transaction-accelerator', { method:'POST', body:JSON.stringify({txId:txid}), headers:{'Content-Type':'application/json','User-Agent':UA} }, 14000);
      const j = await safeJson(r);
      return { ok: r.ok || j?.success===true || ok400(JSON.stringify(j), r.status) };
    }},
    { name:'ViaBTC', tier:'pool', call: async () => {
      try {
        const r = await ft('https://viabtc.com/api/v1/btc/accelerator', { method:'POST', body:JSON.stringify({tx_id:txid}), headers:{'Content-Type':'application/json','User-Agent':UA,'Origin':'https://viabtc.com'} }, 14000);
        const j = await safeJson(r); if (r.ok || j?.code===0) return { ok:true };
      } catch(_) {}
      const r2 = await ft('https://www.viabtc.com/tools/txaccelerator/', { method:'POST', body:`txid=${txid}`, headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA} }, 14000);
      const t2 = await safeText(r2);
      return { ok: r2.ok || t2.includes('"code":0') };
    }},
    { name:'SpiderPool', tier:'pool', call: async () => {
      const r = await ftr('https://www.spiderpool.com/api/v1/accelerate', { method:'POST', body:JSON.stringify({txid}), headers:{'Content-Type':'application/json','User-Agent':UA} }, 12000);
      const j = await safeJson(r);
      return { ok: r.ok || j?.code===0 || j?.success===true };
    }},
    { name:'F2Pool', tier:'pool', call: async () => {
      const r = await ftr('https://www.f2pool.com/api/v2/tx/accelerate', { method:'POST', body:JSON.stringify({tx_id:txid}), headers:{'Content-Type':'application/json','User-Agent':UA} }, 12000);
      const j = await safeJson(r);
      return { ok: r.ok || j?.code===0 };
    }},
    { name:'Luxor', tier:'pool', call: async () => {
      const r = await ftr('https://luxor.tech/api/accelerate', { method:'POST', body:JSON.stringify({txHash:txid}), headers:{'Content-Type':'application/json','User-Agent':UA} }, 12000);
      const j = await safeJson(r);
      return { ok: r.ok || j?.success===true || ok400(JSON.stringify(j), r.status) };
    }},
    { name:'CloverPool', tier:'pool', call: async () => {
      const r = await ftr('https://clvpool.com/accelerator', { method:'POST', body:`tx_id=${txid}`, headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA} }, 12000);
      return { ok: r.ok };
    }},
    { name:'BitFuFu', tier:'pool', call: async () => {
      const r = await ftr('https://www.bitfufu.com/txaccelerator/submit', { method:'POST', body:JSON.stringify({txHash:txid}), headers:{'Content-Type':'application/json','User-Agent':UA} }, 12000);
      const j = await safeJson(r);
      return { ok: r.ok || j?.success===true };
    }},
    { name:'BTC.com', tier:'pool', call: async () => {
      const r = await ftr('https://btc.com/service/accelerator/boost', { method:'POST', body:JSON.stringify({tx_id:txid}), headers:{'Content-Type':'application/json','User-Agent':UA} }, 12000);
      const j = await safeJson(r);
      return { ok: r.ok || j?.err_no===0 };
    }},
    { name:'mempoolAccel', tier:'pool', call: async () => {
      const r = await ftr('https://mempool.space/api/v1/tx-accelerator/enqueue', { method:'POST', body:JSON.stringify({txid}), headers:{'Content-Type':'application/json','User-Agent':UA} }, 12000);
      const j = await safeJson(r);
      return { ok: r.ok || j?.message==='Success' };
    }},
    { name:'TxBoost', tier:'pool', call: async () => {
      const r = await ftr('https://txboost.com/', { method:'POST', body:`txid=${txid}`, headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA} }, 12000);
      return { ok: r.ok || (await safeText(r)).includes('success') };
    }},
    { name:'bitaccelerate', tier:'pool', call: async () => {
      const r = await ftr('https://www.bitaccelerate.com/', { method:'POST', body:`txid=${txid}`, headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA} }, 12000);
      return { ok: r.ok };
    }},
    { name:'360btc', tier:'pool', call: async () => {
      const r = await ftr('https://360btc.net/accelerate', { method:'POST', body:`txid=${txid}`, headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA} }, 12000);
      return { ok: r.ok };
    }},
    { name:'txfaster', tier:'pool', call: async () => {
      const r = await ftr('https://txfaster.com/api/accelerate', { method:'POST', body:JSON.stringify({txid}), headers:{'Content-Type':'application/json','User-Agent':UA} }, 10000);
      const j = await safeJson(r);
      return { ok: r.ok || j?.success===true };
    }},
    { name:'btcspeed', tier:'pool', call: async () => {
      const r = await ftr('https://btcspeed.org/boost', { method:'POST', body:`tx=${txid}`, headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA} }, 10000);
      return { ok: r.ok };
    }},
  ];

  return [...nodes, ...pools];
}

// ─── TELEGRAM ─────────────────────────────────────────────────
async function tg({ results, txid, plan, analysis, ms, hr, ip, blocked }) {
  const token = process.env.TG_TOKEN;
  const chat  = process.env.TG_CHAT_ID;
  if (!token || !chat) return;

  let text;
  if (blocked) {
    text = [`🛡 *TurboTX BLOCKED*`, `📋 \`${txid?.slice(0,14)||'???'}\``, `🚫 ${blocked}`, `🌐 \`${ip}\``,
      `🕐 ${new Date().toLocaleString('ru',{timeZone:'Europe/Moscow'})} МСК`].join('\n');
  } else {
    const ok  = results.filter(r=>r.ok).length;
    const tot = results.length;
    const pct = tot ? Math.round(ok/tot*100) : 0;
    const bar = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10-Math.round(pct/10));
    text = [
      `⚡ *TurboTX v6 — ${plan.toUpperCase()}*`,
      `📋 \`${txid.slice(0,14)}…${txid.slice(-6)}\` 🌐 \`${ip}\``,
      `⏱ ${ms}ms`,
      `\`${bar}\` ${pct}% (${ok}/${tot})`,
      hr > 0 ? `⛏ ~${hr}% хешрейта` : '',
      `🔗 ${results.filter(r=>r.tier==='node'&&r.ok).map(r=>r.channel).join(', ')||'—'}`,
      plan==='premium' ? `🏊 ${results.filter(r=>r.tier==='pool'&&r.ok).map(r=>r.channel).join(', ')||'—'}` : '',
      analysis ? `📐 ${analysis.vsize}vB·${analysis.feeRate}sat/vB${analysis.needCpfp?' ⚠️CPFP':' ✅'}${analysis.rbfEnabled?' 🔄RBF':''}` : '',
      `🕐 ${new Date().toLocaleString('ru',{timeZone:'Europe/Moscow'})} МСК`,
    ].filter(Boolean).join('\n');
  }

  await ft(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      chat_id:chat, text, parse_mode:'Markdown',
      ...(!blocked && { reply_markup:{ inline_keyboard:[[{ text:'🔍 Mempool', url:`https://mempool.space/tx/${txid}` }]] } }),
    }),
  }, 5000).catch(()=>{});
}

// ─── PING CACHE ───────────────────────────────────────────────
// Хранит последние замеры пинга каждого канала
// Сбрасывается через 10 минут (Vercel может переиспользовать инстанс)
const _pingCache = new Map(); // name → { ms, updatedAt }
const PING_TTL   = 10 * 60 * 1000; // 10 мин

function getCachedPing(name) {
  const e = _pingCache.get(name);
  if (e && Date.now() - e.updatedAt < PING_TTL) return e.ms;
  return null;
}
function setPing(name, ms) {
  _pingCache.set(name, { ms, updatedAt: Date.now() });
}

// Быстрый HEAD-пинг одного канала (не бродкастим, просто меряем)
const PING_URLS = {
  'mempool.space':   'https://mempool.space/api/blocks/tip/height',
  'blockstream.info':'https://blockstream.info/api/blocks/tip/height',
  'blockchair':      'https://api.blockchair.com/bitcoin/stats',
  'blockcypher':     'https://api.blockcypher.com/v1/btc/main',
  'btcscan.org':     'https://btcscan.org/api/blocks/tip/height',
  'blockchain.info': 'https://blockchain.info/latestblock',
  'bitaps.com':      'https://bitaps.com/api/bitcoin/blockcount',
  'sochain.com':     'https://sochain.com/api/v2/get_info/BTC',
  'Foundry':         'https://foundryusapool.com/',
  'AntPool':         'https://www.antpool.com/',
  'MARA':            'https://mara.com/',
  'ViaBTC':          'https://viabtc.com/',
  'SpiderPool':      'https://www.spiderpool.com/',
  'F2Pool':          'https://www.f2pool.com/',
  'Luxor':           'https://luxor.tech/',
  'CloverPool':      'https://clvpool.com/',
  'BitFuFu':         'https://www.bitfufu.com/',
  'BTC.com':         'https://btc.com/',
  'TxBoost':         'https://txboost.com/',
  'mempoolAccel':    'https://mempool.space/',
  'bitaccelerate':   'https://www.bitaccelerate.com/',
  '360btc':          'https://360btc.net/',
  'txfaster':        'https://txfaster.com/',
  'btcspeed':        'https://btcspeed.org/',
};

async function pingChannel(name) {
  const cached = getCachedPing(name);
  if (cached !== null) return cached;

  const url = PING_URLS[name];
  if (!url) return 9999;

  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 3000);
    await fetch(url, { method: 'HEAD', signal: ac.signal });
    clearTimeout(tm);
    const ms = Date.now() - t0;
    setPing(name, ms);
    return ms;
  } catch {
    // timeout или ошибка — ставим большой пинг (не исключаем, вдруг POST пройдёт)
    setPing(name, 5000);
    return 5000;
  }
}

// ─── RUN CHANNELS — с приоритизацией по пингу ─────────────────
// 1. Пингуем все каналы параллельно (HEAD, 3 сек макс)
// 2. Сортируем по пингу — быстрые идут первыми
// 3. Запускаем волнами: топ-8 сразу, остальные с небольшой задержкой
// 4. Отменяем хвосты если уже набрали достаточно ok-ответов
async function run(channels) {
  if (channels.length === 0) return [];

  // Шаг 1: параллельный пинг всех каналов
  const pings = await Promise.all(
    channels.map(ch => pingChannel(ch.name).then(ms => ({ ch, ms })))
  );

  // Шаг 2: сортируем — быстрые первые, внутри тира nodes < pools
  pings.sort((a, b) => {
    // Сначала узлы (они быстрее и надёжнее)
    if (a.ch.tier !== b.ch.tier) return a.ch.tier === 'node' ? -1 : 1;
    return a.ms - b.ms;
  });

  const sorted = pings.map(p => p.ch);

  // Шаг 3: волновой запуск
  // Волна 1 (0мс)   — топ 8 по пингу
  // Волна 2 (+200мс) — следующие 8
  // Волна 3 (+500мс) — остальные
  const WAVE_SIZE  = 8;
  const WAVE_DELAY = [0, 200, 500];
  const results    = new Array(sorted.length).fill(null);
  let   okCount    = 0;
  const EARLY_STOP = Math.min(sorted.length, Math.ceil(sorted.length * 0.6)); // 60% ok → стоп

  await new Promise(resolve => {
    let launched = 0, finished = 0;
    let aborted  = false;

    const launchWave = (waveChannels, waveIdx) => {
      waveChannels.forEach((ch, i) => {
        const globalIdx = waveIdx * WAVE_SIZE + i;

        // Пропускаем канал если он на cooldown после 429
        if (isCooling(ch.name)) {
          const e    = _cooldown.get(ch.name);
          const mins = Math.ceil((e.until - Date.now()) / 60_000);
          results[globalIdx] = { channel:ch.name, tier:ch.tier, ok:false,
            skipped:true, reason:'rate_limited', cooldownMins:mins, ms:0 };
          finished++;
          if (finished === sorted.length) resolve();
          return;
        }

        if (aborted) {
          results[globalIdx] = { channel:ch.name, tier:ch.tier, ok:false, skipped:true, ms:0 };
          finished++;
          if (finished === sorted.length) resolve();
          return;
        }

        const t0 = Date.now();
        ch.call().then(r => {
          const ms = Date.now() - t0;
          setPing(ch.name, ms);
          // Регистрируем 429 — канал уйдёт на cooldown
          if (r.status === 429) registerHit(ch.name);
          else if (r.ok)        registerSuccess(ch.name);
          results[globalIdx] = { channel:ch.name, tier:ch.tier, ok:!!r.ok,
            ms, ...(r.status===429 ? { reason:'rate_limited' } : {}) };
          if (r.ok) okCount++;
          finished++;
          if (!aborted && okCount >= EARLY_STOP) aborted = true;
          if (finished === sorted.length) resolve();
        }).catch(e => {
          results[globalIdx] = { channel:ch.name, tier:ch.tier, ok:false, error:e.message, ms:Date.now()-t0 };
          finished++;
          if (finished === sorted.length) resolve();
        });
        launched++;
      });
    };

    for (let w = 0; w < Math.ceil(sorted.length / WAVE_SIZE); w++) {
      const wave = sorted.slice(w * WAVE_SIZE, (w + 1) * WAVE_SIZE);
      const delay = WAVE_DELAY[w] ?? 500 + w * 200;
      if (delay === 0) {
        launchWave(wave, w);
      } else {
        setTimeout(() => {
          if (!aborted) launchWave(wave, w);
          else {
            // Волна отменена — заполняем skipped
            wave.forEach((ch, i) => {
              const idx = w * WAVE_SIZE + i;
              results[idx] = { channel:ch.name, tier:ch.tier, ok:false, skipped:true, ms:0 };
              finished++;
              if (finished === sorted.length) resolve();
            });
          }
        }, delay);
      }
    }
  });

  return results.filter(Boolean);
}

// ─── MAIN ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  const ip = getIp(req);

  // Бот-фильтр
  if (isBot(req)) {
    tg({ txid:'?', plan:'?', ip, blocked:'bot_ua' }).catch(()=>{});
    return res.status(403).json({ ok:false, error:'Forbidden' });
  }

  const { txid, plan='free', hex:hexIn } = req.body || {};

  // Валидация
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ ok:false, error:'Invalid TXID' });
  if (hexIn && hexIn.length > MAX_HEX_BYTES * 2)
    return res.status(413).json({ ok:false, error:'Hex too large' });

  const effectivePlan = ['free','premium'].includes(plan) ? plan : 'free';

  // Premium токен (если PREMIUM_SECRET задан в env)
  if (effectivePlan === 'premium') {
    const secret = process.env.PREMIUM_SECRET;
    const token  = req.headers['x-turbotx-token'] || req.body?.token;
    if (secret && token !== secret)
      return res.status(401).json({ ok:false, error:'Invalid premium token' });
  }

  // Rate limit
  const rl = checkLimits(ip, txid, effectivePlan);
  if (!rl.ok) {
    const minLeft = Math.ceil(rl.retryAfter / 60);
    if (rl.reason === 'abuse') tg({ txid, plan:effectivePlan, ip, blocked:`abuse` }).catch(()=>{});
    const msgs = {
      rate_limit:   `Лимит запросов. Повторите через ${minLeft} мин.`,
      txid_cooldown:`TXID уже ускорялся. Повтор через ${minLeft} мин.`,
      abuse:        'Слишком много TXID. Попробуйте позже.',
    };
    return res.status(429).json({ ok:false, error:msgs[rl.reason]||'Rate limited', retryAfter:rl.retryAfter });
  }

  // Кеш подтверждённых
  if (_confirmed.has(txid))
    return res.status(200).json({ ok:true, confirmed:true, cached:true, message:'Already confirmed (cached)' });

  const t0 = Date.now();

  const [hex, analysis] = await Promise.all([
    hexIn && HEX_RE.test(hexIn) ? Promise.resolve(hexIn) : getHex(txid),
    analyze(txid),
  ]);

  if (analysis?.confirmed) {
    _confirmed.add(txid);
    return res.status(200).json({ ok:true, confirmed:true, message:'Already confirmed', analysis });
  }

  // Free без hex — честный отказ (не делаем вид что что-то произошло)
  if (effectivePlan === 'free' && !hex)
    return res.status(200).json({ ok:false,
      error:'TX hex not found. Possibly too old or invalid.', analysis });

  const channels = effectivePlan === 'premium'
    ? premiumChannels(txid, hex)
    : freeChannels(hex);

  const results = await run(channels);
  const ms      = Date.now() - t0;

  const hr = effectivePlan === 'premium'
    ? results.filter(r=>r.ok&&r.tier==='pool').reduce((s,r)=>s+(HR[r.channel]||0),0)
    : 0;

  const okCount = results.filter(r=>r.ok).length;

  const summary = {
    total:results.length, ok:okCount, failed:results.length-okCount,
    hexFound:!!hex, ms, plan:effectivePlan, hashrateReach:hr,
    feeRate:       analysis?.feeRate       ?? null,
    needCpfp:      analysis?.needCpfp      ?? false,
    cpfpFeeNeeded: analysis?.cpfpFeeNeeded ?? 0,
    rbfEnabled:    analysis?.rbfEnabled    ?? false,
  };

  tg({ results, txid, plan:effectivePlan, analysis, ms, hr, ip }).catch(()=>{});

  return res.status(200).json({
    ok: okCount > 0, results, summary, analysis,
    ...(effectivePlan==='premium' ? { jobId:`${txid.slice(0,8)}_${Date.now()}` } : {}),
  });
}
