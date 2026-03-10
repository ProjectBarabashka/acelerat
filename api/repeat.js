// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ ADAPTIVE WAVES ★  —  /api/repeat.js
//  Vercel Serverless · Node.js 20
//
//  POST /api/repeat
//  Body: { txid, wave:1-5, token? }
//  Headers: X-TurboTX-Token: <secret>
//
//  ═══ АДАПТИВНЫЕ ВОЛНЫ (п.4) ════════════════════════════════
//  Перед каждой волной анализируем fee rate сети + TX.
//  Если сеть разгрузилась и TX конкурентоспособна — ускоряем.
//  Если перегружена — флагуем CPFP/RBF.
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 35 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TurboTX-Token',
};

const BASE_INTERVALS = [
  15  * 60_000,
  15  * 60_000,
  30  * 60_000,
  60  * 60_000,
  120 * 60_000,
];

async function ft(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}

async function getTxAndFees(txid) {
  const [txR, feesR] = await Promise.allSettled([
    ft(`https://mempool.space/api/tx/${txid}`, {}, 7000),
    ft('https://mempool.space/api/v1/fees/recommended', {}, 5000),
  ]);
  const tx   = txR.status==='fulfilled'   && txR.value.ok   ? await txR.value.json().catch(()=>null)   : null;
  const fees = feesR.status==='fulfilled' && feesR.value.ok ? await feesR.value.json().catch(()=>null) : null;
  return { tx, fees };
}

async function isTxConfirmed(txid) {
  const check = async (url) => {
    try { const r = await ft(url,{},6000); if(r.ok){const s=await r.json(); if(s.confirmed) return s;} } catch {}
    return null;
  };
  const s = await check(`https://mempool.space/api/tx/${txid}/status`)
         || await check(`https://blockstream.info/api/tx/${txid}/status`);
  return s ? { confirmed:true, blockHeight:s.block_height, blockTime:s.block_time }
           : { confirmed:false };
}

// ─── АДАПТИВНЫЙ ИНТЕРВАЛ ─────────────────────────────────────
function adaptiveNextInterval(waveNum, txFeeRate, fees, baseInterval) {
  if (!fees || !txFeeRate) return { ms: baseInterval, reason: 'no_data' };
  const fastest  = fees.fastestFee  || 50;
  const halfHour = fees.halfHourFee || 30;
  const ratio    = txFeeRate / fastest;

  // TX конкурентоспособна — сократить паузу
  if (ratio >= 0.9)
    return { ms: Math.min(baseInterval, 5 * 60_000), reason: 'tx_competitive' };
  // Близко к halfHour — ускорить
  if (txFeeRate >= halfHour * 0.8)
    return { ms: Math.round(baseInterval * 0.6), reason: 'near_confirmation' };
  // Сеть перегружена — нужен CPFP
  if (fastest > 150)
    return { ms: baseInterval, reason: 'high_congestion', needCpfp: true };

  return { ms: baseInterval, reason: 'normal' };
}

function baseUrl() {
  return process.env.PRODUCTION_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const secret = process.env.PREMIUM_SECRET;
  const token  = req.headers['x-turbotx-token'] || req.body?.token;
  if (secret && token !== secret)
    return res.status(401).json({ ok: false, error: 'Premium token required' });

  const { txid, wave = 1 } = req.body || {};
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ ok: false, error: 'Invalid TXID' });

  const waveNum = parseInt(wave) || 1;
  if (waveNum < 1 || waveNum > 5)
    return res.status(400).json({ ok: false, error: 'Wave must be 1-5' });

  // 1. Проверка + fee rates параллельно
  const [statusRes, dataRes] = await Promise.allSettled([
    isTxConfirmed(txid),
    getTxAndFees(txid),
  ]);
  const status = statusRes.status === 'fulfilled' ? statusRes.value : { confirmed: false };
  const { tx, fees } = dataRes.status === 'fulfilled' ? dataRes.value : { tx: null, fees: null };

  if (status.confirmed) {
    return res.status(200).json({
      confirmed:true, broadcasted:false, wave:waveNum, nextWaveMs:null,
      blockHeight:status.blockHeight, blockTime:status.blockTime,
      message:`✅ Confirmed at block ${status.blockHeight}`,
    });
  }

  // 2. Анализ TX
  const vsize     = tx ? (tx.weight ? Math.ceil(tx.weight/4) : (tx.size||250)) : 250;
  const feePaid   = tx?.fee || 0;
  const txFeeRate = feePaid && vsize ? Math.round(feePaid/vsize) : 0;
  const fastest   = fees?.fastestFee || 50;
  const needCpfp  = txFeeRate > 0 && txFeeRate < fastest * 0.4;
  const cpfpFee   = needCpfp ? Math.max(0, fastest*(vsize+110)-feePaid) : 0;

  // 3. Адаптивный интервал
  const baseMs   = BASE_INTERVALS[Math.min(waveNum-1, BASE_INTERVALS.length-1)];
  const adaptive = adaptiveNextInterval(waveNum, txFeeRate, fees, baseMs);
  const nextWaveMs = waveNum < 5 ? adaptive.ms : null;

  // 4. Broadcast
  let broadcastData = null;
  try {
    const r = await ft(`${baseUrl()}/api/broadcast`, {
      method:'POST',
      headers:{'Content-Type':'application/json','X-TurboTX-Token':token||''},
      body: JSON.stringify({ txid, plan:'premium', token }),
    }, 30000);
    broadcastData = await r.json();
  } catch(e) {
    return res.status(500).json({ ok:false, error:`Broadcast failed: ${e.message}` });
  }

  return res.status(200).json({
    confirmed:false, broadcasted:true, wave:waveNum,
    nextWave:    waveNum < 5 ? waveNum+1 : null,
    nextWaveMs,
    adaptiveReason: adaptive.reason,
    txFeeRate, networkFastest: fastest,
    ratio: txFeeRate && fastest ? +(txFeeRate/fastest).toFixed(2) : null,
    needCpfp, cpfpFeeNeeded: cpfpFee,
    broadcastSummary: broadcastData?.summary      ?? null,
    hashrateReach:    broadcastData?.summary?.hashrateReach ?? 0,
    // ③ Стратегия волн из broadcast (адаптивное кол-во волн)
    waveStrategy: broadcastData?.waveStrategy ?? null,
    // Если broadcast вернул другой интервал — используем его
    recommendedNextWaveMs: broadcastData?.waveStrategy?.intervalMs ?? nextWaveMs,
  });
}
