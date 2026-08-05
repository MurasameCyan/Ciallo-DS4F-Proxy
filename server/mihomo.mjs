/**
 * mihomo.mjs —— 内核进程管理(Linux 容器版)。
 *
 * 与 desktop-app/mihomo.js 的不同:
 *
 * - 不再 detached + unref 然后靠 netstat 找 PID、taskkill 杀。容器里我们是
 *   1 号进程的孩子,句柄一直握着,停就是 SIGTERM,超时才 SIGKILL。
 *   顺带解决桌面版那个"getPid 永远返回 null"的空壳。
 * - stderr 不再写进文件等人去翻,直接喂给面板日志 —— 容器里日志文件没人看得见。
 * - 就绪判定改成问控制端口 /version,而不是 TCP 连得上 mixed-port。
 *   端口 listen 了不代表配置加载完,провider 还在拉的时候连上去也是白连。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import { MIHOMO_BIN, MIHOMO_CONFIG, MIHOMO_DATA_DIR, CTRL_PORT } from './config.mjs';

let child = null;
let lastErr = '';

export function isSpawned() {
  return !!child && child.exitCode === null;
}

/** 问控制端口要版本号;拿不到就是还没就绪 */
export function getVersion() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: CTRL_PORT, path: '/version', method: 'GET', timeout: 2000 },
      (resp) => {
        let d = '';
        resp.on('data', (c) => (d += c));
        resp.on('end', () => {
          try { resolve(JSON.parse(d).version || null); } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

export async function isRunning() {
  return (await getVersion()) !== null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function start(logger) {
  if (await isRunning()) {
    logger('info', '[mihomo] 已在运行');
    return true;
  }
  if (!fs.existsSync(MIHOMO_BIN)) throw new Error(`找不到 mihomo 内核: ${MIHOMO_BIN}`);
  if (!fs.existsSync(MIHOMO_CONFIG)) throw new Error('还没有 mihomo 配置 —— 先填订阅地址');

  fs.mkdirSync(MIHOMO_DATA_DIR, { recursive: true });
  logger('info', '[mihomo] 启动中...');
  lastErr = '';

  child = spawn(MIHOMO_BIN, ['-d', MIHOMO_DATA_DIR, '-f', MIHOMO_CONFIG], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const feed = (level) => (buf) => {
    for (const line of buf.toString().split('\n')) {
      const s = line.trim();
      if (!s) continue;
      if (level === 'error') lastErr = s;
      logger(level, `[mihomo] ${s}`);
    }
  };
  child.stdout.on('data', feed('info'));
  child.stderr.on('data', feed('error'));

  // 闭包里捏住这一个进程。直接读模块级的 child 会串:重启时旧进程的 exit
  // 往往在新进程 spawn 之后才到,那时把 child 清成 null 会把刚起来的新进程
  // 句柄丢掉 —— 之后 stop() 就杀不掉它了。
  const self = child;
  self.on('exit', (code, signal) => {
    if (child === self) child = null;
    // stop() 要的退出不用报警
    if (!self.__stopping) logger('error', `[mihomo] 进程退出 code=${code} signal=${signal}`);
  });

  // 首次要拉订阅,给足 30 秒
  for (let waited = 0; waited < 30_000; waited += 500) {
    if (!isSpawned()) throw new Error(`mihomo 启动即退出${lastErr ? ': ' + lastErr : '(多半是订阅拉不下来或格式不对)'}`);
    if (await isRunning()) {
      logger('ok', `[mihomo] 已启动 (PID ${self.pid})`);
      return true;
    }
    await sleep(500);
  }
  await stop(logger);
  throw new Error(`mihomo 启动超时${lastErr ? ': ' + lastErr : ''}`);
}

export async function stop(logger) {
  if (!isSpawned()) {
    child = null;
    return true;
  }
  const proc = child;
  proc.__stopping = true;
  proc.kill('SIGTERM');

  for (let waited = 0; waited < 5000; waited += 200) {
    if (proc.exitCode !== null || proc.signalCode !== null) break;
    await sleep(200);
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    logger('warn', '[mihomo] SIGTERM 没反应,改用 SIGKILL');
    proc.kill('SIGKILL');
    await sleep(300);
  }
  child = null;
  logger('ok', '[mihomo] 已停止');
  return true;
}

export async function restart(logger) {
  await stop(logger);
  await sleep(300);
  return start(logger);
}
