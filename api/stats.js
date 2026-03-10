// ══════════════════════════════════════════════════════════════
//  TurboTX v11 ★ STATS ★  —  /api/stats.js
//  Vercel Serverless · Node.js 20 · Hobby Plan
//
//  GET /api/stats            — публичные метрики (кэш 60с)
//  GET /api/stats?admin=1    — полная статистика (токен)
//  GET /api/stats?live=1     — без кэша (только admin)
//
//  ✦ Реальные данные: блок, hashrate EH/s, цена BTC
//  ✦ Mempool: размер, fee rates, congestion
//  ✦ In-memory счётчики: broadcast/verify/cpfp/lightning
//  ✦ Blockstream fallback если mempool.space лежит
//  ✦ Rate limiter 60 req/min
//  ✦ 25 каналов, ~83% hashrate охват, batch + Lightning
// ══════════════════════════════════════════════════════════════

export const config = { maxDuration: 12 };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// ─── RATE LIMITER ─────────────────────────────────────────────
const _rl = new Map();
function checkRl(ip) {
  const now = Date.now(), min = 60_000;
  if (_rl.size > 2000) for (const [k,v] of _rl) if (v.r < now) _rl.delete(k);
  let e = _rl.get(ip);
  if (!e || e.r < now) { e = {c:0, r:now+min}; _rl.set(ip, e); }
  return ++e.c <= 60;
}

// ─── IN-MEMORY СЧЁТЧИКИ ────────────────────────────────────────
const _sess = {
  startedAt:         Date.now(),
  broadcasts:        0,
  freeBroadcasts:    0,
  premBroadcasts:    0,
  batchBroadcasts:   0,
  verifications:     0,
  lightningInvoices: 0,
  cpfpCalcs:         0,
  rbfChecks:         0,
  errors:            0,
  totalHashreachPct: 0,
  broadcastsWithHex: 0,
};

export function incBroadcast(plan, hr=0, hasHex=false) {
  _sess.broadcasts++;
  if (plan==='premium')     _sess.premBroadcasts++;
  else if (plan==='batch')  _sess.batchBroadcasts++;
  else                      _sess.freeBroadcasts++;
  if (hr > 0)     _sess.totalHashreachPct += hr;
  if (hasHex)     _sess.broadcastsWithHex++;
}
export function incVerify()    { _sess.verifications++;    }
export function incLightning() { _sess.lightningInvoices++; }
export function incCpfp()      { _sess.cpfpCalcs++;        }
export function incRbf()       { _sess.rbfChecks++;        }
export function incError()     { _sess.errors++;           }

// ─── УТИЛИТЫ ──────────────────────────────────────────────────
async function ft(url, ms=7000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, {signal:ac.signal}); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}
async function sj(r) { try { return await r.json(); } catch { return {}; } }

