// ══════════════════════════════════════════════════════════════
//  TurboTX v6 ★ TELEGRAM BOT ★  —  /api/telegram.js
//  Vercel Serverless · Node.js 20  · Telegram Bot Webhook
//
//  Команды: /start /help /status /accelerate /price /cpfp
//           /rbf /mempool /hashrate /stats
//
//  ✦ Premium token в broadcast (PREMIUM_SECRET)
//  ✦ /rbf    — объяснение RBF + инструкция
//  ✦ /mempool — текущая загрузка + fee rates
//  ✦ /hashrate — кто майнит сейчас + % хешрейта
//  ✦ Inline кнопки на каждое действие
//  ✦ Авто-определение TXID без команды
//  ✦ /stats — статистика текущей сессии
//  ✦ Защита: только ожидаемые обновления от Telegram
//
//  Настройка:
//  1. @BotFather → /newbot → TOKEN → ENV: TG_TOKEN
//  2. setWebhook: POST https://api.telegram.org/bot<TOKEN>/setWebhook
//     { "url": "https://acelerat.vercel.app/api/telegram" }
//  3. ENV: TG_TOKEN, TG_CHAT_ID, TG_SUPPORT_CHAT, PREMIUM_SECRET
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 20 };

const TOKEN   = process.env.TG_TOKEN;
const SUPPORT = process.env.TG_SUPPORT_CHAT;
const PREM_SECRET = process.env.PREMIUM_SECRET || '';

// Сессионная статистика (in-memory, сбрасывается при холодном старте)
const _stats = { broadcasts: 0, statusChecks: 0, cpfpCalcs: 0, startedAt: Date.now() };

function base() {
  // PRODUCTION_URL берём из env (задать в Vercel: PRODUCTION_URL=https://acelerat.vercel.app)
  // Фоллбэк на VERCEL_URL только если PRODUCTION_URL не задан
  return process.env.PRODUCTION_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}

async function ft(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}

async function tgApi(method, body) {
  if (!TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    return r.json();
  } catch { return null; }
}

const send = (chat_id, text, extra = {}) =>
  tgApi('sendMessage', { chat_id, text, parse_mode: 'Markdown', disable_web_page_preview: true, ...extra });

const edit = (chat_id, message_id, text, extra = {}) =>
  tgApi('editMessageText', { chat_id, message_id, text, parse_mode: 'Markdown', disable_web_page_preview: true, ...extra });

// Прогресс-бар
function bar(ok, total) {
  const pct = total ? Math.round(ok / total * 10) : 0;
  return '█'.repeat(pct) + '░'.repeat(10 - pct) + ` ${ok}/${total}`;
}

// ─────────────────────────────────────────────────────────────
//  КОМАНДЫ
// ─────────────────────────────────────────────────────────────

async function cmdStart(chatId) {
  return send(chatId, [
    '⚡ *TurboTX v6 — Bitcoin Accelerator*',
    '',
    'Ускоряю застрявшие BTC транзакции.',
    'Broadcast в *24 канала* · ~80% хешрейта сети.',
    '',
    '📋 *Основные команды:*',
    '`/status <txid>` — статус транзакции',
    '`/accelerate <txid>` — ускорить TX',
    '`/cpfp <txid>` — расчёт CPFP',
    '`/rbf <txid>` — проверить RBF',
    '`/price` — цена Premium сейчас',
    '`/mempool` — загрузка сети',
    '`/hashrate` — распределение хешрейта',
    '',
    '💡 Просто пришли TXID — я сам пойму что делать.',
    '',
    '🌐 [acelerat.vercel.app](https://acelerat.vercel.app)',
  ].join('\n'), {
    reply_markup: { inline_keyboard: [
      [{ text: '🌐 Открыть сайт', url: 'https://acelerat.vercel.app' }],
      [{ text: '💬 Поддержка @Sup_TurboTX', url: 'https://t.me/Sup_TurboTX' }],
    ]}
  });
}

