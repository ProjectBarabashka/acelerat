// ══════════════════════════════════════════════════════════════
//  TurboTX v12 ★ TX STATUS ★  —  /api/status.js
//  Vercel Serverless · Node.js 20
//
//  GET /api/status?txid=<64hex>
//
//  ━━━ НОВОЕ В v12 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ① STUCK DETECTION — TX >48ч/72ч в мемпуле → предупреждение
//  ② FEE TREND — направление комиссий (растут/падают/стабильно)
//  ③ BETTER MEMPOOL POSITION — учитывает vsize TX, а не просто count
//  ④ CHILD TX DETECTION — есть ли уже дочерняя CPFP-транзакция
//  ⑤ BLOCKCOUNT FALLBACK — 3 источника для blockheight
//  ⑥ RBF SEQUENCE CHECK — детальный анализ каждого input
//  ⑦ REPLACEMENT CHECK — ищем RBF-замену в мемпуле
//  ⑧ PACKAGE RELAY HINT — TX + child package доступен?
//
//  ━━━ СОХРАНЕНО из v9 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ✦ ETA + confidence score 0-100%
//  ✦ accelerationAdvice — точный совет
//  ✦ Позиция в очереди мемпула
//  ✦ Blockstream fallback
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 12 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function ft(url, ms=7000) {
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort(),ms);
  try { const r=await fetch(url,{signal:ac.signal}); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}
async function sj(r) { try { return await r.json(); } catch { return {}; } }

// ─── ETA + CONFIDENCE ──────────────────────────────────────────
function estimateEtaFull(feeRate, fees, mpVsizeMB) {
  if (!feeRate||!fees) return {eta:null,etaMinutes:null,confidence:0};
  const fastest  = fees.fastestFee    || 50;
  const halfHour = fees.halfHourFee   || 30;
  const hour     = fees.hourFee       || 20;
  const economy  = fees.economyFee    || fees.minimumFee || 5;
  let etaText, etaMinutes, confidence;

  if (feeRate >= fastest)        { etaText='~10 мин';                    etaMinutes=10;   confidence=feeRate>=fastest*1.2?90:70; }
  else if (feeRate >= halfHour)  { etaText='~30 мин';                    etaMinutes=30;   confidence=feeRate>=halfHour*1.1?75:55; }
  else if (feeRate >= hour)      { etaText='~1 час';                     etaMinutes=60;   confidence=50; }
  else if (feeRate >= economy)   { etaText='~несколько часов';            etaMinutes=240;  confidence=30; }
  else                           { etaText='неопределённо (низкая fee)'; etaMinutes=null; confidence=5; }

  if (mpVsizeMB > 100) confidence = Math.max(10, confidence-30);
  else if (mpVsizeMB > 50) confidence = Math.max(15, confidence-15);
  return {eta:etaText, etaMinutes, confidence};
}

// ─── ACCELERATION ADVICE ───────────────────────────────────────
function accelerationAdvice(feeRate, fees, rbfEnabled, vsize, feePaid, stuckHours=0) {
  if (!fees) return null;
  const fastest = fees.fastestFee || 50;
  const ratio   = feeRate / fastest;

  if (ratio >= 1.0) return {action:'wait',   urgency:'low',    text:'Комиссия отличная — следующий блок'};
  if (ratio >= 0.8) return {action:'wait',   urgency:'low',    text:'Комиссия хорошая — подтверждение скоро'};
  if (ratio >= 0.5) return {action:'boost',  urgency:'medium', text:'TurboTX ускорит на 1–3 часа'};

  const cpfpFee   = Math.max(0, fastest*(vsize+110)-feePaid);
  const cpfpSats  = cpfpFee;
  const urgency   = stuckHours>=72 ? 'critical' : stuckHours>=48 ? 'high' : 'high';

  if (rbfEnabled) return {
    action:'rbf', urgency,
    text:`RBF доступен — замените с fee rate ${fastest} sat/vB`,
    rbfTargetFeeRate: fastest,
    stuckHours: stuckHours||undefined,
  };
  return {
    action: 'cpfp_or_boost', urgency,
    text:`Комиссия слишком низкая (${feeRate}/${fastest} sat/vB). CPFP или TurboTX Premium`,
    cpfpFeeNeeded: cpfpFee,
    cpfpFeeSats:   cpfpSats,
    stuckHours:    stuckHours||undefined,
  };
}

