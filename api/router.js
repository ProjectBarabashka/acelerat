// ══════════════════════════════════════════════════════════════
//  TurboTX v14 ★ UNIFIED ROUTER ★  —  /api/router.js
//  Vercel Serverless · Node.js 20 · Hobby Plan
//
//  Единый файл объединяет 8 endpoints, экономя слоты функций:
//  /api/health  /api/status  /api/stats
//  /api/price   /api/mempool /api/cpfp
//  /api/rbf     /api/notify
//
//  Маршрутизация через query-параметр _fn:
//    GET /api/health   → vercel rewrite → /api/router?_fn=health
//    GET /api/status   → vercel rewrite → /api/router?_fn=status
//    ...и т.д.
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 20 };

import { CORS as CORS_ALL, ft, getIp, sj, makeRl } from './_shared.js';

// ─── УТИЛИТЫ ──────────────────────────────────────────────────
// ft(), sj(), getIp(), makeRl() — из _shared.js
// router.js передаёт явный ms=7000 там где нужен короткий таймаут


// ─── RATE LIMITER (shared across all handlers) ─────────────────
const checkRl = makeRl(30, 60_000); // 30 запросов / минуту с одного IP

// ══════════════════════════════════════════════════════════════
//  HEALTH  —  GET /api/health[?verbose=1]
// ══════════════════════════════════════════════════════════════
// v13: хешрейт обновлён Q1 2026 + новые пулы
const HR_HEALTH = {
  Foundry:27, AntPool:16, MARA:11, MaraSlipstream:11, ViaBTC:9, SpiderPool:8,
  F2Pool:7, Luxor:5, CloverPool:4, BitFuFu:4, 'BTC.com':3,
  Ocean:2, EMCDPool:2, SBICrypto:2,
  TxBoost:1, mempoolAccel:1, bitaccelerate:1, '360btc':1, txfaster:1, btcspeed:1,
  '2Miners':1, Rawpool:1, Lincoin:1,
};

// v14: 8 nodes + 23 pools = 31 канал, ~88% хешрейта
const HEALTH_CHANNELS = [
  // ── Hex nodes ─────────────────────────────────────────────
  { name:'mempool.space',    tier:'node', url:'https://mempool.space/api/blocks/tip/height',   method:'GET' },
  { name:'blockstream',      tier:'node', url:'https://blockstream.info/api/blocks/tip/height', method:'GET' },
  { name:'blockchair',       tier:'node', url:'https://api.blockchair.com/bitcoin/stats',        method:'GET' },
  { name:'blockcypher',      tier:'node', url:'https://api.blockcypher.com/v1/btc/main',         method:'GET' },
  { name:'btcscan',          tier:'node', url:'https://btcscan.org/api/blocks/tip/height',       method:'GET' },
  { name:'blockchain.info',  tier:'node', url:'https://blockchain.info/latestblock',             method:'GET' },
  { name:'bitaps',           tier:'node', url:'https://bitaps.com/api/bitcoin/blockcount',       method:'GET' },
  { name:'sochain',          tier:'node', url:'https://sochain.com/api/v2/get_info/BTC',         method:'GET' },
  // ── Mining pools ──────────────────────────────────────────
  { name:'Foundry',          tier:'pool', url:'https://foundryusapool.com/',             method:'HEAD' },
  { name:'AntPool',          tier:'pool', url:'https://www.antpool.com/',                method:'HEAD' },
  { name:'MARA',             tier:'pool', url:'https://mara.com/',                       method:'HEAD' },
  { name:'MaraSlipstream',   tier:'pool', url:'https://slipstream.mara.com/',            method:'HEAD' }, // v12 NEW
  { name:'ViaBTC',           tier:'pool', url:'https://viabtc.com/',                     method:'HEAD' },
  { name:'SpiderPool',       tier:'pool', url:'https://www.spiderpool.com/',             method:'HEAD' },
  { name:'F2Pool',           tier:'pool', url:'https://www.f2pool.com/',                 method:'HEAD' },
  { name:'Luxor',            tier:'pool', url:'https://luxor.tech/',                     method:'HEAD' },
  { name:'CloverPool',       tier:'pool', url:'https://clvpool.com/',                    method:'HEAD' },
  { name:'BitFuFu',          tier:'pool', url:'https://www.bitfufu.com/',                method:'HEAD' },
  { name:'BTC.com',          tier:'pool', url:'https://btc.com/',                        method:'HEAD' },
  { name:'Ocean',            tier:'pool', url:'https://ocean.xyz/',                      method:'HEAD' },
  { name:'EMCDPool',         tier:'pool', url:'https://emcd.io/',                        method:'HEAD' }, // v12 NEW
  { name:'SBICrypto',        tier:'pool', url:'https://sbicrypto.com/',                  method:'HEAD' }, // v12 NEW
  { name:'2Miners',          tier:'pool', url:'https://2miners.com/',                    method:'HEAD' }, // v12 NEW
  { name:'Rawpool',          tier:'pool', url:'https://rawpool.com/',                    method:'HEAD' }, // v12 NEW
  // Акселераторы: GET вместо HEAD (Cloudflare блокирует HEAD с Vercel IP → ложный offline)
  // noBlock:true → любой HTTP ответ (включая 4xx) считается "живой"
  { name:'TxBoost',          tier:'pool', url:'https://txboost.com/',                    method:'GET', noBlock:true },
  { name:'mempoolAccel',     tier:'pool', url:'https://mempool.space/',                  method:'GET', noBlock:true },
  { name:'bitaccelerate',    tier:'pool', url:'https://www.bitaccelerate.com/',          method:'GET', noBlock:true },
  { name:'360btc',           tier:'pool', url:'https://360btc.net/',                     method:'GET', noBlock:true },
  { name:'txfaster',         tier:'pool', url:'https://txfaster.com/',                   method:'GET', noBlock:true },
  { name:'btcspeed',         tier:'pool', url:'https://btcspeed.org/',                   method:'GET', noBlock:true },
];

async function pingCh(ch, timeout = 5000) {
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), timeout);
    const r  = await fetch(ch.url, { method: ch.method, signal: ac.signal });
    clearTimeout(tm);
    // noBlock: любой HTTP ответ = сайт живой (4xx тоже — просто блокирует наш IP)
    const ok = ch.noBlock ? r.status < 600 : r.status < 500;
    return { name:ch.name, tier:ch.tier, ok, status:r.status, ms:Date.now()-t0 };
  } catch(e) {
    return { name:ch.name, tier:ch.tier, ok:false, status:0, ms:Date.now()-t0,
      error: e.name==='AbortError' ? 'timeout' : e.message };
  }
}

async function handleHealth(req, res) {
  if (!checkRl(getIp(req), 60)) return res.status(429).json({ ok:false, error:'Too many requests' });
  const verbose = req.query?.verbose === '1';
  const t0 = Date.now();
  const results = await Promise.allSettled(HEALTH_CHANNELS.map(ch => pingCh(ch)))
    .then(rs => rs.map((r, i) => r.status === 'fulfilled' ? r.value : {
      name:HEALTH_CHANNELS[i].name, tier:HEALTH_CHANNELS[i].tier, ok:false, status:0, ms:0, error:'internal_error'
    }));
  const elapsed = Date.now()-t0;
  const nodes = results.filter(r=>r.tier==='node');
  const pools = results.filter(r=>r.tier==='pool');
  const nodesOk = nodes.filter(r=>r.ok).length;
  const poolsOk = pools.filter(r=>r.ok).length;
  const hrAvailable = pools.filter(r=>r.ok).reduce((s,r)=>s+(HR_HEALTH[r.name]||0),0);
  const avgMs = Math.round(results.reduce((s,r)=>s+r.ms,0)/results.length);
  const overallOk = nodesOk >= 2 && poolsOk >= 5;
  const status = !overallOk ? 'degraded' : hrAvailable >= 60 ? 'ok' : 'partial';
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=180');
  return res.status(200).json({
    ok: overallOk, status, elapsed,
    summary: { nodes:{ok:nodesOk,total:nodes.length}, pools:{ok:poolsOk,total:pools.length}, hrAvailable, avgPingMs:avgMs },
    ...(verbose ? { channels:results } : { failed:results.filter(r=>!r.ok).map(r=>({name:r.name,tier:r.tier,error:r.error||`HTTP ${r.status}`})) }),
    timestamp: Date.now(),
  });
}

