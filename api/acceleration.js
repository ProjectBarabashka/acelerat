// ══════════════════════════════════════════════════════════════
//  TurboTX v12 ★ SMART ADVISOR ★  —  /api/acceleration.js
//  Vercel Serverless · Node.js 20
//
//  GET /api/acceleration?txid=<64hex>[&hex=<rawHex>]
//
//  Умный советник — отвечает на один вопрос:
//  "Что КОНКРЕТНО нужно сделать с этой транзакцией прямо сейчас?"
//
//  Возвращает:
//  ① DECISION — boost / rbf / cpfp / wait / already_confirmed / not_found
//  ② URGENCY  — low / medium / high / critical
//  ③ EXACT NUMBERS — сколько sat нужно для CPFP/RBF, сколько ждать
//  ④ TIME FORECAST — когда подтвердится БЕЗ ускорения vs С ускорением
//  ⑤ COST ANALYSIS — во сколько USD обойдётся каждый вариант
//  ⑥ MEMPOOL FORECAST — через сколько блоков TX выйдет из мемпула
//  ⑦ CURRENT MINER   — кто добывает прямо сейчас → кому слать первым
//  ⑧ FEE MARKET WINDOW — когда ближайший провал загрузки (дёшево)
//  ⑨ STUCK RESCUE PLAN — если зависла >72ч → пошаговый план спасения
//
//  Конкуренты: дают только «нажми ускорить».
//  TurboTX: даёт точные цифры + прогноз + альтернативы.
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 15 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function ft(url, ms=8000) {
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort(),ms);
  try { const r=await fetch(url,{signal:ac.signal}); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}
async function sj(r) { try { return await r.json(); } catch { return {}; } }

// Rate limiter
const _rl=new Map();
function checkRl(ip){
  const now=Date.now(),min=60_000;
  if(_rl.size>3000) for(const[k,v]of _rl)if(v.r<now)_rl.delete(k);
  let e=_rl.get(ip);if(!e||e.r<now){e={c:0,r:now+min};_rl.set(ip,e);}
  return ++e.c<=20;
}
function getIp(req){
  return req.headers['x-real-ip']||req.headers['x-forwarded-for']?.split(',')[0]?.trim()||'unknown';
}

// ─── HASHRATE TABLE Q1 2026 ──────────────────────────────────
const HR = {
  Foundry:27, AntPool:16, MARA:11, ViaBTC:9, SpiderPool:8,
  F2Pool:7, Luxor:5, CloverPool:4, BitFuFu:4, 'BTC.com':3,
  Ocean:2, EMCDPool:2, SBICrypto:2,
};

// ─── POOL COINBASE TAGS ───────────────────────────────────────
const POOL_TAGS = {
  'foundry':'Foundry','antpool':'AntPool','mara':'MARA','marathon':'MARA',
  'viabtc':'ViaBTC','spiderpool':'SpiderPool','f2pool':'F2Pool',
  'luxor':'Luxor','clvpool':'CloverPool','bitfufu':'BitFuFu',
  'btc.com':'BTC.com','ocean':'Ocean','emcd':'EMCDPool','sbicrypto':'SBICrypto',
};

// ─── ⑦ CURRENT MINER (последние 3 блока) ─────────────────────
async function getCurrentMiners() {
  try {
    const r = await ft('https://mempool.space/api/v1/blocks/tip', {}, 5000);
    if (!r.ok) return null;
    const blocks = await sj(r);
    const arr = Array.isArray(blocks) ? blocks.slice(0,3) : [blocks];
    const miners = arr.map(b => {
      const poolName = (b?.extras?.pool?.name || b?.pool?.name || '').toLowerCase();
      for (const [key, pool] of Object.entries(POOL_TAGS)) {
        if (poolName.includes(key)) return pool;
      }
      return 'Unknown';
    }).filter(Boolean);

    const dominantMiner = miners[0]; // Последний блок
    const dominantHr    = HR[dominantMiner] || 0;
    return { recent: miners, dominant: dominantMiner, dominantHr };
  } catch { return null; }
}