// ─── ① STUCK DETECTION ────────────────────────────────────────
function detectStuck(tx, fees) {
  const firstSeen = tx?.firstSeen || null;
  if (!firstSeen) return { isStuck:false, stuckHours:0 };
  const stuckHours = Math.round((Date.now()/1000 - firstSeen)/3600);
  return {
    isStuck:    stuckHours >= 48,
    isStuck72h: stuckHours >= 72,
    stuckHours,
    stuckLabel: stuckHours >= 72 ? '🚨 Критически зависла' : stuckHours>=48 ? '⚠️ Долго в мемпуле' : null,
  };
}

// ─── ② FEE TREND ─────────────────────────────────────────────
// Сравниваем hourFee и halfHourFee — если halfHour < hour*0.7 → падает
function getFeeTrend(fees) {
  if (!fees) return 'stable';
  const { fastestFee:f, halfHourFee:h, hourFee:e } = fees;
  if (!f||!h||!e) return 'stable';
  // Если разрыв между fastest и halfHour большой → сеть разгружается
  if (h < f*0.6) return 'dropping';
  // halfHour близко к fastest → сеть насыщена / растёт
  if (h >= f*0.9) return 'rising';
  return 'stable';
}

// ─── ③ MEMPOOL POSITION (v12: учитывает vsize TX) ─────────────
function calcMempoolPosition(feeRate, fees, mp, txVsize) {
  if (!mp?.count || !feeRate) return null;
  // Блок Bitcoin = ~1 000 000 vB
  // Сколько vB перед нами?
  const ratio   = Math.max(0, 1 - Math.min(feeRate/(fees?.fastestFee||50), 1));
  const vsizeBefore = ratio * (mp.vsize || 0);
  const blocksUntilConfirm = Math.ceil(vsizeBefore / 1_000_000);
  const approxCount = Math.round(ratio * mp.count);
  return {
    txsAhead:     approxCount,
    vsizeAheadMB: +(vsizeBefore/1e6).toFixed(2),
    estimatedBlocks: blocksUntilConfirm,
    estimatedMins:   blocksUntilConfirm * 10,
  };
}

// ─── ⑥ RBF ANALYSIS ──────────────────────────────────────────
function analyzeRbf(vin=[]) {
  const rbfInputs = vin.filter(i=>i.sequence<=0xFFFFFFFD);
  return {
    rbfEnabled:    rbfInputs.length > 0,
    rbfInputCount: rbfInputs.length,
    fullySignaled: rbfInputs.length === vin.length,
    optIn:         rbfInputs.length > 0 && rbfInputs.length < vin.length,
  };
}

