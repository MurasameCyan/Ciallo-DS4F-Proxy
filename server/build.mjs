/**
 * build.mjs —— 构建标识 + 检查更新。
 *
 * 面板右上角显示当前跑的是哪个 commit,点一下才去和 GitHub 上的分支 HEAD 比。
 * 刻意不自动查:面板每 2 秒轮一次 /api/status,顺手带上检查的话,GitHub 匿名
 * API 那每小时 60 次配额几分钟就烧光,之后每次点都告诉你「检查失败」。
 *
 * 取值顺序 env → git rev-parse。容器里由 Dockerfile 的 ARG GIT_COMMIT 注入
 * (CI 传 github.sha);开发机上没这个 env,退回问一次 git,免得面板永远显示
 * unknown。镜像里既没 git 也没 .git,那一步失败就是 unknown —— 那时不报
 * 「有新版本」,见 checkUpdate。
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 公开仓库。允许用 GITHUB_REPO 覆盖(fork 出去自己发镜像的人要改这个) */
const REPO = String(process.env.GITHUB_REPO || 'MurasameCyan/Ciallo-DS4F-Proxy')
  .trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '') || 'MurasameCyan/Ciallo-DS4F-Proxy';

/** 盯哪个分支。代码和 latest 镜像都出自 beta,main 只有 README,所以默认 beta */
const REF = String(process.env.GITHUB_TRACK_REF || 'beta').trim() || 'beta';

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** 40 位取前 7 位;不像 sha 的值(tag、日期串)原样留着,最多 32 字符 */
export function shortSha(raw) {
  const s = String(raw ?? '').trim().split(/\s+/)[0] || '';
  if (!s || ['unknown', 'null', 'none', 'n/a'].includes(s.toLowerCase())) return '';
  return SHA_RE.test(s) ? s.slice(0, 7).toLowerCase() : s.slice(0, 32);
}

function fromEnv() {
  // GIT_COMMIT 是我们自己的镜像用的,其余几个是各家 CI/PaaS 的习惯名
  for (const k of ['GIT_COMMIT', 'GITHUB_SHA', 'SOURCE_COMMIT', 'COMMIT_SHA', 'BUILD_ID']) {
    const h = shortSha(process.env[k]);
    if (h) return h;
  }
  return '';
}

function fromGit() {
  try {
    return shortSha(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return '';       // 没装 git / 不是仓库 / 超时:都只是拿不到 hash,不是故障
  }
}

let cached = null;

/** 当前构建的短 hash,取不到时 'unknown'。只算一次(git 那步是同步的) */
export function buildId() {
  if (cached == null) cached = fromEnv() || fromGit() || 'unknown';
  return cached;
}

/** 面板要显示的几样:hash、这次 commit 的链接、仓库链接、盯的分支 */
export function buildInfo() {
  const build = buildId();
  const repoUrl = `https://github.com/${REPO}`;
  return {
    build,
    // 认不出是 hash(unknown、或者被塞了个 tag)时链到分支的提交列表,
    // 比给一个 404 的 /commit/unknown 好
    buildUrl: SHA_RE.test(build) ? `${repoUrl}/commit/${build}` : `${repoUrl}/commits/${REF}`,
    repoUrl,
    trackRef: REF,
  };
}

/**
 * 和 GitHub 上 REF 的 HEAD 比一比。
 *
 * 任何失败都走返回值里的 error 字段,不抛 —— 检查更新失败不该让面板上一个
 * 按钮变成 500,而且「为什么失败」得能显示给用户看(限流?分支改名了?)。
 *
 * fetchImpl 可注入:测试里不能真打 api.github.com(会算进限流,还得看网络)。
 */
export async function checkUpdate(fetchImpl = fetch) {
  const info = buildInfo();
  const base = {
    current: info.build,
    latest: null,
    hasUpdate: false,
    htmlUrl: `${info.repoUrl}/commits/${REF}`,
    publishedAt: null,
    error: null,
  };

  let r;
  try {
    r = await fetchImpl(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(REF)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ciallo-ds4f-proxy' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ...base, error: e?.message || String(e) };
  }

  if (r.status === 404) return { ...base, error: `仓库或分支 ${REF} 不存在` };
  // 403/429 基本都是匿名配额用完了。写清楚,不然会被当成网络不通去查代理
  if (r.status === 403 || r.status === 429) {
    return { ...base, error: 'GitHub 限流(匿名每小时 60 次),过会儿再试' };
  }
  if (!r.ok) return { ...base, error: `GitHub 返回 HTTP ${r.status}` };

  let data;
  try { data = await r.json(); } catch { return { ...base, error: 'GitHub 返回的不是 JSON' }; }

  const latest = shortSha(data?.sha);
  if (!latest) return { ...base, error: 'GitHub 没给出 commit sha' };

  const commit = data?.commit || {};
  return {
    ...base,
    latest,
    // 本地是 unknown 时不报「有新版本」:那只说明构建时没注入 hash,新旧无从
    // 判断,谎报会让人白拉一次镜像然后发现标记还在
    hasUpdate: SHA_RE.test(info.build) && latest.toLowerCase() !== info.build.toLowerCase(),
    htmlUrl: data?.html_url || base.htmlUrl,
    publishedAt: commit.committer?.date || commit.author?.date || null,
  };
}
