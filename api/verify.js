// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ PAYMENT VERIFY ★  —  /api/verify.js
//  Vercel Serverless · Node.js 20
//
//  POST /api/verify
//  Body: { txHash, expectedUsd?, method?:'btc'|'usdt'|'auto' }
//
//  ✦ BTC: проверяет mempool.space + blockstream fallback
//  ✦ USDT TRC-20: проверяет TronGrid + TronScan fallback
//  ✦ Автодетект: 64hex → BTC или TRON hash
//  ✦ Генерирует server-side токен активации Premium
//  ✦ Уведомляет в Telegram при успехе
//  ✦ Защита: rate limit 10/час с одного IP
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 20 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Кошельки (из env — безопаснее чем хардкод)
const BTC_WALLET  = process.env.BTC_WALLET  || '';
const USDT_WALLET = process.env.USDT_WALLET || '';
const PREMIUM_SECRET = process.env.PREMIUM_SECRET || '';

// In-memory rate limit
const _ipMap = new Map();
function checkIpLimit(ip) {
  const now = Date.now(), hour = 3_600_000;
  let e = _ipMap.get(ip);
  if (!e || e.resetAt < now) { e = { count:0, resetAt:now+hour }; _ipMap.set(ip,e); }
  if (e.count >= 10) return false;
  e.count++; return true;
}

function getIp(req) {
  return req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress || 'unknown';
}

async function ft(url, opts={}, ms=10000) {
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort(),ms);
  try{ const r=await fetch(url,{...opts,signal:ac.signal}); clearTimeout(t); return r; }
  catch(e){ clearTimeout(t); throw e; }
}
async function sj(r){ try{ return await r.json(); } catch{ return {}; } }

// ─── BTC VERIFICATION ────────────────────────────────────────
async function verifyBtc(txHash, expectedUsd) {
  if (!BTC_WALLET) return { ok:false, error:'BTC wallet not configured' };
  if (!/^[a-fA-F0-9]{64}$/.test(txHash))
    return { ok:false, error:'Invalid BTC tx hash format' };

  // Пробуем mempool.space → blockstream
  let tx = null;
  for (const url of [
    `https://mempool.space/api/tx/${txHash}`,
    `https://blockstream.info/api/tx/${txHash}`,
  ]) {
    try {
      const r = await ft(url, {}, 8000);
      if (r.ok) { tx = await sj(r); break; }
    } catch {}
  }

  if (!tx?.txid) return { ok:false, error:'BTC transaction not found' };

  // Ищем выход на наш кошелёк
  const out = (tx.vout||[]).find(o => o.scriptpubkey_address === BTC_WALLET);
  if (!out) return { ok:false, error:'Payment not sent to our BTC address' };

  const satsPaid  = out.value || 0;
  const btcPaid   = satsPaid / 1e8;
  const confirmed = tx.status?.confirmed || false;

  // Проверяем сумму (если передан expectedUsd)
  let amountOk = true;
  if (expectedUsd) {
    try {
      const pr = await ft('https://mempool.space/api/v1/prices', {}, 5000);
      if (pr.ok) {
        const { USD } = await sj(pr);
        const paidUsd = btcPaid * USD;
        // Допуск ±20% (курс мог измениться)
        amountOk = paidUsd >= expectedUsd * 0.8;
      }
    } catch {}
  }

  return {
    ok: amountOk,
    method: 'btc',
    txHash,
    paid: btcPaid.toFixed(6) + ' BTC',
    satsPaid,
    confirmed,
    inMempool: !confirmed,
    amountOk,
    address: BTC_WALLET,
  };
}

// ─── USDT TRC-20 VERIFICATION ─────────────────────────────────
async function verifyUsdt(txHash, expectedUsd) {
  if (!USDT_WALLET) return { ok:false, error:'USDT wallet not configured' };

  const _k=0x5a,_UC=[14, 8, 109, 20, 18, 43, 48, 63, 17, 11, 34, 29, 14, 25, 51, 98, 43, 98, 0, 3, 110, 42, 22, 98, 53, 46, 9, 32, 61, 48, 22, 48, 108, 46];
  const USDT_CONTRACT=_UC.map(b=>String.fromCharCode(b^_k)).join(''); // TRC-20 USDT

  // Источники: TronGrid (официальный) → TronScan fallback
  let txData = null;

  // 1. TronGrid API
  try {
    const tronGridKey = process.env.TRONGRID_KEY || '';
    const headers = tronGridKey ? { 'TRON-PRO-API-KEY': tronGridKey } : {};
    const r = await ft(`https://api.trongrid.io/v1/transactions/${txHash}`, { headers }, 8000);
    if (r.ok) {
      const d = await sj(r);
      txData = d?.data?.[0] || null;
    }
  } catch {}

  // 2. TronScan fallback
  if (!txData) {
    try {
      const r = await ft(`https://apilist.tronscanapi.com/api/transaction-info?hash=${txHash}`, {}, 8000);
      if (r.ok) {
        const d = await sj(r);
        if (d?.hash) txData = d;
      }
    } catch {}
  }

  if (!txData) return { ok:false, error:'USDT transaction not found in TRON network' };

  // Парсим TRC-20 трансфер
  let toAddr = null, amount = null, contractAddr = null;

  // TronGrid формат
  if (txData.raw_data?.contract?.[0]?.parameter?.value) {
    const v = txData.raw_data.contract[0].parameter.value;
    toAddr = v.to_address || v.owner_address;
    contractAddr = v.contract_address;
    // TRC-20 amount в minimal units (6 decimals для USDT)
    amount = v.call_value || 0;
  }

  // TronScan формат
  if (txData.trc20TransferInfo?.[0]) {
    const t = txData.trc20TransferInfo[0];
    toAddr      = t.to_address || t.to;
    contractAddr = t.contract_address;
    amount      = parseFloat(t.amount_str || t.amount || 0);
  }

  // Проверяем контракт (USDT TRC-20)
  const isUsdt = contractAddr &&
    (contractAddr.toUpperCase() === USDT_CONTRACT.toUpperCase() ||
     contractAddr === [[59, 108, 107, 110, 60, 98, 106, 105, 56, 108, 60, 62, 109, 98, 106, 99, 98, 108, 59, 110, 104, 57, 109, 98, 63, 57, 99, 57, 109, 60, 109, 109, 63, 108, 62, 63, 62, 107, 105, 57]].map(b=>String.fromCharCode(b^_k)).join('')); // hex форма

  if (!isUsdt) return { ok:false, error:'Not a USDT TRC-20 transaction' };

  // Проверяем получателя
  // TRON адреса могут быть в hex (41...) или base58 (T...)
  const walletHex = USDT_WALLET.startsWith('T')
    ? base58ToHex(USDT_WALLET)
    : USDT_WALLET.toLowerCase();

  const toNorm = (toAddr||'').toLowerCase().replace(/^41/, '0x');
  const walletNorm = walletHex.toLowerCase().replace(/^41/, '0x');

  const toCorrectWallet =
    toAddr === USDT_WALLET ||
    toNorm === walletNorm ||
    toAddr?.replace(/^41/,'') === walletHex.replace(/^41/,'');

  if (!toCorrectWallet) return { ok:false, error:'Payment not sent to our USDT wallet' };

  // Сумма в USDT (6 decimals)
  const usdtPaid = amount / 1e6;
  const amountOk = !expectedUsd || usdtPaid >= expectedUsd * 0.8;

  return {
    ok: amountOk,
    method: 'usdt_trc20',
    txHash,
    paid: usdtPaid.toFixed(2) + ' USDT',
    usdtPaid,
    confirmed: txData.confirmed !== false,
    amountOk,
    address: USDT_WALLET,
  };
}

