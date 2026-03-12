// ══════════════════════════════════════════════════════════════
//  TurboTX v9 ★ LIGHTNING PAYMENT ★  —  /api/lightning.js
//  Vercel Serverless · Node.js 20
//
//  POST /api/lightning          — создать invoice
//  Body: { amountUsd, txid? }   — сумма в USD, опционально TXID
//  → { invoice, paymentHash, amountSats, expiresAt, qr }
//
//  GET /api/lightning?hash=<paymentHash>  — проверить оплату
//  → { paid, settled, amountSats }
//
//  Протокол: Lightning Address → LNURL-pay (стандарт LUD-06/LUD-16)
//  Совместим с: Wallet of Satoshi, Phoenix, Breez, Muun, LNbits, любым LN кошельком
//
//  Env:
//    LIGHTNING_ADDRESS — Lightning Address (user@domain.com)
//    PREMIUM_SECRET    — для авторизации внутренних вызовов
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 20 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TurboTX-Token',
};

// ─── RATE LIMITER ─────────────────────────────────────────────
const _rl = new Map();
function checkRl(ip) {
  const now = Date.now(), h = 3_600_000;
  if (_rl.size > 1000) for (const [k,v] of _rl) if (v.r < now) _rl.delete(k);
  let e = _rl.get(ip);
  if (!e || e.r < now) { e = {c:0, r:now+h}; _rl.set(ip, e); }
  return ++e.c <= 20; // 20 invoice/час с одного IP
}

