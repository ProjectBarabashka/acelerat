// ══════════════════════════════════════════════════════════════
//  TurboTX — /api/broadcast.js
//  Vercel Serverless Function (Node.js 18+)
//  Деплоится автоматически при push в репозиторий
//
//  Запрос: POST /api/broadcast
//  Body:   { txid: string, plan: 'free'|'premium', hex?: string }
//  Ответ:  { ok, results: { channel, status, ms }[], summary }
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 }; // Vercel Pro: до 60 сек, Hobby: 10 сек

// ── CORS ────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── УТИЛИТЫ ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── ПОЛУЧИТЬ RAW HEX ────────────────────────────────────────────
// 5 источников параллельно — первый успешный побеждает
async function getHex(txid) {
  const sources = [
    { url: `https://mempool.space/api/tx/${txid}/hex`,               type: 'text' },
    { url: `https://blockstream.info/api/tx/${txid}/hex`,            type: 'text' },
    { url: `https://api.blockchair.com/bitcoin/raw/transaction/${txid}`, type: 'json', path: ['data', txid, 'raw_transaction'] },
    { url: `https://btcscan.org/api/tx/${txid}/raw`,                 type: 'text' },
    { url: `https://blockchain.info/rawtx/${txid}?format=hex`,       type: 'text' },
  ];

  return new Promise(resolve => {
    let resolved = false, done = 0;
    sources.forEach(async ({ url, type, path }) => {
      try {
        const r = await fetchTimeout(url, { cache: 'no-store' }, 8000);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        let hex;
        if (type === 'json') {
          const j = await r.json();
          hex = path.reduce((o, k) => o?.[k], j);
        } else {
          hex = (await r.text()).trim();
        }
        if (!resolved && hex && /^[0-9a-fA-F]{20,}$/.test(hex)) {
          resolved = true;
          resolve(hex);
        }
      } catch (_) {}
      if (++done === sources.length && !resolved) resolve(null);
    });
  });
}

// ── BROADCAST CHANNEL DEFINITIONS ───────────────────────────────
// Серверная сторона: нет CORS ограничений, читаем реальный ответ

function broadcastChannels(txid, hex) {
  return [
    // ─ CORS-узлы (hex) ─
    {
      name: 'mempool.space',
      tier: 'broadcast',
      enabled: !!hex,
      call: () => fetchTimeout('https://mempool.space/api/tx', {
        method: 'POST', body: hex,
        headers: { 'Content-Type': 'text/plain' }
      }, 10000).then(r => ({ ok: r.ok || r.status === 400, status: r.status }))
    },
    {
      name: 'blockstream.info',
      tier: 'broadcast',
      enabled: !!hex,
      call: () => fetchTimeout('https://blockstream.info/api/tx', {
        method: 'POST', body: hex,
        headers: { 'Content-Type': 'text/plain' }
      }, 10000).then(r => ({ ok: r.ok || r.status === 400, status: r.status }))
    },
    {
      name: 'blockchair',
      tier: 'broadcast',
      enabled: !!hex,
      call: () => fetchTimeout('https://api.blockchair.com/bitcoin/push/transaction', {
        method: 'POST',
        body: `data=${encodeURIComponent(hex)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, 10000).then(async r => {
        const j = await r.json().catch(() => ({}));
        return { ok: !!(j?.data || j?.result || j?.context?.code === 200), status: r.status, body: j };
      })
    },
    {
      name: 'blockcypher',
      tier: 'broadcast',
      enabled: !!hex,
      call: () => fetchTimeout('https://api.blockcypher.com/v1/btc/main/txs/push', {
        method: 'POST',
        body: JSON.stringify({ tx: hex }),
        headers: { 'Content-Type': 'application/json' }
      }, 10000).then(async r => {
        const j = await r.json().catch(() => ({}));
        // 201 = created, 400 с "already" = уже в пуле
        const alreadyIn = r.status === 400 && JSON.stringify(j).includes('already');
        return { ok: r.status === 201 || alreadyIn, status: r.status, body: j };
      })
    },
    {
      name: 'bitaps',
      tier: 'broadcast',
      enabled: !!hex,
      call: () => fetchTimeout('https://bitaps.com/api/bitcoin/push/transaction', {
        method: 'POST', body: hex,
        headers: { 'Content-Type': 'text/plain' }
      }, 10000).then(r => ({ ok: r.ok, status: r.status }))
    },
    {
      name: 'btcscan',
      tier: 'broadcast',
      enabled: !!hex,
      call: () => fetchTimeout('https://btcscan.org/api/tx/push', {
        method: 'POST', body: hex,
        headers: { 'Content-Type': 'text/plain' }
      }, 10000).then(r => ({ ok: r.ok, status: r.status }))
    },

    // ─ Pool accelerators (txid-only, серверно работают без CORS!) ─
    {
      name: 'ViaBTC_accelerator',
      tier: 'pool',
      enabled: true,
      call: () => fetchTimeout('https://www.viabtc.com/tools/txaccelerator/', {
        method: 'POST',
        body: `txid=${txid}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }
      }, 12000).then(async r => {
        const txt = await r.text().catch(() => '');
        // ViaBTC возвращает JSON с code: 0 при успехе
        const ok = r.ok || txt.includes('"code":0') || txt.includes('success');
        return { ok, status: r.status, snippet: txt.slice(0, 80) };
      })
    },
    {
      name: 'fujn.com',
      tier: 'pool',
      enabled: true,
      call: () => fetchTimeout('https://fujn.com/accelerate', {
        method: 'POST',
        body: `txid=${txid}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }
      }, 12000).then(r => ({ ok: r.ok, status: r.status }))
    },
    {
      name: 'bitaccelerate',
      tier: 'pool',
      enabled: true,
      call: () => fetchTimeout('https://bitaccelerate.com/', {
        method: 'POST',
        body: `txid=${txid}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }
      }, 12000).then(r => ({ ok: r.ok, status: r.status }))
    },
    {
      name: 'CloverPool',
      tier: 'pool',
      enabled: true,
      call: () => fetchTimeout('https://clvpool.com/accelerator', {
        method: 'POST',
        body: `tx_id=${txid}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }
      }, 12000).then(r => ({ ok: r.ok, status: r.status }))
    },
    {
      name: 'AntPool',
      tier: 'pool',
      enabled: true,
      call: () => fetchTimeout(`https://antpool.com/txAccelerate?txid=${txid}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, 10000).then(r => ({ ok: r.ok, status: r.status }))
    },
    {
      name: 'F2Pool',
      tier: 'pool',
      enabled: true,
      call: () => fetchTimeout(`https://f2pool.com/txaccelerator/submit?txid=${txid}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, 10000).then(r => ({ ok: r.ok, status: r.status }))
    },
    {
      name: '360btc',
      tier: 'pool',
      enabled: true,
      call: () => fetchTimeout('https://360btc.net/accelerate', {
        method: 'POST',
        body: `txid=${txid}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }
      }, 12000).then(r => ({ ok: r.ok, status: r.status }))
    },
  ];
}

