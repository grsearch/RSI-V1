// src/monitor.js — Core monitoring engine (Singleton)
//
// RSI 策略：
//   webhook 收到代币 → 开始 15 分钟监控期
//   → 1秒轮询价格，聚合 5 秒 K 线，计算 RSI(7)
//   → RSI 上穿 30 买入
//   → RSI 下穿 70 / RSI > 80 / +50% 止盈 / -15% 止损 卖出
//
// 仓位管理：
//   - 第一笔交易盈利 → 不再开仓，退出监控
//   - 第一笔交易亏损 → 允许再开一次（第二笔无论盈亏，退出）
//   - 最多 2 次开仓
//   - 15 分钟到期自动清仓退出
//   - FDV < $10,000 立即退出

'use strict';

const birdeye                          = require('./birdeye');
const { evaluateSignal, buildCandles } = require('./rsi');
const trader                           = require('./trader');
const { broadcastToClients }           = require('./wsHub');
const logger                           = require('./logger');

const PRICE_POLL_SEC     = parseInt(process.env.PRICE_POLL_SEC        || '1');   // 1秒价格轮询
const KLINE_INTERVAL_SEC = parseInt(process.env.KLINE_INTERVAL_SEC    || '5');   // 5秒K线
const TOKEN_MAX_AGE_MIN  = parseInt(process.env.TOKEN_MAX_AGE_MINUTES || '15');  // 15分钟监控期
const FDV_EXIT_USD       = parseInt(process.env.FDV_EXIT_USD          || '10000'); // FDV < 10000 退出
const MAX_TICKS_HISTORY  = 60 * 60 * 1;  // 1h × 60 ticks/min (1s poll) = 3600 ticks max

class TokenMonitor {
  static instance = null;
  static getInstance() {
    if (!TokenMonitor.instance) TokenMonitor.instance = new TokenMonitor();
    return TokenMonitor.instance;
  }

  constructor() {
    this.tokens      = new Map();   // Map<address, TokenState>
    this.tradeLog    = [];          // last 200 trade entries (实时feed)
    this.tradeRecords = [];         // 24h完整交易记录（用于统计dashboard）
    this._pollTimer  = null;
    this._metaTimer  = null;
    this._ageTimer   = null;
    this._dashTimer  = null;
  }

  // ── Add token to whitelist ──────────────────────────────────
  async addToken({ address, symbol, network = 'solana', xMentions, holders, top10Pct, devPct }) {
    if (this.tokens.has(address)) {
      logger.info(`[Monitor] Already in whitelist: ${symbol} (${address.slice(0, 8)})`);
      return { ok: false, reason: 'already_exists' };
    }

    const state = {
      address,
      symbol:       symbol || address.slice(0, 8),
      network,
      addedAt:      Date.now(),
      ticks:        [],
      candles:      [],
      currentPrice: null,
      rsi:          NaN,
      lastSignal:   null,
      fdv:          null,
      lp:           null,
      age:          null,
      // 扫描服务器发来的额外数据
      xMentions:    xMentions ?? null,
      holders:      holders   ?? null,
      top10Pct:     top10Pct  ?? null,
      devPct:       devPct    ?? null,
      // Position tracking (null = no open position)
      position:     null,
      pnlPct:       null,
      // Trade counting for position management
      tradeCount:     0,      // 已完成的买卖轮次
      lastTradePnl:   null,   // 上一笔交易盈亏 ('profit' | 'loss')
      shouldExit:     false,  // 是否应退出监控（基于仓位管理规则）
      // Lifecycle flags
      bought:       false,
      exitSent:     false,
      inPosition:   false,
    };

    this.tokens.set(address, state);
    logger.info(`[Monitor] ✅ Added: ${state.symbol} (${address}) — 开始 ${TOKEN_MAX_AGE_MIN} 分钟 RSI 监控`);

    // 获取初始元数据（FDV 检查）
    await this._fetchInitialMeta(state);

    broadcastToClients({ type: 'token_added', data: this._stateView(state) });
    return { ok: true };
  }

