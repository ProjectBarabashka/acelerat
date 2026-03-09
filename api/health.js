// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ HEALTH CHECK ★  —  /api/health.js
//  Vercel Serverless · Node.js 20
//
//  GET /api/health
//  GET /api/health?verbose=1  — детальный статус каждого пула
//
//  ✦ Ping всех 16 пулов + 8 hex-узлов
//  ✦ Статус: ok / timeout / error
//  ✦ Время ответа каждого канала
//  ✦ Общий % доступности и % хешрейта
//  ✦ Для мониторинга + отображения в UI
//  ✦ Cache: 2 минуты
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 20 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const HR = {
  Foundry:27, AntPool:16, MARA:11, ViaBTC:9, SpiderPool:8,
  F2Pool:7, Luxor:5, CloverPool:4, BitFuFu:4, 'BTC.com':3,
  TxBoost:2, mempoolAccel:1, bitaccelerate:1, '360btc':1, txfaster:1, btcspeed:1,
};

// Пинг через HEAD/GET — просто проверяем доступность
const CHANNELS = [
  // Hex nodes
  { name:'mempool.space',   tier:'node', url:'https://mempool.space/api/blocks/tip/height',   method:'GET' },
  { name:'blockstream',     tier:'node', url:'https://blockstream.info/api/blocks/tip/height', method:'GET' },
  { name:'blockchair',      tier:'node', url:'https://api.blockchair.com/bitcoin/stats',        method:'GET' },
  { name:'blockcypher',     tier:'node', url:'https://api.blockcypher.com/v1/btc/main',         method:'GET' },
  { name:'btcscan',         tier:'node', url:'https://btcscan.org/api/blocks/tip/height',       method:'GET' },
  { name:'blockchain.info', tier:'node', url:'https://blockchain.info/latestblock',             method:'GET' },
  { name:'bitaps',          tier:'node', url:'https://bitaps.com/api/bitcoin/blockcount',       method:'GET' },
  { name:'sochain',         tier:'node', url:'https://sochain.com/api/v2/get_info/BTC',         method:'GET' },
  // Pools
  { name:'Foundry',      tier:'pool', url:'https://foundryusapool.com/',         method:'HEAD' },
  { name:'AntPool',      tier:'pool', url:'https://www.antpool.com/',            method:'HEAD' },
  { name:'MARA',         tier:'pool', url:'https://mara.com/',                   method:'HEAD' },
  { name:'ViaBTC',       tier:'pool', url:'https://viabtc.com/',                 method:'HEAD' },
  { name:'SpiderPool',   tier:'pool', url:'https://www.spiderpool.com/',         method:'HEAD' },
  { name:'F2Pool',       tier:'pool', url:'https://www.f2pool.com/',             method:'HEAD' },
  { name:'Luxor',        tier:'pool', url:'https://luxor.tech/',                 method:'HEAD' },
  { name:'CloverPool',   tier:'pool', url:'https://clvpool.com/',                method:'HEAD' },
  { name:'BitFuFu',      tier:'pool', url:'https://www.bitfufu.com/',            method:'HEAD' },
  { name:'BTC.com',      tier:'pool', url:'https://btc.com/',                    method:'HEAD' },
  { name:'TxBoost',      tier:'pool', url:'https://txboost.com/',                method:'HEAD' },
  { name:'mempoolAccel', tier:'pool', url:'https://mempool.space/',              method:'HEAD' },
  { name:'bitaccelerate',tier:'pool', url:'https://www.bitaccelerate.com/',      method:'HEAD' },
  { name:'360btc',       tier:'pool', url:'https://360btc.net/',                 method:'HEAD' },
  { name:'txfaster',     tier:'pool', url:'https://txfaster.com/',               method:'HEAD' },
  { name:'btcspeed',     tier:'pool', url:'https://btcspeed.org/',               method:'HEAD' },
];

async function ping(ch, timeout=5000) {
  const t0 = Date.now();
  try {
    const ac = new AbortController();
    const tm = setTimeout(()=>ac.abort(), timeout);
    const r  = await fetch(ch.url, { method:ch.method, signal:ac.signal });
    clearTimeout(tm);
    const ms = Date.now()-t0;
    // 2xx или 3xx или 4xx (сервер жив, просто не тот endpoint)
    const ok = r.status < 500;
    return { name:ch.name, tier:ch.tier, ok, status:r.status, ms };
  } catch(e) {
    return { name:ch.name, tier:ch.tier, ok:false, status:0, ms:Date.now()-t0,
      error: e.name==='AbortError'?'timeout':e.message };
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));

  const verbose = req.query?.verbose === '1';

  const t0 = Date.now();
  const results = await Promise.all(CHANNELS.map(ch => ping(ch)));
  const elapsed = Date.now()-t0;

  const nodes = results.filter(r=>r.tier==='node');
  const pools = results.filter(r=>r.tier==='pool');

  const nodesOk = nodes.filter(r=>r.ok).length;
  const poolsOk = pools.filter(r=>r.ok).length;

  // Доступный хешрейт
  const hrAvailable = pools
    .filter(r=>r.ok)
    .reduce((s,r) => s+(HR[r.name]||0), 0);

  // Средний ping
  const avgMs = Math.round(results.reduce((s,r)=>s+r.ms,0)/results.length);

  // Общий статус
  const overallOk = nodesOk >= 2 && poolsOk >= 5;
  const status = !overallOk ? 'degraded' : hrAvailable >= 60 ? 'ok' : 'partial';

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=180');

  return res.status(200).json({
    ok:     overallOk,
    status,
    elapsed,
    summary: {
      nodes:  { ok:nodesOk,  total:nodes.length },
      pools:  { ok:poolsOk,  total:pools.length },
      hrAvailable,
      avgPingMs: avgMs,
    },
    ...(verbose ? { channels: results } : {
      // Не verbose — только упавшие
      failed: results.filter(r=>!r.ok).map(r=>({name:r.name,tier:r.tier,error:r.error||`HTTP ${r.status}`})),
    }),
    timestamp: Date.now(),
  });
}
