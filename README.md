# SOL RSI Monitor v5

Solana 新币 RSI(7) 策略监控 + Jupiter 自动交易机器人。

5秒K线 · 1秒价格轮询 · 15分钟监控窗口 · RSI超买超卖交易 · 防夹保护

---

## 策略逻辑

### 买入条件

```
扫描服务器发送代币到白名单
→ 开始 15 分钟监控期
→ 1秒轮询价格，聚合 5 秒 K 线
→ RSI(7) 上穿 30 时买入（前一根 RSI ≤ 30，当前 RSI > 30）
```

### 卖出条件

| 优先级 | 条件 | 行为 |
| --- | --- | --- |
| 1 | RSI(7) > 80 | 立即全仓卖出 |
| 2 | RSI(7) 下穿 70（前一根 ≥ 70，当前 < 70） | 全仓卖出 |
| 3 | 涨幅 ≥ +50% | 止盈卖出 |
| 4 | 跌幅 ≤ -15% | 止损卖出 |
| 5 | FDV 跌破 $10,000 | 立即清仓退出 |
| 6 | 监控 15 分钟到期 | 清仓退出，移除白名单 |

### 仓位管理

| 情况 | 行为 |
| --- | --- |
| 第一笔交易盈利 | 不再开仓，立即退出监控 |
| 第一笔交易亏损 | 允许再开一次仓 |
| 第二笔交易（无论盈亏） | 不再开仓，退出监控 |
| 最多开仓次数 | 2 次 |

* **5秒K线聚合**：1秒轮询采集价格，每5秒聚合一根K线
* **RSI预热**：RSI(7) 需要至少 9 根K线（约45秒）才能计算
* **不再收录即买**：收到代币后等待 RSI 信号再买入

---

## 目录结构

```
sol-rsi-v5/
├── src/
│   ├── index.js        # 主入口，HTTP + WebSocket
│   ├── monitor.js      # 核心引擎（1s轮询、5sK线、RSI信号 + 仓位管理）
│   ├── rsi.js          # RSI计算 + BUY/SELL信号
│   ├── trader.js       # Jupiter交易（买入/卖出）
│   ├── birdeye.js      # Birdeye API封装
│   ├── reporter.js     # 每日报告
│   ├── wsHub.js        # WebSocket广播
│   ├── logger.js       # 日志
│   └── routes/
│       ├── webhook.js  # POST /webhook/add-token
│       └── dashboard.js# REST API
├── public/
│   ├── index.html      # 实时Dashboard
│   └── stats.html      # 24h交易统计
├── .env.example
├── deploy.sh
└── package.json
```

---

## 快速部署

### 1. 上传代码到服务器

```
scp -r sol-rsi-v5/ ubuntu@YOUR_SERVER_IP:~/
ssh ubuntu@YOUR_SERVER_IP
cd ~/sol-rsi-v5
```

### 2. 一键部署

```
bash deploy.sh
```

### 3. 填写配置

```
nano .env
```

**必填项：**

```
BIRDEYE_API_KEY=       # Birdeye API Key
HELIUS_RPC_URL=        # https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=        # Helius API Key
WALLET_PRIVATE_KEY=    # 钱包Base58私钥（仅用于签名，不存储）
TRADE_SIZE_SOL=0.2     # 每笔交易买入的SOL数量
```

```
sudo systemctl restart sol-ema-monitor
```

### 4. 开放端口

```
sudo ufw allow 3001/tcp
```

### 5. 访问 Dashboard

```
http://YOUR_SERVER_IP:3001
```

---

## 防夹（Anti-Sandwich）机制

