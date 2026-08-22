import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ModelMetadataStore,
  normalizeModelsDev,
  findModelMetadata,
  inferNativeProtocol,
  metadataFree,
} from '../server/model-metadata.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ciallo-model-meta-'));
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const payload = {
  opencode: {
    name: 'OpenCode Zen',
    models: {
      'deepseek-v4-flash-free': {
        id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free',
        limit: { context: 200000, output: 128000 },
        cost: { input: 0, output: 0, cache_read: 0 },
        modalities: { input: ['text'], output: ['text'] },
        reasoning: true, tool_call: true,
      },
      'claude-opus-4-7': {
        name: 'Claude Opus', limit: { context: 1000000 },
        cost: { input: 5, output: 25 }, modalities: { input: ['text', 'image'], output: ['text'] },
        reasoning: true, tool_call: true, status: 'deprecated',
      },
    },
  },
  'opencode-go': {
    name: 'OpenCode Go',
    models: {
      // Duplicate should not overwrite the Zen record.
      'deepseek-v4-flash-free': { limit: { context: 999 }, cost: { input: 9, output: 9 } },
      'qwen3.7-max': { id: 'qwen3.7-max', name: 'Qwen', limit: { context: 1000000 }, cost: { input: 2, output: 7 } },
    },
  },
};

await t('normalizeModelsDev 按 OpenCode provider 优先合并模型', () => {
  const map = normalizeModelsDev(payload);
  assert.equal(map.get('deepseek-v4-flash-free').contextWindow, 200000);
  assert.equal(map.get('deepseek-v4-flash-free').provider, 'opencode');
  assert.equal(map.get('qwen3.7-max').outputCost, 7);
  assert.deepEqual(map.get('deepseek-v4-flash-free').inputModalities, ['text']);
});

await t('findModelMetadata 支持大小写、free 后缀和 provider 前缀匹配', () => {
  const map = normalizeModelsDev(payload);
  assert.equal(findModelMetadata(map, 'DEEPSEEK-V4-FLASH-FREE').name, 'DeepSeek V4 Flash Free');
  assert.equal(findModelMetadata(map, 'opencode/deepseek-v4-flash-free').id, 'deepseek-v4-flash-free');
  assert.equal(findModelMetadata(map, 'qwen3.7-max').id, 'qwen3.7-max');
  assert.equal(findModelMetadata(map, 'missing'), null);
});

await t('metadataFree 需要双零成本且不能弃用,名称 free 可作为兜底', () => {
  const map = normalizeModelsDev(payload);
  assert.equal(metadataFree(findModelMetadata(map, 'deepseek-v4-flash-free')), true);
  assert.equal(metadataFree(findModelMetadata(map, 'claude-opus-4-7')), false);
  assert.equal(metadataFree(null, 'brand-new-free'), true);
  assert.equal(metadataFree(null, 'paid-model'), false);
});

await t('inferNativeProtocol 按模型名和元数据推断协议', () => {
  const map = normalizeModelsDev(payload);
  assert.equal(inferNativeProtocol(findModelMetadata(map, 'claude-opus-4-7')), 'anthropic');
  assert.equal(inferNativeProtocol(findModelMetadata(map, 'qwen3.7-max')), 'chat');
  assert.equal(inferNativeProtocol(null, 'gpt-5.5'), 'responses');
});

await t('store 首次 refresh 可注入 fetch,并缓存快照', async () => {
  const file = path.join(TMP, 'models.dev.json');
  let calls = 0;
  const store = new ModelMetadataStore({
    file,
    fetchImpl: async () => { calls++; return { ok: true, json: async () => payload }; },
    now: () => 1_700_000_000_000,
    logger: () => {},
  });
  assert.equal(store.status().ready, false);
  const result = await store.refresh();
  assert.equal(result.updated, true);
  assert.equal(calls, 1);
  assert.equal(store.get('qwen3.7-max').id, 'qwen3.7-max');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).models['qwen3.7-max'].outputCost, 7);
});

await t('store 24 小时内不重复刷新,过期后刷新一次', async () => {
  const file = path.join(TMP, 'ttl.json');
  let now = 1_700_000_000_000;
  let calls = 0;
  const store = new ModelMetadataStore({
    file, fetchImpl: async () => { calls++; return { ok: true, json: async () => payload }; },
    now: () => now, logger: () => {},
  });
  await store.refresh();
  await store.refresh();
  assert.equal(calls, 1);
  now += 24 * 60 * 60 * 1000 + 1;
  await store.refresh();
  assert.equal(calls, 2);
});

await t('坏缓存不阻止启动,网络失败保留旧数据', async () => {
  const file = path.join(TMP, 'bad.json');
  fs.writeFileSync(file, '{broken');
  const store = new ModelMetadataStore({
    file, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    logger: () => {},
  });
  assert.equal(store.status().ready, false);
  await assert.rejects(store.refresh());
  assert.equal(store.get('qwen3.7-max'), null);
});

await t('缓存快照可在新实例加载', async () => {
  const file = path.join(TMP, 'reload.json');
  const first = new ModelMetadataStore({ file, fetchImpl: async () => ({ ok: true, json: async () => payload }), logger: () => {} });
  await first.refresh();
  const second = new ModelMetadataStore({ file, fetchImpl: async () => { throw new Error('should not fetch'); }, logger: () => {} });
  assert.equal(second.status().ready, true);
  assert.equal(second.get('deepseek-v4-flash-free').contextWindow, 200000);
});

console.log(`model-metadata.mjs: 全部通过 (${n} 组)`);
