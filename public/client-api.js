// ══════════════════════════════════════════════════════════════
//  TurboTX v14 — client-api.js
//  Вставляется в index.html перед </body>
//
//  ✦ serverBroadcast    — одиночный broadcast через /api/broadcast
//  ✦ batchBroadcast     — пакетный broadcast (массив txids)
//  ✦ startServerRepeat  — волны повтора с wave recovery
//  ✦ fetchDynamicPrice  — цена с кэшем 3 мин + sats для Lightning
//  ✦ createLightningInvoice / checkLightningPayment — LN оплата
//  ✦ applyDynamicPrice  — обновляет UI элементы
// ══════════════════════════════════════════════════════════════

const _API = ''; // тот же origin (acelerat.vercel.app)

// ─── BROADCAST ────────────────────────────────────────────────
async function serverBroadcast(txid, plan, token) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-TurboTX-Token'] = token;

    const r = await fetch(`${_API}/api/broadcast`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ txid, plan }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } catch(e) {
    console.warn('[TurboTX] Server broadcast failed:', e.message);
    // Fallback на клиентский broadcast если есть
    if (typeof freeBroadcast === 'function' && plan !== 'premium')
      return freeBroadcast(txid);
    throw e;
  }
}

// ─── BATCH BROADCAST ──────────────────────────────────────────
// Уникально для TurboTX v14 — ни один конкурент не умеет
async function batchBroadcast(txids, token) {
  if (!Array.isArray(txids) || txids.length === 0) throw new Error('txids array required');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-TurboTX-Token'] = token;

  const r = await fetch(`${_API}/api/broadcast`, {
    method:  'POST',
    headers,
    body:    JSON.stringify({ txids, plan: 'premium' }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
  // → { ok, batch:true, total, succeeded, failed, ms, items:[...] }
}

// ─── АВТО-ПОВТОРЫ ─────────────────────────────────────────────
// Планируем волны через setTimeout, передаём startedAt для wave recovery
// Даже если пользователь закроет вкладку — сервер уже знает когда запускать

const _activeRepeats = new Map(); // txid → [timerIds]

function startServerRepeat(txid, token, onWave) {
  stopServerRepeat(txid);

  const startedAt     = Date.now();
  const waveSchedule  = [15, 30, 60, 120, 120, 120, 120, 120, 180, 180]; // минуты (v14: 10 волн)
  const timers        = [];

  let cumulativeMs = 0;
  waveSchedule.forEach((mins, i) => {
    cumulativeMs += mins * 60_000;
    const waveIntervalMs = mins * 60_000;

    const tid = setTimeout(async () => {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['X-TurboTX-Token'] = token;

        const r = await fetch(`${_API}/api/repeat`, {
          method:  'POST',
          headers,
          body: JSON.stringify({
            txid,
            wave:          i + 1,
            startedAt,           // для wave recovery на сервере
            waveIntervalMs,
          }),
        });
        const data = await r.json();

        if (data.confirmed) {
          console.log(`[TurboTX] ✅ TX confirmed at wave ${i+1}`);
          stopServerRepeat(txid);
          if (typeof onWave === 'function') onWave({ confirmed: true, wave: i+1, data });
        } else if (data.broadcasted) {
          console.log(`[TurboTX] ⚡ Wave ${i+1}: ${data.broadcastSummary?.ok}/${data.broadcastSummary?.total} ok`);
          if (typeof onWave === 'function') onWave({ confirmed: false, wave: i+1, data });
        }
      } catch(e) {
        console.warn(`[TurboTX] Wave ${i+1} error:`, e.message);
      }
    }, cumulativeMs);

    timers.push(tid);
  });

  _activeRepeats.set(txid, timers);
  console.log(`[TurboTX] Scheduled ${waveSchedule.length} waves for ${txid.slice(0,8)}…`);
}

function stopServerRepeat(txid) {
  const timers = _activeRepeats.get(txid);
  if (timers) {
    timers.forEach(t => clearTimeout(t));
    _activeRepeats.delete(txid);
  }
}

// ─── ЦЕНА ─────────────────────────────────────────────────────
let _priceCache     = null;
let _priceFetchedAt = 0;

async function fetchDynamicPrice(forceRefresh = false) {
  const CLIENT_CACHE_MS = 90_000; // 90 сек
  if (!forceRefresh && _priceCache && Date.now() - _priceFetchedAt < CLIENT_CACHE_MS)
    return _priceCache;
  try {
    // BUG FIX: cache-bust param — обходим Vercel CDN кэш
    const cacheBust = '?_t=' + Math.floor(Date.now() / 60000);
    const ac = new AbortController();
    const _t = setTimeout(() => ac.abort(), 6000);
    const r = await fetch(`${_API}/api/price` + cacheBust, {
      cache: 'no-store',
      signal: ac.signal,
    }).finally(() => clearTimeout(_t));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _priceCache     = await r.json();
    _priceFetchedAt = Date.now();
    applyDynamicPrice(_priceCache);
    // Синхронизируем с _TurboPrice если он инициализирован
    if (window._TurboPrice?.apply && _priceCache?.usd > 0) {
      window._TurboPrice.apply(_priceCache);
    }
    return _priceCache;
  } catch(e) {
    console.warn('[TurboTX] Price fetch failed:', e.message);
    return _priceCache; // вернём старые данные если есть
  }
}

function applyDynamicPrice(p) {
  if (!p) return;
  const { usd, btc, sats, emoji, text, congestion, mempoolCongestion, feeRate } = p;

  // Ценовые элементы
  document.querySelectorAll('[data-price-usd]').forEach(el => {
    el.textContent = `$${usd}`;
  });
  document.querySelectorAll('[data-price-btc]').forEach(el => {
    if (btc) el.textContent = `${btc} BTC`;
  });
  document.querySelectorAll('[data-price-sats]').forEach(el => {
    if (sats) el.textContent = `${sats.toLocaleString()} sats`;
  });

  // ── Индикатор fee-рынка (sat/vB) ──────────────────────────────
  // BUG FIX v14: congestion теперь корректируется сервером по mp.count,
  // поэтому цвет/текст будут адекватны даже при низком feeRate + большом мемпуле.
  const netEl = document.getElementById('network-congestion');
  if (netEl) {
    netEl.textContent = `${emoji} ${text} · ${feeRate} sat/vB`;
    netEl.style.color = congestion === 'low'    ? 'var(--g)' :
                        congestion === 'medium' ? 'var(--a)' : '#ff5555';
  }

  // ── Отдельный индикатор нагрузки мемпула (кол-во TX) ─────────
  // BUG FIX v14: раньше этого индикатора не было → пользователь не видел
  // что мемпул забит 41k TX, хотя fee-рынок был "свободен".
  const mpEl = document.getElementById('mempool-congestion');
  if (mpEl && mempoolCongestion) {
    const mc = mempoolCongestion;
    const txStr = mc.txCount != null ? ` · ${mc.txCount.toLocaleString()} TX` : '';
    mpEl.textContent = `${mc.emoji} ${mc.text}${txStr}`;
    mpEl.style.color = mc.level === 'clear' || mc.level === 'low' ? 'var(--g)' :
                       mc.level === 'medium' ? 'var(--a)' : '#ff5555';
  }

  // ── data-атрибуты для мемпула (удобно для кастомного UI) ──────
  document.querySelectorAll('[data-mempool-count]').forEach(el => {
    if (mempoolCongestion?.txCount != null)
      el.textContent = mempoolCongestion.txCount.toLocaleString();
  });
  document.querySelectorAll('[data-mempool-level]').forEach(el => {
    if (mempoolCongestion?.level) el.dataset.level = mempoolCongestion.level;
  });

  // Глобальный selBtc для платёжной формы
  if (btc && typeof selBtc !== 'undefined') {
    selBtc = btc;
    const amtEl = document.getElementById('pay-amount');
    if (amtEl) amtEl.textContent = `${btc} BTC`;
  }
}

// ─── LIGHTNING PAYMENT ────────────────────────────────────────
// Создаём invoice и запускаем polling до оплаты

async function createLightningInvoice(amountUsd, txid) {
  const r = await fetch(`${_API}/api/lightning`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ amountUsd, txid }),
  });
  if (!r.ok) throw new Error(`Lightning invoice failed: ${r.status}`);
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || 'Invoice error');
  return data;
  // → { invoice, paymentHash, amountSats, lightningUri, expiresAt }
}