// ══════════════════════════════════════════════════════════════
//  STATUS  —  GET /api/status?txid=<64hex>
// ══════════════════════════════════════════════════════════════
// ① STUCK DETECTION ② FEE TREND ③ MEMPOOL POS ④ RBF ANALYSIS
// ⑤ BLOCKCOUNT FALLBACK ⑥ ETA FULL ⑦ ACCELERATION ADVICE
// (слито из api/status.js v13 → router.js для экономии слотов Vercel)

function estimateEtaFull(feeRate, fees, mpVsizeMB) {
  if (!feeRate||!fees) return {eta:null,etaMinutes:null,confidence:0};
  const fastest=fees.fastestFee||50, halfHour=fees.halfHourFee||30,
        hour=fees.hourFee||20, economy=fees.economyFee||fees.minimumFee||5;
  let etaText, etaMinutes, confidence;
  if (feeRate >= fastest)       { etaText='~10 мин';                    etaMinutes=10;   confidence=feeRate>=fastest*1.2?90:70; }
  else if (feeRate >= halfHour) { etaText='~30 мин';                    etaMinutes=30;   confidence=feeRate>=halfHour*1.1?75:55; }
  else if (feeRate >= hour)     { etaText='~1 час';                     etaMinutes=60;   confidence=50; }
  else if (feeRate >= economy)  { etaText='~несколько часов';            etaMinutes=240;  confidence=30; }
  else                          { etaText='неопределённо (низкая fee)'; etaMinutes=null; confidence=5; }
  if (mpVsizeMB > 100) confidence = Math.max(10, confidence-30);
  else if (mpVsizeMB > 50) confidence = Math.max(15, confidence-15);
  return {eta:etaText, etaMinutes, confidence};
}
// Legacy alias
const estimateEta = estimateEtaFull;

function accelerationAdviceFull(feeRate, fees, rbfEnabled, vsize, feePaid, stuckHours=0) {
  if (!fees) return null;
  const fastest = fees.fastestFee || 50;
  const ratio   = feeRate / fastest;
  if (ratio >= 1.0) return {action:'wait',   urgency:'low',    text:'Комиссия отличная — следующий блок'};
  if (ratio >= 0.8) return {action:'wait',   urgency:'low',    text:'Комиссия хорошая — подтверждение скоро'};
  if (ratio >= 0.5) return {action:'boost',  urgency:'medium', text:'TurboTX ускорит на 1–3 часа'};
  const cpfpFee = Math.max(0, fastest*(vsize+110)-feePaid);
  const urgency = stuckHours>=72?'critical':stuckHours>=48?'high':'high';
  if (rbfEnabled) return {
    action:'rbf', urgency,
    text:`RBF доступен — замените с fee rate ${fastest} sat/vB`,
    rbfTargetFeeRate:fastest, stuckHours:stuckHours||undefined,
  };
  return {
    action:'cpfp_or_boost', urgency,
    text:`Комиссия слишком низкая (${feeRate}/${fastest} sat/vB). CPFP или TurboTX Premium`,
    cpfpFeeNeeded:cpfpFee, cpfpFeeSats:cpfpFee, stuckHours:stuckHours||undefined,
  };
}
const accelAdvice = accelerationAdviceFull;

function detectStuck(tx, fees) {
  const firstSeen = tx?.firstSeen || null;
  if (!firstSeen) return {isStuck:false,stuckHours:0};
  const stuckHours = Math.round((Date.now()/1000 - firstSeen)/3600);
  return {
    isStuck:    stuckHours >= 48,
    isStuck72h: stuckHours >= 72,
    stuckHours,
    stuckLabel: stuckHours>=72?'🚨 Критически зависла':stuckHours>=48?'⚠️ Долго в мемпуле':null,
  };
}

function getFeeTrend(fees) {
  if (!fees) return 'stable';
  const {fastestFee:f, halfHourFee:h} = fees;
  if (!f||!h) return 'stable';
  if (h < f*0.6) return 'dropping';
  if (h >= f*0.9) return 'rising';
  return 'stable';
}

function calcMempoolPosition(feeRate, fees, mp) {
  if (!mp?.count||!feeRate) return null;
  const ratio = Math.max(0, 1-Math.min(feeRate/(fees?.fastestFee||50),1));
  const vsizeBefore = ratio*(mp.vsize||0);
  const blocksUntilConfirm = Math.ceil(vsizeBefore/1_000_000);
  return {
    txsAhead:        Math.round(ratio*mp.count),
    vsizeAheadMB:    +(vsizeBefore/1e6).toFixed(2),
    estimatedBlocks: blocksUntilConfirm,
    estimatedMins:   blocksUntilConfirm*10,
  };
}

function analyzeRbf(vin=[]) {
  const rbfInputs = vin.filter(i=>i.sequence<=0xFFFFFFFD);
  return {
    rbfEnabled:    rbfInputs.length > 0,
    rbfInputCount: rbfInputs.length,
    fullySignaled: rbfInputs.length === vin.length,
    optIn:         rbfInputs.length > 0 && rbfInputs.length < vin.length,
  };
}

