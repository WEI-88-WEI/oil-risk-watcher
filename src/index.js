#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = process.cwd();
const configPath = path.join(rootDir, 'config.json');
const args = new Set(process.argv.slice(2));

function nowIso() {
  return new Date().toISOString();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function appendLog(logFile, message) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `[${nowIso()}] ${message}\n`);
}

function loadConfig() {
  const config = readJson(configPath, null);
  if (!config) throw new Error(`Missing config: ${configPath}`);
  config.stateFile = path.resolve(rootDir, config.stateFile);
  config.logFile = path.resolve(rootDir, config.logFile);
  config.dataSource ??= { provider: 'hyperliquid', endpoint: 'https://api.hyperliquid.xyz/info', dex: 'xyz' };
  return config;
}

async function fetchQuotesHyperliquid(config, symbols, timeoutMs) {
  const endpoint = config.dataSource?.endpoint || 'https://api.hyperliquid.xyz/info';
  const dex = config.dataSource?.dex || 'xyz';
  const py = [
    'import json, sys, urllib.request',
    'endpoint = sys.argv[1]',
    'symbols = json.loads(sys.argv[2])',
    'timeout = float(sys.argv[3]) / 1000.0',
    'dex = sys.argv[4]',
    'headers = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 OilRiskWatcher/1.0"}',
    'def post(payload):',
    '    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), headers=headers)',
    '    with urllib.request.urlopen(req, timeout=timeout) as r:',
    '        return json.load(r)',
    'meta = post({"type": "meta", "dex": dex})',
    'mids = post({"type": "allMids", "dex": dex})',
    'valid = {item["name"] for item in meta["universe"]}',
    'out = {}',
    'for symbol in symbols:',
    '    if symbol in valid and symbol in mids:',
    '        out[symbol] = {"symbol": symbol, "price": float(mids[symbol]), "currency": "USD", "marketTime": None}',
    'print(json.dumps(out))'
  ].join('\n');

  const { stdout } = await execFileAsync('python3', ['-c', py, endpoint, JSON.stringify(symbols), String(timeoutMs), String(dex)], {
    cwd: rootDir,
    timeout: Math.max(30000, timeoutMs * 3),
    maxBuffer: 1024 * 1024
  });
  const raw = JSON.parse(stdout || '{}');
  const map = new Map();
  for (const [symbol, item] of Object.entries(raw)) {
    map.set(symbol, {
      symbol,
      price: item.price,
      currency: item.currency ?? null,
      marketTime: item.marketTime ?? null
    });
  }
  return map;
}

async function fetchQuotes(config, symbols, timeoutMs) {
  const provider = config.dataSource?.provider || 'hyperliquid';
  if (provider === 'hyperliquid') {
    return fetchQuotesHyperliquid(config, symbols, timeoutMs);
  }
  throw new Error(`Unsupported data source provider: ${provider}`);
}

function initState(config) {
  const state = readJson(config.stateFile, {});
  state.symbols ??= {};
  return state;
}

function getZone({ price, liquidationPrice, direction, warnDistance, dangerDistance }) {
  if (direction === 'up') {
    if (price >= liquidationPrice - dangerDistance) return 'danger3';
    if (price >= liquidationPrice - warnDistance) return 'warn5';
    return 'safe';
  }
  if (price <= liquidationPrice + dangerDistance) return 'danger3';
  if (price <= liquidationPrice + warnDistance) return 'warn5';
  return 'safe';
}

function getDistance({ price, liquidationPrice, direction }) {
  return direction === 'up' ? liquidationPrice - price : price - liquidationPrice;
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(2) : String(value);
}

function buildMessage({ prefix, level, label, symbol, price, liquidationPrice, distance, direction, marketTime, repeated }) {
  const status = level === 'danger3' ? '三级危险' : '一级预警';
  const icon = level === 'danger3' ? '🛑' : '⚠️';
  const directionText = direction === 'up' ? '上涨逼近' : '下跌逼近';
  const repeatText = repeated ? '\n- 持续提醒：是' : '';
  return `${prefix}\n${icon} ${status} · ${label} (${symbol})\n- 当前价：${formatNumber(price)}\n- 爆仓价：${formatNumber(liquidationPrice)}\n- 距离爆仓：${formatNumber(distance)}\n- 方向：${directionText}${repeatText}\n- 行情时间：${marketTime ?? 'hyperliquid realtime'}\n- 发送时间：${nowIso()}`;
}