// ── ЗАПУСТИТЬ ВОЛНУ ──────────────────────────────────────────────
async function runWave(channels, plan) {
  const active = plan === 'premium' ? channels : channels.filter(c => c.tier === 'broadcast');
  const results = await Promise.allSettled(
    active.map(async ch => {
      const t0 = Date.now();
      try {
        const r = await ch.call();
        return { channel: ch.name, tier: ch.tier, ok: r.ok, status: r.status ?? null, ms: Date.now() - t0, snippet: r.snippet };
      } catch (e) {
        return { channel: ch.name, tier: ch.tier, ok: false, error: e.message, ms: Date.now() - t0 };
      }
    })
  );
  return results.map(r => r.status === 'fulfilled' ? r.value : { ...r.reason, ok: false });
}

// ── TELEGRAM УВЕДОМЛЕНИЕ ─────────────────────────────────────────
async function tgNotify(results, txid, plan) {
  const token = process.env.TG_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) return;

  const ok = results.filter(r => r.ok).length;
  const total = results.length;
  const pools = results.filter(r => r.tier === 'pool' && r.ok).map(r => r.channel).join(', ') || '—';

  const text = [
    `⚡ *TurboTX Broadcast*`,
    `📋 TXID: \`${txid.slice(0,14)}…${txid.slice(-6)}\``,
    `🎯 План: *${plan.toUpperCase()}*`,
    `✅ Успешно: *${ok}/${total}* каналов`,
    `🏊 Пулы: ${pools}`,
    `🕐 ${new Date().toLocaleString('ru', { timeZone: 'Europe/Moscow' })} МСК`,
  ].join('\n');

  await fetchTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  }, 5000).catch(() => {});
}

// ── MAIN HANDLER ─────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).set(CORS).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { txid, plan = 'free', hex: hexProvided } = req.body || {};

  // Валидация TXID
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid)) {
    return res.status(400).json({ ok: false, error: 'Invalid TXID' });
  }

  const t0 = Date.now();

  // Получаем hex (серверно — нет CORS, быстро)
  const hex = hexProvided && /^[0-9a-fA-F]{20,}$/.test(hexProvided)
    ? hexProvided
    : await getHex(txid);

  const channels = broadcastChannels(txid, hex);

  // Волна 1: все каналы параллельно
  const wave1 = await runWave(channels, plan);

  // Telegram уведомление (без ожидания)
  tgNotify(wave1, txid, plan).catch(() => {});

  // Статистика
  const okCount  = wave1.filter(r => r.ok).length;
  const summary  = {
    total:     wave1.length,
    ok:        okCount,
    failed:    wave1.length - okCount,
    hexFound:  !!hex,
    ms:        Date.now() - t0,
    plan,
  };

  return res.status(200).json({
    ok: okCount > 0,
    results: wave1,
    summary,
    // Для Premium — возвращаем jobId чтобы фронт мог отслеживать авто-повторы
    ...(plan === 'premium' ? { jobId: `${txid.slice(0,8)}_${Date.now()}` } : {})
  });
}
