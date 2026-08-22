import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
export const MODELS_DEV_TIMEOUT_MS = 30_000;
export const DEFAULT_MODELS_DEV_FILE = path.join(DATA_DIR, 'models.dev.json');

const providerRank = (id) => {
  const key = String(id || '').toLowerCase();
  if (key === 'opencode' || key === 'opencode-zen' || key === 'opencode_zen') return 0;
  if (key === 'opencode-go' || key.includes('opencode')) return 1;
  return 2;
};

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const bool = (value) => value === true;

function protocolValue(value) {
  const p = String(value ?? '').trim().toLowerCase();
  if (p === 'anthropic' || p === 'messages' || p === 'claude') return 'anthropic';
  if (p === 'responses' || p === 'response' || p === 'openai-responses') return 'responses';
  if (p === 'chat' || p === 'openai' || p === 'completions') return 'chat';
  return '';
}

function deprecatedOf(model) {
  if (bool(model?.deprecated)) return true;
  const status = String(model?.status ?? model?.lifecycle ?? '').toLowerCase();
  return ['deprecated', 'retired', 'disabled'].includes(status)
    || model?.deprecated_at != null || model?.retirement_date != null;
}

function normalizeModel(provider, key, model) {
  if (!model || typeof model !== 'object') return null;
  const id = String(model.id || key || '').trim();
  if (!id) return null;
  const cost = model.cost && typeof model.cost === 'object' ? model.cost : {};
  const limit = model.limit && typeof model.limit === 'object' ? model.limit : {};
  const modalities = model.modalities && typeof model.modalities === 'object' ? model.modalities : {};
  const explicit = protocolValue(model.protocol || model.native_protocol || model.api);
  return {
    id,
    provider,
    name: String(model.name || id),
    description: typeof model.description === 'string' ? model.description : '',
    contextWindow: number(limit.context),
    maxOutputTokens: number(limit.output),
    inputCost: number(cost.input),
    outputCost: number(cost.output),
    cacheReadCost: number(cost.cache_read ?? cost.cacheRead),
    cacheWriteCost: number(cost.cache_write ?? cost.cacheWrite),
    deprecated: deprecatedOf(model),
    reasoning: bool(model.reasoning),
    toolCall: bool(model.tool_call ?? model.toolCall),
    inputModalities: Array.isArray(modalities.input) ? modalities.input.map(String) : [],
    outputModalities: Array.isArray(modalities.output) ? modalities.output.map(String) : [],
    nativeProtocol: explicit || inferNativeProtocol({ id, name: model.name }, id),
    sourceUpdatedAt: model.last_updated || model.updated_at || null,
  };
}

/** Normalize the provider map returned by models.dev without copying its schema. */
export function normalizeModelsDev(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object') return out;
  const providers = Object.entries(raw).sort(([a], [b]) => providerRank(a) - providerRank(b) || a.localeCompare(b));
  for (const [provider, entry] of providers) {
    const models = entry?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [key, model] of Object.entries(models)) {
      const normalized = normalizeModel(provider, key, model);
      if (!normalized) continue;
      const exact = normalized.id.toLowerCase();
      if (!out.has(exact)) out.set(exact, normalized);
    }
  }
  return out;
}

const candidates = (id) => {
  const raw = String(id ?? '').trim().toLowerCase();
  if (!raw) return [];
  const out = [raw];
  const slash = raw.lastIndexOf('/');
  if (slash >= 0 && slash + 1 < raw.length) out.push(raw.slice(slash + 1));
  return [...new Set(out)];
};

export function findModelMetadata(map, id) {
  if (!(map instanceof Map)) return null;
  for (const key of candidates(id)) {
    if (map.has(key)) return map.get(key);
  }
  const wanted = candidates(id);
  for (const value of map.values()) {
    if (wanted.includes(String(value.id).toLowerCase())) return value;
    if (wanted.includes(String(value.id).toLowerCase().split('/').pop())) return value;
  }
  return null;
}