async function handleStatus(req, res) {
  if (!checkRl(getIp(req), 30)) return res.status(429).json({ok:false, error:'Too many requests'});
  const txid = req.query?.txid || req.body?.txid;
  if (!txid||!/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ok:false, error:'Invalid TXID'});
  try {
    const [txR, statusR, tipR, tip2R, feesR, mpR] = await Promise.allSettled([
      ft(`https://mempool.space/api/tx/${txid}`),
      ft(`https://mempool.space/api/tx/${txid}/status`),
      ft('https://mempool.space/api/blocks/tip/height'),
      ft('https://blockstream.info/api/blocks/tip/height'),   // ⑤ fallback
      ft('https://mempool.space/api/v1/fees/recommended'),
      ft('https://mempool.space/api/mempool'),
    ]);
    const get = s=>(s.status==='fulfilled'&&s.value?.ok)?s.value:null;
    let tx = get(txR) ? await sj(get(txR)) : null;
    if (!tx) {
      try { const fb=await ft(`https://blockstream.info/api/tx/${txid}`,{},7000); if(fb.ok) tx=await sj(fb); } catch {}
    }
    if (!tx?.txid) return res.status(200).json({ok:true, status:'not_found', txid, message:'Transaction not found in mempool or blockchain'});
    const txStatus = get(statusR) ? await sj(get(statusR)) : null;
    let tip = 0;
    if (get(tipR))  { try { const tipText = await get(tipR).text(); tip = parseInt(tipText) || 0; } catch {} }
    if (!tip&&get(tip2R)) { try { const tipText2 = await get(tip2R).text(); tip = parseInt(tipText2) || 0; } catch {} }
    const fees = get(feesR) ? await sj(get(feesR)) : {};
    const mp   = get(mpR)   ? await sj(get(mpR))   : {};
    const vsize     = tx.weight ? Math.ceil(tx.weight/4) : (tx.size||250);
    const feePaid   = tx.fee||0;
    const feeRate   = feePaid&&vsize ? Math.round(feePaid/vsize) : 0;
    const fastest   = fees.fastestFee||50;
    const confirmed = txStatus?.confirmed||tx.status?.confirmed||false;
    const blockH    = txStatus?.block_height||tx.status?.block_height||null;
    const blockT    = txStatus?.block_time  ||tx.status?.block_time  ||null;
    const confs     = confirmed&&tip&&blockH ? Math.max(1,tip-blockH+1) : 0;
    const mpVsizeMB = mp.vsize ? +(mp.vsize/1e6).toFixed(1) : 0;
    const rbfInfo   = analyzeRbf(tx.vin||[]);
    const stuck     = detectStuck(tx, fees);
    const feeTrend  = getFeeTrend(fees);
    const mempoolPos = !confirmed ? calcMempoolPosition(feeRate, fees, mp) : null;
    const {eta, etaMinutes, confidence} = !confirmed
      ? estimateEtaFull(feeRate, fees, mpVsizeMB)
      : {eta:null, etaMinutes:null, confidence:100};
    const advice = !confirmed
      ? accelerationAdviceFull(feeRate, fees, rbfInfo.rbfEnabled, vsize, feePaid, stuck.stuckHours)
      : null;
    res.setHeader('Cache-Control','no-store');
    return res.status(200).json({
      ok:true, txid,
      status:        confirmed ? 'confirmed' : 'mempool',
      confirmed,
      confirmations: confs,
      blockHeight:   blockH,
      blockTime:     blockT,
      vsize, feePaid, feeRate, feeRateNeeded:fastest,
      needsBoost:    !confirmed&&feeRate>0&&feeRate<fastest*0.5,
      ...rbfInfo,
      fees:{ fastest, halfHour:fees.halfHourFee||fastest, hour:fees.hourFee||fastest, economy:fees.economyFee||fees.minimumFee||1 },
      feeTrend,
      feeTrendLabel: feeTrend==='dropping'?'📉 Комиссии падают':feeTrend==='rising'?'📈 Комиссии растут':'→ Стабильно',
      ...stuck,
      eta, etaMinutes, confidence,
      accelerationAdvice: advice,
      mempoolPosition:    mempoolPos?.txsAhead??null,
      mempoolPositionV12: mempoolPos,
      mempoolCount:       mp.count||null,
      mempoolMB:          mpVsizeMB,
      inputs:  (tx.vin ||[]).length,
      outputs: (tx.vout||[]).length,
      weight:  tx.weight||null,
      firstSeen: tx.firstSeen||null,
      timestamp: Date.now(),
    });
  } catch(e) { return res.status(500).json({ok:false,error:e.message}); }
}

// ══════════════════════════════════════════════════════════════
//  STATS  —  GET /api/stats[?admin=1]
// ══════════════════════════════════════════════════════════════
const _sess = {
  startedAt:Date.now(), broadcasts:0, freeBroadcasts:0, premBroadcasts:0,
  batchBroadcasts:0, verifications:0, lightningInvoices:0, cpfpCalcs:0,
  rbfChecks:0, errors:0, totalHashreachPct:0, broadcastsWithHex:0,
};
export function incBroadcast(plan,hr=0,hasHex=false){
  _sess.broadcasts++;
  if(plan==='premium') _sess.premBroadcasts++;
  else if(plan==='batch') _sess.batchBroadcasts++;
  else _sess.freeBroadcasts++;
  if(hr>0) _sess.totalHashreachPct+=hr;
  if(hasHex) _sess.broadcastsWithHex++;
}
export function incVerify()    { _sess.verifications++;    }
export function incLightning() { _sess.lightningInvoices++; }
export function incCpfp()      { _sess.cpfpCalcs++;        }
export function incRbf()       { _sess.rbfChecks++;        }
export function incError()     { _sess.errors++;           }

async function handleStats(req, res) {
  if (!checkRl(getIp(req), 60)) return res.status(429).json({ ok:false, error:'Too many requests' });
  const isAdmin = req.query?.admin==='1' && req.headers['x-turbotx-token']===process.env.PREMIUM_SECRET;
  const isLive  = isAdmin && req.query?.live==='1';
  try {
    const [feesR,mpR,tipR,priceR,hrR,tip2R,hrFbR] = await Promise.allSettled([
      ft('https://mempool.space/api/v1/fees/recommended',   {}, 6000),
      ft('https://mempool.space/api/mempool',               {}, 6000),
      ft('https://mempool.space/api/blocks/tip/height',     {}, 5000),
      ft('https://mempool.space/api/v1/prices',             {}, 5000),
      ft('https://mempool.space/api/v1/mining/hashrate/3d', {}, 8000),
      ft('https://blockstream.info/api/blocks/tip/height',  {}, 5000),
      ft('https://api.blockchair.com/bitcoin/stats',        {}, 7000),
    ]);
    const ok = s=>s.status==='fulfilled'&&s.value?.ok?s.value:null;
    const fees  = ok(feesR) ?await sj(ok(feesR)):{};
    const mp    = ok(mpR)   ?await sj(ok(mpR))  :{};
    const price = ok(priceR)?await sj(ok(priceR)):{};
    let hr = ok(hrR) ? await sj(ok(hrR)) : {};
    if (!hr.currentHashrate && ok(hrFbR)) {
      try { const fb=await sj(ok(hrFbR)); if(fb?.data?.hashrate_24h) hr={currentHashrate:fb.data.hashrate_24h}; } catch {}
    }
    let tip=0;
    if(ok(tipR))  { try { const t1 = await ok(tipR).text(); tip = parseInt(t1, 10) || 0; } catch {} }
    if(!tip&&ok(tip2R)) { try { const t2 = await ok(tip2R).text(); tip = parseInt(t2, 10) || 0; } catch {} }
    const fastest=fees.fastestFee||0,halfHour=fees.halfHourFee||0,hour=fees.hourFee||0;
    const economy=fees.economyFee||fees.minimumFee||0,btcPrice=price.USD||null;
    // BUG FIX v14: учитываем mp.count при определении congestion (аналогично handlePrice)
    const mpCountStats = mp.count || 0;
    let congestion = fastest>200?'critical':fastest>100?'extreme':fastest>50?'high':fastest>20?'medium':'low';
    if ((mpCountStats > 80000 || (mp.vsize||0) > 80_000_000) && (congestion==='low'||congestion==='medium')) congestion='high';
    else if ((mpCountStats > 30000 || (mp.vsize||0) > 30_000_000) && congestion==='low') congestion='medium';
    const CTEXT={critical:'Критическая перегрузка',extreme:'Сильная перегрузка',high:'Высокая нагрузка',medium:'Умеренная нагрузка',low:'Сеть свободна'};
    const CEMOJI={critical:'🔴',extreme:'🔴',high:'🟠',medium:'🟡',low:'🟢'};
    const uptimeSec=Math.round((Date.now()-_sess.startedAt)/1000);
    const uptimeStr=uptimeSec<60?`${uptimeSec}с`:uptimeSec<3600?`${Math.round(uptimeSec/60)}м`:`${Math.round(uptimeSec/3600)}ч`;
    const avgHr=_sess.premBroadcasts>0?Math.round(_sess.totalHashreachPct/_sess.premBroadcasts):88;
    const hexRate=_sess.broadcasts>0?Math.round(_sess.broadcastsWithHex/_sess.broadcasts*100):null;
    const pub={
      ok:true,version:'v14',
      network:{blockHeight:tip||null,feeRate:fastest||null,feeHalfHour:halfHour||null,feeHour:hour||null,
        feeEconomy:economy||null,congestion,congestionText:CTEXT[congestion],congestionEmoji:CEMOJI[congestion],
        btcPrice,mempoolCount:mp.count||null,mempoolMB:mp.vsize?+(mp.vsize/1e6).toFixed(1):null,
        hashrateEHs:hr.currentHashrate?+(hr.currentHashrate/1e18).toFixed(2):null},
      service:{version:'v14',nodeChannels:8,poolChannels:22,totalChannels:30,hashrateReach:`~${avgHr}%`,
        batchSupport:true,lightningSupport:true,maraSlipstream:true,lastBlockMiner:true,uptime:uptimeStr},
      timestamp:Date.now(),
    };
    if(isAdmin) pub.session={startedAt:new Date(_sess.startedAt).toISOString(),uptime:uptimeStr,..._sess,avgHashreachPct:avgHr,hexHitRate:hexRate!==null?`${hexRate}%`:'n/a'};
    if(!isLive) res.setHeader('Cache-Control','s-maxage=60, stale-while-revalidate=120');
    else res.setHeader('Cache-Control','no-store');
    return res.status(200).json(pub);
  } catch(e) { incError(); return res.status(500).json({ok:false,error:e.message}); }
}

