// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ MEMPOOL ANALYTICS ★  —  /api/mempool.js
//  Vercel Serverless · Node.js 20
//
//  GET /api/mempool
//  GET /api/mempool?txid=<64hex>  — персональный прогноз
//
//  ✦ Реальная загрузка mempool + следующий блок
//  ✦ Предсказание fee rate для 1/3/6/24 блоков
//  ✦ Если txid — оценка когда попадёт в блок
//  ✦ Исторический минимум за 24ч (лучшее время платить)
//  ✦ Cache: 30 сек (быстро меняется)
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 12 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function ft(url, ms = 7000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal }); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}
async function j(r) { try { return await r.json(); } catch { return {}; } }

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));

  const txid = req.query?.txid;
  if (txid && !/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ ok:false, error:'Invalid TXID' });

  try {
    // Параллельный сбор данных
    const [feesR, mpR, blocksR, txR] = await Promise.allSettled([
      ft('https://mempool.space/api/v1/fees/recommended'),
      ft('https://mempool.space/api/mempool'),
      ft('https://mempool.space/api/v1/mining/blocks/fee-rates/24h'),
      txid ? ft(`https://mempool.space/api/tx/${txid}`) : Promise.resolve(null),
    ]);

    const get = s => s.status==='fulfilled' && s.value?.ok ? s.value : null;
    const fees   = get(feesR)   ? await j(get(feesR))   : {};
    const mp     = get(mpR)     ? await j(get(mpR))     : {};
    const blocks = get(blocksR) ? await j(get(blocksR)) : [];
    const tx     = txid && get(txR) ? await j(get(txR)) : null;

    const fastest  = fees.fastestFee    || 50;
    const halfHour = fees.halfHourFee   || 30;
    const hour     = fees.hourFee       || 20;
    const economy  = fees.economyFee    || fees.minimumFee || 5;
    const minimum  = fees.minimumFee    || 1;

    // Анализ блоков за 24ч для поиска исторического минимума
    let histMin = null, histMax = null, histAvg = null;
    if (Array.isArray(blocks) && blocks.length > 0) {
      const rates = blocks.map(b => b.avgFee || b.medianFee || b.feeRange?.[0]).filter(Boolean);
      if (rates.length) {
        histMin = Math.min(...rates);
        histMax = Math.max(...rates);
        histAvg = Math.round(rates.reduce((a,b)=>a+b,0)/rates.length);
      }
    }

    // Конгестия
    const congestionLevel =
      fastest > 200 ? 'critical' :
      fastest > 100 ? 'extreme'  :
      fastest > 50  ? 'high'     :
      fastest > 20  ? 'medium'   : 'low';

    const congestionText = {
      critical: 'Критическая перегрузка',
      extreme:  'Сильная перегрузка',
      high:     'Высокая нагрузка',
      medium:   'Умеренная нагрузка',
      low:      'Сеть свободна',
    }[congestionLevel];

    // Предсказание времени по fee rate
    function etaBlocks(feeRate) {
      if (feeRate >= fastest)  return 1;
      if (feeRate >= halfHour) return 3;
      if (feeRate >= hour)     return 6;
      if (feeRate >= economy)  return 24;
      return 144; // >24ч
    }
    function etaMin(feeRate) {
      return etaBlocks(feeRate) * 10; // ~10 мин на блок
    }

    // Персональный прогноз для txid
    let txForecast = null;
    if (tx) {
      const vsize    = tx.weight ? Math.ceil(tx.weight/4) : (tx.size||250);
      const feePaid  = tx.fee || 0;
      const feeRate  = feePaid && vsize ? Math.round(feePaid/vsize) : 0;
      const blocks_  = etaBlocks(feeRate);
      const minsEta  = etaMin(feeRate);
      const needCpfp = feeRate < fastest * 0.5;
      const rbf      = Array.isArray(tx.vin) && tx.vin.some(i=>i.sequence<=0xFFFFFFFD);

      // Позиция в мемпуле (грубая оценка)
      const mpPos = mp.count ? Math.round((1 - Math.min(feeRate/fastest,1)) * mp.count) : null;

      txForecast = {
        txid, feeRate, vsize, feePaid,
        etaBlocks: blocks_,
        etaMinutes: minsEta,
        etaText: minsEta < 60
          ? `~${minsEta} мин`
          : minsEta < 1440
            ? `~${Math.round(minsEta/60)} ч`
            : `>24 часов`,
        needCpfp,
        rbfEnabled: rbf,
        confirmed: tx.status?.confirmed || false,
        mempoolPosition: mpPos,
        // Совет
        advice: needCpfp
          ? `Комиссия слишком низкая (${feeRate} sat/vB). Используй CPFP или ускорение.`
          : feeRate >= fastest
            ? `Комиссия отличная (${feeRate} sat/vB). Подтверждение в следующем блоке.`
            : `Ожидание ~${minsEta} мин. Ускорение поможет.`,
      };
    }

    // Лучшее время для транзакции
    const bestTimeTip = economy < 10
      ? '✅ Сейчас хорошее время — сеть почти свободна'
      : histMin && economy > histMin * 2
        ? `💡 За 24ч минимум был ${histMin} sat/vB. Можно подождать.`
        : null;

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

    return res.status(200).json({
      ok: true,
      fees: { fastest, halfHour, hour, economy, minimum },
      congestion: {
        level: congestionLevel,
        text:  congestionText,
        emoji: { critical:'🔴', extreme:'🔴', high:'🟠', medium:'🟡', low:'🟢' }[congestionLevel],
      },
      mempool: {
        count:    mp.count    || 0,
        vsizeMB:  mp.vsize    ? +(mp.vsize/1e6).toFixed(2) : 0,
        totalFee: mp.total_fee || 0,
      },
      history24h: histMin ? { min: histMin, max: histMax, avg: histAvg } : null,
      predictions: {
        nextBlock:   { blocks:1,  minutes:10,  feeRate: fastest  },
        thirtyMin:   { blocks:3,  minutes:30,  feeRate: halfHour },
        oneHour:     { blocks:6,  minutes:60,  feeRate: hour     },
        economy:     { blocks:24, minutes:240, feeRate: economy  },
      },
      bestTimeTip,
      txForecast,
      timestamp: Date.now(),
    });

  } catch(e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
}
