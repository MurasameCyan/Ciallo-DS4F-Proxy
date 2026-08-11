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

export const MIHOMO_BIN = process.env.MIHOMO_BIN || '/usr/local/bin/mihomo';
export const MIXED_PORT = 17897;
export const CTRL_PORT = 19090;
export const POOL_NAME = 'zen-pool';

const DEFAULTS = {
  subscriptionUrl: '', apiKey: '', port: 9527,
  opencodeIdentityHeaders: false, subscriptionUpdateHours: 1,
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
  } = cfg;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    subscriptionUrl, apiKey, port,
    opencodeIdentityHeaders: opencodeIdentityHeaders === true,
    subscriptionUpdateHours,
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
export function buildMihomoYaml(subscriptionUrl) {
  if (!subscriptionUrl) throw new Error('订阅地址为空');
  const url = JSON.stringify(String(subscriptionUrl));

  return `# 由 Ciallo Zen Proxy 自动生成,手改会在下次保存配置时被覆盖。
mixed-port: ${MIXED_PORT}
allow-lan: false
mode: rule
log-level: warning
external-controller: 127.0.0.1:${CTRL_PORT}
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
export function writeMihomoConfig(subscriptionUrl) {
  ensureDirs();
  fs.writeFileSync(MIHOMO_CONFIG, buildMihomoYaml(subscriptionUrl), 'utf8');
  return MIHOMO_CONFIG;
}