// ══════════════════════════════════════════════════════════════
//  PRICE  —  GET /api/price
// ══════════════════════════════════════════════════════════════
const PRICE_TIERS = [
  { maxFee:10,  usd:3,  label:'low',      emoji:'🟢', text:'Сеть свободна',        textEn:'Network is clear',    confLabel:'5–10 мин ⚡'  },
  { maxFee:30,  usd:4,  label:'medium',   emoji:'🟡', text:'Умеренная нагрузка',   textEn:'Moderate load',       confLabel:'10–15 мин ⚡' },
  { maxFee:60,  usd:7,  label:'high',     emoji:'🟠', text:'Высокая нагрузка',     textEn:'High load',           confLabel:'10–20 мин ⚡' },
  { maxFee:150, usd:12, label:'extreme',  emoji:'🔴', text:'Перегрузка сети',      textEn:'Network congested',   confLabel:'15–30 мин'    },
  { maxFee:Infinity, usd:18, label:'critical', emoji:'🔴', text:'Критическая перегрузка', textEn:'Critical congestion', confLabel:'20–40 мин' },
];

async function getFeeRate() {
  try { const r=await ft('https://mempool.space/api/v1/fees/recommended'); if(r.ok){const j=await sj(r);return{rate:j.fastestFee||20,all:j};} } catch {}
  try { const r=await ft('https://blockstream.info/api/fee-estimates'); if(r.ok){const j=await sj(r);return{rate:j['1']||j['3']||20,all:{}};} } catch {}
  return { rate:20, all:{} };
}
async function getMempoolStats() {
  try { const r=await ft('https://mempool.space/api/mempool'); if(r.ok){const j=await sj(r);return{count:j.count,vsize:j.vsize,totalFee:j.total_fee};} } catch {}
  return null;
}
async function getBtcPrice() {
  const sources=[
    {url:'https://mempool.space/api/v1/prices',path:['USD']},
    {url:'https://api.coinbase.com/v2/prices/BTC-USD/spot',path:['data','amount']},
    {url:'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',path:['price']},
  ];
  return new Promise(resolve=>{
    let found=false,done=0;
    for(const {url,path} of sources){
      ft(url).then(async r=>{
        if(!r.ok) throw 0;
        const j=await sj(r);
        const price=parseFloat(path.reduce((o,k)=>o?.[k],j));
        if(!found&&price>1000){found=true;resolve(price);}
      }).catch(()=>{}).finally(()=>{if(++done===sources.length&&!found)resolve(null);});
    }
  });
}

async function handlePrice(req, res) {
  if (!checkRl(getIp(req), 30)) return res.status(429).json({ ok:false, error:'Too many requests' });
  const [feeRes,priceRes,mempoolRes] = await Promise.allSettled([getFeeRate(),getBtcPrice(),getMempoolStats()]);
  const {rate:feeRate,all:allFees}=feeRes.status==='fulfilled'?feeRes.value:{rate:20,all:{}};
  const btcPrice=priceRes.status==='fulfilled'?priceRes.value:null;
  const mempoolStats=mempoolRes.status==='fulfilled'?mempoolRes.value:null;
  // ── ДИНАМИЧЕСКАЯ ЦЕНА v14: fee + очередь мемпула ─────────────
  // Два сигнала определяют тир одновременно — берём максимальный.
  //
  // Сигнал 1: feeRate (sat/vB) — рыночная ставка прямо сейчас
  const mpCount      = mempoolStats?.count || 0;
  const mpVsizeBytes = mempoolStats?.vsize  || 0;
  const mpVsizeMB    = mpVsizeBytes / 1_000_000;

  const tierByFee = PRICE_TIERS.find(t => feeRate <= t.maxFee) ?? PRICE_TIERS.at(-1);

  // Сигнал 2: очередь мемпула (TX count + vsize)
  // 1 блок = ~1 МБ = ~2000 TX; норма ≤3 блоков = ≤6000 TX / 3 МБ
  // Каждые +2000 TX сверх нормы = ещё один блок ожидания
  const mpTierIdx =
    mpCount > 100000 || mpVsizeMB > 100 ? 4 :   // critical
    mpCount >  60000 || mpVsizeMB >  60 ? 3 :   // extreme
    mpCount >  30000 || mpVsizeMB >  30 ? 2 :   // high
    mpCount >  10000 || mpVsizeMB >  10 ? 1 :   // medium
                                          0;    // low

  // Итоговый тир = максимум из двух сигналов (цена растёт когда ЛЮБОЙ из них высок)
  const feeTierIdx = PRICE_TIERS.indexOf(tierByFee);
  let tier = PRICE_TIERS[Math.max(feeTierIdx, mpTierIdx)];

  // Отдельный индикатор нагрузки мемпула (не зависит от feeRate)
  const mempoolCongestion =
    mpCount > 80000  ? { level:'critical', emoji:'🔴', text:'Мемпул критически перегружен',  textEn:'Mempool critically overloaded', txCount:mpCount } :
    mpCount > 50000  ? { level:'high',     emoji:'🟠', text:'Мемпул сильно загружен',         textEn:'Mempool heavily loaded',        txCount:mpCount } :
    mpCount > 30000  ? { level:'medium',   emoji:'🟡', text:'Мемпул умеренно загружен',       textEn:'Mempool moderately loaded',     txCount:mpCount } :
    mpCount > 10000  ? { level:'low',      emoji:'🟢', text:'Мемпул в норме',                 textEn:'Mempool normal',                txCount:mpCount } :
                       { level:'clear',    emoji:'🟢', text:'Мемпул свободен',                textEn:'Mempool clear',                 txCount:mpCount };

  const usd=tier.usd;
  const btc=btcPrice?parseFloat((usd/btcPrice).toFixed(6)):null;
  const sats=btcPrice?Math.ceil((usd/btcPrice)*1e8):null;
  const bestTimeFn=(fr,a)=>{
    if(fr<=5)  return{tip:'💚 Идеально — сеть почти пустая. Самое дешёвое время.',quality:'excellent'};
    if(fr<=15) return{tip:'✅ Хорошее время для транзакции.',quality:'good'};
    if(fr<=50) return{tip:'🟡 Умеренная нагрузка. Если не срочно — подожди ночи (UTC 02:00–06:00).',quality:'ok'};
    if(fr<=100)return{tip:'🟠 Высокая нагрузка. Рекомендуем ускорение или подождать.',quality:'poor'};
    return{tip:'🔴 Критическая перегрузка. Транзакции застревают. TurboTX поможет ускорить.',quality:'critical'};
  };
  const tip=bestTimeFn(feeRate,allFees);
  // BUG FIX: confLabel по tier — клиент показывает реальное время подтверждения
  const CONF_LABELS = { low:'5–10 мин ⚡', medium:'10–15 мин ⚡', high:'10–20 мин ⚡', extreme:'15–30 мин', critical:'20–40 мин' };
  const confLabel = CONF_LABELS[tier.label] || '10–20 мин ⚡';
  // BUG FIX: CDN кэш уменьшен до 60с (был 180с) — цена обновляется чаще
  // _t query param от клиента меняется каждую минуту → cache miss каждую минуту
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  return res.status(200).json({
    ok:true,usd,btc,sats,btcPrice,feeRate,
    fees:{fastest:allFees.fastestFee||feeRate,halfHour:allFees.halfHourFee||feeRate,hour:allFees.hourFee||feeRate,economy:allFees.economyFee||allFees.minimumFee||1},
    // fee-рынок + очередь (комбинированный тир)
    congestion:tier.label,emoji:tier.emoji,text:tier.text,textEn:tier.textEn,
    // что именно подняло цену (для UI)
    priceSignals:{
      feeDriver:  feeTierIdx >= mpTierIdx,   // true = цену поднял feeRate
      queueDriver: mpTierIdx > feeTierIdx,   // true = цену поднял мемпул
      feeRate, feeTierIdx, mpTierIdx,
      mpCount, mpVsizeMB: +mpVsizeMB.toFixed(1),
    },
    // отдельный индикатор мемпула — показывает РЕАЛЬНОЕ кол-во TX
    mempoolCongestion,
    confLabel,
    bestTime:tip,mempool:mempoolStats,
    tiers:PRICE_TIERS.map(t=>({usd:t.usd,label:t.label,emoji:t.emoji,text:t.text,textEn:t.textEn,confLabel:t.confLabel,maxFee:t.maxFee===Infinity?null:t.maxFee})),
    timestamp:Date.now(),
  });
}

