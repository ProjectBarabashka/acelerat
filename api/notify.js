// ══════════════════════════════════════════════════════════════
//  TurboTX — /api/notify.js
//  Серверные Telegram уведомления — токен НЕ светится в браузере
//
//  POST /api/notify
//  Body: { type: 'payment'|'broadcast', paidStr?, method?, txShort?, txid?, plan? }
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 8 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function tgSend(token, chatId, text) {
  if (!token || !chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch (_) { return false; }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method !== 'POST') return res.status(405).end();

  const token  = process.env.TG_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) return res.status(200).json({ ok: false, reason: 'TG not configured' });

  const { type, paidStr, method, txShort, txid, plan } = req.body || {};

  let text = '';

  if (type === 'payment') {
    text = [
      '💰 *ОПЛАТА TurboTX*',
      '━━━━━━━━━━━━━',
      '💵 `' + (paidStr || '?') + '`',
      '💳 ' + (method || '?'),
      '🔗 `' + (txShort || '?') + '`',
      '🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК',
    ].join('\n');
  } else if (type === 'broadcast') {
    text = [
      '⚡ *BROADCAST TurboTX*',
      '━━━━━━━━━━━━━',
      txid ? '📋 `' + txid.slice(0,14) + '…' + txid.slice(-6) + '`' : '',
      '🎯 ' + (plan || 'free').toUpperCase(),
      '🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК',
    ].filter(Boolean).join('\n');
  } else {
    return res.status(400).json({ ok: false, error: 'Unknown type' });
  }

  const ok = await tgSend(token, chatId, text);
  return res.status(200).json({ ok });
}
