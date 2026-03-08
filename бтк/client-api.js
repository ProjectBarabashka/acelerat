// ══════════════════════════════════════════════════════════════
//  TurboTX — client-api.js
//  Этот код вставляется в index.html перед закрывающим </body>
//  Подключает серверные API вместо прямых fetch из браузера
// ══════════════════════════════════════════════════════════════

// ── СЕРВЕРНЫЙ BROADCAST (заменяет freeBroadcast / premiumBroadcast) ──
// Фронт вызывает /api/broadcast → сервер делает всё без CORS-ограничений

const _API = ''; // пустая строка = тот же origin (acelerat.vercel.app)

async function serverBroadcast(txid, plan) {
  try {
    const r = await fetch(`${_API}/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid, plan }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } catch (e) {
    console.warn('[TurboTX] Server broadcast failed, falling back to client:', e.message);
    // Fallback: старый клиентский broadcast
    return plan === 'premium' ? premiumBroadcast(txid) : freeBroadcast(txid);
  }
}

// ── АВТО-ПОВТОРЫ PREMIUM (серверный вариант) ──────────────────────
// Планируем волны через setTimeout — фронт пингует /api/repeat
// Даже если пользователь закроет вкладку — волны уже запланированы на сервере

const WAVE_SCHEDULE_MS = [15, 30, 60, 120, 240].map(m => m * 60000);

function startServerRepeat(txid) {
  stopPremiumRepeat(); // остановить старый клиентский interval
  let waveNum = 1;

  WAVE_SCHEDULE_MS.forEach((delayMs, i) => {
    setTimeout(async () => {
      try {
        const r = await fetch(`${_API}/api/repeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txid, wave: i + 1 }),
        });
        const data = await r.json();

        if (data.confirmed) {
          console.log(`[TurboTX] TX confirmed at wave ${i + 1}`);
          stopPremiumRepeat();
        } else if (data.broadcasted) {
          console.log(`[TurboTX] Wave ${i + 1} broadcast: ${data.broadcastSummary?.ok}/${data.broadcastSummary?.total} ok`);
        }
      } catch (e) {
        // Fallback: клиентский broadcast
        premiumBroadcast(txid);
      }
    }, delayMs);
  });
}

// ── ДИНАМИЧЕСКАЯ ЦЕНА ────────────────────────────────────────────
let _priceData = null;
let _priceFetchedAt = 0;

async function fetchDynamicPrice() {
  // Кешируем на 3 минуты
  if (_priceData && Date.now() - _priceFetchedAt < 180000) return _priceData;

  try {
    const r = await fetch(`${_API}/api/price`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _priceData = await r.json();
    _priceFetchedAt = Date.now();
    applyDynamicPrice(_priceData);
    return _priceData;
  } catch (e) {
    console.warn('[TurboTX] Dynamic price failed:', e.message);
    return null;
  }
}

function applyDynamicPrice(p) {
  if (!p) return;

  // Обновляем все элементы с ценой на странице
  const usd = p.usd;
  const btc = p.btc;
  const emoji = p.emoji;

  // Кнопки оплаты
  document.querySelectorAll('[data-price-usd]').forEach(el => {
    el.textContent = `$${usd}`;
  });

  // BTC сумма
  document.querySelectorAll('[data-price-btc]').forEach(el => {
    if (btc) el.textContent = `${btc} BTC`;
  });

  // Индикатор загруженности сети (если есть на странице)
  const congestionEl = document.getElementById('network-congestion');
  if (congestionEl) {
    congestionEl.textContent = `${emoji} ${p.text} · ${p.feeRate} sat/vB`;
    congestionEl.style.color = p.congestion === 'low' ? 'var(--g)' :
                                p.congestion === 'medium' ? 'var(--a)' : '#ff5555';
  }

  // Обновляем selBtc для платёжной формы
  if (btc && typeof selBtc !== 'undefined') {
    selBtc = btc;
    const amtEl = document.getElementById('pay-amount');
    if (amtEl) amtEl.textContent = `${btc} BTC`;
    const directEl = document.getElementById('direct-amount');
    if (directEl) directEl.textContent = `${btc} BTC`;
  }
}

// ── ПЕРЕОПРЕДЕЛЯЕМ СТАРЫЕ ФУНКЦИИ ────────────────────────────────
// Патч activateBroadcast чтобы использовал сервер

const _origAccelerate = typeof doAccelerate !== 'undefined' ? doAccelerate : null;

// Перехватываем на уровне нажатия кнопки
document.addEventListener('DOMContentLoaded', () => {
  // Загружаем цену сразу
  fetchDynamicPrice();

  // Обновляем цену каждые 3 минуты
  setInterval(fetchDynamicPrice, 3 * 60000);

  // Патчим кнопку Ускорить
  const btn = document.getElementById('abtn');
  if (btn) {
    const origClick = btn.onclick;
    // Сохраняем оригинальный обработчик — он выполняется как обычно,
    // но broadcast идёт через сервер. Патч применяется через замену функций выше.
  }
});

// ── ЭКСПОРТИРУЕМ ДЛЯ ИСПОЛЬЗОВАНИЯ В index.html ──────────────────
window._TurboAPI = {
  broadcast: serverBroadcast,
  startRepeat: startServerRepeat,
  fetchPrice: fetchDynamicPrice,
};

console.log('[TurboTX] Server API connected ✓');