// ══════════════════════════════════════════════════════════════
//  MEMPOOL  —  GET /api/mempool[?txid=<64hex>]
// ══════════════════════════════════════════════════════════════
async function handleMempool(req, res) {
  if (!checkRl(getIp(req), 30)) return res.status(429).json({ ok:false, error:'Too many requests' });
  const txid = req.query?.txid;
  if (txid && !/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ ok:false, error:'Invalid TXID' });
  try {
    const [feesR,mpR,blocksR,txR,txR2] = await Promise.allSettled([
      ft('https://mempool.space/api/v1/fees/recommended'),
      ft('https://mempool.space/api/mempool'),
      ft('https://mempool.space/api/v1/mining/blocks/fee-rates/24h'),
      txid?ft(`https://mempool.space/api/tx/${txid}`):Promise.resolve(null),
      txid?ft(`https://blockstream.info/api/tx/${txid}`):Promise.resolve(null),
    ]);
    const get=s=>s.status==='fulfilled'&&s.value?.ok?s.value:null;
    const fees=get(feesR)?await sj(get(feesR)):{};
    const mp=get(mpR)?await sj(get(mpR)):{};
    const blocks=get(blocksR)?await sj(get(blocksR)):[];
    let tx=null;
    if(txid){ if(get(txR))tx=await sj(get(txR)); else if(get(txR2))tx=await sj(get(txR2)); }
    const fastest=fees.fastestFee||50,halfHour=fees.halfHourFee||30,hour=fees.hourFee||20,economy=fees.economyFee||fees.minimumFee||5,minimum=fees.minimumFee||1;
    let histMin=null,histMax=null,histAvg=null;
    if(Array.isArray(blocks)&&blocks.length>0){
      const rates=blocks.map(b=>b.avgFee||b.medianFee||b.feeRange?.[0]).filter(Boolean);
      if(rates.length){histMin=Math.min(...rates);histMax=Math.max(...rates);histAvg=Math.round(rates.reduce((a,b)=>a+b,0)/rates.length);}
    }
    const congestionLevel=fastest>200?'critical':fastest>100?'extreme':fastest>50?'high':fastest>20?'medium':'low';
    const congestionText={critical:'Критическая перегрузка',extreme:'Сильная перегрузка',high:'Высокая нагрузка',medium:'Умеренная нагрузка',low:'Сеть свободна'}[congestionLevel];
    const etaBlocks=fr=>fr>=fastest?1:fr>=halfHour?3:fr>=hour?6:fr>=economy?24:144;
    let txForecast=null;
    if(tx){
      const vsize=tx.weight?Math.ceil(tx.weight/4):(tx.size||250);
      const feePaid=tx.fee||0,feeRate=feePaid&&vsize?Math.round(feePaid/vsize):0;
      const bl_=etaBlocks(feeRate),minsEta=bl_*10;
      const needCpfp=feeRate<fastest*0.5,rbf=Array.isArray(tx.vin)&&tx.vin.some(i=>i.sequence<=0xFFFFFFFD);
      const mpPos=mp.count?Math.round((1-Math.min(feeRate/fastest,1))*mp.count):null;
      txForecast={txid,feeRate,vsize,feePaid,etaBlocks:bl_,etaMinutes:minsEta,etaText:minsEta<60?`~${minsEta} мин`:minsEta<1440?`~${Math.round(minsEta/60)} ч`:`>24 часов`,needCpfp,rbfEnabled:rbf,confirmed:tx.status?.confirmed||false,mempoolPosition:mpPos,
        advice:tx.status?.confirmed?'✅ Транзакция уже подтверждена.':needCpfp?`⚠️ Комиссия слишком низкая (${feeRate}/${fastest} sat/vB). ${rbf?'RBF доступен — замените TX.':'Используй CPFP или TurboTX ускорение.'}`:feeRate>=fastest?`✅ Комиссия отличная (${feeRate} sat/vB) — следующий блок (~10 мин).`:`⏳ Ожидание ~${minsEta} мин. TurboTX ускорение сократит время.`};
    }
    const bestTimeTip=economy<10?'✅ Сейчас хорошее время — сеть почти свободна':histMin&&economy>histMin*2?`💡 За 24ч минимум был ${histMin} sat/vB. Можно подождать.`:null;
    res.setHeader('Cache-Control','s-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({
      ok:true,fees:{fastest,halfHour,hour,economy,minimum},
      congestion:{level:congestionLevel,text:congestionText,emoji:{critical:'🔴',extreme:'🔴',high:'🟠',medium:'🟡',low:'🟢'}[congestionLevel]},
      mempool:{count:mp.count||0,vsizeMB:mp.vsize?+(mp.vsize/1e6).toFixed(2):0,totalFee:mp.total_fee||0},
      history24h:histMin?{min:histMin,max:histMax,avg:histAvg}:null,
      predictions:{nextBlock:{blocks:1,minutes:10,feeRate:fastest},thirtyMin:{blocks:3,minutes:30,feeRate:halfHour},oneHour:{blocks:6,minutes:60,feeRate:hour},economy:{blocks:24,minutes:240,feeRate:economy}},
      bestTimeTip,txForecast,timestamp:Date.now(),
    });
  } catch(e) { return res.status(500).json({ok:false,error:e.message}); }
}

