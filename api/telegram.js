// ══════════════════════════════════════════════════════════════
//  TurboTX — /api/telegram.js
//  Telegram Bot Webhook
//
//  Функции бота:
//  1. Принимает /start, /help, /status <txid>
//  2. Уведомления о платежах
//  3. Запускает broadcast напрямую через сервер
//  4. Мониторинг подтверждений и отчёт в чат поддержки
//
//  Настройка:
//  1. @BotFather → /newbot → получи TOKEN
//  2. Установи webhook: https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://acelerat.vercel.app/api/telegram
//  3. В Vercel → Settings → Environment Variables:
//     TG_TOKEN = "1234567890:ABC..."
//     TG_SUPPORT_CHAT = "-1001234567890"  (ID вашего чата поддержки)
// ══════════════════════════════════════════════════════════════

const TOKEN    = process.env.TG_TOKEN;
const SUPPORT  = process.env.TG_SUPPORT_CHAT; // чат поддержки @Sup_TurboTX

async function tgApi(method, body) {
  if (!TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return r.json();
  } catch (_) { return null; }
}

async function sendMessage(chat_id, text, opts = {}) {
  return tgApi('sendMessage', { chat_id, text, parse_mode: 'Markdown', ...opts });
}

// ── ПРОВЕРИТЬ СТАТУС TX ──────────────────────────────────────────
async function checkTxStatus(txid) {
  try {
    const r = await fetch(`https://mempool.space/api/tx/${txid}/status`,
      { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    return r.json();
  } catch (_) { return null; }
}

// ── BROADCAST ЧЕРЕЗ ВНУТРЕННИЙ API ───────────────────────────────
async function doBroadcast(txid, plan = 'premium') {
  try {
    const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    const r = await fetch(`${base}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid, plan }),
      signal: AbortSignal.timeout(30000),
    });
    return r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── ФОРМАТИРОВАТЬ РЕЗУЛЬТАТЫ BROADCAST ───────────────────────────
function formatResults(data) {
  if (!data?.results) return '—';
  const ok = data.results.filter(r => r.ok);
  const fail = data.results.filter(r => !r.ok);
  return [
    `✅ *Успешно* (${ok.length}): ${ok.map(r => r.channel).join(', ')}`,
    fail.length ? `❌ *Не ответили* (${fail.length}): ${fail.map(r => r.channel).join(', ')}` : '',
    `⏱ Время: ${data.summary?.ms ?? '?'} мс`,
  ].filter(Boolean).join('\n');
}

// ── ОБРАБОТЧИК КОМАНД ────────────────────────────────────────────
async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text   = msg.text?.trim() ?? '';
  const [cmd, arg] = text.split(/\s+/);

  // /start
  if (cmd === '/start') {
    return sendMessage(chatId, [
      '⚡ *TurboTX Accelerator Bot*',
      '',
      'Я помогу ускорить застрявшую Bitcoin транзакцию.',
      '',
      '📋 *Команды:*',
      '/status `<txid>` — проверить статус транзакции',
      '/accelerate `<txid>` — запустить ускорение',
      '/price — текущая цена Premium',
      '/help — помощь',
      '',
      '🌐 Сервис: [acelerat.vercel.app](https://acelerat.vercel.app)',
      '💬 Поддержка: @Sup\\_TurboTX',
    ].join('\n'));
  }

  // /help
  if (cmd === '/help') {
    return sendMessage(chatId, [
      '❓ *Как использовать TurboTX:*',
      '',
      '1. Скопируй TXID транзакции из своего кошелька',
      '2. Открой [acelerat.vercel.app](https://acelerat.vercel.app)',
      '3. Вставь TXID и нажми *Ускорить*',
      '',
      '*Что такое TXID?* Это 64-символьный хэш транзакции.',
      'Найти его можно в истории своего кошелька.',
      '',
      '*Почему транзакция зависает?*',
      'Сеть перегружена — майнеры выбирают TX с высокой комиссией.',
      'TurboTX отправляет твою TX напрямую в 9+ пулов.',
    ].join('\n'));
  }

  // /price
  if (cmd === '/price') {
    try {
      const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
      const r = await fetch(`${base}/api/price`, { signal: AbortSignal.timeout(8000) });
      const p = await r.json();
      return sendMessage(chatId, [
        `${p.emoji} *TurboTX Premium — цена сейчас*`,
        '',
        `💵 Цена: *$${p.usd}*`,
        p.btc ? `₿ В BTC: *${p.btc} BTC*` : '',
        `📊 Комиссия сети: *${p.feeRate} sat/vB*`,
        `🌡 Нагрузка: *${p.text}*`,
        '',
        '🔗 [Ускорить транзакцию →](https://acelerat.vercel.app)',
      ].filter(Boolean).join('\n'));
    } catch (_) {
      return sendMessage(chatId, '❌ Не удалось получить цену. Попробуй позже.');
    }
  }

  // /status <txid>
  if (cmd === '/status') {
    if (!arg || !/^[a-fA-F0-9]{64}$/.test(arg)) {
      return sendMessage(chatId, '⚠️ Укажи TXID: `/status <64 символа>`', { parse_mode: 'Markdown' });
    }
    const status = await checkTxStatus(arg);
    if (!status) {
      return sendMessage(chatId, `❌ Транзакция не найдена:\n\`${arg}\`\n\nВозможно ещё не попала в мемпул — подожди 1–2 мин.`);
    }
    const lines = [
      `📋 *Статус транзакции*`,
      `\`${arg.slice(0,14)}…${arg.slice(-6)}\``,
      '',
      status.confirmed
        ? `✅ *Подтверждена* в блоке ${status.block_height}`
        : `⏳ *В мемпуле* — ожидает включения в блок`,
      '',
      !status.confirmed ? '💡 Хочешь ускорить? Напиши `/accelerate ' + arg + '`' : '',
    ].filter(Boolean);
    return sendMessage(chatId, lines.join('\n'));
  }

  // /accelerate <txid>
  if (cmd === '/accelerate') {
    if (!arg || !/^[a-fA-F0-9]{64}$/.test(arg)) {
      return sendMessage(chatId, '⚠️ Укажи TXID: `/accelerate <64 символа>`');
    }

    // Проверяем — не подтверждена ли уже
    const status = await checkTxStatus(arg);
    if (status?.confirmed) {
      return sendMessage(chatId, `✅ Транзакция уже подтверждена в блоке ${status.block_height}!\nУскорение не нужно.`);
    }

    await sendMessage(chatId, `⚡ Запускаю ускорение...\n\`${arg.slice(0,14)}…${arg.slice(-6)}\``);

    const result = await doBroadcast(arg, 'premium');
    const ok = result?.summary?.ok ?? 0;
    const total = result?.summary?.total ?? 0;

    return sendMessage(chatId, [
      `🚀 *Broadcast завершён*`,
      `✅ ${ok}/${total} каналов успешно`,
      '',
      formatResults(result),
      '',
      '📍 Проверяй статус: `/status ' + arg + '`',
      '🔗 [Открыть на сайте →](https://acelerat.vercel.app)',
    ].join('\n'));
  }

  // Неизвестная команда или сообщение без команды
  if (text.startsWith('/')) {
    return sendMessage(chatId, '❓ Неизвестная команда. Напиши /help');
  }

  // Если это TXID — авто-определяем
  if (/^[a-fA-F0-9]{64}$/.test(text)) {
    return sendMessage(chatId, [
      `🔍 Вижу TXID! Что сделать?`,
      '',
      `📊 Статус: \`/status ${text}\``,
      `⚡ Ускорить: \`/accelerate ${text}\``,
    ].join('\n'));
  }

  // Пересылаем в поддержку если есть SUPPORT chat
  if (SUPPORT && msg.chat.type === 'private') {
    const user = msg.from;
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    await tgApi('forwardMessage', { chat_id: SUPPORT, from_chat_id: chatId, message_id: msg.message_id });
    await sendMessage(SUPPORT, `👤 @${user.username || name} (${chatId}): ${text}`);
    return sendMessage(chatId, '✅ Твоё сообщение переслано в поддержку. Скоро ответим!');
  }
}

// ── MAIN HANDLER ─────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).end('OK');

  try {
    const update = req.body;
    const msg = update.message || update.edited_message;
    if (msg?.text) await handleCommand(msg);
  } catch (e) {
    console.error('TG webhook error:', e);
  }

  // Telegram требует 200 OK всегда
  return res.status(200).json({ ok: true });
}
