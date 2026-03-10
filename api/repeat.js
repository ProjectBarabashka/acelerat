// ══════════════════════════════════════════════════════════════
//  TurboTX v8 ★ ADAPTIVE WAVES ★  —  /api/repeat.js
//  Vercel Serverless · Node.js 20
//
//  POST /api/repeat
//  Body: { txid, wave:1-8, token?, startedAt? }
//  Headers: X-TurboTX-Token: <secret>
//
//  УЛУЧШЕНИЯ v8:
//  ⑦ Congestion backoff — при сети >150 sat/vB интервал ×1.5
//     При снижении нагрузки интервал ÷1.5 (ускоряем)
//  ⑧ Самовосстановление — клиент передаёт startedAt + waveStrategy,
//     сервер определяет пропущенные волны при Vercel cold start
//     и немедленно запускает догоняющий broadcast
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 35 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TurboTX-Token',
};

const BASE_INTERVALS = [
  15  * 60_000,   // wave 1
  15  * 60_000,   // wave 2
  30  * 60_000,   // wave 3
  60  * 60_000,   // wave 4
  120 * 60_000,   // wave 5
  120 * 60_000,   // wave 6  ← v8: aggressive strategy
  120 * 60_000,   // wave 7
  120 * 60_000,   // wave 8
];
const MAX_WAVES = 8;

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

// ─── ⑦ CONGESTION BACKOFF ────────────────────────────────────
// Если сеть перегружена (>150 sat/vB) → ×1.5 интервал (ждать бессмысленно)
// Если разгрузилась и TX конкурентоспособна → ÷1.5 (ускоряем!)
// Если TX почти в следующем блоке → 5 мин максимум
function adaptiveNextInterval(waveNum, txFeeRate, fees, baseInterval) {
  if (!fees || !txFeeRate) return { ms: baseInterval, reason: 'no_data' };
  const fastest  = fees.fastestFee  || 50;
  const halfHour = fees.halfHourFee || 30;
  const ratio    = txFeeRate / fastest;

  // TX конкурентоспособна — следующий блок уже близко
  if (ratio >= 0.9)
    return { ms: Math.min(baseInterval, 5 * 60_000), reason: 'tx_competitive' };

  // Близко к halfHour — ускорить интервал
  if (txFeeRate >= halfHour * 0.8)
    return { ms: Math.round(baseInterval * 0.6), reason: 'near_confirmation' };

  // ⑦ Сеть критически перегружена → ×1.5 (нет смысла слать в пул каждые 15 мин)
  if (fastest > 150)
    return { ms: Math.round(baseInterval * 1.5), reason: 'high_congestion', needCpfp: true };

  // Умеренная перегрузка, но сеть разгружается (сравниваем с halfHour)
  if (fastest > 80 && halfHour < fastest * 0.7)
    return { ms: Math.round(baseInterval * 0.8), reason: 'congestion_clearing' };

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

  const { txid, wave = 1, startedAt, waveIntervalMs } = req.body || {};
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ ok: false, error: 'Invalid TXID' });

  let waveNum = parseInt(wave) || 1;
  if (waveNum < 1 || waveNum > MAX_WAVES)
    return res.status(400).json({ ok: false, error: `Wave must be 1-${MAX_WAVES}` });

  // ⑧ Самовосстановление — проверяем не пропустили ли волны
  // Если startedAt и waveIntervalMs переданы, вычисляем какая волна должна быть сейчас
  let recoveredWaves = 0;
  if (startedAt && waveIntervalMs && waveNum > 1) {
    const elapsed = Date.now() - parseInt(startedAt);
    const expectedWave = Math.min(MAX_WAVES, Math.floor(elapsed / waveIntervalMs) + 1);
    if (expectedWave > waveNum) {
      recoveredWaves = expectedWave - waveNum;
      waveNum = expectedWave; // догоняем
      console.log(`[repeat] recovery: пропущено ${recoveredWaves} волн, стартуем с волны ${waveNum}`);
    }
  }

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
    nextWave:    waveNum < MAX_WAVES ? waveNum+1 : null,
    nextWaveMs,
    adaptiveReason: adaptive.reason,
    txFeeRate, networkFastest: fastest,
    ratio: txFeeRate && fastest ? +(txFeeRate/fastest).toFixed(2) : null,
    needCpfp, cpfpFeeNeeded: cpfpFee,
    broadcastSummary: broadcastData?.summary      ?? null,
    hashrateReach:    broadcastData?.summary?.hashrateReach ?? 0,
    waveStrategy: broadcastData?.waveStrategy ?? null,
    recommendedNextWaveMs: broadcastData?.waveStrategy?.intervalMs ?? nextWaveMs,
    // ⑧ Информация о восстановлении
    ...(recoveredWaves > 0 ? { recoveredWaves, recoveryNote: `Пропущено ${recoveredWaves} волн — догнали` } : {}),
  });
}