export function metadataFree(meta, id = '') {
  const name = `${id} ${meta?.id || ''} ${meta?.name || ''}`.toLowerCase();
  if (name.includes('free')) return true;
  return !!meta && !meta.deprecated && meta.inputCost === 0 && meta.outputCost === 0;
}

export function inferNativeProtocol(meta, id = '') {
  const explicit = protocolValue(meta?.nativeProtocol || meta?.protocol || meta?.api);
  if (explicit) return explicit;
  const value = String(meta?.id || id || meta?.name || '').toLowerCase();
  if (/^(claude[-_/]|anthropic[/_-])/.test(value) || value.includes('anthropic')) return 'anthropic';
  if (/^(gpt[-_/]|o[134](?:[-_/]|$)|grok[-_/]|muse[-_/])/.test(value)) return 'responses';
  return 'chat';
}

function cachePayload(updatedAt, models) {
  return { version: 1, updatedAt, models: Object.fromEntries(models) };
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (e) {
    // Windows cannot replace an existing file with rename; keep the replacement
    // recoverable and restore the old cache if the second rename fails.
    const backup = `${file}.replace`;
    try {
      if (fs.existsSync(file)) fs.renameSync(file, backup);
      fs.renameSync(temp, file);
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
    } catch (inner) {
      try { if (!fs.existsSync(file) && fs.existsSync(backup)) fs.renameSync(backup, file); } catch {}
      throw inner;
    } finally {
      try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch {}
    }
  }
  try { fs.chmodSync(file, 0o600); } catch {}
}

export class ModelMetadataStore {
  constructor({
    file = DEFAULT_MODELS_DEV_FILE,
    endpoint = MODELS_DEV_URL,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    logger = () => {},
  } = {}) {
    this.file = file;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.models = new Map();
    this.updatedAt = 0;
    this.lastError = '';
    this.inflight = null;
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const records = saved?.models;
      if (!records || typeof records !== 'object') return;
      this.models = new Map(Object.entries(records));
      this.updatedAt = Number(saved.updatedAt) || 0;
    } catch {}
  }

  status() {
    const age = this.updatedAt ? Math.max(0, this.now() - this.updatedAt) : Infinity;
    return {
      ready: this.models.size > 0,
      models: this.models.size,
      updatedAt: this.updatedAt || null,
      stale: age > MODELS_DEV_TTL_MS,
      nextRefresh: this.updatedAt ? this.updatedAt + MODELS_DEV_TTL_MS : null,
      lastError: this.lastError || null,
    };
  }

  get(id) { return findModelMetadata(this.models, id); }

  forModels(ids) {
    const out = {};
    for (const id of ids || []) {
      const meta = this.get(id);
      if (meta) out[id] = meta;
    }
    return out;
  }

  refresh({ force = false } = {}) {
    if (this.inflight) return this.inflight;
    if (!force && this.updatedAt && this.now() - this.updatedAt < MODELS_DEV_TTL_MS) {
      return Promise.resolve({ updated: false, reason: 'fresh', models: this.models.size });
    }
    if (typeof this.fetchImpl !== 'function') return Promise.reject(new Error('fetch is unavailable'));
    this.inflight = this.#refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.endpoint, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response?.ok) throw new Error(`models.dev HTTP ${response?.status ?? 0}`);
      const normalized = normalizeModelsDev(await response.json());
      if (!normalized.size) throw new Error('models.dev returned no models');
      const updatedAt = this.now();
      writeAtomic(this.file, cachePayload(updatedAt, normalized));
      this.models = normalized;
      this.updatedAt = updatedAt;
      this.lastError = '';
      return { updated: true, models: normalized.size, updatedAt };
    } catch (e) {
      this.lastError = e?.name === 'AbortError' ? 'models.dev timeout' : String(e?.message || e);
      this.logger('warn', `[models.dev] ${this.lastError}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