function getIp(req) {
  return req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

// ─── MAIN ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));

  const ip = getIp(req);
  if (!checkRl(ip)) return res.status(429).json({ok:false, error:'Too many requests'});

  const isAdmin = req.query?.admin === '1' &&
    req.headers['x-turbotx-token'] === process.env.PREMIUM_SECRET;
  const isLive  = isAdmin && req.query?.live === '1';

  try {
    // Параллельно: mempool.space + blockstream fallback для высоты блока
    const [feesR, mpR, tipR, priceR, hrR, tip2R] = await Promise.allSettled([
      ft('https://mempool.space/api/v1/fees/recommended', 6000),
      ft('https://mempool.space/api/mempool', 6000),
      ft('https://mempool.space/api/blocks/tip/height', 5000),
      ft('https://mempool.space/api/v1/prices', 5000),
      ft('https://mempool.space/api/v1/mining/hashrate/3d', 6000),
      ft('https://blockstream.info/api/blocks/tip/height', 5000),
    ]);

    const ok = s => s.status==='fulfilled' && s.value?.ok ? s.value : null;

    const fees  = ok(feesR)  ? await sj(ok(feesR))  : {};
    const mp    = ok(mpR)    ? await sj(ok(mpR))     : {};
    const price = ok(priceR) ? await sj(ok(priceR))  : {};
    const hr    = ok(hrR)    ? await sj(ok(hrR))     : {};

    let tip = 0;
    if (ok(tipR))  tip = parseInt(await ok(tipR).text(),  10) || 0;
    if (!tip && ok(tip2R)) tip = parseInt(await ok(tip2R).text(), 10) || 0;

    const fastest  = fees.fastestFee    || 0;
    const halfHour = fees.halfHourFee   || 0;
    const hour     = fees.hourFee       || 0;
    const economy  = fees.economyFee    || fees.minimumFee || 0;
    const btcPrice = price.USD || null;

    const congestion =
      fastest > 200 ? 'critical' :
      fastest > 100 ? 'extreme'  :
      fastest > 50  ? 'high'     :
      fastest > 20  ? 'medium'   : 'low';

    const CONGESTION_EMOJI = {critical:'🔴',extreme:'🔴',high:'🟠',medium:'🟡',low:'🟢'};
    const CONGESTION_TEXT  = {
      critical:'Критическая перегрузка', extreme:'Сильная перегрузка',
      high:'Высокая нагрузка', medium:'Умеренная нагрузка', low:'Сеть свободна',
    };

    const uptimeSec = Math.round((Date.now()-_sess.startedAt)/1000);
    const uptimeStr = uptimeSec < 60   ? `${uptimeSec}с`
                    : uptimeSec < 3600 ? `${Math.round(uptimeSec/60)}м`
                    :                    `${Math.round(uptimeSec/3600)}ч`;

    const avgHr  = _sess.premBroadcasts > 0
      ? Math.round(_sess.totalHashreachPct / _sess.premBroadcasts) : 83;
    const hexRate = _sess.broadcasts > 0
      ? Math.round(_sess.broadcastsWithHex / _sess.broadcasts * 100) : null;

    const pub = {
      ok: true,
      version: 'v11',
      network: {
        blockHeight:    tip       || null,
        feeRate:        fastest   || null,
        feeHalfHour:    halfHour  || null,
        feeHour:        hour      || null,
        feeEconomy:     economy   || null,
        congestion,
        congestionText: CONGESTION_TEXT[congestion],
        congestionEmoji:CONGESTION_EMOJI[congestion],
        btcPrice,
        mempoolCount:   mp.count  || null,
        mempoolMB:      mp.vsize  ? +(mp.vsize/1e6).toFixed(1) : null,
        hashrateEHs:    hr.currentHashrate
          ? +(hr.currentHashrate/1e18).toFixed(2) : null,
      },
      service: {
        version:         'v11',
        nodeChannels:    8,
        poolChannels:    17,
        totalChannels:   25,
        hashrateReach:   `~${avgHr}%`,
        batchSupport:    true,
        lightningSupport:true,
        uptime:          uptimeStr,
      },
      timestamp: Date.now(),
    };

    if (isAdmin) {
      pub.session = {
        startedAt:       new Date(_sess.startedAt).toISOString(),
        uptime:          uptimeStr,
        broadcasts:      _sess.broadcasts,
        free:            _sess.freeBroadcasts,
        premium:         _sess.premBroadcasts,
        batch:           _sess.batchBroadcasts,
        verifications:   _sess.verifications,
        lightning:       _sess.lightningInvoices,
        cpfpCalcs:       _sess.cpfpCalcs,
        rbfChecks:       _sess.rbfChecks,
        errors:          _sess.errors,
        avgHashreachPct: avgHr,
        hexHitRate:      hexRate !== null ? `${hexRate}%` : 'n/a',
      };
    }

    if (!isLive) {
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    return res.status(200).json(pub);

  } catch(e) {
    incError();
    return res.status(500).json({ok:false, error:e.message});
  }
}
