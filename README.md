# ⚡ T_U_R_B_O_T_X — Bitcoin Transaction Accelerator v13

<p align="center">
  <img src="https://img.shields.io/badge/version-v13-f7931a?style=for-the-badge&logo=bitcoin&logoColor=white"/>
  <img src="https://img.shields.io/badge/status-PRODUCTION-00e87a?style=for-the-badge"/>
  <img src="https://img.shields.io/badge/hashrate-~88%25-7c5cfc?style=for-the-badge"/>
  <img src="https://img.shields.io/badge/channels-30-26d0a8?style=for-the-badge"/>
  <img src="https://img.shields.io/badge/Lightning-Network-ffd600?style=for-the-badge"/>
</p>

<p align="center">
  <a href="#english">🇺🇸 English</a> &nbsp;•&nbsp;
  <a href="#russian">🇷🇺 Русский</a> &nbsp;•&nbsp;
  <a href="https://acelerat.vercel.app">🌐 Live Demo</a>
</p>

---

<div id="english"></div>

## 🇺🇸 English

> **Status: 🟢 PRODUCTION (2026) · v13**
> Fully serverless Bitcoin transaction accelerator.
> 30 broadcast channels: 8 hex-nodes + 22 mining pool accelerators covering **~88% of network hashrate**.
> Now with **Lightning Network** instant payments.

### 🔥 What's New in v13

| Feature | Description |
|---|---|
| ⚡ **Lightning Network** | Instant invoice payments via LNURL-pay. Compatible with WoS, Phoenix, Breez, Muun, Zeus |
| 📊 **Network Intelligence** | Live dashboard: real-time price, fee rate, mempool size, Smart Advisor recommendations |
| 🎯 **Last-Block-Miner Boost** | Detects who mined the last block — sends to that pool first for max priority |
| 🔐 **MARA Slipstream** | Private mempool submission to Marathon's Slipstream API |
| 🧠 **Smart Advisor** | AI-powered acceleration strategy via `/api/acceleration` endpoint |
| 🛡 **Anti-Stuck 72h** | Auto-detects transactions stuck >72h, switches to aggressive mode |
| 📦 **Batch ×20** | Accelerate up to 20 TXIDs simultaneously (Premium) |
| 🔁 **8 Waves** | Adaptive wave intervals: 15→15→30→60→120→120→120→120 min |
| 💱 **Dynamic Pricing** | $3–18 based on real-time mempool load |
| 🌍 **Multi-language** | Auto-detects browser language (RU/EN + 8 others via flags) |

### 🏗 Architecture

```
Browser (index.html, ~6200 lines, single file SPA — zero build step)
    │
    ├── /api/router.js       → price · mempool · cpfp · rbf · status · stats
    ├── /api/broadcast.js    → 30 channels (8 hex-nodes + 22 pool accelerators)
    ├── /api/lightning.js    → Lightning invoices via LNURL-pay  ← NEW v13
    ├── /api/repeat.js       → 8-wave premium repeat scheduler
    ├── /api/verify.js       → BTC on-chain + USDT TRC-20 payment verification
    ├── /api/acceleration.js → Smart Advisor strategy engine
    └── /api/telegram.js     → Payment notifications
         │
Firebase RTDB ──────────────── mempool.space, coinbase, binance APIs
(counters · feed · queue)       (real-time fee + price data)
```

**Vercel Hobby Plan constraints respected:**
- All functions: `maxDuration ≤ 60s` (broadcast) or `≤ 20s` (others)
- No paid databases — Firebase free tier only
- No Redis, no KV store, no Postgres add-ons
- Single-file SPA — zero build step, zero npm on frontend
- CSP headers configured for all required external domains

### 📡 Broadcast Channels (~88% hashrate)

| Pool | Hashrate | Method |
|---|---|---|
| Foundry USA | ~27% | Direct API ⭐ |
| AntPool | ~16% | Direct API ⭐ |
| MARA (Marathon) | ~11% | Direct API + Slipstream ⭐ |
| ViaBTC | ~9% | Direct API |
| SpiderPool | ~8% | Direct API ★ |
| F2Pool | ~7% | Direct API |
| Luxor | ~5% | Direct API ★ |
| CloverPool | ~4% | Direct API |
| BitFuFu | ~4% | Direct API ★ |
| BTC.com | ~3% | Direct API |
| Ocean.xyz | ~2% | Direct API |
| EMCDPool | ~2% | Direct API |
| SBICrypto | ~2% | Direct API |
| + 9 more pools | ~3% | P2P / API |
| **8 hex-nodes** | — | mempool.space · blockstream · blockchair · blockcypher · btcscan + 3 more |