function getIp(req) {
  return req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

// ─── In-memory invoice store ──────────────────────────────────
// Хранит pending invoices с TTL (Vercel instance живёт часами)
// В production стоит заменить на Redis/KV, но для hobby плана хватит
const _invoices = new Map(); // paymentHash → { amountSats, amountUsd, txid, createdAt, expiresAt, paid }
const INVOICE_TTL = 60 * 60_000; // 1 час

function cleanInvoices() {
  const now = Date.now();
  const PAID_GRACE = 24 * 60 * 60_000; // оплаченные храним 24 часа (для идемпотентности)
  for (const [k, v] of _invoices) {
    if (v.paid) {
      // BUG FIX: не удаляем оплаченные invoice сразу — polling может прийти позже
      if (now - v.paidAt > PAID_GRACE) _invoices.delete(k);
    } else {
      if (v.expiresAt < now) _invoices.delete(k);
    }
  }
}

// ─── УТИЛИТЫ ──────────────────────────────────────────────────
async function ft(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}
async function sj(r) { try { return await r.json(); } catch { return {}; } }

// ─── BTC PRICE ────────────────────────────────────────────────
async function getBtcPrice() {
  try {
    const r = await ft('https://mempool.space/api/v1/prices', {}, 5000);
    if (r.ok) { const j = await sj(r); return j.USD || null; }
  } catch {}
  try {
    const r = await ft('https://api.coinbase.com/v2/prices/BTC-USD/spot', {}, 5000);
    if (r.ok) { const j = await sj(r); return parseFloat(j?.data?.amount) || null; }
  } catch {}
  return null;
}

// ─── USD → SATS ───────────────────────────────────────────────
function usdToSats(usd, btcPrice) {
  if (!btcPrice || btcPrice <= 0) return null;
  return Math.ceil((usd / btcPrice) * 1e8);
}

// ─── LNURL-PAY STEP 1: получаем параметры от Lightning Address ─
// Спека LUD-16: https://github.com/lnurl/luds/blob/luds/16.md
// BUG FIX: кэшируем на 5 минут — minSendable/maxSendable почти никогда не меняются
let _lnurlCache = null, _lnurlCachedAt = 0, _lnurlCachedAddr = '';
const LNURL_CACHE_MS = 5 * 60_000;

async function fetchLnurlPayParams(lightningAddress) {
  const now = Date.now();
  if (_lnurlCache && _lnurlCachedAddr === lightningAddress && now - _lnurlCachedAt < LNURL_CACHE_MS) {
    return _lnurlCache;
  }

  const [user, domain] = lightningAddress.split('@');
  if (!user || !domain) throw new Error('Invalid Lightning Address format');

  const url = `https://${domain}/.well-known/lnurlp/${user}`;
  const r = await ft(url, {}, 8000);
  if (!r.ok) throw new Error(`LNURL endpoint error: ${r.status}`);

  const data = await sj(r);
  if (data.tag !== 'payRequest') throw new Error('Not a valid LNURL-pay endpoint');
  if (!data.callback)           throw new Error('No callback URL in LNURL response');

  _lnurlCache      = data;
  _lnurlCachedAt   = now;
  _lnurlCachedAddr = lightningAddress;

  return data; // { tag, callback, minSendable, maxSendable, metadata, commentAllowed }
}

// ─── LNURL-PAY STEP 2: запрашиваем invoice на конкретную сумму ─
async function requestInvoice(callback, amountMsats, comment) {
  const url = new URL(callback);
  url.searchParams.set('amount', String(amountMsats));
  if (comment) url.searchParams.set('comment', comment.slice(0, 255));

  const r = await ft(url.toString(), {}, 10000);
  if (!r.ok) throw new Error(`Invoice request failed: ${r.status}`);

  const data = await sj(r);
  if (data.status === 'ERROR') throw new Error(data.reason || 'LNURL error');
  if (!data.pr) throw new Error('No invoice (pr) in response');

  return data; // { pr, routes, successAction }
}

// ─── ИЗВЛЕЧЬ PAYMENT HASH из invoice ─────────────────────────
// LN invoice: lnbc<amount>1<data><checksum>
// BUG FIX: lastIndexOf('1') находил '1' в теле данных, а не разделитель HRP.
// Правильно: ищем первый '1' ПОСЛЕ HRP-префикса (lnbc/lntb/lnbcrt и т.д.)
function extractPaymentHash(invoice) {
  try {
    const inv = invoice.toLowerCase();

    // HRP заканчивается на первый символ '1' ПОСЛЕ буквенного префикса
    // Стандарт bech32: все символы до первого '1' — это HRP
    // Для BOLT11: hrp = lnbc | lntb | lnbcrt | lnsb и т.д.
    // Ищем '1' начиная с позиции 4 (минимальный HRP: "lnb" + цифры)
    let sep = -1;
    for (let i = 4; i < inv.length; i++) {
      if (inv[i] === '1') { sep = i; break; }
    }
    if (sep < 0) return null;

    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const data = inv.slice(sep + 1, -6); // убираем checksum (6 символов)

    const decoded = [];
    for (const c of data) {
      const v = CHARSET.indexOf(c);
      if (v < 0) return null;
      decoded.push(v);
    }

    // Пропускаем timestamp (первые 7 пятибитных групп = 35 бит)
    let pos = 7;
    while (pos < decoded.length - 3) {
      const tag = decoded[pos];
      const len = decoded[pos+1] * 32 + decoded[pos+2];
      pos += 3;

      if (tag === 1 && len === 52) {
        // payment hash: 52 × 5-bit = 260 бит → первые 256 (32 байта = 64 hex)
        const hashBits = decoded.slice(pos, pos + 52);
        let hex = '', bits = 0, value = 0;
        for (const b of hashBits) {
          value = (value << 5) | b;
          bits += 5;
          while (bits >= 8) {
            bits -= 8;
            hex += ((value >> bits) & 0xff).toString(16).padStart(2, '0');
          }
        }
        return hex.slice(0, 64);
      }
      pos += len;
    }
    return null;
  } catch { return null; }
}

// ─── GENERATE SIMPLE QR DATA URL ──────────────────────────────
// Возвращаем просто lightning: URI — фронтенд рендерит QR сам (qrcode.js)
function lightningUri(invoice) {
  return `lightning:${invoice.toUpperCase()}`;
}

// ─── TELEGRAM УВЕДОМЛЕНИЕ ─────────────────────────────────────
async function tgNotify(amountSats, amountUsd, txid, ip, type = 'paid') {
  const token = process.env.TG_TOKEN;
  const chat  = process.env.TG_CHAT_ID;
  if (!token || !chat) return;

  const btcAmount = (amountSats / 1e8).toFixed(8);
  const isPaid    = type === 'paid';
  const isCreated = type === 'created';
  const header    = isPaid    ? '✅ *ОПЛАТА ПОЛУЧЕНА — TurboTX LN*' :
                    isCreated ? '🔔 *Новый LN Invoice — TurboTX*' :
                                '⚡ *LN Webhook — TurboTX*';
  const text = [
    header,
    '━━━━━━━━━━━━━━━━',
    `⚡ ${amountSats.toLocaleString()} sats (~$${amountUsd})`,
    `🔗 ${btcAmount} BTC`,
    txid ? `📋 TXID: \`${txid.slice(0,14)}…\`` : '',
    ip && ip !== 'webhook' ? `🌐 IP: \`${ip}\`` : (isPaid ? '🌐 IP: webhook' : ''),
    `🕐 ${new Date().toLocaleString('ru', {timeZone:'Europe/Moscow'})} МСК`,
  ].filter(Boolean).join('\n');

  await ft(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id:chat, text, parse_mode:'Markdown' }),
  }, 5000).catch(() => {});
}

