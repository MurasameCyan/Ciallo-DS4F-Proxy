/**
 * 免费模型的低成本连通性缓存。
 *
 * 这和 capabilities.mjs 的能力探测是两件事:这里只问「这个模型现在能不能
 * 接受一个最小请求」,不猜上下文或思考档位。结果默认六小时有效,并发调用
 * 共用同一轮探测,避免面板轮询把同一模型重复打出去。
 */

import { classifyUpstreamError, upstreamErrorMessage } from './upstream-errors.mjs';

export const MODEL_AVAILABILITY_TTL_MS = 6 * 60 * 60 * 1000;
export const MODEL_AVAILABILITY_RETRY_MS = 60 * 1000;
export const MODEL_AVAILABILITY_STATES = Object.freeze([
  'unknown', 'probing', 'available', 'unavailable',
]);

const normalizeModels = (models) => [...new Set(
  (Array.isArray(models) ? models : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean),
)];

/**
 * 探针失败时把业务 4xx（包括模型下线、鉴权/额度/端点错误）记成
 * unavailable; 429、网络错误、408、5xx 都是临时状态,先保留 unknown,
 * 下一轮六小时探测再确认,不能据此把模型灰掉六小时。
 */
export function classifyAvailabilityError(error) {
  const status = Number(error?.status) || 0;
  const kind = classifyUpstreamError(status, error?.body);
  const unavailable = kind === 'terminal' || kind === 'model_unavailable';
  return {
    status: unavailable ? 'unavailable' : 'unknown',
    kind,
    statusCode: status || null,
    message: upstreamErrorMessage(error?.body) || String(error?.message || 'probe failed'),
  };
}

const copyError = (error) => error ? {
  kind: error.kind,
  status: error.statusCode ?? null,
  message: error.message,
} : null;

export class ModelAvailability {
  constructor({
    post, logger = () => {}, now = () => Date.now(),
    ttlMs = MODEL_AVAILABILITY_TTL_MS, retryMs = MODEL_AVAILABILITY_RETRY_MS,
  }) {
    if (typeof post !== 'function') throw new TypeError('ModelAvailability.post must be a function');
    this.post = post;
    this.logger = logger;
    this.now = now;
    this.ttlMs = ttlMs;
    this.retryMs = retryMs;
    this.records = new Map();
    this.running = null;
    this.scheduler = null;
    this.timer = null;
  }

  _due(record, at = this.now()) {
    if (record?.nextTryAt != null) return at >= record.nextTryAt;
    return !record || record.checkedAt == null || at - record.checkedAt >= this.ttlMs;
  }

  /** 是否有模型需要一轮新的探测。 */
  needsProbe(models) {
    const at = this.now();
    return normalizeModels(models).some((id) => this._due(this.records.get(id), at));
  }

  _snapshot(models) {
    const at = this.now();
    const out = {};
    for (const id of normalizeModels(models)) {
      const record = this.records.get(id);
      if (!record || (record.status !== 'probing' && this._due(record, at))) {
        out[id] = {
          status: 'unknown',
          checkedAt: record?.checkedAt ?? null,
          error: copyError(record?.error),
        };
        continue;
      }
      out[id] = {
        status: record.status,
        checkedAt: record.checkedAt ?? null,
        error: copyError(record.error),
      };
    }
    return out;
  }

  /** 给 /api/status 用的只读快照,只返回请求中的当前清单。 */
  status(models) {
    return this._snapshot(models);
  }

  /** 测试或模型清单变化时让某个模型立即进入 unknown。 */
  expire(model) {
    const id = String(model ?? '').trim();
    const record = this.records.get(id);
    if (record) {
      record.checkedAt = null;
      record.nextTryAt = null;
    }
  }

  markUnavailable(model, error = { status: 400, body: 'Model is unavailable' }) {
    const id = String(model ?? '').trim();
    if (!id) return;
    const classified = classifyAvailabilityError(error);
    // 只有明确的 unavailable 才允许这个快捷入口改状态。
    if (classified.status !== 'unavailable') return;
    this.records.set(id, {
      status: 'unavailable',
      checkedAt: this.now(),
      error: classified,
      nextTryAt: null,
    });
  }

  /**
   * 探测当前清单。一个实例同一时间只跑一轮;第二个调用直接拿第一轮 Promise。
   * 每个模型使用一个极小的非流式请求,并且严格串行,适配单节点出站。
   */
  probe(models) {
    const ids = normalizeModels(models);
    if (this.running) return this.running;
    const at = this.now();
    const due = ids.filter((id) => this._due(this.records.get(id), at));
    if (!due.length) return Promise.resolve(this._snapshot(ids));

    for (const id of due) {
      const previous = this.records.get(id);
      this.records.set(id, {
        status: 'probing',
        checkedAt: previous?.checkedAt ?? null,
        error: null,
      });
    }

    this.running = this._run(due, ids).finally(() => { this.running = null; });
    return this.running;
  }

  async _run(due, ids) {
    for (const model of due) {
      try {
        await this.post({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        });
        this.records.set(model, { status: 'available', checkedAt: this.now(), error: null, nextTryAt: null });
        this.logger('info', `[availability] ${model} 可用`);
      } catch (error) {
        const classified = classifyAvailabilityError(error);
        this.records.set(model, {
          status: classified.status,
          checkedAt: this.now(),
          error: classified,
          nextTryAt: null,
        });
        this.logger(
          classified.status === 'unavailable' ? 'warn' : 'info',
          `[availability] ${model} ${classified.status}: ${classified.kind}`,
        );
      }
    }
    return this._snapshot(ids);
  }

  /**
   * 启动六小时后台轮询。getModels 返回当前清单, canProbe 可用于等待 mihomo
   * 节点就绪。定时器 unref,不会阻止测试进程或优雅退出。
   */
  startScheduler(getModels, { canProbe = () => true, immediate = true } = {}) {
    if (typeof getModels !== 'function') throw new TypeError('getModels must be a function');
    this.stopScheduler();
    const state = { stopped: false };
    this.scheduler = state;
    const tick = async () => {
      if (state.stopped) return;
      let delay = this.ttlMs;
      try {
        const models = normalizeModels(await getModels());
        if (models.length && await canProbe(models)) {
          await this.probe(models);
          delay = this.nextDelay(models);
        } else if (models.length) {
          // 没有出站节点时短暂重试,节点恢复后无需等满六小时。
          delay = this.retryMs;
        }
      } catch (error) {
        this.logger('info', `[availability] 定时探测跳过: ${error?.message || error}`);
        delay = this.retryMs;
      } finally {
        if (!state.stopped) {
          this.timer = setTimeout(tick, Math.max(1000, delay));
          this.timer.unref?.();
        }
      }
    };
    this.timer = setTimeout(tick, immediate ? 0 : this.ttlMs);
    this.timer.unref?.();
    return this;
  }

  stopScheduler() {
    if (this.scheduler) this.scheduler.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.scheduler = null;
    this.timer = null;
  }

  schedulerStatus() {
    return {
      running: !!this.running,
      scheduled: !!this.scheduler,
      ttlMs: this.ttlMs,
    };
  }

  /** 返回当前清单中最早需要重试的时间,供后台调度避免无谓唤醒或长等待。 */
  nextDelay(models) {
    const ids = normalizeModels(models);
    if (!ids.length) return this.ttlMs;
    const at = this.now();
    let delay = this.ttlMs;
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) return 0;
      const dueAt = record.nextTryAt != null
        ? record.nextTryAt
        : (record.checkedAt ?? at) + this.ttlMs;
      delay = Math.min(delay, Math.max(0, dueAt - at));
    }
    return delay;
  }
}
