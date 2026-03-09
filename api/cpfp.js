// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ SMART CPFP ★  —  /api/cpfp.js
//  Vercel Serverless · Node.js 20
//
//  GET /api/cpfp?txid=<64hex>&outputIndex=<n>&target=<fast|std|eco>
//
//  Умный CPFP v6:
//  ✦ Автоопределение типа адреса → точный childVsize
//     P2WPKH=110, P2SH-P2WPKH=133, P2PKH=192, P2WSH=155
//  ✦ Все выходы TX — выбирай лучший UTXO
//  ✦ Три тира скорости: eco/std/fast
//  ✦ Проверка: хватит ли value выхода на комиссию
//  ✦ Пошаговые инструкции для 5 популярных кошельков
//  ✦ BTC сумма комиссии (из текущего курса)
//  ✦ Позиция TX в мемпуле (approx)
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 15 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Типичные vsize для child TX в зависимости от типа адреса получателя
const CHILD_VSIZE_BY_TYPE = {
  'v0_p2wpkh':    110, // Native SegWit (bc1q...)   — самый дешёвый
  'v0_p2wsh':     155, // Native SegWit MultiSig
  'p2sh':         133, // P2SH-SegWit (3...)
  'p2pkh':        192, // Legacy (1...)              — самый дорогой
  'v1_p2tr':      111, // Taproot (bc1p...)
  'unknown':      141, // Среднее если не знаем
};

async function ft(url, ms = 8000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal }); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}

// Получить текущий курс BTC/USD для отображения в USD
async function getBtcPrice() {
  try {
    const r = await ft('https://mempool.space/api/v1/prices', 5000);
    if (r.ok) { const j = await r.json(); return j.USD || null; }
  } catch {}
  return null;
}

// Определить vsize child TX по типу адреса выхода
function getChildVsize(scriptpubkey_type) {
  return CHILD_VSIZE_BY_TYPE[scriptpubkey_type] || CHILD_VSIZE_BY_TYPE['unknown'];
}