// ─── ⑧ FEE MARKET WINDOW ─────────────────────────────────────
// Статистически дешевле всего UTC 02:00–06:00 (азиатская ночь + европейское утро)
// Даём пользователю точный прогноз
function cheapWindowForecast() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  // Дешёвое окно: 01:00–06:00 UTC
  const CHEAP_START = 1, CHEAP_END = 6;
  let hoursUntilCheap;

  if (utcHour >= CHEAP_START && utcHour < CHEAP_END) {
    // Сейчас дешёвое окно
    hoursUntilCheap = 0;
  } else if (utcHour < CHEAP_START) {
    hoursUntilCheap = CHEAP_START - utcHour;
  } else {
    // utcHour >= CHEAP_END
    hoursUntilCheap = 24 - utcHour + CHEAP_START;
  }

  const cheapUntilHour = CHEAP_END;
  return {
    isNowCheap:     hoursUntilCheap === 0,
    hoursUntilCheap,
    cheapWindowUtc: '01:00–06:00 UTC',
    cheapWindowMsk: '04:00–09:00 МСК',
    currentUtcHour: utcHour,
    tip: hoursUntilCheap === 0
      ? '💚 Сейчас дешёвое время — комиссии минимальны'
      : `⏰ Дешёвое окно через ${hoursUntilCheap}ч (${CHEAP_START}:00–${CHEAP_END}:00 UTC)`,
  };
}

// ─── COST ANALYSIS ────────────────────────────────────────────
function costAnalysis(feeRate, fastest, vsize, feePaid, btcPrice) {
  if (!btcPrice) return null;
  const SAT = 1e8;

  // Текущая комиссия TX
  const currentFeeSat  = feePaid;
  const currentFeeUsd  = +(currentFeeSat / SAT * btcPrice).toFixed(4);

  // CPFP: дочерняя TX (~110 vB) должна компенсировать нехватку родителя
  const cpfpNeededSat  = Math.max(0, fastest*(vsize+110) - feePaid);
  const cpfpFeeUsd     = +(cpfpNeededSat / SAT * btcPrice).toFixed(4);

  // RBF: заменяем TX с нужной fee rate
  const rbfTotalSat    = fastest * vsize;
  const rbfAdditSat    = Math.max(0, rbfTotalSat - feePaid);
  const rbfFeeUsd      = +(rbfAdditSat / SAT * btcPrice).toFixed(4);

  // TurboTX Premium: фиксированная цена (из /api/price логики)
  const turboUsd       = fastest > 150 ? 18 : fastest > 60 ? 12 : fastest > 30 ? 7 : fastest > 10 ? 4 : 3;

  return {
    currentFee:   { sat:currentFeeSat,  usd:currentFeeUsd },
    cpfpOption:   { sat:cpfpNeededSat,  usd:cpfpFeeUsd,  available: cpfpNeededSat > 0 },
    rbfOption:    { sat:rbfAdditSat,    usd:rbfFeeUsd,   available: rbfAdditSat > 0 },
    turboTxOption:{ usd:turboUsd,       note:'Фиксированная цена TurboTX Premium' },
    cheapest: cpfpNeededSat < rbfAdditSat && cpfpNeededSat < turboUsd*SAT/btcPrice
      ? 'cpfp' : rbfAdditSat < turboUsd*SAT/btcPrice ? 'rbf' : 'turbo',
    btcPrice,
  };
}

// ─── TIME FORECAST ────────────────────────────────────────────
function timeForecast(feeRate, fastest, halfHour, stuckHours) {
  const ratio = feeRate / (fastest || 50);

  // Без ускорения
  const withoutBoost =
    ratio >= 1.0  ? { blocks:1,  text:'~10 мин' }  :
    ratio >= 0.8  ? { blocks:1,  text:'~10–20 мин' }:
    ratio >= 0.5  ? { blocks:3,  text:'~30–60 мин' }:
    ratio >= 0.3  ? { blocks:6,  text:'~1–2 часа' } :
    ratio >= 0.1  ? { blocks:20, text:'~3–5 часов' }:
                    { blocks:144,text:'24+ часов или никогда' };

  // С TurboTX Premium (цель: приоритетная очередь в топ-пулах)
  const withBoost = ratio >= 0.5
    ? withoutBoost  // уже быстро
    : ratio >= 0.3
      ? { blocks:2, text:'~20–40 мин после ускорения' }
      : { blocks:4, text:'~40–90 мин после ускорения' };

  return { withoutBoost, withBoost, improvementBlocks: withoutBoost.blocks - withBoost.blocks };
}