async function cmdHelp(chatId) {
  return send(chatId, [
    '❓ *Как работает TurboTX v6:*',
    '',
    '*Проблема:* TX зависла → майнеры её игнорируют.',
    '*Решение:* Broadcast в 24 канала одновременно:',
    '',
    '🔗 *TIER 1 — hex-узлы* (8 штук):',
    'mempool.space, blockstream, blockchair,',
    'blockcypher, btcscan, blockchain.info...',
    'Шлём RAW HEX прямо в биткоин-сеть.',
    '',
    '🏊 *TIER 2 — майнинг-пулы* (16 штук):',
    'Foundry 27% · AntPool 16% · MARA 11%',
    'SpiderPool 8% · F2Pool 7% · Luxor 5%...',
    'Суммарно: ~80% хешрейта сети Bitcoin.',
    '',
    '⚡ *Методы:*',
    '• Free — 3 hex-узла, 1 повтор через 20 мин',
    '• Premium — все каналы, 6 волн за 4 часа',
    '',
    '🔧 *Если fee слишком низкая:*',
    'Используй `/cpfp <txid>` — рассчитаем',
    'сколько нужно заплатить дочерней TX.',
  ].join('\n'));
}

async function cmdPrice(chatId) {
  try {
    const r = await ft(`${base()}/api/price`, {}, 8000);
    if (!r.ok) throw new Error('API error');
    const d = await r.json();
    return send(chatId, [
      `${d.emoji} *Цена TurboTX Premium*`,
      '',
      `💵 Сейчас: *$${d.usd}* USD`,
      d.btc ? `₿ В BTC: \`${d.btc}\`` : '',
      `📊 Mempool: ${d.feeRate} sat/vB`,
      `🌡 Сеть: ${d.text}`,
      '',
      d.mempool ? `📦 Транзакций в очереди: ${d.mempool.count?.toLocaleString()}` : '',
    ].filter(Boolean).join('\n'), {
      reply_markup: { inline_keyboard: [[
        { text: '💳 Купить Premium', url: 'https://acelerat.vercel.app#premium' },
      ]]}
    });
  } catch {
    return send(chatId, '❌ Не удалось получить цену. Попробуй позже.');
  }
}

async function cmdMempool(chatId) {
  try {
    const [feesR, mpR] = await Promise.all([
      ft('https://mempool.space/api/v1/fees/recommended', {}, 7000),
      ft('https://mempool.space/api/mempool', {}, 7000),
    ]);
    const fees = feesR.ok ? await feesR.json() : {};
    const mp   = mpR.ok   ? await mpR.json()   : {};

    const congestion =
      fees.fastestFee > 150 ? '🔴 Критическая перегрузка' :
      fees.fastestFee > 60  ? '🟠 Высокая нагрузка' :
      fees.fastestFee > 20  ? '🟡 Умеренная нагрузка' :
                               '🟢 Сеть свободна';

    return send(chatId, [
      `📊 *Mempool Bitcoin*`,
      '',
      `${congestion}`,
      '',
      `⚡ Быстро (1-2 блока): \`${fees.fastestFee} sat/vB\``,
      `🕐 30 минут:           \`${fees.halfHourFee} sat/vB\``,
      `🕑 1 час:              \`${fees.hourFee} sat/vB\``,
      `🐢 Медленно:           \`${fees.minimumFee || fees.economyFee} sat/vB\``,
      '',
      mp.count ? `📦 Транзакций: \`${mp.count.toLocaleString()}\`` : '',
      mp.vsize ? `📐 Размер: \`${(mp.vsize / 1e6).toFixed(1)} MB\`` : '',
    ].filter(Boolean).join('\n'));
  } catch {
    return send(chatId, '❌ Ошибка получения данных mempool.');
  }
}

async function cmdHashrate(chatId) {
  // Данные Q1 2026
  const pools = [
    { name: 'Foundry USA',  pct: 27, flag: '🇺🇸' },
    { name: 'AntPool',      pct: 16, flag: '🇨🇳' },
    { name: 'MARA Pool',    pct: 11, flag: '🇺🇸' },
    { name: 'ViaBTC',       pct:  9, flag: '🇨🇳' },
    { name: 'SpiderPool',   pct:  8, flag: '🌐' },
    { name: 'F2Pool',       pct:  7, flag: '🇨🇳' },
    { name: 'Luxor',        pct:  5, flag: '🇺🇸' },
    { name: 'CloverPool',   pct:  4, flag: '🇨🇳' },
    { name: 'BitFuFu',      pct:  4, flag: '🌐' },
    { name: 'Другие',       pct:  9, flag: '🌍' },
  ];
  const covered = pools.slice(0, 9).reduce((s, p) => s + p.pct, 0);

  const lines = pools.map(p => {
    const b = '▓'.repeat(Math.round(p.pct / 5)) + '░'.repeat(20 - Math.round(p.pct / 5));
    return `${p.flag} \`${p.name.padEnd(12)}\` ${b} ${p.pct}%`;
  });

  return send(chatId, [
    '⛏ *Распределение хешрейта Bitcoin (Q1 2026)*',
    '',
    ...lines,
    '',
    `✅ TurboTX Premium охватывает ~*${covered}%* сети`,
    `📅 Данные: Q1 2026`,
  ].join('\n'));
}

