// ══════════════════════════════════════════════════════════════
//  TurboTX v14 ★ ADAPTIVE WAVES ★  —  /api/repeat.js
//  Vercel Serverless · Node.js 20 · Hobby Plan
//
//  POST /api/repeat
//  Body: { txid, wave:1-8, token?, startedAt?, waveIntervalMs? }
//  Headers: X-TurboTX-Token: <secret>
//
//  ━━━ ИСПРАВЛЕНО В v13 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  🐛 BUG FIX: nextWaveMs был null при wave<5, должен быть null при wave>=MAX_WAVES
//  🐛 BUG FIX: Восстановление пропущенных волн считало линейно,
//     но интервалы нелинейные (15/15/30/60/120/120/120/120 мин)
//  🐛 BUG FIX: Нет retry если /api/broadcast вернул ошибку — добавлен retry×2
//  🐛 BUG FIX: waveNum validated after parseInt but not clamped properly
//
//  ━━━ НОВОЕ В v13 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ① LAST-BLOCK-MINER per wave — каждая волна знает кто добыл
//     последний блок и приоритизирует этот пул
//  ② FEE TREND AWARENESS — если комиссии падают >30% → ускоряем
//     следующую волну; растут — замедляем (бесполезно ждать)
//  ③ WAVE SUCCESS TRACKING — если волна N покрыла >80% хешрейта,
//     следующий интервал увеличивается (TX и так в очереди топ-пулов)
//  ④ ANTI-STUCK BOOST — TX >48ч в мемпуле → сокращаем интервал ÷2
//     TX >72ч → каждая волна агрессивная (8 каналов, маx интенсивность)
//  ⑤ CONFIRMATION WEBHOOK — при подтверждении сразу пушим в TG
//  ⑥ BROADCAST RETRY — если /api/broadcast упал, ждём 3с и повторяем
//  ⑦ CONGESTION BACKOFF — сохранено из v11
//  ⑧ SELF-RECOVERY — улучшено: нелинейные интервалы
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 35 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TurboTX-Token',
};