  // ── Meta fetch + FDV gate（不再立即买入，等 RSI 信号）─────────
  async _fetchInitialMeta(state) {
    try {
      const overview = await birdeye.getTokenOverview(state.address);
      if (overview) {
        state.fdv    = overview.fdv ?? overview.mc ?? null;
        state.lp     = overview.liquidity ?? null;
        state.symbol = overview.symbol || state.symbol;
        const created = overview.createdAt || overview.created_at || null;
        if (created) {
          state.age = ((Date.now() - created * 1000) / 60000).toFixed(1);
        }
      }
    } catch (e) {
      logger.warn(`[Monitor] meta fetch error ${state.symbol}: ${e.message}`);
    }

    // FDV < 10000 直接退出
    if (state.fdv !== null && state.fdv < FDV_EXIT_USD) {
      const reason = `FDV_TOO_LOW($${state.fdv}<$${FDV_EXIT_USD})`;
      logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${reason}`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, reason), 1000);
      return;
    }

    logger.info(
      `[Monitor] 📊 ${state.symbol} FDV=$${state.fdv?.toLocaleString() ?? '?'}` +
      ` LP=$${state.lp?.toLocaleString() ?? '?'} — 等待 RSI 买入信号`
    );
  }

  // ── Meta refresh every 30s: check FDV drop ───────────────────
  async _fetchMeta(state) {
    if (state.exitSent) return;
    try {
      const overview = await birdeye.getTokenOverview(state.address);
      if (!overview) return;

      state.fdv    = overview.fdv ?? overview.mc ?? null;
      state.lp     = overview.liquidity ?? null;
      state.symbol = overview.symbol || state.symbol;
      const created = overview.createdAt || overview.created_at || null;
      if (created) {
        state.age = ((Date.now() - created * 1000) / 60000).toFixed(1);
      }

      // FDV < 10000 → 立即退出（有仓位先清仓）
      if (state.fdv !== null && state.fdv < FDV_EXIT_USD) {
        logger.warn(`[Monitor] ⚠️ FDV退出: ${state.symbol} FDV=$${state.fdv} < $${FDV_EXIT_USD}`);
        if (state.inPosition && state.position) {
          await this._doSellExit(state, `FDV_DROP($${state.fdv}<$${FDV_EXIT_USD})`);
        } else {
          state.exitSent = true;
          this._removeToken(state.address, `FDV_DROP($${state.fdv}<$${FDV_EXIT_USD})`);
        }
      }
    } catch (e) {
      logger.warn(`[Monitor] meta refresh error ${state.symbol}: ${e.message}`);
    }
  }

  // ── Start all timers ──────────────────────────────────────────
  start() {
    logger.info(
      `[Monitor] Starting — poll ${PRICE_POLL_SEC}s | kline ${KLINE_INTERVAL_SEC}s` +
      ` | FDV_EXIT $${FDV_EXIT_USD} | max_age ${TOKEN_MAX_AGE_MIN}min | RSI strategy`
    );
    this._pollTimer  = setInterval(() => this._pollAndEvaluate(), PRICE_POLL_SEC * 1000);
    this._metaTimer  = setInterval(async () => {
      for (const s of this.tokens.values()) {
        await this._fetchMeta(s);
        await sleep(100);
      }
    }, 30_000);
    this._ageTimer  = setInterval(() => this._checkAgeExpiry(), 15_000);
    this._dashTimer = setInterval(() => {
      broadcastToClients({ type: 'update', data: this.getDashboardData() });
    }, 5000);
    // 每15分钟刷新交易记录里的 currentFdv
    this._fdvTimer  = setInterval(() => this._refreshTradeRecordFdv(), 15 * 60 * 1000);
  }

  stop() {
    [this._pollTimer, this._metaTimer, this._ageTimer, this._dashTimer, this._fdvTimer]
      .forEach(t => t && clearInterval(t));
    logger.info('[Monitor] Stopped');
  }

  // ── 价格轮询 + RSI 评估 每 PRICE_POLL_SEC (1s) ──────────────
  async _pollAndEvaluate() {
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent) continue;
      // 如果 shouldExit 且无仓位 → 退出监控
      if (state.shouldExit && !state.inPosition) {
        logger.info(`[Monitor] 🏁 ${state.symbol} 仓位管理规则：退出监控`);
        state.exitSent = true;
        this._removeToken(state.address, 'POSITION_RULE_EXIT');
        continue;
      }

      const price = await birdeye.getPrice(addr);
      if (price !== null && price > 0) {
        state.currentPrice = price;
        state.ticks.push({ time: Date.now(), price });
        if (state.ticks.length > MAX_TICKS_HISTORY) {
          state.ticks.splice(0, state.ticks.length - MAX_TICKS_HISTORY);
        }

        // 更新 PnL 显示
        if (state.inPosition && state.position && state.position.entryPriceUsd) {
          const pnlPct = (price - state.position.entryPriceUsd) / state.position.entryPriceUsd * 100;
          state.pnlPct = pnlPct.toFixed(2);
        }

        // 更新 dashboard 显示用的峰值
        if (state.position && price > (state.position.peakPriceUsd ?? 0)) {
          state.position.peakPriceUsd = price;
        }

        // ── RSI 评估（已收盘K线算基线 + 实时价格做增量，穿越即触发）──
        const { closed, current: currentCandle } = buildCandles(state.ticks, KLINE_INTERVAL_SEC);
        // 合并 closed + current 用于 dashboard 显示
        state.candles = currentCandle ? [...closed, currentCandle] : [...closed];

        if (closed.length >= 2) {
          // 传入已收盘K线 + 实时价格，evaluateSignal 内部做增量RSI
          const result = evaluateSignal(closed, price, state);
          state.rsi    = result.rsi;

          // 调试日志
          if (!isNaN(result.rsi)) {
            logger.info(
              `[RSI] ${state.symbol}` +
              ` | closed=${closed.length}` +
              ` | RSI_rt=${result.rsi.toFixed(2)}` +
              ` | price=${price}` +
              ` | inPos=${state.inPosition}` +
              ` | trades=${state.tradeCount}` +
              ` | signal=${result.signal || 'HOLD'}` +
              ` | ${result.reason}`
            );
          } else if (result.reason) {
            logger.info(`[RSI] ${state.symbol} | ${result.reason}`);
          }

          // ── BUY signal ────────────────────────────────────
          if (result.signal === 'BUY' && !state.inPosition && !state.shouldExit) {
            logger.warn(`[Strategy] ⚡ RSI BUY ${state.symbol} — ${result.reason}`);
            await this._doBuy(state);
          }

          // ── SELL signal ───────────────────────────────────
          if (result.signal === 'SELL' && state.inPosition) {
            logger.warn(`[Strategy] ⚡ RSI SELL ${state.symbol} — ${result.reason}`);
            await this._doSellExit(state, result.reason);
          }
        }
      }

      await sleep(10);  // 10ms 间隔错开 Birdeye 请求
    }
  }

  // ── BUY helper ─────────────────────────────────────────────────
  async _doBuy(state) {
    const pos = await trader.buy(state);
    if (pos) {
      state.position   = pos;
      state.inPosition = true;
      state.bought     = true;
      state.lastSignal = 'BUY';

      this._addTradeLog({ type: 'BUY', symbol: state.symbol, reason: 'RSI_CROSS_UP_30' });
      this._createTradeRecord(state, pos);
    } else {
      logger.warn(`[Monitor] ⚠️ ${state.symbol} 买入失败`);
    }
  }

  // ── SELL + exit logic helper ───────────────────────────────────
  async _doSellExit(state, reason) {
    // 记录卖出前的 PnL
    const pnlPct = state.pnlPct ? parseFloat(state.pnlPct) : 0;
    const isProfit = pnlPct > 0;

    await trader.exitPosition(state, reason);
    state.inPosition = false;
    state.position   = null;
    state.lastSignal = 'SELL';

    state.tradeCount++;
    state.lastTradePnl = isProfit ? 'profit' : 'loss';

    this._addTradeLog({ type: 'SELL', symbol: state.symbol, reason });
    this._finalizeTradeRecord(state, reason);

    // ── 仓位管理规则 ──────────────────────────────────────
    if (state.tradeCount === 1) {
      if (isProfit) {
        // 第一笔盈利 → 不再开仓，退出
        logger.info(`[Monitor] 🏁 ${state.symbol} 第1笔盈利(${pnlPct.toFixed(1)}%)，退出监控`);
        state.shouldExit = true;
      } else {
        // 第一笔亏损 → 允许再开一次
        logger.info(`[Monitor] ↩️ ${state.symbol} 第1笔亏损(${pnlPct.toFixed(1)}%)，允许再开一次`);
      }
    } else if (state.tradeCount >= 2) {
      // 第二笔无论盈亏 → 退出
      logger.info(`[Monitor] 🏁 ${state.symbol} 第2笔完成(${pnlPct.toFixed(1)}%)，退出监控`);
      state.shouldExit = true;
    }

    // 如果 shouldExit，延迟移除
    if (state.shouldExit) {
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, reason), 5000);
    }
  }

  // ── Age expiry check every 15s ────────────────────────────────
  async _checkAgeExpiry() {
    const maxMin = TOKEN_MAX_AGE_MIN;
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent) continue;

      const ageMin = (Date.now() - state.addedAt) / 60000;

      if (ageMin < maxMin) continue;

      state.exitSent = true;

      if (state.inPosition && state.position) {
        logger.info(`[Monitor] ⏰ Age expiry SELL: ${state.symbol} (${ageMin.toFixed(1)}min)`);
        await trader.exitPosition(state, `AGE_EXPIRY_${maxMin}min`);
        state.inPosition = false;
        state.position   = null;
        this._addTradeLog({ type: 'SELL', symbol: state.symbol, reason: 'AGE_EXPIRY' });
        this._finalizeTradeRecord(state, 'AGE_EXPIRY');
        setTimeout(() => this._removeToken(addr, 'AGE_EXPIRY'), 5000);
      } else {
        logger.info(`[Monitor] ⏰ Age expiry (no position): ${state.symbol}`);
        this._removeToken(addr, 'AGE_EXPIRY_NO_POSITION');
      }
    }
  }

  _removeToken(addr, reason) {
    const state = this.tokens.get(addr);
    if (state) {
      logger.info(`[Monitor] 🗑  Removed ${state.symbol} — ${reason}`);
      this.tokens.delete(addr);
      broadcastToClients({ type: 'token_removed', data: { address: addr, reason } });
    }
  }

  // ── 24h 交易记录 ──────────────────────────────────────────────
  _createTradeRecord(state, pos) {
    const rec = {
      id:          `${state.address}_${state.tradeCount}`,
      address:     state.address,
      symbol:      state.symbol,
      buyAt:       Date.now(),
      tradeRound:  state.tradeCount + 1,  // 第几轮交易
      // 买入时的链上数据
      entryFdv:    state.fdv,
      entryLp:     state.lp,
      entryLpFdv:  state.fdv ? +((state.lp / state.fdv) * 100).toFixed(1) : null,
      // 扫描服务器发来的数据
      xMentions:   state.xMentions,
      holders:     state.holders,
      top10Pct:    state.top10Pct,
      devPct:      state.devPct,
      // 买入信息
      solSpent:    pos.solSpent,
      entryPrice:  pos.entryPriceUsd,
      // 退出信息（待填）
      exitAt:      null,
      exitReason:  null,
      exitFdv:     null,
      solReceived: null,
      pnlPct:      null,
      // 当前FDV（15分钟更新）
      currentFdv:  state.fdv,
      fdvUpdatedAt: Date.now(),
    };
    this.tradeRecords.unshift(rec);
    // 只保留 24h 内的记录
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.tradeRecords = this.tradeRecords.filter(r => r.buyAt > cutoff);
  }

  _finalizeTradeRecord(state, reason) {
    const rec = this.tradeRecords.find(r =>
      r.address === state.address && r.exitAt === null
    );
    if (!rec) return;
    rec.exitAt     = Date.now();
    rec.exitReason = reason;
    rec.exitFdv    = state.fdv;
    rec.pnlPct     = state.pnlPct;
    // 用 pnlPct 和买入SOL反推卖出SOL
    if (state.pnlPct != null && rec.solSpent) {
      const pnl = parseFloat(state.pnlPct) / 100;
      rec.solReceived = +(rec.solSpent * (1 + pnl)).toFixed(4);
    }
  }

  // 每15分钟更新一次 currentFdv
  async _refreshTradeRecordFdv() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.tradeRecords = this.tradeRecords.filter(r => r.buyAt > cutoff);
    for (const rec of this.tradeRecords) {
      try {
        const overview = await birdeye.getTokenOverview(rec.address);
        if (overview) {
          rec.currentFdv   = overview.fdv ?? overview.mc ?? rec.currentFdv;
          rec.fdvUpdatedAt = Date.now();
        }
      } catch (_) {}
      await sleep(200);
    }
  }

  getTradeRecords() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.tradeRecords.filter(r => r.buyAt > cutoff);
  }

  _addTradeLog(entry) {
    const log = { id: Date.now(), time: new Date().toISOString(), ...entry };
    this.tradeLog.unshift(log);
    if (this.tradeLog.length > 200) this.tradeLog.length = 200;
    broadcastToClients({ type: 'trade_log', data: log });
  }

  _stateView(s) {
    const pos = s.position;
    return {
      address:       s.address,
      symbol:        s.symbol,
      age:           s.age,
      lp:            s.lp,
      fdv:           s.fdv,
      currentPrice:  s.currentPrice,
      entryPrice:    pos?.entryPriceUsd ?? null,
      peakPrice:     pos?.peakPriceUsd  ?? null,
      tokenBalance:  pos?.tokenBalance  ?? 0,
      pnlPct:        s.pnlPct,
      rsi:           isNaN(s.rsi) ? null : +s.rsi.toFixed(2),
      lastSignal:    s.lastSignal,
      candleCount:   s.candles.length,
      tickCount:     s.ticks.length,
      addedAt:       s.addedAt,
      bought:        s.bought,
      exitSent:      s.exitSent,
      inPosition:    s.inPosition,
      tradeCount:    s.tradeCount,
      recentCandles: s.candles.slice(-60),
    };
  }

  getDashboardData() {
    return {
      tokens:     [...this.tokens.values()].map(s => this._stateView(s)),
      tradeLog:   this.tradeLog.slice(0, 100),
      uptime:     process.uptime(),
      tokenCount: this.tokens.size,
    };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { TokenMonitor };