async function cmdStatus(chatId, txid) {
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return send(chatId, '⚠️ Укажи TXID:\n`/status <64 символа>`');

  _stats.statusChecks++;

  try {
    const r = await ft(`${base()}/api/status?txid=${txid}`, {}, 10000);
    if (!r.ok) throw new Error('API error');
    const d = await r.json();

    if (d.status === 'confirmed') {
      return send(chatId, [
        `✅ *Подтверждена!*`,
        `📋 \`${txid.slice(0,14)}…${txid.slice(-6)}\``,
        `🔲 Блок: \`#${d.blockHeight}\``,
        `✔ Подтверждений: ${d.confirmations}`,
        d.feeRate ? `💸 Комиссия: ${d.feeRate} sat/vB` : '',
      ].filter(Boolean).join('\n'), {
        reply_markup: { inline_keyboard: [[
          { text: '🔍 Mempool', url: `https://mempool.space/tx/${txid}` },
        ]]}
      });
    }

    if (d.status === 'not_found') {
      return send(chatId, [
        `❓ *TX не найдена*`,
        `\`${txid.slice(0,14)}…\``,
        '',
        'Возможно: уже давно подтверждена',
        'или TXID неверный.',
      ].join('\n'));
    }

    // В мемпуле
    const urgency =
      d.needsBoost && d.feeRate < 2  ? '🔴 Критически низкая комиссия' :
      d.needsBoost                    ? '🟠 Низкая комиссия, нужно ускорение' :
                                        '🟡 В мемпуле, ждёт майнера';

    return send(chatId, [
      `⏳ *В мемпуле*`,
      `📋 \`${txid.slice(0,14)}…${txid.slice(-6)}\``,
      '',
      urgency,
      `💸 Комиссия: \`${d.feeRate} sat/vB\` (нужно ≥${d.feeRateNeeded})`,
      `📐 Размер: ${d.vsize} vBytes`,
      d.inputs  ? `↙ Входов: ${d.inputs} · Выходов: ${d.outputs}` : '',
    ].filter(Boolean).join('\n'), {
      reply_markup: { inline_keyboard: [
        [
          { text: '⚡ Ускорить', callback_data: `acc_${txid}` },
          { text: '📐 CPFP',    callback_data: `cpfp_${txid}` },
        ],
        [{ text: '🔍 Mempool', url: `https://mempool.space/tx/${txid}` }],
      ]}
    });
  } catch {
    return send(chatId, '❌ Ошибка проверки статуса. Попробуй позже.');
  }
}

