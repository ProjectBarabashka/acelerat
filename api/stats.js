// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ STATS ★  —  /api/stats.js
//  Vercel Serverless · Node.js 20
//
//  GET /api/stats          — публичные метрики
//  GET /api/stats?admin=1  — детальная статистика (с токеном)
//
//  ✦ Реальные данные биткоин-сети (блоки, хешрейт, цена)
//  ✦ Статус акселератора (in-memory счётчики)
//  ✦ Данные mempool: размер, congestion, fee rates
//  ✦ Uptime сервера
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 12 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// In-memory счётчики (сбрасываются при cold start)
const _sess = {
  startedAt:    Date.now(),
  broadcasts:   0,
  freeBroadcasts: 0,
  premBroadcasts: 0,
  verifications: 0,
  cpfpCalcs:    0,
  rbfChecks:    0,
};

// Экспортируем для импорта из других файлов (если нужно)
export function incBroadcast(plan) {
  _sess.broadcasts++;
  if (plan==='premium') _sess.premBroadcasts++;
  else _sess.freeBroadcasts++;
}
export function incVerify()  { _sess.verifications++; }
export function incCpfp()    { _sess.cpfpCalcs++; }
export function incRbf()     { _sess.rbfChecks++; }

async function ft(url, ms=7000) {
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort(),ms);
  try{ const r=await fetch(url,{signal:ac.signal}); clearTimeout(t); return r; }
  catch(e){ clearTimeout(t); throw e; }
}
async function sj(r){ try{ return await r.json(); } catch{ return {}; } }

export default async function handler(req, res) {
  if (req.method==='OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v));

  const isAdmin = req.query?.admin==='1' &&
    req.headers['x-turbotx-token']===process.env.PREMIUM_SECRET;

  try {
    // Параллельные запросы к Bitcoin-сети
    const [feesR, mpR, tipR, priceR, hrR] = await Promise.allSettled([
      ft('https://mempool.space/api/v1/fees/recommended'),
      ft('https://mempool.space/api/mempool'),
      ft('https://mempool.space/api/blocks/tip/height'),
      ft('https://mempool.space/api/v1/prices'),
      ft('https://mempool.space/api/v1/mining/hashrate/3d'),
    ]);

    const get = s => s.status==='fulfilled'&&s.value?.ok ? s.value : null;
    const fees  = get(feesR)  ? await sj(get(feesR))  : {};
    const mp    = get(mpR)    ? await sj(get(mpR))     : {};
    const tip   = get(tipR)   ? parseInt(await get(tipR).text()) : 0;
    const price = get(priceR) ? await sj(get(priceR))  : {};
    const hr    = get(hrR)    ? await sj(get(hrR))     : {};

    const feeRate  = fees.fastestFee || 0;
    const btcPrice = price.USD || null;

    // Конгестия
    const congestion =
      feeRate>150?'critical':feeRate>60?'extreme':feeRate>30?'high':feeRate>10?'medium':'low';

    // Аптайм
    const uptimeSec = Math.round((Date.now()-_sess.startedAt)/1000);
    const uptimeStr = uptimeSec < 3600
      ? `${Math.round(uptimeSec/60)} мин`
      : `${Math.round(uptimeSec/3600)} ч`;

    const pub = {
      ok: true,
      network: {
        blockHeight:  tip || null,
        feeRate:      fees.fastestFee  || null,
        feeHalfHour: fees.halfHourFee || null,
        feeEconomy:  fees.economyFee  || fees.minimumFee || null,
        congestion,
        btcPrice,
        mempoolCount: mp.count || null,
        mempoolMB:    mp.vsize ? +(mp.vsize/1e6).toFixed(1) : null,
        hashrateEHs:  hr.currentHashrate ? +(hr.currentHashrate/1e18).toFixed(2) : null,
      },
      service: {
        version:    'v6.0',
        channels:   24, // 8 nodes + 16 pools
        hashratePct: 80,
        uptime:      uptimeStr,
      },
      timestamp: Date.now(),
    };

    // Детальная статистика только для admin
    if (isAdmin) {
      pub.session = {
        startedAt:     new Date(_sess.startedAt).toISOString(),
        broadcasts:    _sess.broadcasts,
        free:          _sess.freeBroadcasts,
        premium:       _sess.premBroadcasts,
        verifications: _sess.verifications,
        cpfpCalcs:     _sess.cpfpCalcs,
        rbfChecks:     _sess.rbfChecks,
      };
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(pub);

  } catch(e) {
    return res.status(500).json({ok:false,error:e.message});
  }
}