// Пошаговые инструкции для популярных кошельков
function getWalletInstructions(childFeeRate, childFeeNeeded, outputAddr, outputIndex) {
  const addr = outputAddr ? `\`${outputAddr.slice(0, 12)}…\`` : `выход #${outputIndex}`;
  return {
    electrum: [
      `Открой Electrum → Coin Control → найди ${addr}`,
      `Создай новую транзакцию трата этого UTXO → на свой же адрес`,
      `В поле "Fee" установи ${childFeeRate} sat/vB`,
      `Подпиши и отправь`,
    ],
    sparrow: [
      `Sparrow Wallet → UTXOs → найди ${addr}`,
      `ПКМ → "Send from" → создай транзакцию`,
      `Fee Rate: ${childFeeRate} sat/vB (≈${childFeeNeeded} sat)`,
      `Broadcast`,
    ],
    bluewallet: [
      `BlueWallet → Coin Control → выбери UTXO ${addr}`,
      `Создай транзакцию с fee ${childFeeRate} sat/vB`,
      `Отправь на свой же адрес (self-transfer)`,
    ],
    wasabi: [
      `Wasabi → Coins → выбери ${addr}`,
      `Send → своему адресу → Custom fee: ${childFeeRate} sat/vB`,
    ],
    ledger: [
      `Ledger Live → Send → Advanced → Custom fees`,
      `Установи ${childFeeRate} sat/vB, потрать UTXO ${addr}`,
    ],
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const txid        = req.query?.txid;
  const outputIndex = parseInt(req.query?.outputIndex ?? '0');
  const targetTier  = req.query?.target || 'fast'; // eco | std | fast

  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return res.status(400).json({ ok: false, error: 'Invalid TXID' });

  try {
    const [txR, feesR, btcPrice] = await Promise.all([
      ft(`https://mempool.space/api/tx/${txid}`),
      ft('https://mempool.space/api/v1/fees/recommended'),
      getBtcPrice(),
    ]);

    if (!txR.ok) return res.status(404).json({ ok: false, error: 'TX not found in mempool' });

    const tx   = await txR.json();
    const fees = feesR.ok ? await feesR.json() : {};

    // Уже подтверждена?
    if (tx.status?.confirmed) {
      return res.status(200).json({
        ok: true, needed: false,
        reason: 'TX already confirmed',
        blockHeight: tx.status.block_height,
      });
    }

    // Параметры родительской TX
    const parentVsize   = tx.weight ? Math.ceil(tx.weight / 4) : (tx.size || 250);
    const parentFeePaid = tx.fee || 0;
    const parentFeeRate = parentFeePaid && parentVsize ? Math.round(parentFeePaid / parentVsize) : 0;

    // Целевые ставки по тирам
    const targetRates = {
      eco:  fees.halfHourFee  || Math.max(parentFeeRate + 2, 5),
      std:  fees.halfHourFee  || 10,
      fast: fees.fastestFee   || 30,
    };
    const target = targetRates[targetTier] || targetRates.fast;

    // Нужен ли вообще CPFP?
    const needed = parentFeeRate < target * 0.85;

    // Все выходы — выбираем указанный (или лучший по value)
    const outputs = tx.vout || [];
    const out = outputs[outputIndex] || outputs.reduce((best, o) =>
      o.value > (best?.value || 0) ? o : best, null);
    const bestOutputIndex = out === outputs[outputIndex] ? outputIndex
      : outputs.indexOf(out);

    // Определяем childVsize по типу адреса
    const childVsize    = getChildVsize(out?.scriptpubkey_type);
    const packageVsize  = parentVsize + childVsize;

    // Комиссия которую должна заплатить child TX
    const totalFeeNeeded = target * packageVsize;
    const childFeeNeeded = Math.max(1, Math.ceil(totalFeeNeeded - parentFeePaid));
    const childFeeRate   = Math.ceil(childFeeNeeded / childVsize);

    // Хватит ли value выхода на оплату?
    const outValue      = out?.value || 0;
    const canAfford     = outValue > childFeeNeeded + 546; // 546 sat — dust limit
    const remainingSat  = outValue - childFeeNeeded;
    const remainingUsd  = btcPrice ? ((remainingSat / 1e8) * btcPrice).toFixed(2) : null;

    // USD стоимость комиссии
    const childFeeUsd = btcPrice
      ? ((childFeeNeeded / 1e8) * btcPrice).toFixed(2)
      : null;

    // Мемпул позиция (грубая оценка)
    let mempoolPosition = null;
    try {
      const mpR = await ft('https://mempool.space/api/mempool', 5000);
      if (mpR.ok) {
        const mp = await mpR.json();
        const totalTx = mp.count || 0;
        // Позиция ≈ % TX с более высоким fee rate
        mempoolPosition = totalTx > 0
          ? `~${Math.round((1 - parentFeeRate / target) * 100)}% транзакций имеют приоритет выше вашей`
          : null;
      }
    } catch {}

    const walletInstructions = getWalletInstructions(
      childFeeRate, childFeeNeeded,
      out?.scriptpubkey_address || null,
      bestOutputIndex
    );

    return res.status(200).json({
      ok:      true,
      needed,
      txid,

      // Родительская TX
      parent: {
        vsize:    parentVsize,
        feePaid:  parentFeePaid,
        feeRate:  parentFeeRate,
        inputs:   (tx.vin  || []).length,
        outputs:  (tx.vout || []).length,
      },

      // Целевые ставки
      targets: {
        eco:  targetRates.eco,
        std:  targetRates.std,
        fast: targetRates.fast,
        selected: targetTier,
        current: target,
      },

      // Дочерняя TX
      child: {
        vsize:       childVsize,
        feeNeeded:   childFeeNeeded,
        feeRate:     childFeeRate,
        feeUsd:      childFeeUsd,
        addressType: out?.scriptpubkey_type || 'unknown',
      },

      // Пакет
      package: {
        vsize:   packageVsize,
        feeRate: target,
      },

      // Выход для CPFP
      output: out ? {
        index:      bestOutputIndex,
        value:      outValue,
        address:    out.scriptpubkey_address || null,
        type:       out.scriptpubkey_type    || null,
        canAfford,
        remainingSat,
        remainingUsd,
      } : null,

      // Все выходы (для выбора в UI)
      allOutputs: outputs.map((o, i) => ({
        index:   i,
        value:   o.value,
        address: o.scriptpubkey_address || null,
        type:    o.scriptpubkey_type    || null,
      })),

      mempoolPosition,
      walletInstructions,

      // Инструкция краткая (для Telegram/bot)
      instructions: {
        ru: `Создай дочернюю TX, потрать выход #${bestOutputIndex} (${outValue} sat), установи комиссию ${childFeeRate} sat/vB (≈${childFeeNeeded} sat${childFeeUsd ? ` / ~$${childFeeUsd}` : ''})`,
        en: `Create child TX spending output #${bestOutputIndex} (${outValue} sat) with fee rate ${childFeeRate} sat/vB (≈${childFeeNeeded} sat${childFeeUsd ? ` / ~$${childFeeUsd}` : ''})`,
      },

      timestamp: Date.now(),
    });

  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
