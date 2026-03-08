// ══════════════════════════════════════════════════════════════
//  TurboTX — /api/repeat.js
//  Vercel Serverless Function
//
//  Вызывается фронтом каждые N минут для Premium.
//  Проверяет статус TX → если не подтверждена → повторяет broadcast.
//
//  POST /api/repeat
//  Body: { txid, wave: 1|2|3|4|5 }
//  Ответ: { confirmed, broadcasted, wave, nextWaveMs }
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 30 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Расписание волн (мс от старта)
const WAVE_DELAYS = [
  0,          // Волна 0: мгновенно (выполняет /api/broadcast)
  15 * 60000, // Волна 1: +15 мин
  30 * 60000, // Волна 2: +30 мин
  60 * 60000, // Волна 3: +60 мин
  120 * 60000,// Волна 4: +120 мин
  240 * 60000,// Волна 5: +240 мин (конец гарантии)
];

async function fetchTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer); return r;
  } catch (e) { clearTimeout(timer); throw e; }
}

async function isTxConfirmed(txid) {
  try {
    const r = await fetchTimeout(`https://mempool.space/api/tx/${txid}/status`, 6000);
    if (!r.ok) return false;
    const s = await r.json();
    return s.confirmed === true;
  } catch (_) { return false; }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const { txid, wave = 1 } = req.body || {};
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid)) {
    return res.status(400).json({ ok: false, error: 'Invalid TXID' });
  }

  // Сначала проверяем — возможно уже подтверждена
  const confirmed = await isTxConfirmed(txid);
  if (confirmed) {
    return res.status(200).json({ confirmed: true, broadcasted: false, wave, nextWaveMs: null });
  }

  // Не подтверждена — запускаем broadcast через внутренний вызов
  try {
    const broadcastRes = await fetchTimeout(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid, plan: 'premium' })
    }, 25000);

    const data = await broadcastRes.json();
    const nextWave = parseInt(wave) + 1;
    const nextWaveMs = nextWave < WAVE_DELAYS.length ? WAVE_DELAYS[nextWave] - WAVE_DELAYS[parseInt(wave)] : null;

    return res.status(200).json({
      confirmed: false,
      broadcasted: true,
      wave,
      nextWave: nextWave < WAVE_DELAYS.length ? nextWave : null,
      nextWaveMs,
      broadcastSummary: data.summary,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
