/**
 * rotation.mjs —— 节点轮换的三张状态表,从 gateway.mjs 拆出来。
 *
 * 这三个类是纯状态机:不碰网络、不碰磁盘、不认识 Gateway。轮换策略的判断
 * 全在这儿,gateway.mjs 只负责在合适的时机调它们。冷却语义(429 / 5xx /
 * 封域各自多久、解冻后排到队尾而不是队首)也都在这里,改策略只改这个文件。
 *
 * 冷却键是「落地 IP」而不是节点名 —— 配额是上游按出口 IP 记的,而订阅里
 * 一个落地常挂着几十个节点名。详见 NodeCooldown 的注释。
 */

// 429 但上游没给 Retry-After 时的兜底冷却。配套「解冻排队尾」(见 gateway 的
// rankNodes):解冻的节点不再凭低延迟插回队首,而是排到没限流过的节点后面,所以短
// 冷却不会再造成「解冻→立刻重打→再冻」的高频刷屏。60s 足够躲开一阵限流窗口,又能
// 在其余节点也不行时较快回来重试。带 Retry-After 的仍按上游给的时长走(见 mark429)。
export const COOLDOWN_MS = 60 * 1000;
export const MODEL_COOLDOWN_MS = 15 * 60 * 1000;
// 节点封域(机场在 CONNECT/TLS 层拒连 opencode.ai)的冷却。这不是限流,是确定性
// 故障:同一节点短时间内不会自己好,但机场可能几小时后换线路,所以取 30 分钟 ——
// 比无 Retry-After 的 429(60s)长得多,又不用等一天。
export const BLOCKED_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * 按底层供应商推断模型分组。限流实测:DS4F/big-pickle/mimo/longcat 同时被限,
 * 而 nemotron 系照常可用 —— 上游是按供应商分别计额度的。模型清单里没有供应商
 * 字段,只能靠命名规律推断。后续上游暴露了供应商字段就改成读那个。
 */
export function providerGroup(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('nemotron')) return 'nemotron';
  if (m.startsWith('ling-')) return 'ling';
  if (m.startsWith('laguna')) return 'laguna';
  // DS4F / big-pickle / mimo / longcat / hy3 / north 归默认组
  return 'default';
}

/**
 * session+model 到 mihomo 节点的轻量绑定表。
 *
 * 这里只负责选点,不持有 transport、不自行发请求。Map 的插入顺序同时充当 LRU,
 * 防止长期运行时一次性会话无限堆积；负载就是当前仍保留的绑定数。
 */
export class NodeAffinity {
  constructor(limit = 2048) {
    this.limit = Math.max(1, Number(limit) || 2048);
    this.bindings = new Map();
    this.loads = new Map();
  }

  key(session, model) {
    const s = typeof session === 'string' ? session.trim() : '';
    const m = typeof model === 'string' ? model.trim() : '';
    return s && m ? JSON.stringify([s, m]) : '';
  }

  get(key) { return key ? this.bindings.get(key) || null : null; }
  load(node) { return this.loads.get(node) || 0; }

  #bump(node, delta) {
    const n = this.load(node) + delta;
    if (n > 0) this.loads.set(node, n); else this.loads.delete(node);
  }

  bind(key, node) {
    if (!key || !node) return node || null;
    const current = this.bindings.get(key);
    if (current === node) {
      this.bindings.delete(key);
      this.bindings.set(key, node);
      return node;
    }
    if (current) this.release(key, current);
    while (this.bindings.size >= this.limit) {
      const oldest = this.bindings.keys().next().value;
      this.release(oldest);
    }
    this.bindings.set(key, node);
    this.#bump(node, 1);
    return node;
  }

  release(key, node = null) {
    if (!key) return false;
    const current = this.bindings.get(key);
    if (!current || (node && current !== node)) return false;
    this.bindings.delete(key);
    this.#bump(current, -1);
    return true;
  }

  /**
   * 单节点优先:新绑定一律落 preferred(全局 lockedNode = 当前节点),已有绑定
   * 粘自己的。额度按出口 IP 算,把会话摊到多个出口等于每份额度都只用到一半;
   * 而且全局 selector 只有一个,并发分散选址必然互相拔节点(乱跳的根因)。
   * 迁移只在失败(429/封域/5xx)时发生,由 attempt 的换节点路径驱动。
   *
   * loads 计数保留:面板统计和 LRU 还用得着,但不再参与选址。
   */
  pick(key, nodes, { available = () => true, exclude = null, preferred = null } = {}) {
    const candidates = (nodes || []).filter((node) => !exclude?.has(node) && available(node));
    const current = this.get(key);
    if (current && candidates.includes(current)) return this.bind(key, current);
    if (current) this.release(key, current);
    if (!candidates.length) return null;

    // 没有 key 的调用(旧路径)和新绑定行为一致:preferred 在候选里就落它
    if (preferred && candidates.includes(preferred)) return this.bind(key, preferred);
    return this.bind(key, candidates[0]);
  }

  migrate(key, failedNode, nodes, options = {}) {
    this.release(key, failedNode);
    const exclude = new Set(options.exclude || []);
    if (failedNode) exclude.add(failedNode);
    // 迁移时也粘 preferred(当前节点),不往零负载节点散 —— 单节点优先的延续
    return this.pick(key, nodes, { ...options, exclude });
  }

  dropNode(node) {
    let dropped = 0;
    for (const [key, bound] of [...this.bindings]) {
      if (bound === node && this.release(key, node)) dropped++;
    }
    return dropped;
  }

  clear() {
    const n = this.bindings.size;
    this.bindings.clear();
    this.loads.clear();
    return n;
  }
}