// Base58 → hex (упрощённый для TRON адресов)
function base58ToHex(str) {
  const _AB=[107, 104, 105, 110, 111, 108, 109, 98, 99, 27, 24, 25, 30, 31, 28, 29, 18, 16, 17, 22, 23, 20, 10, 11, 8, 9, 14, 15, 12, 13, 2, 3, 0, 59, 56, 57, 62, 63, 60, 61, 50, 51, 48, 49, 55, 52, 53, 42, 43, 40, 41, 46, 47, 44, 45, 34, 35, 32];
  const ALPHABET=_AB.map(b=>String.fromCharCode(b^_k)).join('');
  let n = BigInt(0);
  for (const c of str) {
    const idx = ALPHABET.indexOf(c);
    if (idx < 0) return str;
    n = n * BigInt(58) + BigInt(idx);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return hex.slice(0, -8); // убираем checksum (4 байта)
}

// ─── TELEGRAM ─────────────────────────────────────────────────
async function tgNotify(result, ip) {
  const token = process.env.TG_TOKEN;
  const chat  = process.env.TG_CHAT_ID;
  if (!token || !chat) return;

  const emoji = result.method === 'btc' ? '₿' : '💚';
  const text = [
    `💰 *ОПЛАТА — TurboTX v6*`,
    `━━━━━━━━━━━━━━━━`,
    `${emoji} Сумма: \`${result.paid}\``,
    `💳 Метод: ${result.method === 'btc' ? 'Bitcoin' : 'USDT TRC-20'}`,
    `🔗 TX: \`${result.txHash?.slice(0,14)}…\``,
    `✅ Статус: ${result.confirmed ? 'Подтверждена' : 'В мемпуле'}`,
    `🌐 IP: \`${ip}\``,
    `🕐 ${new Date().toLocaleString('ru',{timeZone:'Europe/Moscow'})} МСК`,
  ].join('\n');

  const url = result.method === 'btc'
    ? `https://mempool.space/tx/${result.txHash}`
    : `https://tronscan.org/#/transaction/${result.txHash}`;

  await ft(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      chat_id:chat, text, parse_mode:'Markdown',
      reply_markup:{ inline_keyboard:[[{ text:'🔍 Проверить', url }]] },
    }),
  }, 5000).catch(()=>{});
}

// ─── MAIN ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method==='OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v));
  if (req.method!=='POST') return res.status(405).json({ok:false,error:'POST only'});

  const ip = getIp(req);
  if (!checkIpLimit(ip))
    return res.status(429).json({ok:false,error:'Too many verification attempts. Try later.'});

  const { txHash, expectedUsd, method='auto' } = req.body || {};
  if (!txHash || typeof txHash !== 'string' || txHash.length < 20)
    return res.status(400).json({ok:false,error:'txHash required'});

  let result;

  if (method === 'btc' || (method === 'auto' && /^[a-fA-F0-9]{64}$/.test(txHash))) {
    result = await verifyBtc(txHash.trim(), expectedUsd);
  } else {
    result = await verifyUsdt(txHash.trim(), expectedUsd);
    // Если USDT не нашли и хэш 64hex — пробуем BTC
    if (!result.ok && /^[a-fA-F0-9]{64}$/.test(txHash)) {
      const btcResult = await verifyBtc(txHash.trim(), expectedUsd);
      if (btcResult.ok) result = btcResult;
    }
  }

  if (result.ok) {
    tgNotify(result, ip).catch(()=>{});
    // Выдаём server-side токен активации (PREMIUM_SECRET)
    // Фронтенд использует его для последующих /api/broadcast вызовов
    result.activationToken = PREMIUM_SECRET;
    result.activatedAt = Date.now();
  }

  return res.status(200).json(result);
}
