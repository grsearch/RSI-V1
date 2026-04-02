// src/rsi.js — RSI calculation + BUY/SELL signal logic
//
// 策略逻辑（RSI-7 + 5秒K线）：
//
// BUY trigger:
//   RSI(7) 上穿 30 → 买入
//   "上穿" = 前一根K线 RSI ≤ 30，当前K线 RSI > 30
//
// SELL trigger (任一条件满足即卖出):
//   1. RSI(7) 下穿 70 → 卖出（前一根 RSI ≥ 70，当前 RSI < 70）
//   2. RSI(7) > 80 → 立即卖出
//   3. 涨幅 ≥ +50% → 止盈
//   4. 跌幅 ≤ -15% → 止损
//
// 仓位管理：
//   - 15分钟监控期
//   - 第一笔盈利 → 不再开仓，退出监控
//   - 第一笔亏损 → 允许再开一次（第二笔无论盈亏都退出）
//   - FDV < $10,000 → 自动退出

'use strict';

const RSI_PERIOD      = parseInt(process.env.RSI_PERIOD       || '7');
const RSI_BUY_LEVEL   = parseFloat(process.env.RSI_BUY_LEVEL  || '30');
const RSI_SELL_LEVEL   = parseFloat(process.env.RSI_SELL_LEVEL || '70');
const RSI_PANIC_LEVEL  = parseFloat(process.env.RSI_PANIC_LEVEL || '80');
const KLINE_INTERVAL   = parseInt(process.env.KLINE_INTERVAL_SEC || '5');

/**
 * Calculate RSI array for a price series (oldest-first).
 * Uses Wilder's smoothing (exponential moving average of gains/losses).
 *
 * Returns array of same length, first RSI_PERIOD entries are NaN.
 */
function calcRSI(closes, period = RSI_PERIOD) {
  const result = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  // First average gain/loss — simple average of first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else          avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI value at index = period
  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - 100 / (1 + rs);
  }

  // Subsequent values — Wilder's smoothing
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

  return result;
}

/**
 * Evaluate RSI signals.
 *
 * @param {Array} candles  — OHLCV candles (oldest first)
 * @param {Object} tokenState — mutable state (prevRsi stored here)
 * @returns {{ rsi: number, signal: string|null, reason: string }}
 */
function evaluateSignal(candles, tokenState) {
  const closes = candles.map(c => c.close);
  const rsiArr = calcRSI(closes, RSI_PERIOD);
  const len    = closes.length;

  // Need at least RSI_PERIOD + 2 candles: period+1 for first RSI, +1 for prev comparison
  if (len < RSI_PERIOD + 2) {
    return { rsi: NaN, signal: null, reason: `warming_up(${len}/${RSI_PERIOD + 2})` };
  }

  const rsiNow  = rsiArr[len - 1];
  const rsiPrev = rsiArr[len - 2];

  if (isNaN(rsiNow) || isNaN(rsiPrev)) {
    return { rsi: NaN, signal: null, reason: 'rsi_nan' };
  }

  // ── SELL conditions (check first if in position) ─────────────
  if (tokenState.inPosition) {
    // 1. RSI > 80 → 立即卖出
    if (rsiNow > RSI_PANIC_LEVEL) {
      return { rsi: rsiNow, signal: 'SELL', reason: `RSI_PANIC(${rsiNow.toFixed(1)}>${RSI_PANIC_LEVEL})` };
    }

    // 2. RSI 下穿 70
    if (rsiPrev >= RSI_SELL_LEVEL && rsiNow < RSI_SELL_LEVEL) {
      return { rsi: rsiNow, signal: 'SELL', reason: `RSI_CROSS_DOWN_70(${rsiPrev.toFixed(1)}→${rsiNow.toFixed(1)})` };
    }

    // 3. 止盈 +50%
    if (tokenState.position && tokenState.position.entryPriceUsd) {
      const pnl = (tokenState.currentPrice - tokenState.position.entryPriceUsd)
                  / tokenState.position.entryPriceUsd * 100;
      if (pnl >= 50) {
        return { rsi: rsiNow, signal: 'SELL', reason: `TAKE_PROFIT(+${pnl.toFixed(1)}%≥50%)` };
      }
      // 4. 止损 -15%
      if (pnl <= -15) {
        return { rsi: rsiNow, signal: 'SELL', reason: `STOP_LOSS(${pnl.toFixed(1)}%≤-15%)` };
      }
    }
  }

  // ── BUY condition (only if NOT in position) ──────────────────
  if (!tokenState.inPosition) {
    // RSI 上穿 30
    if (rsiPrev <= RSI_BUY_LEVEL && rsiNow > RSI_BUY_LEVEL) {
      return { rsi: rsiNow, signal: 'BUY', reason: `RSI_CROSS_UP_30(${rsiPrev.toFixed(1)}→${rsiNow.toFixed(1)})` };
    }
  }

  return { rsi: rsiNow, signal: null, reason: '' };
}

/**
 * Aggregate raw price ticks into fixed-width OHLCV candles.
 * Gaps (no ticks in a bucket) are forward-filled from previous close.
 */
function buildCandles(ticks, intervalSec = KLINE_INTERVAL) {
  if (!ticks.length) return [];

  const intervalMs = intervalSec * 1000;
  const candles    = [];
  let bucketStart  = Math.floor(ticks[0].time / intervalMs) * intervalMs;
  let current      = null;

  for (const tick of ticks) {
    const bucket = Math.floor(tick.time / intervalMs) * intervalMs;

    if (bucket !== bucketStart) {
      if (current) candles.push(current);

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

  if (current) candles.push(current);
  return candles;
}

module.exports = { calcRSI, evaluateSignal, buildCandles, RSI_PERIOD, RSI_BUY_LEVEL, RSI_SELL_LEVEL };