async function cmdAccelerate(chatId, txid) {
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return send(chatId, '⚠️ Укажи TXID:\n`/accelerate <64 символа>`');

  _stats.broadcasts++;

  const waitMsg = await send(chatId,
    `⚡ Запускаю broadcast...\n\`${txid.slice(0,14)}…${txid.slice(-6)}\`\n⏳ Подключаемся к 24 каналам...`
  );

  try {
    const r = await ft(`${base()}/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TurboTX-Token': PREM_SECRET,
      },
      body: JSON.stringify({ txid, plan: 'premium' }),
    }, 55000);
    const d = await r.json();

    if (d.confirmed) {
      return edit(chatId, waitMsg?.result?.message_id,
        `✅ TX уже подтверждена!\nУскорение не нужно.`
      );
    }

    if (!d.ok && d.error?.includes('hex not found')) {
      return edit(chatId, waitMsg?.result?.message_id,
        `⚠️ TX hex не найден в мемпуле.\nВозможно TX слишком старая или уже исключена.`
      );
    }

    const ok    = d.summary?.ok    ?? 0;
    const total = d.summary?.total ?? 0;
    const hr    = d.summary?.hashrateReach ?? 0;
    const ms    = d.summary?.ms ?? 0;

    const okPools = (d.results || []).filter(r => r.ok && r.tier === 'pool').map(r => r.channel);
    const okNodes = (d.results || []).filter(r => r.ok && r.tier === 'node').map(r => r.channel);

    const txt = [
      `🚀 *Broadcast завершён!*`,
      `📋 \`${txid.slice(0,14)}…${txid.slice(-6)}\``,
      '',
      `\`${bar(ok, total)}\``,
      hr > 0 ? `⛏ ~${hr}% хешрейта охвачено` : '',
      `⏱ ${ms}ms`,
      '',
      okNodes.length ? `🔗 Узлы: ${okNodes.join(', ')}` : '',
      okPools.length ? `🏊 Пулы: ${okPools.slice(0, 5).join(', ')}${okPools.length > 5 ? ` +${okPools.length-5}` : ''}` : '',
      '',
      d.summary?.needCpfp ? `⚠️ *Рекомендован CPFP!*\nФи слишком низкая.\n\`/cpfp ${txid}\`` : '✅ Комиссия в норме',
      d.analysis?.rbfEnabled ? `🔄 RBF включён — можно заменить TX` : '',
    ].filter(Boolean).join('\n');

    return edit(chatId, waitMsg?.result?.message_id, txt, {
      reply_markup: { inline_keyboard: [
        [
          { text: '📊 Статус',    callback_data: `status_${txid}` },
          { text: '🔍 Mempool',   url: `https://mempool.space/tx/${txid}` },
        ],
        d.summary?.needCpfp
          ? [{ text: '📐 Рассчитать CPFP', callback_data: `cpfp_${txid}` }]
          : [],
      ].filter(r => r.length)}
    });

  } catch(e) {
    return edit(chatId, waitMsg?.result?.message_id,
      `❌ Ошибка broadcast: ${e.message}\nПопробуй позже или зайди на сайт.`
    );
  }
}

async function cmdCpfp(chatId, txid) {
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid))
    return send(chatId, '⚠️ Укажи TXID:\n`/cpfp <64 символа>`');

  _stats.cpfpCalcs++;

  try {
    const r = await ft(`${base()}/api/cpfp?txid=${txid}&target=fast`, {}, 12000);
    if (!r.ok) throw new Error('API error');
    const d = await r.json();

    if (!d.ok) return send(chatId, `❌ ${d.error || 'TX не найдена'}`);
    if (!d.needed) {
      return send(chatId, [
        `✅ *CPFP не нужен*`,
        `Комиссия ${d.parent?.feeRate} sat/vB — достаточная.`,
        d.blockHeight ? `Блок: #${d.blockHeight}` : '',
      ].filter(Boolean).join('\n'));
    }

    const typeNames = {
      v0_p2wpkh: 'Native SegWit', v0_p2wsh: 'SegWit MultiSig',
      p2sh: 'P2SH', p2pkh: 'Legacy', v1_p2tr: 'Taproot',
    };
    const addrType = typeNames[d.child?.addressType] || d.child?.addressType || '?';

    return send(chatId, [
      `📐 *CPFP Расчёт*`,
      `📋 \`${txid.slice(0,14)}…\``,
      '',
      `📊 *Родительская TX:*`,
      `• Размер: ${d.parent?.vsize} vB`,
      `• Комиссия: ${d.parent?.feePaid?.toLocaleString()} sat`,
      `• Ставка: ${d.parent?.feeRate} sat/vB ← слишком мало`,
      '',
      `🎯 *Нужна дочерняя TX:*`,
      `• Тип адреса: ${addrType} (${d.child?.vsize} vB)`,
      `• Целевая ставка пакета: ${d.targets?.fast} sat/vB`,
      `• *Комиссия: ${d.child?.feeNeeded?.toLocaleString()} sat*`,
      `• Ставка child TX: ${d.child?.feeRate} sat/vB`,
      d.child?.feeUsd ? `• В USD: ~$${d.child.feeUsd}` : '',
      '',
      d.output ? `💎 UTXO для CPFP: выход #${d.output.index} (${d.output.value?.toLocaleString()} sat)` : '',
      !d.output?.canAfford ? `⚠️ Недостаточно sat на выходе!` : '',
      '',
      `*Инструкция (Electrum):*`,
      ...(d.walletInstructions?.electrum?.map((s, i) => `${i+1}. ${s}`) || []),
    ].filter(Boolean).join('\n'), {
      reply_markup: { inline_keyboard: [[
        { text: '🔍 Mempool', url: `https://mempool.space/tx/${txid}` },
        { text: '⚡ Ускорить', callback_data: `acc_${txid}` },
      ]]}
    });
  } catch(e) {
    return send(chatId, `❌ Ошибка CPFP расчёта: ${e.message}`);
  }
}