async function sendTelegramDirect(botToken, target, message, silent = false) {
  const py = [
    'import json, sys, urllib.request',
    'token=sys.argv[1]',
    'target=sys.argv[2]',
    'message=sys.argv[3]',
    'silent=sys.argv[4].lower()=="true"',
    'url=f"https://api.telegram.org/bot{token}/sendMessage"',
    'payload=json.dumps({"chat_id": target, "text": message, "disable_notification": silent}).encode()',
    'req=urllib.request.Request(url, data=payload, headers={"Content-Type":"application/json"})',
    'with urllib.request.urlopen(req, timeout=20) as r:\n    data=json.load(r)\n    print(json.dumps(data))\n    if not data.get("ok"):\n        raise SystemExit(1)'
  ].join('\n');
  const { stdout } = await execFileAsync('python3', ['-c', py, botToken, String(target), message, String(!!silent)], {
    cwd: rootDir,
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout || '{}');
}

async function sendMessage(config, message) {
  if (config.notify.channel === 'telegram' && config.notify.telegramBotToken) {
    return sendTelegramDirect(config.notify.telegramBotToken, config.notify.target, message, config.notify.silent);
  }
  const args = ['message', 'send', '--channel', config.notify.channel, '--target', config.notify.target, '--message', message];
  if (config.notify.account) args.push('--account', config.notify.account);
  if (config.notify.silent) args.push('--silent');
  const { stdout, stderr } = await execFileAsync('openclaw', args, { cwd: rootDir, timeout: 30000 });
  return { stdout, stderr };
}

async function sendTestAlert(config) {
  const msg = `${config.notify.prefix}\n🧪 测试提醒\n- 服务通知链路正常\n- 时间：${nowIso()}`;
  await sendMessage(config, msg);
  appendLog(config.logFile, 'Sent test alert');
}

async function runOnce({ stdout = false, forceTestAlert = false } = {}) {
  const config = loadConfig();
  const state = initState(config);

  if (forceTestAlert) {
    await sendTestAlert(config);
    return { mode: 'test-alert' };
  }

  const symbols = Object.keys(config.symbols);
  const quotes = await fetchQuotes(config, symbols, config.timing.fetchTimeoutMs);
  const summary = [];
  let anyDanger = false;

  for (const symbol of symbols) {
    const quote = quotes.get(symbol);
    if (!quote) {
      appendLog(config.logFile, `Missing quote for ${symbol}`);
      summary.push({ symbol, error: 'missing quote' });
      continue;
    }

    const meta = config.symbols[symbol];
    const entry = state.symbols[symbol] ?? {
      zone: 'safe',
      lastWarnNotifiedAt: 0,
      lastDangerNotifiedAt: 0,
      lastPrice: null,
      lastFetchedAt: null
    };

    const zone = getZone({
      price: quote.price,
      liquidationPrice: meta.liquidationPrice,
      direction: meta.direction,
      warnDistance: config.thresholds.warnDistance,
      dangerDistance: config.thresholds.dangerDistance
    });
    const distance = getDistance({ price: quote.price, liquidationPrice: meta.liquidationPrice, direction: meta.direction });
    const now = Date.now();
    let sent = false;

    if (zone === 'danger3') {
      anyDanger = true;
      const shouldSend = entry.zone !== 'danger3' || now - (entry.lastDangerNotifiedAt || 0) >= config.timing.dangerRepeatMs;
      if (shouldSend) {
        const message = buildMessage({
          prefix: config.notify.prefix,
          level: zone,
          label: meta.label,
          symbol,
          price: quote.price,
          liquidationPrice: meta.liquidationPrice,
          distance,
          direction: meta.direction,
          marketTime: quote.marketTime,
          repeated: entry.zone === 'danger3'
        });
        await sendMessage(config, message);
        entry.lastDangerNotifiedAt = now;
        sent = true;
      }
    } else if (zone === 'warn5') {
      const shouldSend = entry.zone === 'safe' || (entry.zone === 'warn5' && now - (entry.lastWarnNotifiedAt || 0) >= config.timing.warnCooldownMs);
      if (shouldSend) {
        const message = buildMessage({
          prefix: config.notify.prefix,
          level: zone,
          label: meta.label,
          symbol,
          price: quote.price,
          liquidationPrice: meta.liquidationPrice,
          distance,
          direction: meta.direction,
          marketTime: quote.marketTime,
          repeated: entry.zone === 'warn5'
        });
        await sendMessage(config, message);
        entry.lastWarnNotifiedAt = now;
        sent = true;
      }
    }

    entry.zone = zone;
    entry.lastPrice = quote.price;
    entry.lastFetchedAt = nowIso();
    state.symbols[symbol] = entry;
    summary.push({ symbol, price: quote.price, zone, distance, sent });
  }

  state.meta = {
    lastRunAt: nowIso(),
    nextPollMs: anyDanger ? config.timing.dangerPollMs : config.timing.normalPollMs
  };
  writeJson(config.stateFile, state);
  appendLog(config.logFile, `Run complete: ${JSON.stringify(summary)}`);
  if (stdout) process.stdout.write(JSON.stringify({ summary, nextPollMs: state.meta.nextPollMs }, null, 2) + '\n');
  return { summary, nextPollMs: state.meta.nextPollMs };
}

async function loop() {
  while (true) {
    try {
      const result = await runOnce();
      await new Promise((resolve) => setTimeout(resolve, result.nextPollMs));
    } catch (error) {
      const config = loadConfig();
      const message = `Watcher error: ${error?.stack || error}`;
      appendLog(config.logFile, message);
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }
}

if (args.has('--test-alert')) {
  await runOnce({ forceTestAlert: true });
} else if (args.has('--once') || args.has('--stdout')) {
  await runOnce({ stdout: args.has('--stdout') });
} else {
  await loop();
}