// ══════════════════════════════════════════════════════════════
//  CPFP  —  GET /api/cpfp?txid=<64hex>[&outputIndex=0&target=fast]
// ══════════════════════════════════════════════════════════════
const CHILD_VSIZE = { v0_p2wpkh:110, v0_p2wsh:155, p2sh:133, p2pkh:192, v1_p2tr:111, unknown:140 };
const ADDR_TYPE_NAMES = { v0_p2wpkh:'Native SegWit (bc1q)', v0_p2wsh:'SegWit MultiSig (bc1q long)', p2sh:'P2SH (3...)', p2pkh:'Legacy (1...)', v1_p2tr:'Taproot (bc1p)', unknown:'Unknown' };
function detectAddrType(t){ return {v0_p2wpkh:'v0_p2wpkh',v0_p2wsh:'v0_p2wsh',p2sh:'p2sh',p2pkh:'p2pkh',v1_p2tr:'v1_p2tr'}[t]||'unknown'; }

async function handleCpfp(req, res) {
  if (!checkRl(getIp(req), 20)) return res.status(429).json({ ok:false, error:'Too many requests' });
  const txid=req.query?.txid, outputIndex=parseInt(req.query?.outputIndex??'0'), targetMode=req.query?.target||'fast';
  if (!txid||!/^[a-fA-F0-9]{64}$/.test(txid)) return res.status(400).json({ok:false,error:'Invalid TXID'});
  try {
    const [txR,feesR,mpR,priceP] = await Promise.allSettled([
      ft(`https://mempool.space/api/tx/${txid}`), ft('https://mempool.space/api/v1/fees/recommended'),
      ft('https://mempool.space/api/mempool'), getBtcPrice(),
    ]);
    const getR=s=>s.status==='fulfilled'?s.value:null;
    const txRsp=getR(txR),feesRsp=getR(feesR),mpRsp=getR(mpR),priceVal=priceP.status==='fulfilled'?priceP.value:null;
    let txFinal = txRsp?.ok ? txRsp : null;
    if (!txFinal?.ok) {
      try { const fb=await ft(`https://blockstream.info/api/tx/${txid}`,{},6000); if(fb.ok) txFinal=fb; } catch {}
    }
    if (!txFinal?.ok) return res.status(404).json({ok:false,error:'TX not found'});
    const tx=await sj(txFinal),fees=feesRsp?.ok?await sj(feesRsp):{},mp=mpRsp?.ok?await sj(mpRsp):{};
    if(tx.status?.confirmed) return res.status(200).json({ok:true,needed:false,reason:'already_confirmed'});
    const vsize=tx.weight?Math.ceil(tx.weight/4):(tx.size||250),feePaid=tx.fee||0,feeRate=feePaid&&vsize?Math.round(feePaid/vsize):0;
    const targets={eco:fees.hourFee||fees.halfHourFee||20,std:fees.halfHourFee||fees.fastestFee||30,fast:fees.fastestFee||50};
    const target=targets[targetMode]||targets.fast;
    const outputs=tx.vout||[];
    let bestOutput=null,bestIdx=outputIndex;
    if(outputs[outputIndex]){bestOutput=outputs[outputIndex];}
    else if(outputs.length>0){let mx=-1;outputs.forEach((o,i)=>{if((o.value||0)>mx){mx=o.value;bestIdx=i;bestOutput=o;}});}
    const addrType=bestOutput?detectAddrType(bestOutput.scriptpubkey_type):'unknown';
    const childVsize=CHILD_VSIZE[addrType]||CHILD_VSIZE.unknown;
    const packageVsize=vsize+childVsize,totalFeeNeeded=target*packageVsize;
    const childFeeNeeded=Math.max(0,totalFeeNeeded-feePaid),childFeeRate=Math.ceil(childFeeNeeded/childVsize);
    const canAfford=bestOutput&&bestOutput.value>childFeeNeeded+546;
    const feeUsd=priceVal&&childFeeNeeded?+((childFeeNeeded/1e8)*priceVal).toFixed(4):null;
    const mpCount=mp.count||0,posBefore=mpCount?Math.round((1-Math.min(feeRate/target,1))*mpCount):null;
    const allOutputs=outputs.map((o,i)=>({index:i,value:o.value,valueBtc:o.value?+(o.value/1e8).toFixed(8):0,address:o.scriptpubkey_address||null,type:detectAddrType(o.scriptpubkey_type),typeName:ADDR_TYPE_NAMES[detectAddrType(o.scriptpubkey_type)],canAfford:o.value>childFeeNeeded+546}));
    const walletInstructions={
      electrum:[`Убедись что TX видна в Electrum`,`Coins → найди UTXO из выхода #${bestIdx}`,`ПКМ → Spend → создай новую TX`,`Установи fee rate: ${childFeeRate} sat/vB (${childFeeNeeded} sat)`,`Отправь на любой свой адрес`],
      sparrow:[`UTXOs → найди выход #${bestIdx} от этой TX`,`ПКМ → "Send From"`,`Fee rate: ${childFeeRate} sat/vB`,`Sign → Broadcast`],
      bluewallet:[`Coin Control → выбери UTXO #${bestIdx}`,`Создай транзакцию отправки`,`Укажи Custom fee: ${childFeeRate} sat/vB`,`Confirm`],
    };
    return res.status(200).json({
      ok:true,needed:feeRate<target*0.9,txid,targetMode,
      parent:{vsize,feePaid,feeRate,feeUsd:priceVal?+((feePaid/1e8)*priceVal).toFixed(4):null},
      targets:{eco:targets.eco,std:targets.std,fast:targets.fast,selected:target},
      child:{addressType:addrType,addressTypeName:ADDR_TYPE_NAMES[addrType],vsize:childVsize,feeNeeded:childFeeNeeded,feeRate:childFeeRate,feeUsd,canAfford},
      package:{vsize:packageVsize,totalFee:totalFeeNeeded,effectiveRate:target},
      output:bestOutput?{index:bestIdx,value:bestOutput.value,valueBtc:+(bestOutput.value/1e8).toFixed(8),address:bestOutput.scriptpubkey_address||null,type:addrType,canAfford}:null,
      allOutputs,mempoolPosition:{before:posBefore,after:0},walletInstructions,btcPrice:priceVal,timestamp:Date.now(),
    });
  } catch(e) { return res.status(500).json({ok:false,error:e.message}); }
}

