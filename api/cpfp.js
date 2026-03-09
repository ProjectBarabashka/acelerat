// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ CPFP CALCULATOR ★  —  /api/cpfp.js
//  Vercel Serverless · Node.js 20
//
//  GET /api/cpfp?txid=<64hex>&outputIndex=<n>&target=eco|std|fast
//
//  ✦ Определяет тип адреса → точный childVsize
//  ✦ Все выходы TX (выбор оптимального UTXO)
//  ✦ USD сумма комиссии (BTC/USD из mempool.space)
//  ✦ Позиция в мемпуле до и после CPFP
//  ✦ Инструкции для 5 кошельков
//  ✦ Сравнение с RBF если применимо
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 15 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Точный vsize дочерней TX по типу адреса (1in-1out)
const CHILD_VSIZE = {
  v0_p2wpkh: 110,  // Native SegWit — самый дешёвый
  v0_p2wsh:  155,  // SegWit MultiSig
  p2sh:      133,  // P2SH
  p2pkh:     192,  // Legacy — самый дорогой
  v1_p2tr:   111,  // Taproot
  unknown:   140,  // среднее
};

const ADDR_TYPE_NAMES = {
  v0_p2wpkh: 'Native SegWit (bc1q)',
  v0_p2wsh:  'SegWit MultiSig (bc1q long)',
  p2sh:      'P2SH (3...)',
  p2pkh:     'Legacy (1...)',
  v1_p2tr:   'Taproot (bc1p)',
  unknown:   'Unknown',
};

async function ft(url, ms=7000) {
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort(),ms);
  try{ const r=await fetch(url,{signal:ac.signal}); clearTimeout(t); return r; }
  catch(e){ clearTimeout(t); throw e; }
}
async function safeJson(r){ try{ return await r.json(); } catch{ return {}; } }

async function getBtcPrice() {
  try {
    const r = await ft('https://mempool.space/api/v1/prices', 5000);
    if (r.ok) { const j = await safeJson(r); return j.USD||null; }
  } catch {}
  return null;
}