// ─── УТИЛИТЫ ──────────────────────────────────────────────────
async function ft(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function sj(r) { try { return await r.json(); } catch { return {}; } }

// ─── RATE LIMITER ─────────────────────────────────────────────
const _rl = new Map();
function checkRl(ip) {
  const now = Date.now(), h = 3_600_000;
  if (_rl.size > 500) for (const [k,v] of _rl) if (v.r < now) _rl.delete(k);
  let e = _rl.get(ip);
  if (!e || e.r < now) { e = {c:0, r:now+h}; _rl.set(ip, e); }
  return ++e.c <= 30; // 30 repeat-запросов в час с одного IP
}

function getIp(req) {
  return req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

// ─── ИНТЕРВАЛЫ ВОЛН ───────────────────────────────────────────
// Каждый элемент — задержка ПЕРЕД этой волной (в мс)
// wave 1 = первая повторная волна через 15 мин после initial
const BASE_INTERVALS = [
  15  * 60_000,   // волна 1
  15  * 60_000,   // волна 2
  30  * 60_000,   // волна 3
  60  * 60_000,   // волна 4
  120 * 60_000,   // волна 5
  120 * 60_000,   // волна 6
  120 * 60_000,   // волна 7
  120 * 60_000,   // волна 8
  180 * 60_000,   // волна 9  ← v14: для TX 18+ часов в мемпуле
  180 * 60_000,   // волна 10 ← v14: финальная агрессивная волна
];
const MAX_WAVES = 10; // v14: было 8

// Суммарное время до волны N (для восстановления)
function cumulativeMsToWave(targetWave) {
  return BASE_INTERVALS
    .slice(0, Math.min(targetWave - 1, MAX_WAVES - 1))
    .reduce((s, v) => s + v, 0);
}

// ─── ВНЕШНИЕ ДАННЫЕ ───────────────────────────────────────────
async function getTxFeeAndStatus(txid) {
  const [txR, feesR, statusR] = await Promise.allSettled([
    ft(`https://mempool.space/api/tx/${txid}`, {}, 7000),
    ft('https://mempool.space/api/v1/fees/recommended', {}, 5000),
    ft(`https://mempool.space/api/tx/${txid}/status`, {}, 6000),
  ]);
  const tx     = txR.status==='fulfilled'     && txR.value?.ok     ? await sj(txR.value)     : null;
  const fees   = feesR.status==='fulfilled'   && feesR.value?.ok   ? await sj(feesR.value)   : null;
  const status = statusR.status==='fulfilled' && statusR.value?.ok ? await sj(statusR.value) : null;
  return { tx, fees, status };
}

// Подтверждение — проверяем 3 источника параллельно (v14: +Blockchair)
async function isTxConfirmed(txid) {
  const check = async (url, parse) => {
    try {
      const r = await ft(url, {}, 6000);
      if (r.ok) { const s = await parse(r); if (s?.confirmed) return s; }
    } catch {}
    return null;
  };
  const [a, b, c] = await Promise.allSettled([
    check(`https://mempool.space/api/tx/${txid}/status`,    r => r.json()),
    check(`https://blockstream.info/api/tx/${txid}/status`, r => r.json()),
    check(`https://api.blockchair.com/bitcoin/transactions?q=hash(${txid})`, async r => {
      const j = await r.json();
      const tx = j?.data?.[0];
      return tx?.block_id ? { confirmed: true, block_height: tx.block_id, block_time: tx.time } : null;
    }),
  ]);
  const s = (a.status==='fulfilled' && a.value) ||
            (b.status==='fulfilled' && b.value) ||
            (c.status==='fulfilled' && c.value);
  return s
    ? { confirmed:true, blockHeight:s.block_height, blockTime:s.block_time }
    : { confirmed:false };
}

// ─── ① LAST-BLOCK-MINER (per wave) ───────────────────────────
// Кэш актуален 60 секунд — каждая волна получает свежие данные
const _lbmCache = { miner:null, at:0 };
async function detectLastBlockMiner() {
  if (_lbmCache.miner && Date.now()-_lbmCache.at < 60_000) return _lbmCache.miner;
  try {
    const r = await ft('https://mempool.space/api/v1/blocks/tip', {}, 5000);
    if (!r.ok) return null;
    const blocks = await sj(r);
    const block  = Array.isArray(blocks) ? blocks[0] : blocks;
    const poolName = (block?.extras?.pool?.name || block?.pool?.name || '').toLowerCase();
    const MAP = {
      'foundry':'Foundry','antpool':'AntPool','mara':'MaraSlipstream',
      'marathon':'MaraSlipstream','viabtc':'ViaBTC','spiderpool':'SpiderPool',
      'f2pool':'F2Pool','luxor':'Luxor','clvpool':'CloverPool','clover':'CloverPool',
      'bitfufu':'BitFuFu','btc.com':'BTC.com','ocean':'Ocean','emcd':'EMCDPool',
      'sbicrypto':'SBICrypto','2miners':'2Miners','rawpool':'Rawpool',
    };
    for (const [key, pool] of Object.entries(MAP)) {
      if (poolName.includes(key)) {
        _lbmCache.miner = pool;
        _lbmCache.at    = Date.now();
        return pool;
      }
    }
  } catch {}
  return null;
}

// ─── ② FEE TREND ─────────────────────────────────────────────
// Сравниваем текущий fastest с предыдущим измерением
let _prevFastest = 0;
function getFeeTrend(currentFastest) {
  if (!_prevFastest) { _prevFastest = currentFastest; return 'stable'; }
  const ratio = currentFastest / _prevFastest;
  _prevFastest = currentFastest;
  if (ratio < 0.7) return 'dropping';   // упали >30%
  if (ratio > 1.3) return 'rising';     // выросли >30%
  return 'stable';
}

// ─── ③ WAVE SUCCESS TRACKING ─────────────────────────────────
// Храним результат предыдущей волны
const _waveHistory = new Map(); // txid → { wave, hashrateReach, okCount }

// ─── ⑦ ADAPTIVE INTERVAL ──────────────────────────────────────
function adaptiveNextInterval(waveNum, txFeeRate, fees, baseInterval, opts = {}) {
  const { feeTrend='stable', stuckHours=0, prevHashrateReach=0 } = opts;
  if (!fees || !txFeeRate) return { ms: baseInterval, reason: 'no_data' };

  const fastest  = fees.fastestFee  || 50;
  const halfHour = fees.halfHourFee || 30;
  const ratio    = txFeeRate / fastest;
  let ms         = baseInterval;
  let reason     = 'normal';

  // ④ Anti-stuck: TX давно в мемпуле → ускоряем
  if (stuckHours >= 72) {
    ms = Math.min(baseInterval, 10 * 60_000);
    reason = 'stuck_72h';
  } else if (stuckHours >= 48) {
    ms = Math.round(baseInterval * 0.5);
    reason = 'stuck_48h';
  }

  // TX почти готова к майнингу
  if (ratio >= 0.9) return { ms: Math.min(ms, 5*60_000), reason:'tx_competitive' };
  if (txFeeRate >= halfHour * 0.8) return { ms: Math.round(ms*0.6), reason:'near_confirmation' };

  // ② Fee trend
  if (feeTrend === 'dropping') {
    ms = Math.round(ms * 0.75); // комиссии падают → ускоряемся
    reason = reason==='normal' ? 'fees_dropping' : reason;
  } else if (feeTrend === 'rising') {
    ms = Math.round(ms * 1.3); // растут → нет смысла спешить
    reason = reason==='normal' ? 'fees_rising' : reason;
  }

  // ③ Если прошлая волна хорошо покрыла хешрейт → чуть ждём больше
  if (prevHashrateReach >= 80 && feeTrend !== 'dropping') {
    ms = Math.round(ms * 1.2);
    reason = reason==='normal' ? 'good_prev_coverage' : reason;
  }

  // Congestion backoff
  if (fastest > 150) {
    ms = Math.round(ms * 1.5);
    reason = 'high_congestion';
  } else if (fastest > 80 && halfHour < fastest * 0.7) {
    ms = Math.round(ms * 0.8);
    reason = 'congestion_clearing';
  }

  return { ms, reason };
}

function baseUrl() {
  return process.env.PRODUCTION_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}

// ─── ⑥ BROADCAST WITH RETRY ───────────────────────────────────
async function broadcastWithRetry(url, token, txid, lastBlockMiner, tries=2) {
  for (let i=0; i<=tries; i++) {
    try {
      const r = await ft(url, {
        method:  'POST',
        headers: { 'Content-Type':'application/json', 'X-TurboTX-Token':token||'' },
        body:    JSON.stringify({
          txid, plan:'premium', token,
          ...(lastBlockMiner ? {lastBlockMinerHint:lastBlockMiner} : {}),
        }),
      }, 30000);
      if (r.ok || r.status < 500) return await sj(r);
      if (i < tries) await sleep(3000*(i+1));
    } catch(e) {
      if (i===tries) throw e;
      await sleep(3000*(i+1));
    }
  }
}

// ─── ⑤ TELEGRAM CONFIRMATION PUSH ────────────────────────────
async function tgConfirmed(txid, blockHeight, waveNum) {
  const token = process.env.TG_TOKEN, chat = process.env.TG_CHAT_ID;
  if (!token||!chat) return;
  const text = [
    `✅ *TX ПОДТВЕРЖДЕНА!*`,
    `📋 \`${txid.slice(0,14)}…${txid.slice(-6)}\``,
    `📦 Блок #${blockHeight}`,
    `🌊 Подтверждена после волны ${waveNum}`,
    `🕐 ${new Date().toLocaleString('ru',{timeZone:'Europe/Moscow'})} МСК`,
  ].join('\n');
  ft(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      chat_id:chat, text, parse_mode:'Markdown',
      reply_markup:{inline_keyboard:[[{text:'🔍 Explorer',url:`https://mempool.space/tx/${txid}`}]]},
    }),
  }, 5000).catch(()=>{});
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'POST only' });

  const ip = getIp(req);
  if (!checkRl(ip)) return res.status(429).json({ ok:false, error:'Too many requests' });

  const secret = process.env.PREMIUM_SECRET;
  const token  = req.headers['x-turbotx-token'] || req.body?.token;
  if (secret && token !== secret)
    return res.status(401).json({ ok:false, error:'Premium token required' });

  const { txid, wave=1, startedAt, waveIntervalMs } = req.body || {};
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ ok:false, error:'Invalid TXID' });

  // BUG FIX: правильный clamp
  let waveNum = Math.max(1, Math.min(MAX_WAVES, parseInt(wave)||1));

  // ─── ⑧ SELF-RECOVERY (УЛУЧШЕНО) ─────────────────────────────
  // v12: используем накопленные интервалы (нелинейные), а не просто elapsed/singleInterval
  let recoveredWaves = 0;
  if (startedAt) {
    const elapsed = Date.now() - parseInt(startedAt);
    // Находим какая волна должна была случиться к этому времени
    let expectedWave = 1;
    for (let w=2; w<=MAX_WAVES; w++) {
      if (elapsed >= cumulativeMsToWave(w)) expectedWave = w;
      else break;
    }
    if (expectedWave > waveNum) {
      recoveredWaves = expectedWave - waveNum;
      waveNum = expectedWave;
    }
  }

  // Собираем данные параллельно
  const [confirmedRes, dataRes, lbmRes] = await Promise.allSettled([
    isTxConfirmed(txid),
    getTxFeeAndStatus(txid),
    detectLastBlockMiner(),
  ]);

  const confirmed    = confirmedRes.status==='fulfilled' ? confirmedRes.value : {confirmed:false};
  const { tx, fees } = dataRes.status==='fulfilled'      ? dataRes.value      : {tx:null, fees:null};
  const lastBlock    = lbmRes.status==='fulfilled'        ? lbmRes.value       : null;

  // ─── ⑤ Подтверждена? ─────────────────────────────────────────
  if (confirmed.confirmed) {
    tgConfirmed(txid, confirmed.blockHeight, waveNum);
    return res.status(200).json({
      confirmed:true, broadcasted:false, wave:waveNum, nextWaveMs:null,
      blockHeight:confirmed.blockHeight, blockTime:confirmed.blockTime,
      message:`✅ Confirmed at block ${confirmed.blockHeight}`,
    });
  }

  // Анализ TX
  const vsize     = tx ? (tx.weight ? Math.ceil(tx.weight/4) : (tx.size||250)) : 250;
  const feePaid   = tx?.fee || 0;
  const txFeeRate = feePaid && vsize ? Math.round(feePaid/vsize) : 0;
  const fastest   = fees?.fastestFee || 50;
  const needCpfp  = txFeeRate > 0 && txFeeRate < fastest * 0.4;
  const cpfpFee   = needCpfp ? Math.max(0, fastest*(vsize+110)-feePaid) : 0;

  // ④ Stuck detection
  const firstSeen  = tx?.firstSeen || tx?.status?.block_time || null;
  const stuckHours = firstSeen ? Math.round((Date.now()/1000 - firstSeen)/3600) : 0;
  const isStuck72h = stuckHours >= 72;
  const isStuck48h = stuckHours >= 48;

  // ② Fee trend
  const feeTrend = getFeeTrend(fastest);

  // ③ Предыдущая волна
  const prevWaveData = _waveHistory.get(txid) || {};

  // Адаптивный интервал
  const baseMs   = BASE_INTERVALS[Math.min(waveNum-1, BASE_INTERVALS.length-1)];
  const adaptive = adaptiveNextInterval(waveNum, txFeeRate, fees, baseMs, {
    feeTrend,
    stuckHours,
    prevHashrateReach: prevWaveData.hashrateReach || 0,
  });

  // BUG FIX v12: nextWaveMs=null только если ПОСЛЕДНЯЯ волна, не если wave<5
  const nextWaveMs = waveNum < MAX_WAVES ? adaptive.ms : null;

  // ─── ⑥ BROADCAST С RETRY ──────────────────────────────────────
  let broadcastData = null;
  let broadcastError = null;
  try {
    broadcastData = await broadcastWithRetry(
      `${baseUrl()}/api/broadcast`, token, txid, lastBlock
    );
  } catch(e) {
    broadcastError = e.message;
  }

  // ③ Сохраняем результат волны
  if (broadcastData?.summary) {
    _waveHistory.set(txid, {
      wave: waveNum,
      hashrateReach: broadcastData.summary.hashrateReach || 0,
      okCount: broadcastData.summary.ok || 0,
      at: Date.now(),
    });
    // Чистим старые записи
    if (_waveHistory.size > 500) {
      const oldest = [..._waveHistory.entries()].sort((a,b)=>a[1].at-b[1].at)[0];
      if (oldest) _waveHistory.delete(oldest[0]);
    }
  }

  return res.status(200).json({
    ok: !broadcastError,
    confirmed:      false,
    broadcasted:    !broadcastError,
    wave:           waveNum,
    nextWave:       waveNum < MAX_WAVES ? waveNum+1 : null,
    nextWaveMs,                          // BUG FIXED: был null при wave<5
    adaptiveReason: adaptive.reason,
    txFeeRate,
    networkFastest: fastest,
    ratio:          txFeeRate && fastest ? +(txFeeRate/fastest).toFixed(2) : null,
    feeTrend,                            // NEW: направление комиссий
    needCpfp,
    cpfpFeeNeeded:  cpfpFee,
    stuckHours,
    isStuck72h,                          // NEW: флаг залипания
    isStuck48h,
    lastBlockMiner: lastBlock,           // NEW: кто добыл последний блок
    broadcastSummary:       broadcastData?.summary      ?? null,
    hashrateReach:          broadcastData?.summary?.hashrateReach ?? 0,
    waveStrategy:           broadcastData?.waveStrategy ?? null,
    recommendedNextWaveMs:  broadcastData?.waveStrategy?.intervalMs ?? nextWaveMs,
    ...(broadcastError ? { broadcastError } : {}),
    ...(recoveredWaves > 0 ? {
      recoveredWaves,
      recoveryNote:`Пропущено ${recoveredWaves} волн (нелинейные интервалы) — догнали`
    } : {}),
  });
}