// ══════════════════════════════════════════════════════════════
//  RBF  —  GET /api/rbf?txid=<64hex>[&targetFee=<sat/vB>]
// ══════════════════════════════════════════════════════════════
async function handleRbf(req, res) {
  if (!checkRl(getIp(req), 20)) return res.status(429).json({ ok:false, error:'Too many requests' });
  const txid=req.query?.txid, targetFee=parseInt(req.query?.targetFee)||null;
  if (!txid||!/^[a-fA-F0-9]{64}$/.test(txid)) return res.status(400).json({ok:false,error:'Invalid TXID'});
  try {
    const [txRes,feesRes,priceRes] = await Promise.allSettled([
      ft(`https://mempool.space/api/tx/${txid}`), ft('https://mempool.space/api/v1/fees/recommended'), getBtcPrice(),
    ]);
    const getR=s=>s.status==='fulfilled'?s.value:null;
    const txR=getR(txRes),feesR=getR(feesRes),priceP=getR(priceRes);
    if(!txR?.ok) return res.status(404).json({ok:false,error:'TX not found'});
    const tx=await txR.json(),fees=feesR?.ok?await sj(feesR):{};
    if(tx.status?.confirmed) return res.status(200).json({ok:true,rbfPossible:false,reason:'already_confirmed'});
    const vsize=tx.weight?Math.ceil(tx.weight/4):(tx.size||250),feePaid=tx.fee||0,feeRate=feePaid&&vsize?Math.round(feePaid/vsize):0;
    const fastest=fees.fastestFee||50,minRelay=1;
    const rbfInputs=(tx.vin||[]).filter(i=>i.sequence<=0xFFFFFFFD),rbfEnabled=rbfInputs.length>0;
    if(!rbfEnabled) return res.status(200).json({ok:true,rbfEnabled:false,rbfPossible:false,reason:'RBF not signaled in any input',alternative:'cpfp',alternativeUrl:`/api/cpfp?txid=${txid}`,txid,feeRate,vsize,feePaid});
    const target=targetFee||fastest,minNewFee=feePaid+vsize*minRelay,targetFeeAbs=target*vsize,newFeeAbs=Math.max(minNewFee,targetFeeAbs),newFeeRate=Math.ceil(newFeeAbs/vsize),feeDiff=newFeeAbs-feePaid;
    const feeDiffUsd=priceP?+((feeDiff/1e8)*priceP).toFixed(4):null,newFeeUsd=priceP?+((newFeeAbs/1e8)*priceP).toFixed(4):null;
    const cpfpChildVsize=110,cpfpFeeNeeded=Math.max(0,fastest*(vsize+cpfpChildVsize)-feePaid),cpfpUsd=priceP?+((cpfpFeeNeeded/1e8)*priceP).toFixed(4):null,rbfCheaper=feeDiff<cpfpFeeNeeded;
    const walletInstructions={
      electrum:[`Открой Electrum → История транзакций`,`Правый клик на TX → "Increase fee" (RBF)`,`Установи fee rate: ${newFeeRate} sat/vB`,`Подпиши и отправь новую транзакцию`],
      sparrow:[`Открой Sparrow → Transactions`,`Выбери TX → кнопка "Replace by fee"`,`Установи ${newFeeRate} sat/vB`,`Sign → Broadcast`],
      bluewallet:[`Открой BlueWallet → транзакция`,`Нажми "Bump Fee" (RBF)`,`Выбери Custom: ${newFeeRate} sat/vB`,`Confirm`],
    };
    return res.status(200).json({
      ok:true,rbfEnabled:true,rbfPossible:true,txid,
      current:{feeRate,feePaid,vsize,feeUsd:priceP?+((feePaid/1e8)*priceP).toFixed(4):null},
      replacement:{feeRate:newFeeRate,feeAbs:newFeeAbs,feeDiff,feeDiffUsd,feeUsd:newFeeUsd,targetFeeRate:target},
      bip125:{minNewFee,minRelayFeeRate:minRelay,satisfiesBip125:newFeeAbs>=minNewFee},
      vsRbf:{rbfFeeDiff:feeDiff,cpfpFeeNeeded,rbfCheaper,recommendation:rbfCheaper?`RBF дешевле на ${cpfpFeeNeeded-feeDiff} sat`:`CPFP дешевле на ${feeDiff-cpfpFeeNeeded} sat`},
      walletInstructions,btcPrice:priceP,timestamp:Date.now(),
    });
  } catch(e) { return res.status(500).json({ok:false,error:e.message}); }
}

// ══════════════════════════════════════════════════════════════
//  NOTIFY  —  POST /api/notify
// ══════════════════════════════════════════════════════════════
async function tgSend(token, chatId, text, extra = {}) {
  if (!token||!chatId) return false;
  try {
    const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,parse_mode:'Markdown',...extra}),signal:AbortSignal.timeout(5000)});
    return r.ok;
  } catch { return false; }
}

async function handleNotify(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const secret=process.env.PREMIUM_SECRET,token=req.headers['x-turbotx-token']||req.body?.token;
  if(secret&&token!==secret) return res.status(401).json({ok:false,error:'Unauthorized'});
  if(!checkRl(getIp(req),30)) return res.status(429).json({ok:false,error:'Rate limited'});
  const tgToken=process.env.TG_TOKEN,chatId=process.env.TG_CHAT_ID;
  if(!tgToken||!chatId) return res.status(200).json({ok:false,reason:'TG not configured'});
  const {type,txid,paidStr,method,txShort,plan,wave,okCount,total,feeRate,needCpfp,hashrateReach,error,amountSats,paymentHash}=req.body||{};
  const now=new Date().toLocaleString('ru',{timeZone:'Europe/Moscow'});
  const txLink=txid?`https://mempool.space/tx/${txid}`:null;
  let text='',extra={};
  if(type==='payment'){
    text=['💰 *НОВАЯ ОПЛАТА — TurboTX v14*','━━━━━━━━━━━━━━━━',`💵 Сумма: \`${paidStr||'?'}\``,`💳 Способ: ${method||'?'}`,txShort?`🔗 TX: \`${txShort}\``:'',`📋 Тариф: *${(plan||'free').toUpperCase()}*`,`🕐 ${now} МСК`].filter(Boolean).join('\n');
    if(txLink) extra.reply_markup={inline_keyboard:[[{text:'🔍 Открыть TX',url:txLink}]]};
  } else if(type==='broadcast'){
    const pct=total?Math.round((okCount||0)/total*100):0,bar='█'.repeat(Math.round(pct/10))+'░'.repeat(10-Math.round(pct/10));
    text=[`⚡ *Broadcast — TurboTX*`,`📋 \`${txShort||txid?.slice(0,14)||'?'}\``,`\`${bar}\` ${pct}% (${okCount}/${total})`,hashrateReach?`⛏ ~${hashrateReach}% хешрейта`:'',needCpfp?'⚠️ Рекомендован CPFP':'✅ Комиссия ок',`🕐 ${now} МСК`].filter(Boolean).join('\n');
    if(txLink) extra.reply_markup={inline_keyboard:[[{text:'🔍 Mempool',url:txLink}]]};
  } else if(type==='confirmed'){
    text=[`✅ *TX ПОДТВЕРЖДЕНА!*`,`📋 \`${txShort||txid?.slice(0,14)||'?'}\``,`🎉 Premium отработал${wave?` (волна ${wave})`:''}`,`🕐 ${now} МСК`].filter(Boolean).join('\n');
    if(txLink) extra.reply_markup={inline_keyboard:[[{text:'🔍 Mempool',url:txLink}]]};
  } else if(type==='lightning'){
    text=['⚡ *Lightning — TurboTX v14*',`⚡ ${Number(amountSats||0).toLocaleString()} sats оплачено`,paymentHash?`📋 Hash: \`${String(paymentHash).slice(0,20)}…\``:'',`🕐 ${now} МСК`].filter(Boolean).join('\n');
  } else if(type==='batch'){
    const {total:bt,ok:bok}=req.body||{};
    text=['📦 *Batch Broadcast — TurboTX v14*',`✅ ${bok||0}/${bt||0} TX ускорено параллельно`,`🕐 ${now} МСК`].filter(Boolean).join('\n');
  } else if(type==='error'){
    text=[`❌ *Ошибка — TurboTX v14*`,error?`\`${String(error).slice(0,200)}\``:'',`🕐 ${now} МСК`].filter(Boolean).join('\n');
  } else {
    text=`📌 *TurboTX v14* — ${type||'event'}\n🕐 ${now} МСК`;
  }
  const ok=await tgSend(tgToken,chatId,text,extra);
  return res.status(200).json({ok,type});
}


// ══════════════════════════════════════════════════════════════
//  ACCELERATION (SMART ADVISOR)  —  GET /api/acceleration?txid=
//  Merged from /api/acceleration.js to save Vercel function slots
// ══════════════════════════════════════════════════════════════

// ─── HASHRATE TABLE Q1 2026 ──────────────────────────────────
const HR_ACCEL = {
  Foundry:27, AntPool:16, MARA:11, ViaBTC:9, SpiderPool:8,
  F2Pool:7, Luxor:5, CloverPool:4, BitFuFu:4, 'BTC.com':3,
  Ocean:2, EMCDPool:2, SBICrypto:2,
  TxBoost:1, '2Miners':1, Rawpool:1, Lincoin:1,
};