### ⚡ Lightning Network (v13)

Full LNURL-pay flow built into the payment modal:

1. User clicks "⚡ Lightning" tab → "Create Invoice"
2. Server POST `/api/lightning` → fetches BTC price, gets LNURL params, requests invoice
3. Frontend renders QR code (api.qrserver.com, no JS libs needed)
4. Auto-polling every 5s → `GET /api/lightning?hash=<paymentHash>`
5. On payment detected: Premium token issued, modal closes automatically

Compatible with: **Wallet of Satoshi, Phoenix, Breez, Muun, Zeus, BlueWallet, LNbits**, any LN wallet.

Requires env var: `LIGHTNING_ADDRESS=user@domain.com` (any Lightning Address).

### 💳 Payment Methods

| Method | Network | Verification |
|---|---|---|
| ₿ Bitcoin | On-chain | mempool.space + blockstream fallback |
| ⚡ Lightning | LN via LNURL-pay | In-memory polling (`/api/lightning`) |
| ₮ USDT | TRC-20 / TRON | TronGrid + TronScan fallback |
| 🎟 Promo | — | SHA-256 hash, Firebase usage counter |

### ⚙️ Dynamic Pricing Logic

```
feeRate ≤ 10 sat/vB  →  $3   🟢 Network calm     → best time to accelerate
feeRate ≤ 30 sat/vB  →  $4   🟡 Moderate load
feeRate ≤ 60 sat/vB  →  $7   🟠 High load
feeRate ≤ 150 sat/vB →  $12  🔴 Congested
feeRate > 150 sat/vB →  $18  🔥 Critical
```

CDN cache: `s-maxage=60, stale-while-revalidate=90`. Client cache: 90s with per-minute cache-bust.

### 🛠 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PREMIUM_SECRET` | ✅ | Activation token returned on successful payment |
| `LIGHTNING_ADDRESS` | ⚡ | Lightning Address for LN invoices |
| `BTC_WALLET` | ✅ | Bitcoin address for direct payments |
| `USDT_WALLET` | ✅ | USDT TRC-20 address |
| `FIREBASE_DB_URL` | ✅ | Firebase Realtime DB URL |
| `TG_TOKEN` | optional | Telegram bot token for notifications |
| `TG_CHAT_ID` | optional | Telegram chat ID |

### 📞 Contact

