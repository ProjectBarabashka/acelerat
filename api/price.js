// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ DYNAMIC PRICE ★  —  /api/price.js
//  Vercel Serverless · Node.js 20
//
//  GET /api/price
//
//  ✦ Реальная загрузка мемпула → sat/vB
//  ✦ BTC/USD из 3 источников (race — берём первый)
//  ✦ Динамическая цена $3–18 по 5 тирам
//  ✦ Прогноз: лучшее время для транзакции
//  ✦ Cache: 3 мин на CDN Vercel
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 10 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const TIERS = [
  { maxFee:  10, usd:  3, label:'low',      emoji:'🟢', text:'Сеть свободна',        textEn:'Network is clear'     },
  { maxFee:  30, usd:  4, label:'medium',   emoji:'🟡', text:'Умеренная нагрузка',   textEn:'Moderate load'        },
  { maxFee:  60, usd:  7, label:'high',     emoji:'🟠', text:'Высокая нагрузка',     textEn:'High load'            },
  { maxFee: 150, usd: 12, label:'extreme',  emoji:'🔴', text:'Перегрузка сети',      textEn:'Network congested'    },
  { maxFee: Infinity, usd:18, label:'critical', emoji:'🔴', text:'Критическая перегрузка', textEn:'Critical congestion' },
];

async function ft(url, ms=5000) {
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort(),ms);
  try{ const r=await fetch(url,{signal:ac.signal}); clearTimeout(t); return r; }
  catch(e){ clearTimeout(t); throw e; }
}

async function getFeeRate() {
  try {
    const r = await ft('https://mempool.space/api/v1/fees/recommended');
    if (r.ok) { const j=await r.json(); return { rate: j.fastestFee||20, all: j }; }
  } catch {}
  try {
    const r = await ft('https://blockstream.info/api/fee-estimates');
    if (r.ok) { const j=await r.json(); return { rate: j['1']||j['3']||20, all: {} }; }
  } catch {}
  return { rate: 20, all: {} };
}

async function getMempoolStats() {
  try {
    const r = await ft('https://mempool.space/api/mempool');
    if (r.ok) { const j=await r.json(); return { count:j.count, vsize:j.vsize, totalFee:j.total_fee }; }
  } catch {}
  return null;
}

async function getBtcPrice() {
  const sources = [
    { url:'https://mempool.space/api/v1/prices',               path:['USD'] },
    { url:'https://api.coinbase.com/v2/prices/BTC-USD/spot',   path:['data','amount'] },
    { url:'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', path:['price'] },
  ];
  return new Promise(resolve => {
    let found=false, done=0;
    for(const {url,path} of sources){
      ft(url).then(async r=>{
        if(!r.ok) throw 0;
        const j=await r.json();
        const price=parseFloat(path.reduce((o,k)=>o?.[k],j));
        if(!found&&price>1000){ found=true; resolve(price); }
      }).catch(()=>{}).finally(()=>{
        if(++done===sources.length&&!found) resolve(null);
      });
    }
  });
}

// Прогноз — когда лучше всего платить
function bestTimeTip(feeRate, all) {
  const eco = all?.economyFee || all?.minimumFee || 1;
  if (feeRate <= 5)  return { tip:'💚 Идеально — сеть почти пустая. Самое дешёвое время.', quality:'excellent' };
  if (feeRate <= 15) return { tip:'✅ Хорошее время для транзакции.', quality:'good' };
  if (feeRate <= 50) return { tip:'🟡 Умеренная нагрузка. Если не срочно — подожди ночи (UTC 02:00–06:00).', quality:'ok' };
  if (feeRate <= 100)return { tip:'🟠 Высокая нагрузка. Рекомендуем ускорение или подождать.', quality:'poor' };
  return { tip:'🔴 Критическая перегрузка. Транзакции застревают. TurboTX поможет ускорить.', quality:'critical' };
}

export default async function handler(req, res) {
  if (req.method==='OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v));

  const [{rate:feeRate, all:allFees}, btcPrice, mempoolStats] = await Promise.all([
    getFeeRate(),
    getBtcPrice(),
    getMempoolStats(),
  ]);

  const tier = TIERS.find(t=>feeRate<=t.maxFee) ?? TIERS.at(-1);
  const usd  = tier.usd;
  const btc  = btcPrice ? parseFloat((usd/btcPrice).toFixed(6)) : null;
  const tip  = bestTimeTip(feeRate, allFees);

  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=300');

  return res.status(200).json({
    ok: true,
    usd, btc, btcPrice,
    feeRate,
    fees: {
      fastest:  allFees.fastestFee  || feeRate,
      halfHour: allFees.halfHourFee || feeRate,
      hour:     allFees.hourFee     || feeRate,
      economy:  allFees.economyFee  || allFees.minimumFee || 1,
    },
    congestion: tier.label,
    emoji:      tier.emoji,
    text:       tier.text,
    textEn:     tier.textEn,
    bestTime:   tip,
    mempool:    mempoolStats,
    tiers: TIERS.map(t=>({
      usd:t.usd, label:t.label, emoji:t.emoji,
      text:t.text, textEn:t.textEn,
      maxFee:t.maxFee===Infinity?null:t.maxFee,
    })),
    timestamp: Date.now(),
  });
}
