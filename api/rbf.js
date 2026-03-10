// Rate limiter — 20 req/min per IP
const _rl = new Map();
function checkRl(ip) {
  const now = Date.now(), min = 60_000;
  if (_rl.size > 2000) for (const [k,v] of _rl) if (v.r < now) _rl.delete(k);
  let e = _rl.get(ip); if (!e || e.r < now) { e = {c:0, r:now+min}; _rl.set(ip,e); }
  return ++e.c <= 20;
}

// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ RBF CALCULATOR ★  —  /api/rbf.js
//  Vercel Serverless · Node.js 20
//
//  GET /api/rbf?txid=<64hex>&targetFee=<sat/vB>
//
//  ✦ Проверяет поддержку RBF (sequence < 0xFFFFFFFE)
//  ✦ Рассчитывает новую комиссию для замены TX
//  ✦ BIP-125 правило: новая fee >= старая + min_relay (1 sat/vB)
//  ✦ Инструкции для 5 кошельков
//  ✦ Сравнение RBF vs CPFP — что выгоднее
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

// BTC/USD
async function getBtcPrice() {
  try {
    const r = await ft('https://mempool.space/api/v1/prices', 5000);
    if (r.ok) { const j = await r.json(); return j.USD || null; }
  } catch {}
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
  const _ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!checkRl(_ip)) return res.status(429).json({ ok:false, error:'Too many requests' });


  const txid      = req.query?.txid;
  const targetFee = parseInt(req.query?.targetFee) || null;

  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ ok:false, error:'Invalid TXID' });

  try {
    const [txRes, feesRes, priceRes] = await Promise.allSettled([
      ft(`https://mempool.space/api/tx/${txid}`),
      ft('https://mempool.space/api/v1/fees/recommended'),
      getBtcPrice(),
    ]);

    const getR = s => s.status === 'fulfilled' ? s.value : null;
    const txR    = getR(txRes);
    const feesR  = getR(feesRes);
    const priceP = getR(priceRes);

    if (!txR?.ok) return res.status(404).json({ ok:false, error:'TX not found' });
    const tx   = await txR.json();
    const fees = feesR?.ok ? await feesR.json() : {};

    if (tx.status?.confirmed)
      return res.status(200).json({ ok:true, rbfPossible:false, reason:'already_confirmed' });

    const vsize    = tx.weight ? Math.ceil(tx.weight/4) : (tx.size||250);
    const feePaid  = tx.fee || 0;
    const feeRate  = feePaid && vsize ? Math.round(feePaid/vsize) : 0;
    const fastest  = fees.fastestFee || 50;
    const minRelay = 1; // BIP-125: min relay fee 1 sat/vB

    // Проверка RBF флага
    const rbfInputs = (tx.vin||[]).filter(i => i.sequence <= 0xFFFFFFFD);
    const rbfEnabled = rbfInputs.length > 0;

    if (!rbfEnabled) {
      // Не RBF — подсказываем CPFP
      return res.status(200).json({
        ok: true,
        rbfEnabled: false,
        rbfPossible: false,
        reason: 'RBF not signaled in any input',
        alternative: 'cpfp',
        alternativeUrl: `/api/cpfp?txid=${txid}`,
        txid, feeRate, vsize, feePaid,
      });
    }

    // Целевой fee rate
    const target = targetFee || fastest;

    // BIP-125 правило: новая абсолютная fee >= старая + vsize*minRelay
    const minNewFee    = feePaid + vsize * minRelay;
    const targetFeeAbs = target * vsize;
    const newFeeAbs    = Math.max(minNewFee, targetFeeAbs);
    const newFeeRate   = Math.ceil(newFeeAbs / vsize);
    const feeDiff      = newFeeAbs - feePaid; // сколько доплатить

    // USD
    const feeDiffUsd = priceP ? +((feeDiff / 1e8) * priceP).toFixed(4) : null;
    const newFeeUsd  = priceP ? +((newFeeAbs / 1e8) * priceP).toFixed(4) : null;

    // CPFP сравнение
    const cpfpChildVsize = 110; // P2WPKH child
    const cpfpFeeNeeded  = Math.max(0, fastest * (vsize + cpfpChildVsize) - feePaid);
    const cpfpUsd        = priceP ? +((cpfpFeeNeeded/1e8)*priceP).toFixed(4) : null;

    const rbfCheaper = feeDiff < cpfpFeeNeeded;

    // Инструкции по кошелькам
    const walletInstructions = {
      electrum: [
        'Открой Electrum → История транзакций',
        `Правый клик на TX → "Increase fee" (RBF)`,
        `Установи fee rate: ${newFeeRate} sat/vB`,
        'Подпиши и отправь новую транзакцию',
      ],
      sparrow: [
        'Открой Sparrow → Transactions',
        'Выбери TX → кнопка "Replace by fee"',
        `Установи ${newFeeRate} sat/vB`,
        'Sign → Broadcast',
      ],
      bluewallet: [
        'Открой BlueWallet → транзакция',
        'Нажми "Bump Fee" (RBF)',
        `Выбери Custom: ${newFeeRate} sat/vB`,
        'Confirm',
      ],
      wasabi: [
        'Wasabi → History',
        'ПКМ на TX → "Speed Up Transaction"',
        `Выбери fee: ${newFeeRate} sat/vB`,
        'Broadcast',
      ],
      bitbox: [
        'BitBox App → Activity',
        'Найди TX → "Bump fee"',
        `Укажи ${newFeeRate} sat/vB`,
        'Confirm on device',
      ],
    };

    return res.status(200).json({
      ok: true,
      rbfEnabled: true,
      rbfPossible: true,
      txid,
      current: {
        feeRate, feePaid, vsize,
        feeUsd: priceP ? +((feePaid/1e8)*priceP).toFixed(4) : null,
      },
      replacement: {
        feeRate:  newFeeRate,
        feeAbs:   newFeeAbs,
        feeDiff,
        feeDiffUsd,
        feeUsd:   newFeeUsd,
        targetFeeRate: target,
      },
      bip125: {
        minNewFee,
        minRelayFeeRate: minRelay,
        satisfiesBip125: newFeeAbs >= minNewFee,
      },
      vsRbf: {
        rbfFeeDiff:   feeDiff,
        cpfpFeeNeeded,
        rbfCheaper,
        recommendation: rbfCheaper
          ? `RBF дешевле на ${cpfpFeeNeeded - feeDiff} sat`
          : `CPFP дешевле на ${feeDiff - cpfpFeeNeeded} sat`,
      },
      walletInstructions,
      btcPrice: priceP,
      timestamp: Date.now(),
    });

  } catch(e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
}
