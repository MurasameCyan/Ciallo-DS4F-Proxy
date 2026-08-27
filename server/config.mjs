/**
 * config.mjs —— 运行时配置 + mihomo 配置生成。
 *
 * 与 desktop-app/config.js 的两点不同:
 *
 * 1. 脱掉 electron。路径不再问 app.getPath('userData'),改用 DATA_DIR
 *    (容器里挂 /data),这样订阅地址和 Key 落在卷上,升级镜像不丢。
 *
 * 2. 不再自己拉订阅、解析 yaml、把节点抄进配置。改用 mihomo 自己的
 *    proxy-providers:给它订阅地址,它自己拉、自己按 interval 刷、自己缓存到
 *    磁盘。省掉 js-yaml 依赖(本项目因此保持零依赖),也省掉"机场返回的
 *    proxies 里有我不认识的字段/协议就炸"这类问题 —— 内核认得比我们多。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR || '/data';
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const MIHOMO_CONFIG = path.join(DATA_DIR, 'mihomo-zen.yaml');
export const MIHOMO_DATA_DIR = path.join(DATA_DIR, 'mihomo-data');
export const LAST_NODE_FILE = path.join(DATA_DIR, 'last-node.txt');
export const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
export const CAPS_FILE = path.join(DATA_DIR, 'capabilities.json');
export const MODELS_DEV_FILE = path.join(DATA_DIR, 'models.dev.json');

// buildMihomoYaml 里写的是 `path: ./providers/airport.yaml`,相对内核的 -d 数据目录。
// 子 lane 各有自己的数据目录,但订阅是同一份,节点名到落地 IP 的映射也就同一份,
// 所以只读主 lane 这一个文件。
export const PROVIDER_FILE = path.join(MIHOMO_DATA_DIR, 'providers', 'airport.yaml');

export const MIHOMO_BIN = process.env.MIHOMO_BIN || '/usr/local/bin/mihomo';
export const MIXED_PORT = 17897;
export const CTRL_PORT = 19090;
export const POOL_NAME = 'zen-pool';

const DEFAULTS = {
  subscriptionUrl: '', apiKey: '', port: 9527,
  opencodeIdentityHeaders: false, subscriptionUpdateHours: 1,
  persistUsage: false,
  maxChildLanes: Number(process.env.ZEN_MAX_CHILD_LANES) || 2,
};

export function genApiKey() {
  return 'zen-' + crypto.randomBytes(4).toString('hex');
}

export function ensureDirs() {
  fs.mkdirSync(MIHOMO_DATA_DIR, { recursive: true });
}

/**
 * 读配置。env 只做首次播种,config.json 一旦存在就以它为准 ——
 * 否则用户在面板里改完订阅,重启容器又被 compose 里的旧 env 覆盖回去。
 */
export function load() {
  let saved = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('[config] 读取失败,用默认值:', e.message);
  }

  const cfg = {
    ...DEFAULTS,
    subscriptionUrl: process.env.SUBSCRIPTION_URL || '',
    apiKey: process.env.API_KEY || '',
    ...saved,   // 放最后:已保存的值优先级最高
  };
  cfg.port = Number(process.env.PORT) || Number(cfg.port) || DEFAULTS.port;
  // 旧 config.json 里没有这个字段,读出来是 undefined —— 归一成布尔,
  // 免得前端的 toggle 拿到 undefined 显示成不确定状态
  cfg.opencodeIdentityHeaders = cfg.opencodeIdentityHeaders === true;
  cfg.persistUsage = cfg.persistUsage === true;
  const hours = Number(cfg.subscriptionUpdateHours);
  cfg.subscriptionUpdateHours = Number.isInteger(hours) && hours >= 0 && hours <= 8760
    ? hours : DEFAULTS.subscriptionUpdateHours;

  if (!cfg.apiKey) {
    cfg.apiKey = genApiKey();
    save(cfg);
  }
  return cfg;
}

