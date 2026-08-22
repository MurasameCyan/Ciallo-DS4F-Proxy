import assert from 'node:assert/strict';
import {
  ModelAvailability, MODEL_AVAILABILITY_TTL_MS,
} from '../server/model-availability.mjs';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

await t('初始模型状态都是 unknown', () => {
  const a = new ModelAvailability({ post: async () => ({}) });
  assert.equal(MODEL_AVAILABILITY_TTL_MS, 6 * 60 * 60 * 1000);
  assert.deepEqual(a.status(['a-free', 'b-free']), {
    'a-free': { status: 'unknown', checkedAt: null, error: null },
    'b-free': { status: 'unknown', checkedAt: null, error: null },
  });
});

await t('探针使用 max_tokens=1,成功模型标记 available', async () => {
  const calls = [];
  const a = new ModelAvailability({
    post: async (body) => { calls.push(body); return { id: 'ok' }; },
  });
  const result = await a.probe(['a-free']);
  assert.equal(result['a-free']?.status, 'available', '结果按模型 id 返回');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'a-free');
  assert.equal(calls[0].max_tokens, 1);
  assert.deepEqual(a.status(['a-free'])['a-free'].status, 'available');
});

await t('并发 probe 共用同一个 Promise 且按模型串行', async () => {
  let running = 0;
  let peak = 0;
  const a = new ModelAvailability({
    post: async () => {
      peak = Math.max(peak, ++running);
      await wait(5);
      running--;
      return {};
    },
  });
  const one = a.probe(['a-free', 'b-free']);
  const two = a.probe(['a-free', 'b-free']);
  assert.equal(one, two);
  await one;
  assert.equal(peak, 1);
});

await t('明确 Model unavailable 标记 unavailable', async () => {
  const a = new ModelAvailability({
    post: async () => { throw { status: 400, body: '{"error":{"message":"Model is unavailable"}}' }; },
  });
  await a.probe(['gone-free']);
  const item = a.status(['gone-free'])['gone-free'];
  assert.equal(item.status, 'unavailable');
  assert.equal(item.error.kind, 'model_unavailable');
});

await t('429 和网络错误保留 unknown,记录原因而不是误报 unavailable', async () => {
  let mode = '429';
  const a = new ModelAvailability({
    post: async () => {
      if (mode === '429') throw { status: 429, body: 'slow down' };
      throw { status: 0, body: 'ECONNRESET' };
    },
  });
  await a.probe(['limited-free']);
  let item = a.status(['limited-free'])['limited-free'];
  assert.equal(item.status, 'unknown');
  assert.equal(item.error.kind, 'rate_limited');
  mode = 'network';
  a.expire('limited-free');
  await a.probe(['limited-free']);
  item = a.status(['limited-free'])['limited-free'];
  assert.equal(item.status, 'unknown');
  assert.equal(item.error.kind, 'transport');
});

await t('明确业务 4xx 都标为 unavailable,包括鉴权和额度错误', async () => {
  for (const status of [401, 402, 403, 404, 422]) {
    const a = new ModelAvailability({
      post: async () => { throw { status, body: `HTTP ${status}` }; },
    });
    await a.probe([`model-${status}`]);
    assert.equal(a.status([`model-${status}`])[`model-${status}`].status, 'unavailable', String(status));
  }
});

await t('临时错误保持 unknown,也只随六小时周期重探', async () => {
  let now = 1000;
  let calls = 0;
  const a = new ModelAvailability({
    now: () => now,
    post: async () => { calls++; throw { status: 429, body: 'slow down' }; },
  });
  await a.probe(['limited-free']);
  now += 60_000 + 1;
  await a.probe(['limited-free']);
  assert.equal(calls, 1, '一分钟后不能重打,否则长期 429 会白耗出口额度');
  now += MODEL_AVAILABILITY_TTL_MS;
  await a.probe(['limited-free']);
  assert.equal(calls, 2);
});

await t('后台调度对临时错误和稳定结果都保持六小时周期', async () => {
  let now = 1000;
  const a = new ModelAvailability({
    now: () => now,
    post: async () => { throw { status: 503, body: 'upstream down' }; },
  });
  await a.probe(['transient-free']);
  assert.equal(a.nextDelay(['transient-free']), MODEL_AVAILABILITY_TTL_MS);
  a.post = async () => ({});
  now += MODEL_AVAILABILITY_TTL_MS + 1;
  await a.probe(['transient-free']);
  assert.equal(a.status(['transient-free'])['transient-free'].status, 'available');
  assert.equal(a.nextDelay(['transient-free']), MODEL_AVAILABILITY_TTL_MS);
});

await t('TTL 到期后重新探测,未到期不重复出站', async () => {
  let now = 1000;
  let calls = 0;
  const a = new ModelAvailability({
    now: () => now,
    post: async () => { calls++; return {}; },
  });
  await a.probe(['a-free']);
  await a.probe(['a-free']);
  assert.equal(calls, 1);
  now += MODEL_AVAILABILITY_TTL_MS + 1;
  const running = a.probe(['a-free']);
  assert.equal(a.status(['a-free'])['a-free'].status, 'probing');
  await running;
  assert.equal(calls, 2);
});

console.log(`\nmodel-availability.mjs: 全部通过 (${n} 组)\n`);
