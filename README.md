# ⚡ T_U_R_B_O_T_X — Bitcoin Transaction Accelerator

<p align="center">
  <a href="#english-version">English</a> •
  <a href="#russian-version">Русский</a>
</p>

---

<div id="english-version"></div>

## 🇺🇸 English Version

> **Status: 🟢 PRODUCTION (2026)**  
> Fully serverless, enterprise-grade Bitcoin transaction accelerator.  
> Real rebroadcast to 8 nodes + 16 mining pools covering ~80% of network hashrate.

A professional toolkit to monitor and accelerate stuck Bitcoin transactions.  
Built on **Vercel Serverless**, **Firebase Realtime Database**, and raw performance.

### 🔥 Key Features
*   **Serverless Core** — All heavy lifting done in `/api/*` endpoints (Node.js 20). No CORS, no browser limitations.
*   **Massive Reach** — 24 channels simultaneously: 8 public nodes + 16 mining pools (Foundry, AntPool, MARA, ViaBTC, SpiderPool, Luxor, etc.).
*   **Smart Acceleration** — Real CPFP & RBF calculators with precise fee recommendations and wallet instructions (Electrum, Sparrow, Ledger, etc.).
*   **Dynamic Pricing** — Price changes with mempool load: from $3 (calm) to $18 (critical). Real BTC/USD rate from multiple sources.
*   **Live Diagnostics** — Instant TX analysis: fee rate, mempool position, RBF support, need for CPFP.
*   **Global Sync** — Firebase-backed live feed of confirmed transactions, global queue, and total acceleration counter.
*   **Batch Mode** — Accelerate up to 20 TXIDs at once (Premium only).
*   **Enterprise‑grade Protection** — IP rate‑limiting, TXID cooldown, bot filtering, hex size limits.

### 🧠 Technical Architecture
```

Client (index.html) ↔ Vercel Edge/Serverless Functions ↔ External APIs
│                                    │
└─ Firebase Realtime DB (sync)       └─ 8 nodes + 16 pools

```
*   **`/api/broadcast.js`** — heart of the system. Fetches TX hex, respects rate limits, sends to 8 nodes + 16 pools with exponential backoff.
*   **`/api/cpfp.js`** — advanced CPFP calculator (address‑type aware, USD values, wallet instructions).
*   **`/api/rbf.js`** — RBF checker with BIP‑125 compliance and comparison to CPFP.
*   **`/api/price.js`** — dynamic pricing based on mempool.space fee estimates + fallback sources.
*   **`/api/verify.js`** — payment verification (BTC on‑chain & USDT TRC‑20). Returns activation token.
*   **`/api/health.js`** — monitors all 24 channels, returns availability and response times.
*   **`/api/repeat.js`** — implements 6 premium waves (0,15,30,60,120,240 min) with confirmation checks.
*   **`/api/status.js`**, **`/api/mempool.js`**, **`/api/stats.js`** — live network data.

### ⚙️ How It Works
1. **Submit TXID** — either single or batch (Premium).
2. **Server fetches hex** from 8 different explorers (fallback chain).
3. **Analysis** — fee rate, mempool position, RBF status, CPFP need.
4. **Rebroadcast** —  
   *Free:* 3 public nodes (mempool.space, blockstream, blockchair).  
   *Premium:* 8 nodes + 16 pools (~80% hashrate) with automatic retries.
5. **Live tracking** — confirmation dots, queue position, push notifications.
6. **Premium waves** — automatic re‑broadcasts at 15,30,60,120,240 min until confirmed.

### 💳 Service Details & Limits
*   **🎁 Free Tier:** 100 accelerations per day (global limit). Rebroadcast to 3 nodes, one auto‑retry after 20 min.
*   **💎 Premium:** Dynamic price $3–18. Access to all 24 channels, 6 waves, batch mode, priority queue.
*   **⏱ Typical times:** Free – 1‑3 hours; Premium – 10‑20 minutes.
*   **🔁 Refund guarantee:** If not confirmed within 6 hours, money back.

