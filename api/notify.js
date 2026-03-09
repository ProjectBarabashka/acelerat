// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ NOTIFY ★  —  /api/notify.js
//  Vercel Serverless · Node.js 20
//
//  POST /api/notify
//  Body: { type, ...data }
//  Header: X-TurboTX-Token (required)
//
//  Типы: payment | broadcast | confirmed | error | cpfp | rbf
//
//  ✦ Защита: только с валидным токеном
//  ✦ Rate limit: 30/час
//  ✦ Структурированные алерты с inline кнопками
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 8 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-TurboTX-Token',
};

const _ipMap = new Map();
function checkLimit(ip) {
  const now=Date.now(), h=3_600_000;
  let e=_ipMap.get(ip);
  if(!e||e.r<now){e={c:0,r:now+h};_ipMap.set(ip,e);}
  return ++e.c <= 30;
}

function getIp(req) {
  return req.headers['x-real-ip']||req.headers['x-forwarded-for']?.split(',')[0]?.trim()||'unknown';
}

async function tgSend(token, chatId, text, extra={}) {
  if (!token||!chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:chatId, text, parse_mode:'Markdown', ...extra }),
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method==='OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v])=>res.setHeader(k,v));
  if (req.method!=='POST') return res.status(405).end();

  // Защита токеном
  const secret = process.env.PREMIUM_SECRET;
  const token  = req.headers['x-turbotx-token'] || req.body?.token;
  if (secret && token !== secret)
    return res.status(401).json({ok:false,error:'Unauthorized'});

  const ip = getIp(req);
  if (!checkLimit(ip))
    return res.status(429).json({ok:false,error:'Rate limited'});

  const tgToken = process.env.TG_TOKEN;
  const chatId  = process.env.TG_CHAT_ID;
  if (!tgToken||!chatId) return res.status(200).json({ok:false,reason:'TG not configured'});

  const { type, txid, paidStr, method, txShort, plan, wave, okCount, total,
          feeRate, needCpfp, hashrateReach, error } = req.body||{};
  const now = new Date().toLocaleString('ru',{timeZone:'Europe/Moscow'});
  const txLink = txid ? `https://mempool.space/tx/${txid}` : null;

  let text='', extra={};

  if (type==='payment') {
    text=[
      '💰 *НОВАЯ ОПЛАТА — TurboTX v6*',
      '━━━━━━━━━━━━━━━━',
      `💵 Сумма: \`${paidStr||'?'}\``,
      `💳 Способ: ${method||'?'}`,
      txShort?`🔗 TX: \`${txShort}\``:'',
      `📋 Тариф: *${(plan||'free').toUpperCase()}*`,
      `🕐 ${now} МСК`,
    ].filter(Boolean).join('\n');
    if (txLink) extra.reply_markup={inline_keyboard:[[{text:'🔍 Открыть TX',url:txLink}]]};
  }
  else if (type==='broadcast') {
    const pct  = total ? Math.round((okCount||0)/total*100) : 0;
    const bar  = '█'.repeat(Math.round(pct/10))+'░'.repeat(10-Math.round(pct/10));
    text=[
      `⚡ *Broadcast — TurboTX v6*`,
      `📋 \`${txShort||txid?.slice(0,14)||'?'}\``,
      `\`${bar}\` ${pct}% (${okCount}/${total})`,
      hashrateReach?`⛏ ~${hashrateReach}% хешрейта`:'',
      needCpfp?'⚠️ Рекомендован CPFP':'✅ Комиссия ок',
      `🕐 ${now} МСК`,
    ].filter(Boolean).join('\n');
    if (txLink) extra.reply_markup={inline_keyboard:[[{text:'🔍 Mempool',url:txLink}]]};
  }
  else if (type==='confirmed') {
    text=[
      `✅ *TX ПОДТВЕРЖДЕНА!*`,
      `📋 \`${txShort||txid?.slice(0,14)||'?'}\``,
      `🎉 Premium отработал${wave?` (волна ${wave})`:''}`,
      `🕐 ${now} МСК`,
    ].filter(Boolean).join('\n');
    if (txLink) extra.reply_markup={inline_keyboard:[[{text:'🔍 Mempool',url:txLink}]]};
  }
  else if (type==='cpfp') {
    text=[
      `📐 *CPFP рассчитан*`,
      `📋 \`${txid?.slice(0,14)||'?'}\``,
      feeRate?`Fee: ${feeRate} sat/vB`:'',
      `🕐 ${now} МСК`,
    ].filter(Boolean).join('\n');
  }
  else if (type==='error') {
    text=[
      `❌ *Ошибка — TurboTX v6*`,
      error?`\`${String(error).slice(0,200)}\``:'',
      `🕐 ${now} МСК`,
    ].filter(Boolean).join('\n');
  }
  else {
    text=`📌 *TurboTX v6* — ${type||'event'}\n🕐 ${now} МСК`;
  }

  const ok = await tgSend(tgToken, chatId, text, extra);
  return res.status(200).json({ok, type});
}