/**
 * 429 后把节点关小黑屋,期间跳过它,避免连续请求撞同一个被限的出口。
 *
 * 限流按「节点 × 供应商组」分别记:同一节点上 DS4F 被限不影响 nemotron 继续用。
 * 冷却时长优先读上游的 Retry-After(实测指向 UTC 零点的日额度重置),没给就兜底 COOLDOWN_MS。
 */
export class NodeCooldown {
  /**
   * egressOf: 节点名 -> 落地地址。默认恒等,也就是退回「按节点名冷却」的老行为 ——
   * provider 文件还没拉下来时就是这样。
   * namesOf: 落地地址 -> 用这个落地的所有节点名,只给 summary() 展开用(面板按节点名画)。
   */
  constructor({ egressOf = null, namesOf = null } = {}) {
    this.cooldowns = new Map();   // key(egress,group) -> { until, retryAfter, egress, group }
    // 同 key -> 最近一次被限流的时刻。冷却过期会把上面那条删掉,但这条留着,
    // rankNodes 靠它把刚解冻的节点排到可用节点最后(见 recentMark)。只有 clear/clearAll 清。
    this.lastMarked = new Map();
    this.egressOf = egressOf || ((node) => node);
    this.namesOf = namesOf || ((egress) => [egress]);
  }

  /** 落地地址。解析不出来就用节点名本身,宁可少合并也不要误合并。 */
  egress(node) {
    return this.egressOf(node) || node;
  }

  // 分隔符用 NUL:IPv6 落地地址里带冒号,再用 `${x}:${g}` 就没法切了。
  // 不过下面一律不切 key —— egress/group 存在 value 里。
  #key(node, group = 'default') { return `${this.egress(node)}\u0000${group}`; }

  mark429(node, group = 'default', retryAfterSec = null) {
    const ms = retryAfterSec != null && retryAfterSec > 0
      ? Math.min(retryAfterSec * 1000, 24 * 3600 * 1000)  // 上限一天,防止解析错误
      : COOLDOWN_MS;
    const egress = this.egress(node);
    const key = this.#key(node, group);
    this.cooldowns.set(key, { until: Date.now() + ms, retryAfter: retryAfterSec, egress, group });
    this.lastMarked.set(key, Date.now());
  }

  /**
   * 封域冷却。和 429 共用一张表(跳过逻辑一样),但时长独立、不带 retryAfter,
   * summary 里标 reason 让面板能区分「被限流」和「被机场封了」。
   */
  markBlocked(node, group = 'default') {
    this.cooldowns.set(this.#key(node, group), {
      until: Date.now() + BLOCKED_COOLDOWN_MS, retryAfter: null, blocked: true,
      egress: this.egress(node), group,
    });
    this.lastMarked.set(this.#key(node, group), Date.now());
  }

  /**
   * 5xx 秒拒冷却。上游(zen)对爆满的出口直接秒回 5xx,这种坏节点用 429 同款
   * 短冷却(COOLDOWN_MS),让整批坏出口在一段时间内被排到队尾,而不是每来一个
   * 请求都优先挑到延迟最低的这批(它们延迟最低,专挑坏的打)。reason 标
   * '5xx' 让面板能区分「被限流(429)」「被机场封(blocked)」「上游 5xx」。
   */
  mark5xx(node, group = 'default') {
    const now = Date.now();
    const key = this.#key(node, group);
    const until = now + COOLDOWN_MS;
    const existing = this.cooldowns.get(key);
    // 并发请求可能交错落标记:不能让 5xx 的 60s 覆盖更强的 429
    // Retry-After 或机场封域冷却,否则会把 1h/30min 错缩成 60s。
    if (!existing || existing.until <= now || existing.until < until) {
      this.cooldowns.set(key, { until, retryAfter: null, reason: '5xx', egress: this.egress(node), group });
    }
    this.lastMarked.set(key, now);
  }

  /** 返回仍在生效的节点冷却详情;过期项顺手清掉。 */
  get(node, group = 'default') {
    const key = this.#key(node, group);
    const c = this.cooldowns.get(key);
    if (!c) return null;
    const remain = c.until - Date.now();
    if (remain <= 0) {
      this.cooldowns.delete(key);
      return null;
    }
    return { ...c, remain };
  }