// ─── POOL COINBASE TAGS ───────────────────────────────────────
const POOL_TAGS_ACCEL = {
  'foundry':'Foundry', 'foundryusa':'Foundry',
  'antpool':'AntPool',
  'mara':'MARA', 'marathon':'MARA',
  'viabtc':'ViaBTC',
  'spiderpool':'SpiderPool',
  'f2pool':'F2Pool',
  'luxor':'Luxor',
  'clvpool':'CloverPool', 'clover':'CloverPool',
  'bitfufu':'BitFuFu',
  'btc.com':'BTC.com',
  'ocean':'Ocean', 'ocean.xyz':'Ocean',
  'emcd':'EMCDPool',
  'sbicrypto':'SBICrypto',
  '2miners':'2Miners',
  'rawpool':'Rawpool',
  'lincoin':'Lincoin',
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
      for (const [key, pool] of Object.entries(POOL_TAGS_ACCEL)) {
        if (poolName.includes(key)) return pool;
      }
      return 'Unknown';
    }).filter(Boolean);

    const dominantMiner = miners[0]; // Последний блок
    const dominantHr    = HR_ACCEL[dominantMiner] || 0;
    return { recent: miners, dominant: dominantMiner, dominantHr };
  } catch { return null; }
}

// ─── ⑧ FEE MARKET WINDOW (v14: динамический на основе реальных данных) ─
// Запрашиваем историю fee за 24ч из mempool.space и находим реальный минимум
// Fallback: статистическое окно 01:00–06:00 UTC
let _feeWindowCache = { data: null, at: 0 };
const FEE_WINDOW_TTL = 15 * 60_000; // обновляем каждые 15 мин

async function cheapWindowForecast(currentFeeRate) {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;

  // Пытаемся получить реальную историю fee за 24ч
  let cheapHour = null, minFee = null, avgFee = null;

  try {
    if (!_feeWindowCache.data || Date.now() - _feeWindowCache.at > FEE_WINDOW_TTL) {
      const r = await ft('https://mempool.space/api/v1/mining/blocks/fee-rates/24h', {}, 7000); // BUG FIX: был ft(url, 7000) — opts пропущен
      if (r.ok) {
        const blocks = await r.json();
        if (Array.isArray(blocks) && blocks.length > 0) {
          _feeWindowCache.data = blocks;
          _feeWindowCache.at   = Date.now();
        }
      }
    }

    if (_feeWindowCache.data) {
      const blocks = _feeWindowCache.data;
      // Группируем блоки по UTC-часам, берём средний fee каждого часа
      const byHour = {};
      for (const b of blocks) {
        const ts = b.timestamp || b.time || 0;
        if (!ts) continue;
        const h = new Date(ts * 1000).getUTCHours();
        if (!byHour[h]) byHour[h] = [];
        byHour[h].push(b.avgFee || b.medianFee || b.feeRange?.[0] || 0);
      }
      const hourlyAvg = Object.entries(byHour).map(([h, fees]) => ({
        hour: parseInt(h),
        avg:  Math.round(fees.reduce((a, b) => a + b, 0) / fees.length),
      })).filter(h => h.avg > 0);

      if (hourlyAvg.length >= 4) {
        hourlyAvg.sort((a, b) => a.avg - b.avg);
        cheapHour = hourlyAvg[0].hour;
        minFee    = hourlyAvg[0].avg;
        avgFee    = Math.round(hourlyAvg.reduce((s, h) => s + h.avg, 0) / hourlyAvg.length);
      }
    }
  } catch {}

  // Если данных нет — fallback на статистику
  const STATIC_START = isWeekend ? 0 : 1; // в выходные дешевле почти весь день
  const STATIC_END   = isWeekend ? 10 : 6;
  const cheapStart = cheapHour !== null ? cheapHour : STATIC_START;
  const cheapEnd   = cheapHour !== null ? (cheapHour + 3) % 24 : STATIC_END;

  // Сколько часов до дешёвого окна
  let hoursUntilCheap;
  if (utcHour === cheapStart || (utcHour > cheapStart && utcHour < cheapEnd)) {
    hoursUntilCheap = 0;
  } else if (utcHour < cheapStart) {
    hoursUntilCheap = cheapStart - utcHour;
  } else {
    hoursUntilCheap = 24 - utcHour + cheapStart;
  }

  const isNowCheap = hoursUntilCheap === 0;
  const savingPct  = (avgFee && currentFeeRate && avgFee > minFee)
    ? Math.round((1 - minFee / currentFeeRate) * 100)
    : null;

  return {
    isNowCheap,
    hoursUntilCheap,
    cheapWindowUtc: `${String(cheapStart).padStart(2,'0')}:00–${String(cheapEnd).padStart(2,'0')}:00 UTC`,
    cheapWindowMsk: `${String((cheapStart+3)%24).padStart(2,'0')}:00–${String((cheapEnd+3)%24).padStart(2,'0')}:00 МСК`,
    currentUtcHour: utcHour,
    isWeekend,
    dynamicData: minFee !== null,   // true = данные реальные, false = статистика
    minFeeRate:   minFee,
    avgFeeRate24h: avgFee,
    potentialSavingPct: savingPct,
    tip: isNowCheap
      ? `💚 Сейчас дешёвое время — комиссии минимальны${minFee ? ` (~${minFee} sat/vB)` : ''}`
      : isWeekend
        ? `📅 Выходной — комиссии обычно ниже. Дешёвое окно через ${hoursUntilCheap}ч`
        : `⏰ Дешёвое окно через ${hoursUntilCheap}ч (${String(cheapStart).padStart(2,'0')}:00–${String(cheapEnd).padStart(2,'0')}:00 UTC)${savingPct ? ` — экономия ~${savingPct}%` : ''}`,
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
  const cheapWindow = await cheapWindowForecast(feeRate); // v14: async + динамический
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

async function handleAcceleration(req, res) {
  const ip = req.headers['x-real-ip']||req.headers['x-forwarded-for']?.split(',')[0]?.trim()||'unknown';
  if (!checkRl(ip, 20)) return res.status(429).json({ok:false,error:'Too many requests'});

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
      try { const fb=await ft(`https://blockstream.info/api/tx/${txid}`,{},7000); if(fb.ok) tx=await sj(fb); } // BUG FIX: был ft(url, 7000) — opts пропущен
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

// ══════════════════════════════════════════════════════════════
//  MAIN DISPATCHER
// ══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { Object.entries(CORS_ALL).forEach(([k,v])=>res.setHeader(k,v)); return res.status(204).end(); }
  Object.entries(CORS_ALL).forEach(([k,v]) => res.setHeader(k,v));

  // Определяем endpoint из query-параметра _fn (устанавливается через vercel.json rewrites)
  const fn = req.query?._fn || '';

  switch(fn) {
    case 'health':  return handleHealth(req, res);
    case 'status':  return handleStatus(req, res);
    case 'stats':   return handleStats(req, res);
    case 'price':   return handlePrice(req, res);
    case 'mempool': return handleMempool(req, res);
    case 'cpfp':    return handleCpfp(req, res);
    case 'rbf':     return handleRbf(req, res);
    case 'notify':  return handleNotify(req, res);
    case 'acceleration': return handleAcceleration(req, res);
    default:
      return res.status(400).json({ ok:false, error:`Unknown endpoint: ${fn}. Use _fn=health|status|stats|price|mempool|cpfp|rbf|notify` });
  }
}