### 📞 Contact & Support
*   **Support:** [@Sup_TurboTX](https://t.me/Sup_TurboTX)
*   **Updates:** [@TurboTXAcel](https://t.me/TurboTXAcel)
*   **Reviews:** [@TurboTXcoment](https://t.me/TurboTXcoment)
*   **Email:** pollytrazlo@gmail.com

### 🌐 Live Demo
👉 **[Open Web App (Production)](https://acelerat.vercel.app)**

---

<div id="russian-version"></div>

## 🇷🇺 Русская Версия

> **Статус: 🟢 PRODUCTION (2026)**  
> Полностью serverless, профессиональный ускоритель Bitcoin‑транзакций.  
> Реальный rebroadcast в 8 нод + 16 пулов, покрывающих ~80% хешрейта сети.

Профессиональный набор инструментов для мониторинга и ускорения «зависших» Bitcoin‑транзакций.  
Построен на **Vercel Serverless**, **Firebase Realtime Database** и чистой производительности.

### 🔥 Основные возможности
*   **Serverless ядро** — вся логика вынесена в `/api/*` (Node.js 20). Никаких CORS‑ограничений.
*   **24 канала одновременно** — 8 публичных нод + 16 майнинг‑пулов (Foundry, AntPool, MARA, ViaBTC, SpiderPool, Luxor и др.).
*   **Умные калькуляторы** — CPFP и RBF с точными рекомендациями и инструкциями для кошельков (Electrum, Sparrow, Ledger…).
*   **Динамическая цена** — от $3 (сеть свободна) до $18 (перегрузка). Реальный курс BTC/USD из нескольких источников.
*   **Живая диагностика** — при вводе TXID мгновенный анализ: комиссия, позиция в мемпуле, RBF, нужен ли CPFP.
*   **Глобальная синхронизация** — Firebase: лента подтверждений, общая очередь, счётчик ускорений.
*   **Пакетный режим** — до 20 TXID за раз (только Premium).
*   **Защита уровня enterprise** — лимиты по IP, кулдаун TXID, фильтрация ботов, ограничение размера hex.

### 🧠 Техническая архитектура
*   **`/api/broadcast.js`** — сердце системы. Получает hex, проверяет лимиты, отправляет в 8 нод + 16 пулов с exponential backoff.
*   **`/api/cpfp.js`** — продвинутый CPFP‑калькулятор (учёт типа адреса, USD, инструкции).
*   **`/api/rbf.js`** — RBF‑калькулятор с проверкой BIP‑125 и сравнением с CPFP.
*   **`/api/price.js`** — динамическое ценообразование на основе загрузки mempool.
*   **`/api/verify.js`** — проверка оплаты (BTC on‑chain & USDT TRC‑20). Возвращает токен активации.
*   **`/api/health.js`** — мониторинг всех 24 каналов, статус и время ответа.
*   **`/api/repeat.js`** — реализует 6 премиум‑волн (0,15,30,60,120,240 мин) с автоматическими повторами.
*   **`/api/status.js`**, **`/api/mempool.js`**, **`/api/stats.js`** — живые данные сети.

### ⚙️ Как это работает
1. **Отправляете TXID** (один или пачкой).
2. **Сервер получает hex** из 8 разных эксплореров (цепочка fallback).
3. **Анализ** — ставка, позиция в мемпуле, RBF, нужен ли CPFP.
4. **Rebroadcast** —  
   *Free:* 3 публичные ноды (mempool.space, blockstream, blockchair).  
   *Premium:* 8 нод + 16 пулов (~80% хешрейта) с автоматическими повторными попытками.
5. **Живой трекинг** — точки подтверждений, позиция в очереди, push‑уведомления.
6. **Премиум‑волны** — автоповторы через 15,30,60,120,240 мин до подтверждения.

### 💳 Детали сервиса и лимиты
*   **🎁 Бесплатно:** 100 ускорений в сутки (общий лимит). Rebroadcast в 3 ноды, один автоповтор через 20 мин.
*   **💎 Premium:** динамическая цена $3–18. Все 24 канала, 6 волн, пакетный режим, приоритет.
*   **⏱ Типичное время:** Free – 1‑3 часа; Premium – 10‑20 минут.
*   **🔁 Гарантия возврата:** если не подтвердится за 6 часов — вернём деньги.

### 📞 Контакты и поддержка
*   **Техподдержка:** [@Sup_TurboTX](https://t.me/Sup_TurboTX)
*   **Обновления:** [@TurboTXAcel](https://t.me/TurboTXAcel)
*   **Отзывы:** [@TurboTXcoment](https://t.me/TurboTXcoment)
*   **Email:** pollytrazlo@gmail.com

### 🌐 Доступ к инструменту
👉 **[Открыть Web‑интерфейс (Production)](https://acelerat.vercel.app)**

---

## ⚖️ License & Intellectual Property / Лицензия и Авторское право

<p align="center">
  <code><strong>LICENSE: PROPRIETARY</strong></code> &nbsp;&nbsp; | &nbsp;&nbsp; <code><strong>© 2026 ProjectBarabashka</strong></code>
</p>

> [!CAUTION]
> ### 🚨 PROPRIETARY SOFTWARE / ВСЕ ПРАВА ЗАЩИЩЕНЫ (2026)
>
> **ENG:** This source code is provided for **educational and viewing purposes only**. Any commercial use, creation of mirrors (clones), or distribution of modified versions of the interface and logic of the **BTC Accelerator** (acelerat.vercel.app) is **STRICTLY PROHIBITED** without the express written permission of the owner.
>
> **RUS:** Данный исходный код предоставлен исключительно для **ознакомительных целей**. Любое коммерческое использование, создание зеркал (клонов) или распространение измененных версий интерфейса и логики **BTC Accelerator** (acelerat.vercel.app) **СТРОГО ЗАПРЕЩЕНО** без прямого письменного согласия владельца.

<p align="center">
  <b>Developed by ProjectBarabashka</b><br>
  <i>Ensuring your Bitcoin transactions never get stuck.</i>
</p>
``` 

опять текс поделен на 2 части