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
 *   端口 listen 了不代表配置加载完,provider 还在拉的时候连上去也是白连。
 *
 * 多 lane:每个出站 lane 对应一个独立 mihomo 进程。主 lane 常驻(默认端口
 * 17897/19090),子 lane 按需拉起、空闲回收,各占一个 mixed-port 和一个
 * external-controller 端口、一份独立数据目录,互不抢 cache.db 锁。
 * 模块级 start/stop/restart/getVersion 仍是主实例的便捷封装,index.mjs 照旧。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import { MIHOMO_BIN, MIHOMO_CONFIG, MIHOMO_DATA_DIR, CTRL_PORT } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 问控制端口要版本号;拿不到就是还没就绪 */
export function probeVersion(ctrlPort) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: ctrlPort, path: '/version', method: 'GET', timeout: 2000 },
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

/**
 * 一个独立 mihomo 进程。主 lane 和每个子 lane 各持有一个实例。
 * label 只用于日志前缀,方便把主/子 lane 的 stdout 区分开。
 */
export class MihomoInstance {
  constructor({ bin = MIHOMO_BIN, configFile, dataDir, ctrlPort, label = 'mihomo' } = {}) {
    if (!configFile || !dataDir || !ctrlPort) {
      throw new TypeError('MihomoInstance 需要 configFile / dataDir / ctrlPort');
    }
    this.bin = bin;
    this.configFile = configFile;
    this.dataDir = dataDir;
    this.ctrlPort = ctrlPort;
    this.label = label;
    this.child = null;
    this.lastErr = '';
  }

  isSpawned() {
    return !!this.child && this.child.exitCode === null;
  }

  getVersion() {
    return probeVersion(this.ctrlPort);
  }

  async isRunning() {
    return (await this.getVersion()) !== null;
  }

  async start(logger) {
    if (await this.isRunning()) {
      logger('info', `[${this.label}] 已在运行`);
      return true;
    }
    if (!fs.existsSync(this.bin)) throw new Error(`找不到 mihomo 内核: ${this.bin}`);
    if (!fs.existsSync(this.configFile)) throw new Error('还没有 mihomo 配置 —— 先填订阅地址');

    fs.mkdirSync(this.dataDir, { recursive: true });
    logger('info', `[${this.label}] 启动中...`);
    this.lastErr = '';

    const child = spawn(this.bin, ['-d', this.dataDir, '-f', this.configFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const feed = (level) => (buf) => {
      for (const line of buf.toString().split('\n')) {
        const s = line.trim();
        if (!s) continue;
        if (level === 'error') this.lastErr = s;
        logger(level, `[${this.label}] ${s}`);
      }
    };
    child.stdout.on('data', feed('info'));
    child.stderr.on('data', feed('error'));

    // 闭包里捏住这一个进程。读 this.child 会串:重启时旧进程的 exit
    // 往往在新进程 spawn 之后才到,那时把 child 清成 null 会把刚起来的新进程
    // 句柄丢掉 —— 之后 stop() 就杀不掉它了。
    const self = child;
    self.on('exit', (code, signal) => {
      if (this.child === self) this.child = null;
      // stop() 要的退出不用报警
      if (!self.__stopping) logger('error', `[${this.label}] 进程退出 code=${code} signal=${signal}`);
    });

    // 首次要拉订阅,给足 30 秒
    for (let waited = 0; waited < 30_000; waited += 500) {
      if (!this.isSpawned()) throw new Error(`${this.label} 启动即退出${this.lastErr ? ': ' + this.lastErr : '(多半是订阅拉不下来或格式不对)'}`);
      if (await this.isRunning()) {
        logger('ok', `[${this.label}] 已启动 (PID ${self.pid})`);
        return true;
      }
      await sleep(500);
    }
    await this.stop(logger);
    throw new Error(`${this.label} 启动超时${this.lastErr ? ': ' + this.lastErr : ''}`);
  }

  async stop(logger) {
    if (!this.isSpawned()) {
      this.child = null;
      return true;
    }
    const proc = this.child;
    proc.__stopping = true;
    proc.kill('SIGTERM');

    for (let waited = 0; waited < 5000; waited += 200) {
      if (proc.exitCode !== null || proc.signalCode !== null) break;
      await sleep(200);
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      logger('warn', `[${this.label}] SIGTERM 没反应,改用 SIGKILL`);
      proc.kill('SIGKILL');
      await sleep(300);
    }
    this.child = null;
    logger('ok', `[${this.label}] 已停止`);
    return true;
  }

  async restart(logger) {
    await this.stop(logger);
    await sleep(300);
    return this.start(logger);
  }
}

/** 主 lane 实例:默认端口、默认配置和数据目录,常驻。 */
export const main = new MihomoInstance({
  configFile: MIHOMO_CONFIG,
  dataDir: MIHOMO_DATA_DIR,
  ctrlPort: CTRL_PORT,
});

export function isSpawned() { return main.isSpawned(); }
export function getVersion() { return main.getVersion(); }
export function isRunning() { return main.isRunning(); }
export function start(logger) { return main.start(logger); }
export function stop(logger) { return main.stop(logger); }
export function restart(logger) { return main.restart(logger); }