export function save(cfg) {
  ensureDirs();
  const {
    subscriptionUrl = '', apiKey = '', port = 9527,
    opencodeIdentityHeaders = false, subscriptionUpdateHours = 1,
    persistUsage = false, maxChildLanes = 2,
  } = cfg;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    subscriptionUrl, apiKey, port,
    opencodeIdentityHeaders: opencodeIdentityHeaders === true,
    subscriptionUpdateHours,
    persistUsage: persistUsage === true,
    maxChildLanes: Number(maxChildLanes) || 2,
  }, null, 2), 'utf8');
}

/**
 * 生成 mihomo 配置。
 *
 * 只写 DOMAIN-SUFFIX 和 MATCH 两条规则是刻意的:不碰任何 GEOIP/GEOSITE,
 * 内核就不需要 geoip.dat/geosite.dat,镜像里也不用带这几十 MB,
 * 更不用像桌面版那样从 Clash Verge 目录里拷 —— 容器里没有那个目录。
 *
 * 订阅地址用 JSON.stringify 转义:机场的 token 里常有 & ? = #,
 * 裸着写进 yaml 会被当成注释或流式集合的语法。
 */
export function buildMihomoYaml(subscriptionUrl, { mixedPort = MIXED_PORT, ctrlPort = CTRL_PORT } = {}) {
  if (!subscriptionUrl) throw new Error('订阅地址为空');
  const url = JSON.stringify(String(subscriptionUrl));

  return `# 由 Ciallo Zen Proxy 自动生成,手改会在下次保存配置时被覆盖。
mixed-port: ${mixedPort}
allow-lan: false
mode: rule
log-level: warning
external-controller: 127.0.0.1:${ctrlPort}
ipv6: false
tcp-concurrent: true
unified-delay: true

# 刻意不写 fallback。桌面版那份配置有 fallback + DoH,而 fallback 会启用
# fallback-filter,它默认用 GeoIP 判断要不要采信结果 —— 于是内核启动时要去
# GitHub 下 Country.mmdb(实测 v1.19.29 会打三条 download 日志)。容器首启
# 就多一个必须联外网才能过的步骤,网络受限时直接卡在这儿。
#
# 而这里根本用不上它:opencode.ai 靠 DOMAIN-SUFFIX 匹配,不需要先解析;
# 走代理的那条连接由节点远端解析;其余全 DIRECT。纯 nameserver 够了。
dns:
  enable: true
  ipv6: false
  enhanced-mode: redir-host
  nameserver: [223.5.5.5, 119.29.29.29]

proxy-providers:
  airport:
    type: http
    url: ${url}
    path: ./providers/airport.yaml
    # 周期更新由网关负责,这样每次更新后都能紧接着自动测速。
    interval: 0
    health-check:
      enable: true
      # lazy:没请求走这个组时不主动测延迟。不然十几个节点每 5 分钟测一轮,
      # 机场流量白烧,还可能因为高频探测被判异常。
      lazy: true
      url: 'http://www.gstatic.com/generate_204'
      interval: 300

proxy-groups:
  # select:网关通过 PUT /proxies/${POOL_NAME} 精确指定用哪个节点,
  # 429 换节点靠的就是这个。别换成 url-test,那样选谁由内核说了不算。
  - name: ${POOL_NAME}
    type: select
    use: [airport]
  - name: zen-auto
    type: url-test
    use: [airport]
    url: 'http://www.gstatic.com/generate_204'
    interval: 300
    tolerance: 50

rules:
  - DOMAIN-SUFFIX,opencode.ai,${POOL_NAME}
  - MATCH,DIRECT
`;
}

/** 写出 mihomo 配置文件,返回路径 */
export function writeMihomoConfig(subscriptionUrl, { mixedPort = MIXED_PORT, ctrlPort = CTRL_PORT, name = '' } = {}) {
  ensureDirs();
  // name 非空是子 lane:独立文件名 + 独立端口,和主 lane 的 mihomo-zen.yaml 并存不冲突
  const file = name ? path.join(DATA_DIR, `mihomo-zen-${name}.yaml`) : MIHOMO_CONFIG;
  fs.writeFileSync(file, buildMihomoYaml(subscriptionUrl, { mixedPort, ctrlPort }), 'utf8');
  return file;
}