async function cmdRbf(chatId, txid) {
  if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid)) {
    // Без TXID — общее объяснение RBF
    return send(chatId, [
      '🔄 *RBF — Replace-By-Fee*',
      '',
      'RBF позволяет *заменить* застрявшую транзакцию',
      'новой с более высокой комиссией.',
      '',
      '*Работает если:*',
      '• TX создана с флагом RBF (sequence < 0xFFFFFFFE)',
      '• TX ещё не подтверждена',
      '',
      '*Как использовать:*',
      '• *Electrum:* ПКМ на TX → "Increase fee"',
      '• *BlueWallet:* TX → "Bump Fee"',
      '• *Sparrow:* TX → "Replace by fee"',
      '',
      '💡 Используй `/rbf <txid>` чтобы проверить',
      'включён ли RBF в конкретной TX.',
    ].join('\n'));
  }

  try {
    const r = await ft(`${base()}/api/status?txid=${txid}`, {}, 8000);
    const d = r.ok ? await r.json() : null;

    if (!d || d.status === 'not_found')
      return send(chatId, '❓ TX не найдена в мемпуле.');

    if (d.status === 'confirmed')
      return send(chatId, `✅ TX уже подтверждена в блоке #${d.blockHeight}. RBF не нужен.`);

    // status.js не возвращает rbfEnabled напрямую — добавим проверку через mempool
    let rbfEnabled = false;
    try {
      const tR = await ft(`https://mempool.space/api/tx/${txid}`, {}, 6000);
      if (tR.ok) {
        const tx = await tR.json();
        rbfEnabled = Array.isArray(tx.vin) && tx.vin.some(i => i.sequence <= 0xFFFFFFFD);
      }
    } catch {}

    return send(chatId, [
      rbfEnabled
        ? `✅ *RBF включён!*`
        : `❌ *RBF не включён*`,
      `📋 \`${txid.slice(0,14)}…\``,
      '',
      rbfEnabled
        ? [
            `Можно заменить TX с более высокой комиссией.`,
            '',
            `*Как:*`,
            `• Electrum: ПКМ → "Increase fee"`,
            `• BlueWallet: TX → "Bump Fee"`,
            `• Sparrow: TX → "Replace by fee"`,
            '',
            `Текущая ставка: ${d.feeRate} sat/vB`,
            `Рекомендую: ≥${d.feeRateNeeded} sat/vB`,
          ].join('\n')
        : [
            `RBF не был активирован при создании TX.`,
            `Попробуй ускорение через broadcast или CPFP.`,
          ].join('\n'),
    ].join('\n'), {
      reply_markup: { inline_keyboard: [
        rbfEnabled
          ? [{ text: '📊 Проверить статус', callback_data: `status_${txid}` }]
          : [
              { text: '⚡ Broadcast', callback_data: `acc_${txid}` },
              { text: '📐 CPFP',     callback_data: `cpfp_${txid}` },
            ]
      ]}
    });
  } catch {
    return send(chatId, '❌ Ошибка проверки RBF. Попробуй позже.');
  }
}

async function cmdStats(chatId) {
  const uptime = Math.round((Date.now() - _stats.startedAt) / 60000);
  return send(chatId, [
    '📈 *TurboTX v6 — Статистика сессии*',
    '',
    `⚡ Broadcast запусков: ${_stats.broadcasts}`,
    `🔍 Проверок статуса:   ${_stats.statusChecks}`,
    `📐 CPFP расчётов:      ${_stats.cpfpCalcs}`,
    '',
    `⏱ Аптайм инстанса: ${uptime} мин`,
    '',
    `🌐 [acelerat.vercel.app](https://acelerat.vercel.app)`,
  ].join('\n'));
}

