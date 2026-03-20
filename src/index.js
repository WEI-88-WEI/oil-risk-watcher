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
  return config;
}

async function fetchQuotes(symbols, timeoutMs) {
  const map = new Map();

  for (const symbol of symbols) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 OilRiskWatcher/1.0' },
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${symbol}`);
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      if (typeof price === 'number') {
        map.set(symbol, {
          symbol,
          price,
          currency: meta?.currency ?? null,
          marketTime: meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return map;
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
  return `${prefix}\n${icon} ${status} · ${label} (${symbol})\n- 当前价：${formatNumber(price)}\n- 爆仓价：${formatNumber(liquidationPrice)}\n- 距离爆仓：${formatNumber(distance)}\n- 方向：${directionText}${repeatText}\n- 行情时间：${marketTime ?? 'unknown'}\n- 发送时间：${nowIso()}`;
}

async function sendMessage(config, message) {
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
  const quotes = await fetchQuotes(symbols, config.timing.fetchTimeoutMs);
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