// ─── BODY PARSER ──────────────────────────────────────────────
// Vercel serverless (не Next.js) не парсит req.body автоматически —
// нужно читать поток вручную.
function readBody(req) {
  return new Promise((resolve, reject) => {
    // Уже распарсен (Next.js / некоторые версии runtime)
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ─── MAIN HANDLER ─────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));

  // Парсим тело запроса один раз для всего хендлера
  const body = req.method === 'POST' ? await readBody(req) : {};
  req.body = body; // нормализуем — дальнейший код читает req.body

  const ip = getIp(req);

  // ── Webhook от LN-провайдера (BTCPay, LNbits, Voltage) ────────
  if (req.query?.webhook === '1' || req.body?.webhook === true) {
    return handleWebhook(req, res);
  }

  // ── Debug: GET /api/lightning?debug=1 — диагностика конфига ──
  if (req.method === 'GET' && req.query?.debug === '1') {
    const lightningAddress = process.env.LIGHTNING_ADDRESS;
    const hasTg = !!(process.env.TG_TOKEN && process.env.TG_CHAT_ID);
    const hasSecret = !!process.env.PREMIUM_SECRET;
    let lnurlOk = false, lnurlErr = '';
    if (lightningAddress) {
      try {
        const params = await fetchLnurlPayParams(lightningAddress);
        lnurlOk = !!params.callback;
      } catch(e) { lnurlErr = e.message; }
    }
    let priceOk = false;
    try { priceOk = !!(await getBtcPrice()); } catch(e) {}
    return res.status(200).json({
      ok: true,
      config: {
        LIGHTNING_ADDRESS: lightningAddress ? lightningAddress.replace(/^.+@/, '***@') : 'NOT SET',
        PREMIUM_SECRET: hasSecret ? 'SET' : 'NOT SET',
        TG_TOKEN: hasTg ? 'SET' : 'NOT SET',
      },
      checks: { lnurlOk, lnurlErr: lnurlErr || null, priceOk },
    });
  }

  // ── GET /api/lightning?hash=<paymentHash> — проверить оплату ──
  if (req.method === 'GET') {
    const hash = req.query?.hash?.toLowerCase();
    if (!hash || !/^[a-f0-9]{64}$/.test(hash))
      return res.status(400).json({ ok:false, error:'Invalid payment hash' });

    cleanInvoices();
    const inv = _invoices.get(hash);
    if (!inv)
      return res.status(404).json({ ok:false, error:'Invoice not found or expired' });

    // Если уже помечен как оплаченный
    if (inv.paid) {
      const token = process.env.PREMIUM_SECRET;
      return res.status(200).json({
        ok: true, paid: true, settled: true,
        amountSats: inv.amountSats,
        amountUsd:  inv.amountUsd,
        // BUG FIX: не возвращаем пустой токен — клиент принял бы '' как valid
        ...(token ? { activationToken: token } : {}),
        activatedAt: inv.paidAt,
      });
    }

    // Проверяем через LNURL successAction callback
    // WoS и большинство провайдеров не имеют публичного API проверки
    // Используем heuristic: invoice истёк → не оплачен
    if (Date.now() > inv.expiresAt)
      return res.status(200).json({ ok:true, paid:false, settled:false, expired:true });

    return res.status(200).json({
      ok: true, paid: false, settled: false,
      amountSats: inv.amountSats,
      expiresIn: Math.max(0, Math.ceil((inv.expiresAt - Date.now()) / 1000)),
    });
  }

  // ── POST /api/lightning — создать invoice ──────────────────
  if (req.method !== 'POST')
    return res.status(405).json({ ok:false, error:'GET or POST only' });

  if (!checkRl(ip))
    return res.status(429).json({ ok:false, error:'Too many requests' });

  const lightningAddress = process.env.LIGHTNING_ADDRESS;
  if (!lightningAddress)
    return res.status(503).json({ ok:false, error:'Lightning payments not configured' });

  const { txid, comment } = req.body || {};
  const amountUsd = Number(req.body?.amountUsd);
  if (!amountUsd || isNaN(amountUsd) || amountUsd < 1 || amountUsd > 500)
    return res.status(400).json({ ok:false, error:'amountUsd must be 1-500' });

  try {
    // 1. Получаем текущий курс BTC
    const btcPrice = await getBtcPrice();
    if (!btcPrice)
      return res.status(503).json({ ok:false, error:'Cannot fetch BTC price, try again' });

    const amountSats  = usdToSats(amountUsd, btcPrice);
    const amountMsats = amountSats * 1000;

    // 2. Получаем LNURL-pay параметры
    const lnurlParams = await fetchLnurlPayParams(lightningAddress);

    // Проверяем что сумма в пределах допустимого
    if (amountMsats < lnurlParams.minSendable)
      return res.status(400).json({
        ok: false,
        error: `Amount too small. Min: ${Math.ceil(lnurlParams.minSendable/1000)} sats`,
      });
    if (amountMsats > lnurlParams.maxSendable)
      return res.status(400).json({
        ok: false,
        error: `Amount too large. Max: ${Math.floor(lnurlParams.maxSendable/1000)} sats`,
      });

    // 3. Запрашиваем invoice
    const invoiceComment = comment ||
      (txid ? `TurboTX acceleration ${txid.slice(0,8)}` : 'TurboTX Premium');
    const invoiceData = await requestInvoice(
      lnurlParams.callback, amountMsats, invoiceComment
    );

    // 4. Извлекаем payment hash
    const paymentHash = extractPaymentHash(invoiceData.pr);
    if (!paymentHash)
      return res.status(500).json({ ok:false, error:'Could not parse invoice' });

    // 5. Сохраняем в памяти
    cleanInvoices();
    // BUG FIX: используем expiresAt из LNURL ответа если есть (некоторые провайдеры возвращают)
    const invoiceExpiry = invoiceData.expiry ? invoiceData.expiry * 1000 : INVOICE_TTL;
    const expiresAt = Date.now() + invoiceExpiry;
    _invoices.set(paymentHash, {
      amountSats, amountUsd, txid: txid || null,
      invoice: invoiceData.pr,
      createdAt: Date.now(), expiresAt, paid: false,
    });

    // 6. Telegram уведомление о новом invoice (async, не блокирует ответ)
    tgNotify(amountSats, amountUsd, txid, ip, 'created').catch(() => {});

    // 7. Возвращаем клиенту
    return res.status(200).json({
      ok: true,
      invoice:      invoiceData.pr,          // lnbc... строка для кошелька
      paymentHash,                           // для polling /api/lightning?hash=X
      amountSats,
      amountMsats,
      amountUsd,
      btcPrice,
      lightningUri: lightningUri(invoiceData.pr), // lightning:LNBC... для QR
      expiresAt,
      expiresInSeconds: Math.ceil(invoiceExpiry / 1000),
      // successAction от провайдера (если есть)
      successAction: invoiceData.successAction || null,
      note: `Оплатите ${amountSats.toLocaleString()} sats (~$${amountUsd}) через Lightning Network`,
    });

  } catch(e) {
    console.error('[lightning] error:', e.message);
    return res.status(500).json({ ok:false, error: e.message });
  }
}