// ─────────────────────────────────────────────────────────────
//  CALLBACK QUERY (inline кнопки)
// ─────────────────────────────────────────────────────────────
async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const data   = cb.data || '';

  // Отвечаем сразу чтобы убрать "часики" на кнопке
  await tgApi('answerCallbackQuery', { callback_query_id: cb.id });

  if (data.startsWith('acc_'))    return cmdAccelerate(chatId, data.slice(4));
  if (data.startsWith('status_')) return cmdStatus(chatId, data.slice(7));
  if (data.startsWith('cpfp_'))   return cmdCpfp(chatId, data.slice(5));
  if (data.startsWith('rbf_'))    return cmdRbf(chatId, data.slice(4));
}

// ─────────────────────────────────────────────────────────────
//  MAIN WEBHOOK
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Telegram всегда шлёт POST
  if (req.method !== 'POST') return res.status(200).end('TurboTX Bot OK');

  // Проверяем X-Telegram-Bot-Api-Secret-Token если задан TG_WEBHOOK_SECRET
  // Задать: /setWebhook с secret_token=process.env.TG_WEBHOOK_SECRET
  const webhookSecret = process.env.TG_WEBHOOK_SECRET;
  if (webhookSecret) {
    const incoming = req.headers['x-telegram-bot-api-secret-token'];
    if (incoming !== webhookSecret) return res.status(403).end();
  }

  // Быстрый ответ Telegram (не ждём нашей обработки)
  res.status(200).json({ ok: true });

  try {
    const upd = req.body;
    if (!upd) return;

    if (upd.callback_query) {
      await handleCallback(upd.callback_query);
      return;
    }

    const msg = upd.message || upd.edited_message;
    if (!msg?.text) return;

    const chatId = msg.chat.id;
    const text   = msg.text.trim();
    const parts  = text.split(/\s+/);
    const cmd    = parts[0].toLowerCase().split('@')[0]; // /cmd@BotName → /cmd
    const arg    = parts[1];

    // Команды
    switch(cmd) {
      case '/start':    await cmdStart(chatId); break;
      case '/help':     await cmdHelp(chatId); break;
      case '/price':    await cmdPrice(chatId); break;
      case '/mempool':  await cmdMempool(chatId); break;
      case '/hashrate': await cmdHashrate(chatId); break;
      case '/status':   await cmdStatus(chatId, arg); break;
      case '/accelerate': await cmdAccelerate(chatId, arg); break;
      case '/cpfp':     await cmdCpfp(chatId, arg); break;
      case '/rbf':      await cmdRbf(chatId, arg); break;
      case '/stats':    await cmdStats(chatId); break;

      default:
        // Голый TXID — показываем меню действий
        if (/^[a-fA-F0-9]{64}$/.test(text)) {
          await send(chatId,
            `🔍 TXID обнаружен!\n\`${text.slice(0,14)}…${text.slice(-6)}\`\nЧто делаем?`, {
            reply_markup: { inline_keyboard: [
              [
                { text: '📊 Статус',   callback_data: `status_${text}` },
                { text: '⚡ Ускорить', callback_data: `acc_${text}` },
              ],
              [
                { text: '📐 CPFP',    callback_data: `cpfp_${text}` },
                { text: '🔄 RBF',     callback_data: `rbf_${text}` },
              ],
              [{ text: '🔍 Mempool', url: `https://mempool.space/tx/${text}` }],
            ]}
          });
        } else if (cmd.startsWith('/')) {
          await send(chatId, '❓ Неизвестная команда. Напиши /help');
        } else if (SUPPORT && msg.chat.type === 'private') {
          // Пересылаем в поддержку
          await tgApi('forwardMessage', {
            chat_id: SUPPORT, from_chat_id: chatId, message_id: msg.message_id,
          });
          await send(chatId, '✅ Сообщение передано в поддержку @Sup\\_TurboTX!');
        }
    }
  } catch(e) {
    console.error('[TurboTX] TG webhook error:', e.message);
  }
}
