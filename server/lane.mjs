/**
 * lane.mjs —— 多出口 lane 的轻量调度器。
 *
 * 主进程持有节点和冷却状态，lane 只记录独立出站实例的占用情况。
 * 子 lane 不拉订阅、不维护自己的禁用表；调用方每次从主状态传入实时快照。
 */
export class LaneManager {
  constructor({ idleMs = 5 * 60_000, maxChildren = 2, now = Date.now,
    createChild, destroyChild } = {}) {
    if (typeof createChild !== 'function' || typeof destroyChild !== 'function') {
      throw new TypeError('createChild and destroyChild are required');
    }
    this.idleMs = Math.max(0, Number(idleMs) || 0);
    this.maxChildren = Math.max(0, Number(maxChildren) || 0);
    this.now = now;
    this.createChild = createChild;
    this.destroyChild = destroyChild;
    this.main = { id: 'main', active: 0, lastUsed: now() };
    this._children = new Map();
  }

  children() { return [...this._children.values()]; }

  async acquire({ nodes = [], mainNode = null, available = () => true } = {}) {
    this.main.lastUsed = this.now();
    if (this.main.active === 0) {
      this.main.active++;
      return this.main;
    }
    const occupied = new Set([mainNode, ...this.children().map((lane) => lane.node)]);
    const node = nodes.find((candidate) => !occupied.has(candidate) && available(candidate));
    if (!node || this._children.size >= this.maxChildren) {
      this.main.active++;
      return this.main;
    }
    const lane = await this.createChild({ node, nodes, mainNode });
    lane.active = 1;
    lane.lastUsed = this.now();
    this._children.set(lane.id, lane);
    return lane;
  }

  release(lane) {
    if (!lane) return;
    lane.active = Math.max(0, (lane.active || 0) - 1);
    lane.lastUsed = this.now();
  }

  async reap() {
    const cutoff = this.now() - this.idleMs;
    for (const [id, lane] of this._children) {
      if (lane.active === 0 && lane.lastUsed <= cutoff) {
        await this.destroyChild(lane);
        this._children.delete(id);
      }
    }
  }

  /** 退出时清空全部子 lane(不等空闲,直接关进程释放端口)。 */
  async clear() {
    for (const [id, lane] of this._children) {
      try { await this.destroyChild(lane); } catch { /* 退出路径,吞掉关闭错误 */ }
      this._children.delete(id);
    }
  }
}
