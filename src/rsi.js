// src/rsi.js — RSI calculation + BUY/SELL signal logic
//
// 规则（5s K线，1s轮询）：
//   BUY : RSI(7) 上穿 30
//   SELL: RSI 下穿 70 / RSI > 80 / TP +50%
//
// 实现说明：
//   - RSI 基线使用「已收盘K线」(Wilder smoothing)
//   - 每次 1s 轮询，用实时价格对基线做一步增量，得到当前 RSI
//   - 穿越判定使用「上一轮询 RSI -> 当前 RSI」
//     避免“上一根收盘 vs 当前实时”导致的错位触发

'use strict';

const RSI_PERIOD       = parseInt(process.env.RSI_PERIOD        || '7');
const RSI_BUY_LEVEL    = parseFloat(process.env.RSI_BUY_LEVEL   || '30');
const RSI_SELL_LEVEL   = parseFloat(process.env.RSI_SELL_LEVEL  || '70');
const RSI_PANIC_LEVEL  = parseFloat(process.env.RSI_PANIC_LEVEL || '80');
const KLINE_INTERVAL   = parseInt(process.env.KLINE_INTERVAL_SEC || '5');

/**
 * Calculate RSI array + return final avgGain/avgLoss state for incremental use.
 * Uses Wilder's smoothing.
 *
 * @returns {{ rsiArray: number[], avgGain: number, avgLoss: number }}
 */
function calcRSIWithState(closes, period = RSI_PERIOD) {
  const result = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) {
    return { rsiArray: result, avgGain: 0, avgLoss: 0 };
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else          avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
  }

  return { rsiArray: result, avgGain, avgLoss };
}

/**
 * From a known avgGain/avgLoss state and last close, compute RSI for a new price.
 */
function stepRSI(avgGain, avgLoss, lastClose, newPrice, period = RSI_PERIOD) {
  const diff = newPrice - lastClose;
  const gain = diff > 0 ? diff : 0;
  const loss = diff < 0 ? Math.abs(diff) : 0;

  const ag = (avgGain * (period - 1) + gain) / period;
  const al = (avgLoss * (period - 1) + loss) / period;

  if (al === 0) return 100;
  const rs = ag / al;
  return 100 - 100 / (1 + rs);
}

/**
 * Evaluate RSI signals.
 *
 * @param {Array}  closedCandles — 已收盘K线 (oldest first)
 * @param {number} realtimePrice — 当前实时价格
 * @param {Object} tokenState    — mutable token state
 * @returns {{ rsi: number, signal: string|null, reason: string }}
 */