// ─── ⑨ STUCK RESCUE PLAN ──────────────────────────────────────
function stuckRescuePlan(feeRate, fastest, vsize, feePaid, rbfEnabled, stuckHours) {
  if (stuckHours < 24) return null;

  const cpfpSat = Math.max(0, fastest*(vsize+110)-feePaid);
  const steps = [];

  if (stuckHours >= 72) {
    steps.push({ priority:1, action:'turbo_aggressive', label:'🚀 TurboTX Premium (8 волн, агрессивный режим)', note:'Немедленно — охват ~88% хешрейта за 4 часа' });
    if (rbfEnabled) steps.push({ priority:2, action:'rbf', label:`🔄 RBF: замените TX с ${fastest} sat/vB`, note:'Быстро, но нужен доступ к кошельку' });
    steps.push({ priority:3, action:'cpfp', label:`⚡ CPFP: дочерняя TX +${cpfpSat} sat`, note:'Если нет RBF — создайте дочернюю TX с высокой fee' });
    steps.push({ priority:4, action:'wait_window', label:'🌙 Ждите дешёвого окна (01:00–06:00 UTC)', note:'Мемпул чистится ночью — шанс пройти без дополнительных затрат' });
  } else if (stuckHours >= 48) {
    steps.push({ priority:1, action:'turbo', label:'⚡ TurboTX Premium (5 волн)', note:'Рекомендуется сейчас' });
    if (rbfEnabled) steps.push({ priority:2, action:'rbf', label:`🔄 RBF с ${fastest} sat/vB`, note:'Надёжный вариант' });
  } else {
    steps.push({ priority:1, action:'turbo_free', label:'🆓 Попробуйте TurboTX Free', note:'Часто помогает для TX 24–48ч' });
    steps.push({ priority:2, action:'wait', label:'⏳ Подождите дешёвое окно', note:'Может пройти само ночью' });
  }

  return {
    stuckHours,
    severity: stuckHours>=72 ? 'critical' : stuckHours>=48 ? 'high' : 'medium',
    severityLabel: stuckHours>=72 ? '🚨 Критически зависла' : stuckHours>=48 ? '⚠️ Давно в мемпуле' : '⏳ Зависает',
    steps,
  };
}