- **Support:** [@Sup_TurboTX](https://t.me/Sup_TurboTX)
- **Updates:** [@TurboTXAcel](https://t.me/TurboTXAcel)
- **Reviews:** [@TurboTXcoment](https://t.me/TurboTXcoment)
- **Email:** pollytrazlo@gmail.com

### 🌐 Live

👉 **[acelerat.vercel.app](https://acelerat.vercel.app)**

---

<div id="russian"></div>

## 🇷🇺 Русская версия

> **Статус: 🟢 PRODUCTION (2026) · v13**
> Полностью serverless ускоритель Bitcoin-транзакций.
> 30 каналов broadcast: 8 hex-узлов + 22 пул-акселератора, покрывающих **~88% хешрейта Bitcoin**.
> Теперь с оплатой через **Lightning Network**.

### 🔥 Что нового в v13

| Фича | Описание |
|---|---|
| ⚡ **Lightning Network** | Мгновенные invoice-платежи через LNURL-pay. WoS, Phoenix, Breez, Muun, Zeus |
| 📊 **Network Intelligence** | Live-дашборд: цена, fee rate, мемпул, Smart Advisor рекомендации в реальном времени |
| 🎯 **Last-Block-Miner Boost** | Определяет, кто добыл последний блок — отправляет туда первым |
| 🔐 **MARA Slipstream** | Подача в приватный мемпул Marathon Digital через Slipstream API |
| 🧠 **Smart Advisor** | Анализ TX, выбор оптимальной стратегии ускорения |
| 🛡 **Anti-Stuck 72h** | Авто-определение TX >72ч, переход в агрессивный режим |
| 📦 **Batch ×20** | Пакетное ускорение до 20 TXID за раз (Premium) |
| 🔁 **8 волн** | Адаптивные интервалы: 15→15→30→60→120→120→120→120 мин |
| 💱 **Динамическая цена** | $3–18 в зависимости от реальной загрузки мемпула |
| 🌍 **Мультиязычность** | Авто-определение языка браузера (9 языков) |

### 🏗 Техническая архитектура

```
Браузер (index.html, ~6200 строк, SPA без сборки, единый файл)
    │
    ├── /api/router.js       → price · mempool · cpfp · rbf · status · stats
    ├── /api/broadcast.js    → 30 каналов (8 нод + 22 пула)
    ├── /api/lightning.js    → Lightning invoice через LNURL-pay  ← НОВОЕ v13
    ├── /api/repeat.js       → 8-волновой Premium повтор
    ├── /api/verify.js       → Верификация BTC + USDT TRC-20
    ├── /api/acceleration.js → Smart Advisor
    └── /api/telegram.js     → Уведомления об оплате
         │
Firebase RTDB ─────────────── mempool.space, coinbase, binance APIs
(счётчики · лента · очередь)   (live данные сети)
```

**Соответствие Vercel Hobby плану:**
- Все функции: `maxDuration ≤ 60с` (broadcast) или `≤ 20с` (остальные)
- Только Firebase free tier — никаких платных баз данных
- Без Redis, без KV, без Postgres — ноль платных add-on'ов
- Фронтенд — один HTML-файл без build-шага и npm
- CSP заголовки настроены под все внешние домены

### 📡 Каналы broadcast (~88% хешрейта)

**Foundry USA** (~27%) · **AntPool** (~16%) · **MARA + Slipstream** (~11%) · **ViaBTC** (~9%) · **SpiderPool** (~8%) · **F2Pool** (~7%) · **Luxor** (~5%) · **CloverPool** (~4%) · **BitFuFu** (~4%) · **BTC.com** (~3%) · **Ocean.xyz** (~2%) · **EMCDPool** (~2%) · **SBICrypto** (~2%) · 9 других пулов

**8 hex-узлов:** mempool.space · blockstream.info · blockchair · blockcypher · btcscan.org + 3 дополнительных

### ⚡ Lightning Network (v13)

Полный LNURL-pay флоу в модалке оплаты:

1. Вкладка «⚡ Lightning» → «Создать Invoice»
2. Сервер: `POST /api/lightning` → получает курс BTC, LNURL params, запрашивает invoice
3. Фронтенд: QR-код через api.qrserver.com (без JS-библиотек)
4. Автополинг каждые 5с: `GET /api/lightning?hash=<paymentHash>`
5. При оплате: выдаётся Premium токен, модалка закрывается автоматически

Совместимо с: **Wallet of Satoshi, Phoenix, Breez, Muun, Zeus, BlueWallet, LNbits**, любым LN-кошельком.

Требует переменную окружения: `LIGHTNING_ADDRESS=user@domain.com`

### 💳 Способы оплаты

| Метод | Сеть | Верификация |
|---|---|---|
| ₿ Bitcoin | On-chain | mempool.space + blockstream fallback |
| ⚡ Lightning | LN / LNURL-pay | In-memory polling |
| ₮ USDT | TRC-20 / TRON | TronGrid + TronScan fallback |
| 🎟 Промокод | — | SHA-256 hash + Firebase счётчик |

### 💳 Детали и лимиты

| | Бесплатно | Premium |
|---|---|---|
| Каналов broadcast | 3 CORS-узла | 30 (8 нод + 22 пула) |
| Лимит в сутки | 100 TX (Firebase глобальный счётчик) | Без лимита |
| Волны повтора | 1 (через 20 мин) | 8 волн до 4 часов |
| Цена | $0 | $3–18 (динамически) |
| Время Premium | 1–3 часа | ~10–20 минут |
| Гарантия | — | Возврат за 6 часов |

### 🆚 TurboTX vs конкуренты (2026)

| Параметр | **TurboTX v13** | ViaBTC | CloverPool | BitAccelerate |
|---|---|---|---|---|
| Бесплатный план | ✅ 100/день | 20/час | ❌ | ❌ |
| Кол-во каналов | **30 (сервер)** | 1 пул | 1 пул | ~20 (клиент) |
| Цена Premium | **$3–18 динамич.** | $25+ | $24+ | ~$65 |
| Lightning Network | **✅** | ❌ | ❌ | ❌ |
| Серверный broadcast | **✅ реальный ответ** | ❌ | ❌ | ❌ |
| Авто-волны | **8 волн · 4ч** | ❌ | ❌ | раз в 6ч |
| Охват хешрейта | **~88%** | — | — | ~30% |
| CPFP калькулятор | **✅** | ❌ | ❌ | ❌ |
| RBF калькулятор | **✅** | ❌ | ❌ | ❌ |
| Гарантия возврата | **✅ 6ч** | ❌ | ❌ | ❌ |

### 📞 Контакты

- **Техподдержка:** [@Sup_TurboTX](https://t.me/Sup_TurboTX)
- **Обновления:** [@TurboTXAcel](https://t.me/TurboTXAcel)
- **Отзывы:** [@TurboTXcoment](https://t.me/TurboTXcoment)
- **Email:** pollytrazlo@gmail.com

### 🌐 Доступ

👉 **[acelerat.vercel.app](https://acelerat.vercel.app)**

---

## 📋 Changelog

### v13 — 2026 Март
- ⚡ **Lightning Network** — полноценный UI: QR-код, LNURL-pay, auto-polling каждые 5с, 60мин таймер, авто-активация Premium
- 📊 **Network Intelligence Dashboard** — 4 live-карточки на главной странице: текущая цена, fee rate, мемпул, Smart Совет
- 🎨 **UI Hero Update** — v13 badge, 7 feature-badges в hero секции, Lightning в списке оплаты
- 🆚 **Таблица конкурентов** — добавлена строка Lightning Network (единственные на рынке!)
- 🐛 **CSP Fix** — добавлен `api.qrserver.com` в `img-src` для QR-кодов Lightning
- 🏷️ **Rebranding** — все версии обновлены до v13

### v12 — 2026 Февраль
- 30 каналов broadcast (было 24)
- Last-Block-Miner Boost
- MARA Slipstream (приватный мемпул)
- Anti-Stuck 72h режим
- HEX Cache
- Fee Trend Detection
- Hashrate-Weighted Early Stop
- UA Rotation
- 🐛 Исправление dynamic price (6 min stale bug)
- 🐛 Исправление confLabel (всегда пустой)
- 🐛 Исправление race condition fetchMempoolStats + updateFeeMeter
- 🐛 Исправление hashrate bar scale (700→1000 EH/s)
- 🐛 Исправление applyPrice tier по feeRate вместо usd

### v11 и ранее
- Smart Advisor (`/api/acceleration`)
- Batch mode (до 20 TX)
- CPFP/RBF калькуляторы
- Firebase live feed + global queue + promo codes
- Мультиязычность (9 языков)
- Telegram уведомления

---

## ⚖️ Лицензия

<p align="center">
  <code><strong>LICENSE: PROPRIETARY</strong></code> &nbsp;&nbsp;|&nbsp;&nbsp; <code><strong>© 2026 ProjectBarabashka</strong></code>
</p>

> [!CAUTION]
> ### 🚨 PROPRIETARY SOFTWARE / ВСЕ ПРАВА ЗАЩИЩЕНЫ (2026)
>
> **ENG:** This source code is provided for **educational and viewing purposes only**. Any commercial use, creation of mirrors (clones), or distribution of modified versions is **STRICTLY PROHIBITED** without express written permission.
>
> **RUS:** Данный исходный код предоставлен исключительно для **ознакомительных целей**. Любое коммерческое использование, создание зеркал или распространение изменённых версий **СТРОГО ЗАПРЕЩЕНО** без письменного согласия владельца.

<p align="center">
  <b>Developed by ProjectBarabashka</b><br>
  <i>Ensuring your Bitcoin transactions never get stuck. · acelerat.vercel.app</i>
</p>