function evaluateSignal(closedCandles, realtimePrice, tokenState) {
  const closes = closedCandles.map(c => c.close);
  const len    = closes.length;

  // Need at least RSI_PERIOD + 1 closed candles to compute RSI
  if (len < RSI_PERIOD + 1) {
    return { rsi: NaN, signal: null, reason: `warming_up(${len}/${RSI_PERIOD + 1} closed)` };
  }

  const { rsiArray, avgGain, avgLoss } = calcRSIWithState(closes, RSI_PERIOD);
  const lastClosedRsi = rsiArray[len - 1];
  const lastClose = closes[len - 1];
  const rsiRealtime = stepRSI(avgGain, avgLoss, lastClose, realtimePrice, RSI_PERIOD);
  if (!Number.isFinite(lastClosedRsi) || !Number.isFinite(rsiRealtime)) {
    return { rsi: NaN, prevRsi: NaN, signal: null, reason: 'rsi_nan' };
  }

  const nowMs = Date.now();
  const currentBucket = Math.floor(nowMs / (KLINE_INTERVAL * 1000));
  const lastBuyBucket = tokenState._lastBuyBucket ?? -1;
  const lastSellBucket = tokenState._lastSellBucket ?? -1;
  const prevRsiRaw = tokenState._prevRsiRealtime;
  const prevTs = tokenState._prevRsiTs ?? 0;
  const isStale = !Number.isFinite(prevRsiRaw) || (nowMs - prevTs) > 2500;
  // 断档时回退到“上一根已收盘 RSI”作为前值，不直接跳过这次信号判定
  const prevRsi = isStale ? lastClosedRsi : prevRsiRaw;

  // ── SELL conditions (check first if in position) ─────────────
  if (tokenState.inPosition) {
    // 1. 实时 RSI > 80 → 立即卖出
    if (rsiRealtime > RSI_PANIC_LEVEL && currentBucket !== lastSellBucket) {
      tokenState._lastSellBucket = currentBucket;
      tokenState._prevRsiRealtime = rsiRealtime;
      tokenState._prevRsiTs = nowMs;
      return { rsi: rsiRealtime, prevRsi, signal: 'SELL', reason: `RSI_PANIC(${rsiRealtime.toFixed(1)}>${RSI_PANIC_LEVEL})` };
    }

    // 2. RSI 下穿 70（前值 ≥ 70，当前 < 70）
    if (prevRsi >= RSI_SELL_LEVEL && rsiRealtime < RSI_SELL_LEVEL && currentBucket !== lastSellBucket) {
      tokenState._lastSellBucket = currentBucket;
      tokenState._prevRsiRealtime = rsiRealtime;
      tokenState._prevRsiTs = nowMs;
      return {
        rsi: rsiRealtime,
        prevRsi,
        signal: 'SELL',
        reason: `RSI_CROSS_DOWN_70(${prevRsi.toFixed(1)}→${rsiRealtime.toFixed(1)})`,
      };
    }

    // 3. 止盈 +50%（实时价格）
    if (tokenState.position && tokenState.position.entryPriceUsd) {
      const pnl = (realtimePrice - tokenState.position.entryPriceUsd)
                  / tokenState.position.entryPriceUsd * 100;
      if (pnl >= 50) {
        tokenState._prevRsiRealtime = rsiRealtime;
        tokenState._prevRsiTs = nowMs;
        return { rsi: rsiRealtime, prevRsi, signal: 'SELL', reason: `TAKE_PROFIT(+${pnl.toFixed(1)}%≥50%)` };
      }
    }
  }

  // ── BUY condition (only if NOT in position) ──────────────────
  if (!tokenState.inPosition) {
    // RSI 上穿 30：前值 ≤ 30，当前 > 30
    if (prevRsi <= RSI_BUY_LEVEL && rsiRealtime > RSI_BUY_LEVEL && currentBucket !== lastBuyBucket) {
      tokenState._lastBuyBucket = currentBucket;
      tokenState._prevRsiRealtime = rsiRealtime;
      tokenState._prevRsiTs = nowMs;
      return {
        rsi: rsiRealtime,
        prevRsi,
        signal: 'BUY',
        reason: `RSI_CROSS_UP_30(${prevRsi.toFixed(1)}→${rsiRealtime.toFixed(1)})`,
      };
    }
  }

  tokenState._prevRsiRealtime = rsiRealtime;
  tokenState._prevRsiTs = nowMs;
  return { rsi: rsiRealtime, prevRsi, signal: null, reason: isStale ? 'rsi_rebase' : '' };
}

/**
 * Aggregate raw price ticks into fixed-width OHLCV candles.
 * Returns { closed: [...], current: {...}|null }
 *
 *   closed  — 已收盘的完整K线，用于 RSI 计算基线
 *   current — 当前正在形成的K线（未收盘），仅用于 dashboard 显示
 */
function buildCandles(ticks, intervalSec = KLINE_INTERVAL) {
  if (!ticks.length) return { closed: [], current: null };

  const intervalMs = intervalSec * 1000;
  const candles    = [];
  let bucketStart  = Math.floor(ticks[0].time / intervalMs) * intervalMs;
  let current      = null;

  for (const tick of ticks) {
    const bucket = Math.floor(tick.time / intervalMs) * intervalMs;

    if (bucket !== bucketStart) {
      if (current) candles.push(current);

      // Forward-fill gaps
      let gap = bucketStart + intervalMs;
      while (gap < bucket) {
        const prev = candles[candles.length - 1];
        candles.push({
          time: gap, open: prev.close, high: prev.close,
          low: prev.close, close: prev.close, volume: 0,
        });
        gap += intervalMs;
      }

      bucketStart = bucket;
      current     = null;
    }

    if (!current) {
      current = {
        time: bucket, open: tick.price, high: tick.price,
        low: tick.price, close: tick.price, volume: 1,
      };
    } else {
      if (tick.price > current.high) current.high = tick.price;
      if (tick.price < current.low)  current.low  = tick.price;
      current.close = tick.price;
      current.volume++;
    }
  }

  // current 是最后一根 — 检查它是否已收盘
  const now = Date.now();
  if (current) {
    const candleEndTime = current.time + intervalMs;
    if (now >= candleEndTime) {
      candles.push(current);
      return { closed: candles, current: null };
    }
    return { closed: candles, current };
  }

  return { closed: candles, current: null };
}

module.exports = { calcRSIWithState, stepRSI, evaluateSignal, buildCandles, RSI_PERIOD, RSI_BUY_LEVEL, RSI_SELL_LEVEL };