async function checkLightningPayment(paymentHash) {
  const r = await fetch(`${_API}/api/lightning?hash=${paymentHash}`);
  if (!r.ok) throw new Error(`Check failed: ${r.status}`);
  return r.json();
  // → { paid, settled, amountSats, activationToken? }
}

// Polling до оплаты (max 1 час)
function waitForLightningPayment(paymentHash, onStatus) {
  const MAX_MS  = 60 * 60_000;
  const start   = Date.now();
  let   stopped = false;

  const poll = async () => {
    if (stopped || Date.now() - start > MAX_MS) return;
    try {
      const data = await checkLightningPayment(paymentHash);
      if (typeof onStatus === 'function') onStatus(data);
      if (data.paid) { stopped = true; return; }
      if (data.expired) { stopped = true; return; }
    } catch(e) {
      console.warn('[TurboTX] LN poll error:', e.message);
    }
    if (!stopped) setTimeout(poll, 3000); // polling каждые 3с
  };

  poll();
  return () => { stopped = true; }; // возвращаем функцию отмены
}

// ─── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────────
// RT FIX v14: интервал обновления убран отсюда — за реальное время отвечает
// единая петля fetchMempoolStats в index.html (каждые 20 сек).
// Здесь только однократная загрузка для Lightning sats и selBtc.
document.addEventListener('DOMContentLoaded', () => {
  fetchDynamicPrice();
});

// ─── ГЛОБАЛЬНЫЙ API ───────────────────────────────────────────
window._TurboAPI = {
  // Broadcast
  broadcast:     serverBroadcast,
  batchBroadcast,
  // Repeat
  startRepeat:   startServerRepeat,
  stopRepeat:    stopServerRepeat,
  // Price
  fetchPrice:    fetchDynamicPrice,
  applyPrice:    applyDynamicPrice,
  // Lightning
  createInvoice: createLightningInvoice,
  checkPayment:  checkLightningPayment,
  waitPayment:   waitForLightningPayment,
};

console.log('[TurboTX] v14 Server API connected ✓ (broadcast + batch + lightning + waves + acceleration)');