// ─── WEBHOOK — пометить invoice как оплаченный ────────────────
// Вызывается из verify.js когда Lightning оплата подтверждена внешне.
// Также принимает POST /api/lightning?webhook=1&hash=X&secret=S
// от провайдеров (LNbits, BTCPay, Voltage) с push-уведомлением.
export function markInvoicePaid(paymentHash) {
  const inv = _invoices.get(paymentHash?.toLowerCase());
  if (!inv) return false;
  if (inv.paid) return true; // уже оплачен — идемпотентно
  inv.paid   = true;
  inv.paidAt = Date.now();
  _invoices.set(paymentHash.toLowerCase(), inv);
  // Уведомляем в Telegram об успешной оплате
  tgNotify(inv.amountSats, inv.amountUsd, null, 'webhook', 'paid').catch(() => {});
  return true;
}

// ─── INTERNAL: обработка webhook в handler ────────────────────
// GET /api/lightning?webhook=1&hash=X&secret=S
// POST /api/lightning с { webhook:true, hash, secret }
// Провайдеры: LNbits webhook, BTCPay Server IPN, Voltage
function handleWebhook(req, res) {
  const secret = process.env.PREMIUM_SECRET;
  const { hash, secret: reqSecret } = req.method === 'GET' ? req.query : (req.body || {});
  if (!secret || reqSecret !== secret)
    return res.status(403).json({ ok:false, error:'Forbidden' });
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash))
    return res.status(400).json({ ok:false, error:'Invalid hash' });
  const marked = markInvoicePaid(hash.toLowerCase());
  return res.status(200).json({ ok:true, marked });
}