/**
 * 子 lane 的端口和数据目录。主 lane 用默认值(MIXED_PORT/CTRL_PORT 和 mihomo-data),
 * 子 lane 按序号偏移:多实例必须各占一个 mixed-port 和一个 external-controller 端口,
 * 数据目录也要分开,否则会抢同一份 cache.db 锁。
 * id 从 1 起(0 就是主 lane,直接用默认)。
 */
/**
 * 从一段 proxy 条目文本里取一个字段。同时认 flow 风格(`{"server":"1.2.3.4"}`)
 * 和块风格(`server: 1.2.3.4`),引号可有可无。
 * 前置的 `(?:^|[,{\s])` 是为了不让 `server` 匹配到 `servername`、
 * `name` 匹配到 `username`。
 */
function field(text, key) {
  const re = new RegExp(`(?:^|[,{\\s])["']?${key}["']?\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|([^,}\\r\\n]*))`);
  const m = re.exec(text);
  if (!m) return '';
  if (m[1] !== undefined) return m[1].replace(/\\(.)/g, '$1').trim();
  return (m[2] !== undefined ? m[2] : m[3] || '').trim();
}

/**
 * 解析 provider 缓存文件,得到 节点名 -> 落地地址(server 字段)。
 *
 * 为什么要这个:免费额度是按出口 IP 计的,而一个机场里几十个节点名常常
 * 指向同一台机器 —— 实测 396 个名字只有 291 个 server。按名字冷却等于
 * 同一个 IP 被 429 之后还会被换着名字反复撞。
 *
 * 为什么不问内核:mihomo 的 /providers/proxies 不返回 server 字段,
 * 它的 id 又是按节点算的(396 个名字 396 个 id),没法用来分组。
 *
 * 不引 yaml 库(本项目零依赖),所以按"条目"切:一行以 `- ` 开头算一条,
 * 后面缩进更深的行算它的续行。机场订阅就这两种形状。
 */
export function parseProviderEgress(text) {
  const map = new Map();
  const lines = String(text || '').split(/\r?\n/);
  let entry = null;
  const flush = () => {
    if (!entry) return;
    const name = field(entry, 'name');
    const server = field(entry, 'server');
    // ponytail: server 可能是域名而不是 IP,不同域名也可能解析到同一个 IP。
    // 这里不做 DNS 解析,按字符串区分 —— 会少合并,但不会误合并。
    // 真要更准就得在这里查 A 记录并按解析结果分组。
    if (name && server) map.set(name, server);
    entry = null;
  };
  for (const line of lines) {
    if (/^\s*-\s/.test(line)) {
      flush();
      entry = line;
    } else if (entry !== null && /^\s+\S/.test(line)) {
      entry += '\n' + line;
    } else if (entry !== null) {
      flush();
    }
  }
  flush();
  return map;
}

/**
 * 带 mtime 缓存的 provider 读取。订阅更新才会动这个文件,
 * 每次请求都重解析 400 个节点没必要。
 */
let egressCache = { key: '', map: new Map() };
export function loadProviderEgress(file = PROVIDER_FILE) {
  try {
    const st = fs.statSync(file);
    const key = `${file}:${st.mtimeMs}:${st.size}`;
    if (key !== egressCache.key) {
      egressCache = { key, map: parseProviderEgress(fs.readFileSync(file, 'utf8')) };
    }
  } catch {
    // 文件还没拉下来(首启)或读不了:留着上一次的结果,没有就空 Map。
    // 空 Map 时上层退回"按节点名冷却",也就是改动前的行为。
  }
  return egressCache.map;
}

export function lanePorts(id) {
  return { mixedPort: MIXED_PORT + id, ctrlPort: CTRL_PORT + id };
}

export function laneDataDir(id) {
  return path.join(DATA_DIR, `mihomo-data-${id}`);
}