1. **Jito MEV保护**（`USE_JITO=true`）：交易打包进Jito bundle，绕过公共mempool
2. **优先费**（`PRIORITY_FEE_MICROLAMPORTS=100000`）：确保交易被优先打包
3. **Jito Tip**（`JITO_TIP_LAMPORTS=1000000` ≈ 0.001 SOL）：支付给Jito验证者
4. **双倍滑点卖出**：卖出时slippage翻倍（最大20%），确保卖出单成交

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BIRDEYE_API_KEY` | — | Birdeye API Key（必填） |
| `HELIUS_RPC_URL` | — | Helius私有RPC URL（必填） |
| `HELIUS_API_KEY` | — | Helius API Key（必填） |
| `JUPITER_API_URL` | `https://api.jup.ag` | Jupiter API |
| `JUPITER_API_KEY` | — | Jupiter API Key |
| `WALLET_PRIVATE_KEY` | — | 交易钱包Base58私钥（必填） |
| `TRADE_SIZE_SOL` | `0.2` | 每笔买入SOL数量 |
| `SLIPPAGE_BPS` | `300` | 滑点（100=1%） |
| `TOKEN_MAX_AGE_MINUTES` | `15` | 监控窗口（分钟） |
| `FDV_EXIT_USD` | `10000` | FDV低于此值自动退出 |
| `RSI_PERIOD` | `7` | RSI 周期 |
| `RSI_BUY_LEVEL` | `30` | RSI 上穿此值买入 |
| `RSI_SELL_LEVEL` | `70` | RSI 下穿此值卖出 |
| `RSI_PANIC_LEVEL` | `80` | RSI 超过此值立即卖出 |
| `PRICE_POLL_SEC` | `1` | 价格轮询间隔（秒） |
| `KLINE_INTERVAL_SEC` | `5` | K线宽度（秒） |
| `PORT` | `3001` | HTTP端口 |

---

## API

```
# 添加代币（来自扫描服务器）
curl -X POST http://YOUR_SERVER:3001/webhook/add-token \
  -H "Content-Type: application/json" \
  -d '{"network":"solana","address":"TOKEN_ADDRESS","symbol":"TOKEN_SYMBOL"}'

# 查询接口
curl http://YOUR_SERVER:3001/api/dashboard
curl http://YOUR_SERVER:3001/api/tokens
curl http://YOUR_SERVER:3001/api/trades
curl http://YOUR_SERVER:3001/api/trade-records

# 手动移除（有持仓自动卖出）
curl -X DELETE http://YOUR_SERVER:3001/api/tokens/TOKEN_ADDRESS
```

---

## 常见问题

**Q: RSI显示 WARMING UP？**
A: 正常。RSI(7) 需要至少 9 根 5秒K线（约45秒）才能计算。预热期内不会触发任何买卖信号。

**Q: 为什么收到代币后不立即买入？**
A: v5 改用 RSI 策略，不再"收录即买"。收到代币后开始监控，等待 RSI 上穿 30 的信号才买入。如果15分钟内没有出现买入信号，代币会被移除。

**Q: 最多会买卖几次？**
A: 最多2次。第一次盈利则直接退出；第一次亏损允许再开一次，第二次结束后无论盈亏都退出。

**Q: 交易失败怎么处理？**
A: trader.js 内置动态滑点重试（最多3次，滑点每次×1.5，上限20%）。

**Q: 如何查看RSI实时状态？**
A: 日志中每次轮询都会打印 `[RSI]` 行，包含 RSI 值和信号状态。使用 `journalctl -u sol-ema-monitor -f` 实时查看。

---

## 与 v4 (EMA) 的区别

| 对比项 | v4 (EMA) | v5 (RSI) |
| --- | --- | --- |
| 策略 | EMA9/EMA20 死叉 | RSI(7) 超买超卖 |
| K线周期 | 15秒 | 5秒 |
| 买入方式 | 收录即买 | RSI 上穿30买入 |
| 卖出条件 | EMA死叉 + FDV止损 | RSI下穿70 / RSI>80 / +50%止盈 / -15%止损 |
| 监控时长 | 30分钟 | 15分钟 |
| 仓位管理 | 一次买卖 | 最多2次（首笔盈利退出，首笔亏损再开一次） |
| FDV门槛 | $15,000~$60,000 | 低于 $10,000 退出 |
