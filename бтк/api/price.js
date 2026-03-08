// ══════════════════════════════════════════════════════════════
//  TurboTX — /api/price.js
//  Динамическая цена Premium на основе загруженности mempool
//
//  GET /api/price
//  Ответ: { usd, btc, btcPrice, congestion: 'low'|'medium'|'high'|'extreme', feeRate }
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 10 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Ценовая матрица по загрузке сети
const PRICE_TIERS = [
  { maxFee: 10,  usd: 3,  label: 'low',     emoji: '🟢', text: 'Сеть свободна' },
  { maxFee: 30,  usd: 4,  label: 'medium',   emoji: '🟡', text: 'Умеренная нагрузка' },
  { maxFee: 60,  usd: 7,  label: 'high',     emoji: '🟠', text: 'Высокая нагрузка' },
  { maxFee: 150, usd: 12, label: 'extreme',  emoji: '🔴', text: 'Перегрузка сети' },
  { maxFee: Infinity, usd: 18, label: 'critical', emoji: '🔴', text: 'Критическая перегрузка' },
];

async function fetchTimeout(url, ms = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer); return r;
  } catch (e) { clearTimeout(timer); throw e; }
}

async function getFeeRate() {
  // Пробуем mempool.space → blockstream.info как fallback
  try {
    const r = await fetchTimeout('https://mempool.space/api/v1/fees/recommended');
    if (r.ok) {
      const j = await r.json();
      return j.fastestFee ?? j.halfHourFee ?? 20;
    }
  } catch (_) {}
  try {
    const r = await fetchTimeout('https://blockstream.info/api/fee-estimates');
    if (r.ok) {
      const j = await r.json();
      return j['1'] ?? j['3'] ?? 20;
    }
  } catch (_) {}
  return 20; // fallback
}

async function getBtcPrice() {
  try {
    const r = await fetchTimeout('https://api.coindesk.com/v1/bpi/currentprice/USD.json');
    if (r.ok) {
      const j = await r.json();
      return j?.bpi?.USD?.rate_float ?? null;
    }
  } catch (_) {}
  try {
    // Fallback: mempool.space prices
    const r = await fetchTimeout('https://mempool.space/api/v1/prices');
    if (r.ok) {
      const j = await r.json();
      return j?.USD ?? null;
    }
  } catch (_) {}
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const [feeRate, btcPrice] = await Promise.all([getFeeRate(), getBtcPrice()]);

  const tier = PRICE_TIERS.find(t => feeRate <= t.maxFee) ?? PRICE_TIERS.at(-1);
  const usd = tier.usd;
  const btc = btcPrice ? parseFloat((usd / btcPrice).toFixed(6)) : null;

  // Кешируем на 3 минуты (CDN Vercel)
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=300');

  return res.status(200).json({
    ok: true,
    usd,
    btc,
    btcPrice,
    feeRate,
    congestion: tier.label,
    emoji: tier.emoji,
    text: tier.text,
    tiers: PRICE_TIERS.map(t => ({ usd: t.usd, label: t.label, emoji: t.emoji, text: t.text })),
  });
}