// ─── MAIN DECISION ENGINE ─────────────────────────────────────
async function makeDecision(txid, btcPrice, fees, tx, status, mp, miners) {
  const confirmed = status?.confirmed || tx?.status?.confirmed || false;
  if (confirmed) return {
    decision:'already_confirmed',
    urgency:'none',
    message:'✅ Транзакция уже подтверждена',
    blockHeight: status?.block_height || tx?.status?.block_height,
  };

  if (!tx?.txid) return {
    decision:'not_found',
    urgency:'none',
    message:'TX не найдена в мемпуле или блокчейне. Проверьте TXID.',
  };

  const fastest  = fees.fastestFee    || 50;
  const halfHour = fees.halfHourFee   || 30;
  const hour     = fees.hourFee       || 20;
  const vsize    = tx.weight ? Math.ceil(tx.weight/4) : (tx.size||250);
  const feePaid  = tx.fee || 0;
  const feeRate  = feePaid&&vsize ? Math.round(feePaid/vsize) : 0;
  const ratio    = feeRate / fastest;
  const rbfEnabled = Array.isArray(tx.vin) && tx.vin.some(i=>i.sequence<=0xFFFFFFFD);
  const mpVsizeMB  = mp.vsize ? +(mp.vsize/1e6).toFixed(1) : 0;

  // Stuck detection
  const firstSeen  = tx.firstSeen || null;
  const stuckHours = firstSeen ? Math.round((Date.now()/1000 - firstSeen)/3600) : 0;
  const isStuck72h = stuckHours >= 72;
  const isStuck48h = stuckHours >= 48;

  // Decision
  let decision, urgency, message;

  if (ratio >= 1.0) {
    decision = 'wait'; urgency = 'low';
    message = `Комиссия отличная (${feeRate}/${fastest} sat/vB). Следующий–второй блок.`;
  } else if (ratio >= 0.8 && !isStuck48h) {
    decision = 'wait'; urgency = 'low';
    message = `Комиссия хорошая (${feeRate}/${fastest} sat/vB). Подтверждение в течение 30 мин.`;
  } else if (isStuck72h) {
    decision = 'boost_aggressive'; urgency = 'critical';
    message = `TX зависла ${stuckHours}ч! Нужны срочные меры.`;
  } else if (ratio >= 0.5) {
    decision = 'boost'; urgency = 'medium';
    message = `TurboTX ускорит на 1–3 часа (${feeRate}/${fastest} sat/vB).`;
  } else if (rbfEnabled) {
    decision = 'rbf'; urgency = 'high';
    message = `Низкая комиссия (${feeRate}/${fastest} sat/vB). RBF доступен — лучшее решение.`;
  } else {
    decision = 'cpfp_or_boost'; urgency = 'high';
    message = `Очень низкая комиссия (${feeRate}/${fastest} sat/vB). Нужны CPFP или ускорение.`;
  }

  const costs = costAnalysis(feeRate, fastest, vsize, feePaid, btcPrice);
  const timing = timeForecast(feeRate, fastest, halfHour, stuckHours);
  const cheapWindow = cheapWindowForecast();
  const rescuePlan = stuckRescuePlan(feeRate, fastest, vsize, feePaid, rbfEnabled, stuckHours);

  // ③ Exact numbers for action
  const cpfpSat = Math.max(0, fastest*(vsize+110)-feePaid);
  const rbfSat  = Math.max(0, fastest*vsize - feePaid);

  return {
    decision, urgency, message,
    txid,
    feeAnalysis: {
      feeRate, feeRateNeeded:fastest,
      ratio:        +ratio.toFixed(3),
      ratioPercent: Math.round(ratio*100),
      feePaid,      vsize,
      rbfEnabled,
      rbfInputs: Array.isArray(tx.vin) ? tx.vin.filter(i=>i.sequence<=0xFFFFFFFD).length : 0,
    },
    fees: { fastest, halfHour, hour, economy: fees.economyFee||fees.minimumFee||1 },
    stuck: { stuckHours, isStuck48h, isStuck72h, firstSeen },
    // ③ exact numbers
    actionDetails: {
      cpfp: { neededSat:cpfpSat, neededUsd: btcPrice ? +(cpfpSat/1e8*btcPrice).toFixed(2):null, childVsize:110 },
      rbf:  { additionalSat:rbfSat, targetFeeRate:fastest },
      turboTx: { recommended: decision!=='wait', plan: isStuck72h?'premium_aggressive':ratio>=0.5?'free':'premium' },
    },
    // ④ time forecast
    timeForecast: timing,
    // ⑤ cost analysis
    costAnalysis: costs,
    // ⑥ mempool
    mempoolState: {
      txCount: mp.count||null,
      vsizeMB: mpVsizeMB,
      congestion: fastest>150?'critical':fastest>60?'high':fastest>20?'medium':'low',
    },
    // ⑦ current miner
    currentMiners: miners,
    // ⑧ cheap window
    cheapWindow,
    // ⑨ rescue plan (только если stuck)
    rescuePlan,
    timestamp: Date.now(),
  };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method==='OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v));

  const ip = req.headers['x-real-ip']||req.headers['x-forwarded-for']?.split(',')[0]?.trim()||'unknown';
  if (!checkRl(ip)) return res.status(429).json({ok:false,error:'Too many requests'});

  const txid = req.query?.txid || req.body?.txid;
  if (!txid||!/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ok:false,error:'Invalid TXID'});

  try {
    // Параллельно — все данные сразу
    const [txR, statusR, feesR, mpR, priceR, minersR] = await Promise.allSettled([
      ft(`https://mempool.space/api/tx/${txid}`),
      ft(`https://mempool.space/api/tx/${txid}/status`),
      ft('https://mempool.space/api/v1/fees/recommended'),
      ft('https://mempool.space/api/mempool'),
      ft('https://mempool.space/api/v1/prices'),
      getCurrentMiners(),
    ]);

    const get = s=>(s.status==='fulfilled'&&s.value?.ok)?s.value:null;
    let tx = get(txR) ? await sj(get(txR)) : null;
    if (!tx) {
      try { const fb=await ft(`https://blockstream.info/api/tx/${txid}`,7000); if(fb.ok) tx=await sj(fb); }
      catch {}
    }

    const status  = get(statusR) ? await sj(get(statusR))  : null;
    const fees    = get(feesR)   ? await sj(get(feesR))    : {};
    const mp      = get(mpR)     ? await sj(get(mpR))      : {};
    const priceData = get(priceR)? await sj(get(priceR))   : {};
    const miners  = minersR.status==='fulfilled' ? minersR.value : null;
    const btcPrice = priceData.USD || null;

    const result = await makeDecision(txid, btcPrice, fees, tx, status, mp, miners);
    return res.status(200).json({ ok:true, ...result });
  } catch(e) {
    return res.status(500).json({ok:false,error:e.message});
  }
}