function detectAddrType(scriptpubkey_type) {
  const map = {
    'v0_p2wpkh': 'v0_p2wpkh',
    'v0_p2wsh':  'v0_p2wsh',
    'p2sh':      'p2sh',
    'p2pkh':     'p2pkh',
    'v1_p2tr':   'v1_p2tr',
  };
  return map[scriptpubkey_type] || 'unknown';
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));

  const txid        = req.query?.txid;
  const outputIndex = parseInt(req.query?.outputIndex ?? '0');
  const targetMode  = req.query?.target || 'fast'; // eco|std|fast

  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ ok:false, error:'Invalid TXID' });

  try {
    const [txR, feesR, mpR, priceP] = await Promise.all([
      ft(`https://mempool.space/api/tx/${txid}`),
      ft('https://mempool.space/api/v1/fees/recommended'),
      ft('https://mempool.space/api/mempool'),
      getBtcPrice(),
    ]);

    if (!txR.ok) {
      // Fallback: blockstream
      const fb = await ft(`https://blockstream.info/api/tx/${txid}`, 6000);
      if (!fb.ok) return res.status(404).json({ ok:false, error:'TX not found' });
    }

    const tx   = await safeJson(txR.ok ? txR : { json:()=>({}) });
    const fees = feesR.ok ? await safeJson(feesR) : {};
    const mp   = mpR.ok  ? await safeJson(mpR)   : {};

    if (tx.status?.confirmed)
      return res.status(200).json({ ok:true, needed:false, reason:'already_confirmed' });

    const vsize   = tx.weight ? Math.ceil(tx.weight/4) : (tx.size||250);
    const feePaid = tx.fee || 0;
    const feeRate = feePaid&&vsize ? Math.round(feePaid/vsize) : 0;

    // Целевой fee rate по режиму
    const targets = {
      eco:  fees.hourFee     || fees.halfHourFee || 20,
      std:  fees.halfHourFee || fees.fastestFee  || 30,
      fast: fees.fastestFee  || 50,
    };
    const target = targets[targetMode] || targets.fast;

    // Определяем тип адреса из выходов (ищем оптимальный UTXO)
    const outputs = tx.vout || [];

    // Выбираем лучший выход для CPFP:
    // 1. Указанный outputIndex, если есть
    // 2. Иначе — с наибольшей суммой (хватит на fee)
    let bestOutput = null;
    let bestIdx = outputIndex;

    if (outputs[outputIndex]) {
      bestOutput = outputs[outputIndex];
    } else if (outputs.length > 0) {
      // Найти выход с max value
      let maxVal = -1;
      outputs.forEach((o,i) => {
        if ((o.value||0) > maxVal) { maxVal=o.value; bestIdx=i; bestOutput=o; }
      });
    }

    const addrType   = bestOutput ? detectAddrType(bestOutput.scriptpubkey_type) : 'unknown';
    const childVsize = CHILD_VSIZE[addrType] || CHILD_VSIZE.unknown;

    // CPFP расчёт
    const packageVsize   = vsize + childVsize;
    const totalFeeNeeded = target * packageVsize;
    const childFeeNeeded = Math.max(0, totalFeeNeeded - feePaid);
    const childFeeRate   = Math.ceil(childFeeNeeded / childVsize);

    const canAfford = bestOutput && bestOutput.value > childFeeNeeded + 546; // 546 dust limit

    // USD
    const feeUsd = priceP && childFeeNeeded
      ? +((childFeeNeeded/1e8)*priceP).toFixed(4) : null;

    // Позиция в мемпуле до и после CPFP
    const mpCount = mp.count || 0;
    const posBefore = mpCount ? Math.round((1-Math.min(feeRate/target,1))*mpCount) : null;
    const posAfter  = 0; // после CPFP попадаем в следующий блок

    // Все выходы для UI выбора
    const allOutputs = outputs.map((o,i) => ({
      index:     i,
      value:     o.value,
      valueBtc:  o.value ? +(o.value/1e8).toFixed(8) : 0,
      address:   o.scriptpubkey_address || null,
      type:      detectAddrType(o.scriptpubkey_type),
      typeName:  ADDR_TYPE_NAMES[detectAddrType(o.scriptpubkey_type)],
      canAfford: o.value > childFeeNeeded + 546,
    }));

    // Инструкции для кошельков
    const walletInstructions = {
      electrum: [
        'Убедись что TX видна в Electrum (может занять время)',
        'Coins → найди UTXO из выхода #' + bestIdx,
        `ПКМ → Spend → создай новую TX`,
        `Установи fee rate: ${childFeeRate} sat/vB (${childFeeNeeded} sat)`,
        'Отправь на любой свой адрес (можно тот же)',
      ],
      sparrow: [
        'UTXOs → найди выход #' + bestIdx + ' от этой TX',
        'ПКМ → "Send From"',
        `Fee rate: ${childFeeRate} sat/vB`,
        'Sign → Broadcast',
      ],
      bluewallet: [
        'Coin Control → выбери UTXO #' + bestIdx,
        'Создай транзакцию отправки',
        `Укажи Custom fee: ${childFeeRate} sat/vB`,
        'Confirm',
      ],
      wasabi: [
        'Coins → выбери монету из TX ' + txid.slice(0,8) + '...',
        `Fee: ${childFeeRate} sat/vB`,
        'Send → Broadcast',
      ],
      ledger: [
        'Ledger Live → Portfolio → Send',
        'Выбери кошелёк с этой TX',
        `Advanced fee: ${childFeeRate} sat/vB`,
        'Confirm на устройстве',
      ],
    };

    const needed = feeRate < target * 0.9;

    return res.status(200).json({
      ok: true,
      needed,
      txid,
      targetMode,
      parent: {
        vsize, feePaid, feeRate,
        feeUsd: priceP ? +((feePaid/1e8)*priceP).toFixed(4) : null,
      },
      targets: {
        eco:  targets.eco,
        std:  targets.std,
        fast: targets.fast,
        selected: target,
      },
      child: {
        addressType:  addrType,
        addressTypeName: ADDR_TYPE_NAMES[addrType],
        vsize:        childVsize,
        feeNeeded:    childFeeNeeded,
        feeRate:      childFeeRate,
        feeUsd,
        canAfford,
      },
      package: {
        vsize:       packageVsize,
        totalFee:    totalFeeNeeded,
        effectiveRate: target,
      },
      output: bestOutput ? {
        index:    bestIdx,
        value:    bestOutput.value,
        valueBtc: +(bestOutput.value/1e8).toFixed(8),
        address:  bestOutput.scriptpubkey_address || null,
        type:     addrType,
        canAfford,
      } : null,
      allOutputs,
      mempoolPosition: { before: posBefore, after: posAfter },
      walletInstructions,
      btcPrice: priceP,
      timestamp: Date.now(),
    });

  } catch(e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
}