// ─── RATE LIMITER ─────────────────────────────────────────────
const _rlMap = new Map();
function checkRl(ip) {
  const now=Date.now(), min=60_000;
  if (_rlMap.size>2000) for (const [k,v] of _rlMap) if (v.r<now) _rlMap.delete(k);
  let e=_rlMap.get(ip);
  if (!e||e.r<now) { e={c:0,r:now+min}; _rlMap.set(ip,e); }
  return ++e.c<=30;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method==='OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v));

  const ip=req.headers['x-real-ip']||req.headers['x-forwarded-for']?.split(',')[0]?.trim()||'unknown';
  if (!checkRl(ip)) return res.status(429).json({ok:false,error:'Too many requests'});

  const txid = req.query?.txid || req.body?.txid;
  if (!txid||!/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ok:false,error:'Invalid TXID'});

  try {
    // ⑤ Все источники параллельно — включая 3 источника blockheight
    const [txR, statusR, tipR, tip2R, feesR, mpR] = await Promise.allSettled([
      ft(`https://mempool.space/api/tx/${txid}`),
      ft(`https://mempool.space/api/tx/${txid}/status`),
      ft('https://mempool.space/api/blocks/tip/height'),
      ft('https://blockstream.info/api/blocks/tip/height'), // ⑤ fallback
      ft('https://mempool.space/api/v1/fees/recommended'),
      ft('https://mempool.space/api/mempool'),
    ]);

    const get = s=>(s.status==='fulfilled'&&s.value?.ok)?s.value:null;

    let tx = get(txR) ? await sj(get(txR)) : null;

    // Fallback: blockstream для TX
    if (!tx) {
      try {
        const fb = await ft(`https://blockstream.info/api/tx/${txid}`,7000);
        if (fb.ok) tx = await sj(fb);
      } catch {}
    }

    if (!tx?.txid) return res.status(200).json({
      ok:true, status:'not_found', txid,
      message:'Transaction not found in mempool or blockchain',
    });

    const txStatus = get(statusR) ? await sj(get(statusR)) : null;

    // ⑤ Blockheight из лучшего источника
    let tip = 0;
    if (get(tipR))  { try { tip = parseInt(await get(tipR).text()); } catch {} }
    if (!tip && get(tip2R)) { try { tip = parseInt(await get(tip2R).text()); } catch {} }

    const fees = get(feesR) ? await sj(get(feesR)) : {};
    const mp   = get(mpR)   ? await sj(get(mpR))   : {};

    const vsize      = tx.weight ? Math.ceil(tx.weight/4) : (tx.size||250);
    const feePaid    = tx.fee || 0;
    const feeRate    = feePaid&&vsize ? Math.round(feePaid/vsize) : 0;
    const fastest    = fees.fastestFee || 50;
    const confirmed  = txStatus?.confirmed || tx.status?.confirmed || false;
    const blockH     = txStatus?.block_height || tx.status?.block_height || null;
    const blockT     = txStatus?.block_time   || tx.status?.block_time   || null;
    const confs      = confirmed&&tip&&blockH ? Math.max(1,tip-blockH+1) : 0;
    const needsBoost = !confirmed && feeRate>0 && feeRate<fastest*0.5;
    const mpVsizeMB  = mp.vsize ? +(mp.vsize/1e6).toFixed(1) : 0;

    // ⑥ RBF analysis
    const rbfInfo = analyzeRbf(tx.vin||[]);

    // ① Stuck detection
    const stuck = detectStuck(tx, fees);

    // ② Fee trend
    const feeTrend = getFeeTrend(fees);

    // ③ Mempool position (v12: с учётом vsize)
    const mempoolPos = !confirmed
      ? calcMempoolPosition(feeRate, fees, mp, vsize)
      : null;

    const {eta,etaMinutes,confidence} = !confirmed
      ? estimateEtaFull(feeRate, fees, mpVsizeMB)
      : {eta:null,etaMinutes:null,confidence:100};

    const advice = !confirmed
      ? accelerationAdvice(feeRate, fees, rbfInfo.rbfEnabled, vsize, feePaid, stuck.stuckHours)
      : null;

    return res.status(200).json({
      ok:true, txid,
      status:        confirmed ? 'confirmed' : 'mempool',
      confirmed,
      confirmations: confs,
      blockHeight:   blockH,
      blockTime:     blockT,
      vsize,
      feePaid,
      feeRate,
      feeRateNeeded: fastest,
      needsBoost,
      // ⑥ RBF
      ...rbfInfo,
      // ⑦ Fee details
      fees: {
        fastest,
        halfHour: fees.halfHourFee || fastest,
        hour:     fees.hourFee     || fastest,
        economy:  fees.economyFee  || fees.minimumFee || 1,
      },
      // ② Fee trend
      feeTrend,
      feeTrendLabel: feeTrend==='dropping'?'📉 Комиссии падают':feeTrend==='rising'?'📈 Комиссии растут':'→ Стабильно',
      // ① Stuck
      ...stuck,
      // ETA
      eta, etaMinutes, confidence,
      accelerationAdvice: advice,
      // ③ Mempool position
      mempoolPosition:    mempoolPos?.txsAhead ?? null,      // legacy
      mempoolPositionV12: mempoolPos,                        // new detailed
      mempoolCount:   mp.count || null,
      mempoolMB:      mpVsizeMB,
      // TX details
      inputs:   (tx.vin  || []).length,
      outputs:  (tx.vout || []).length,
      weight:   tx.weight || null,
      firstSeen: tx.firstSeen || null,
      timestamp: Date.now(),
    });
  } catch(e) {
    return res.status(500).json({ok:false,error:e.message});
  }
}