  isCooling(node, group = 'default') {
    return this.get(node, group) !== null;
  }

  clear(node, group = null) {
    if (group === null) {
      // 清该落地所有分组(冷却记录和「最近限流时刻」一起清,恢复它的正常优先级)
      const prefix = `${this.egress(node)}\u0000`;
      let n = 0;
      for (const k of [...this.cooldowns.keys()]) {
        if (k.startsWith(prefix)) { this.cooldowns.delete(k); n++; }
      }
      for (const k of [...this.lastMarked.keys()]) {
        if (k.startsWith(prefix)) this.lastMarked.delete(k);
      }
      return n;
    }
    const key = this.#key(node, group);
    this.cooldowns.delete(key);
    this.lastMarked.delete(key);
    return 1;
  }

  clearAll() {
    const n = this.cooldowns.size;
    this.cooldowns.clear();
    this.lastMarked.clear();
    return n;
  }

  /**
   * 该节点最近一次(任意分组)被限流的时刻,含已解冻的;没限流过返回 0。
   * rankNodes 拿它把刚限流/解冻的节点排到可用节点最后 —— 否则延迟最低的那个
   * 一解冻就凭低延迟插回队首、又被打,后面的节点永远轮不到。成功(clear)后归零。
   */
  recentMark(node) {
    const prefix = `${this.egress(node)}\u0000`;
    let ts = 0;
    for (const [k, t] of this.lastMarked) {
      if (k.startsWith(prefix)) ts = Math.max(ts, t);
    }
    return ts;
  }

  /**
   * exclude 里装的是节点名(调用方的 tried 集合)。这里要按落地地址排除:
   * 超时那条分支只 tried.add 不打冷却标记,不换算的话 7 次重试可能全落在
   * 同一台机器的 7 个不同名字上 —— 实测有一个 IP 挂了 51 个名字。
   */
  pickAvailable(nodes, group = 'default', exclude = null) {
    let banned = null;
    if (exclude?.size) {
      banned = new Set();
      for (const n of exclude) banned.add(this.egress(n));
    }
    for (const n of nodes) {
      if (banned?.has(this.egress(n))) continue;
      if (this.isCooling(n, group)) continue;
      return n;
    }
    return null;
  }

  /** 全员冷却时挑该分组剩余最短的,返回 { node, remain }(remain 单位 ms) */
  soonest(nodes, group = 'default') {
    let node = null, remain = Infinity;
    for (const n of nodes) {
      const c = this.get(n, group);
      if (c && c.remain < remain) { remain = c.remain; node = n; }
    }
    return node ? { node, remain } : null;
  }

  /**
   * 供 /api/nodes 用,remain 单位秒。
   *
   * 冷却按落地地址记,面板按节点名画(web/core.js 拿 c.node 建表),所以这里
   * 要把一条落地冷却摊回它名下所有节点名。顺带把「同一台机器的另外 50 个名字
   * 其实也在冷却」这件事显示出来 —— 以前面板只标被打中的那一个。
   */
  summary() {
    const out = [];
    for (const c of this.cooldowns.values()) {
      const left = c.until - Date.now();
      if (left <= 0) continue;
      const row = {
        group: c.group,
        remain: Math.ceil(left / 1000),
        retryAfter: c.retryAfter,
        blocked: c.blocked === true,
        reason: c.reason,
        egress: c.egress,
      };
      for (const node of this.namesOf(c.egress)) out.push({ node, ...row });
    }
    return out;
  }
}

/** 上游明确说模型不可用时,短暂跳过该模型,不要继续消耗其它出口额度。 */
export class ModelCooldown {
  constructor(ttlMs = MODEL_COOLDOWN_MS) {
    this.ttlMs = ttlMs;
    this.cooldowns = new Map(); // model -> { until, message }
  }

  mark(model, message = '') {
    const id = String(model ?? '').trim();
    if (!id) return;
    this.cooldowns.set(id, { until: Date.now() + this.ttlMs, message: String(message || '') });
  }

  get(model) {
    const id = String(model ?? '').trim();
    const entry = this.cooldowns.get(id);
    if (!entry) return null;
    const remain = entry.until - Date.now();
    if (remain <= 0) {
      this.cooldowns.delete(id);
      return null;
    }
    return { ...entry, remain: Math.ceil(remain / 1000) };
  }

  isCooling(model) { return this.get(model) !== null; }

  clear(model) {
    const id = String(model ?? '').trim();
    return id ? this.cooldowns.delete(id) : false;
  }

  clearAll() {
    const n = this.cooldowns.size;
    this.cooldowns.clear();
    return n;
  }

  summary() {
    const out = [];
    for (const [model] of this.cooldowns) {
      const entry = this.get(model);
      if (entry) out.push({ model, remain: entry.remain, message: entry.message });
    }
    return out;
  }
}
