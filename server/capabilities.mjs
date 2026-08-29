/**
 * capabilities.mjs —— 每个模型「能吃多长上下文、认哪几档思考强度」的实测记录。
 *
 * 为什么要有这个文件:上游 /zen/v1/models 只给 id,一个字节的元数据都不给。
 * 这两件事以前是三张手写常量表(web/core.js 的 MODEL_CTX、anthropic.mjs 的
 * MAX_CAPABLE 和 STRICT_EFFORTS),代价已经付过两次:
 *
 *   - 上游新上一个模型,表里没有 → 面板少个 `[1M]` 后缀是小事,思考强度折错档
 *     是大事(x-preview-f-free 的 medium 直接 400,而那正是 Claude Code 的
 *     `think` 翻出来的档位)。
 *   - 上游下线一个模型,表里还留着 → 手动清理时要连带动测试断言,于是干脆不清,
 *     于是表越来越不像真的。
 *
 * 现在的做法:记录**按模型 id 存在盘上**(/data/capabilities.json),开机拉完
 * 免费清单后,给清单里**没有记录**的模型现探一次,探完落盘。于是:
 *
 *   - 下线的模型不会出现在面板上 —— 面板显示的是「上游现在的清单」,而记录只是
 *     一张按 id 查的字典,查不到就不显示后缀,查到多余的也没人问它。
 *   - 记录留着不删。下线的模型哪天回来了,id 一样就直接复用,不用再探一遍。
 *   - 新模型上线只探它自己,不动其它模型。
 *
 * SEED 是搬家过来的那批手工实测值(2026-08-11 全量 + 2026-08-21 补的
 * x-preview-f-free),13 条里有 5 条是已经下线的模型(那 4 个 + 免费一周到期的
 * x-preview-f-free)—— 那正是「留着以后复用」的意思,别顺手删。
 */

import fs from 'node:fs';
import { classifyUpstreamError, isCapabilityError } from './upstream-errors.mjs';

/** 思考强度六档,从弱到强。和 anthropic.mjs 的 LADDER 是同一份顺序 */
export const LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 搬家过来的手工实测值。字段含义见 record 的注释。
 *
 * `efforts: null` = 「宽松」:对不认的档位是丢字段而不是报错,所以不需要夹。
 * `top` 是这个模型认的最高档 —— 上游对不认的档位丢字段而不降级,所以顶档必须
 * 按模型给准,发个它不认的 max 等于什么都没发(xhigh 一度静默失效就是这个)。
 */
export const SEED = {
  'big-pickle': { ctx: 1048576, method: 'validator', top: 'high', efforts: null },
  'deepseek-v4-flash-free': { ctx: 1048576, method: 'validator', top: 'max', efforts: null },
  'mimo-v2.5-free': { ctx: 1048576, method: 'validator', top: 'high', efforts: null },
  'nemotron-3-ultra-free': { ctx: 1000000, method: 'validator', top: 'high', efforts: null },
  'nemotron-3.5-lightning-free': { ctx: 1000000, method: 'validator', top: 'high', efforts: null },
  'laguna-s-2.1-free': { ctx: 262144, method: 'validator', top: 'high', efforts: null },
  // 没有参数校验器,超限静默截断 —— 这个数是从 prompt_tokens 封顶推出来的
  'hy3-free': { ctx: 196608, method: 'truncate', top: 'high', efforts: null },
  // 2026-08-21 实测。校验器只说「超了」不说上限,所以是夹出来的(1,048,488 过、
  // 1,048,688 报 [1261]);它对不认的档位**报 400** 而不是丢字段,所以 efforts 有值
  'x-preview-f-free': {
    ctx: 1048576, method: 'bracket', maxOut: 131072, top: 'max', efforts: ['low', 'high', 'max'],
  },
  // 2026-08-21 上线,实测能力探测基本探不动它:什么都回怪状态码,正文里连
  // error 字段都没有,于是档位读不出档位词(按宽松)、上下文一个候选都夹不出来。
  // 不写 ctx —— 面板少个后缀而已,硬编一个数才是错的。
  // ctxAt 是那次探测的真实时刻:「探过了,结论是探不出」和「还没探」得分开,
  // 不然每个全新容器都要为这个已知探不动的模型白花一次 6MB
  'muse-spark-1.2-contributor-free': {
    ctx: null, method: 'unknown', ctxAt: 1787328070506, top: 'high', efforts: null,
  },
  // 2026-08-29 实测(上游 2026-08-29 上线)。校验器把上限直接写在原文里:
  //   This endpoint's maximum context length is 262144 tokens.
  //   However, you requested about 1500001 tokens (1500000 of text input, 1 in the output).
  // 注意这条原文是**先 limit 后 requested**,盲取最大值会读成 1500001 ——
  // 那是发出去的量,不是上限。parseCtx 因此改成先认点名句式(见那边的注释)。
  //
  // 独立复核过 262144:261900/262200/300000 词全部 400 且都报同一个 limit;
  // 二分出「最大能过」是 197568 词 → 上游计 197589 tokens。差额不是矛盾,是
  // 上游按 1.25 倍折算(1500000 词 → 1500000 tokens),262144 ÷ 1.25 ≈ 197568。
  //
  // 严格型:非法档位报 400 并点名六档全认,所以 efforts 有值、顶档是 max
  'ling-3.0-flash-fin-free': {
    ctx: 262144,
    method: 'validator',
    maxOut: 262144,
    top: 'max',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  // ↓ 2026-08-21 已从上游清单下线。记录留着:id 一样的话回来了直接复用
  'longcat-2.0-free': { ctx: 1048580, method: 'validator', top: 'high', efforts: null },
  'ling-3.0-flash-free': { ctx: 262144, method: 'validator', top: 'high', efforts: null },
  'ling-3.0-tiny-free': { ctx: 262144, method: 'validator', top: 'high', efforts: null },
  // thinkingLevelMap 里连 max 都是 null,顶档只到 high
  'north-mini-code-free': { ctx: 256000, method: 'validator', top: 'high', efforts: null },
};

/**
 * 记录 → anthropic.mjs 要的那张 `{id: {top, efforts}}`。
 *
 * 单独摆成纯函数(而不是只有 Capabilities 的方法)是因为 anthropic.mjs 要拿它把
 * SEED 折成自己的默认值 —— 那个文件不碰盘也不碰网络,不该为了一张表去 new 一个
 * 带 fs 的类。缺字段时兜底 high + 宽松:那就是有记录之前的老行为。
 */
export function effortMapOf(records) {
  const out = Object.create(null);
  for (const [id, r] of Object.entries(records || {})) {
    if (!r || typeof r !== 'object') continue;
    out[id] = { top: r.top || 'high', efforts: Array.isArray(r.efforts) && r.efforts.length ? r.efforts : null };
  }
  return out;
}

// ── 探测结果的解析 ──────────────────────────────────────
//
// 三个纯函数,喂上游的错误原文,吐出数字/档位。单独导出是为了能不出站就测 ——
// 真正花钱的是发请求那部分,而会错的是解析这部分。

/**
 * 从错误原文里读出这个模型认的档位。
 *
 * 判据是「原文里点名了哪几个档位词」。x-preview-f-free 的原文:
 *   [1210] This model always engages in thinking and cannot be disabled;
 *          please use low, high, or max
 * → ['low','high','max']
 *
 * 必须按词边界匹配,不能用 includes:`xhigh` 里含着 `high`,子串匹配会把
 * 「只认 xhigh」的模型读成「认 high」。
 *
 * ponytail: 这是个启发式 —— 上游哪天把档位写在散文里(「high is not supported」)
 * 就会读反。所以只在**确实报错**时才采信它,报错本身已经说明这个模型是严格的;
 * 读出来是空的就当没探到(返回 null = 按宽松处理,退回原来的行为)。
 */
export function parseEfforts(msg) {
  const text = String(msg ?? '');
  const found = LADDER.filter((lv) => new RegExp(`\\b${lv}\\b`, 'i').test(text));
  return found.length ? found : null;
}

/**
 * 从错误原文里读出 max_tokens 上限。故意发一个大得离谱的值把校验器逼出来:
 *   [1210] The max_tokens parameter is illegal.:限制数值范围[1,131072]
 * 英文写法(between 1 and N / must be ≤ N)一并认。
 */
export function parseMaxOut(msg) {
  const text = String(msg ?? '');
  const m = text.match(/\[\s*\d+\s*[,,]\s*(\d+)\s*\]/)
    || text.match(/between\s+\d+\s+and\s+(\d+)/i)
    || text.match(/(?:max(?:imum)?|至多|不超过)\D{0,20}?(\d{4,})/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 采信一个上限数字的上界。防的是把时间戳之类的东西读成上限 */
const CTX_SANE_MAX = 20_000_000;

/**
 * 点名上限的句式。命中这些就直接采信括号里那个数,不再看原文里其它数字。
 *
 * 顺序无所谓(都试一遍取第一个命中的),但**必须**盖住两种排列 —— 上游有的把
 * limit 写在前、有的写在后,见 parseCtx 的注释。
 */
/**
 * 限流话术。命中就整条原文都不采信 —— 配额消息同样带「limit + 大数字」,
 * 但那是**每天多少 token**,不是一次能吃多长。读成上限会以 method=validator
 * 落盘,而 run 只探没记录的,于是永不重探。
 */
/**
 * 限流话术那一句。摘掉它再解析上下文上限 —— 它同样带「limit + 大数字」,但说的是
 * **配额**(每天多少次请求),不是上下文容量。
 *
 * 摘一句而不是整条原文一律不认:后者会让「同时提到限流和真上限」的原文退回去夹,
 * 白花几 MB 出站;只摘这一句,两种信息都不丢。`[^;.。]*` 到分句符就停,免得把
 * 后半句真上限一起吃掉。
 */
const RATE_CLAUSE = /(?:rate[\s_-]?limit|too\s+many\s+requests|quota|配额|请求过于频繁)[^;.。]*/gi;

const CTX_NAMED = [
  // This endpoint's maximum context length is 262144 tokens
  /max(?:imum)?\s+context\s+length\s+is\s+(\d+)/i,
  // ... > limit 1048576  /  limit is 262144  /  limit: 262144
  /\blimit\b\D{0,12}?(\d+)/i,
  // Prompt exceeds max length 1048576
  /max(?:imum)?\s+length\D{0,12}?(\d+)/i,
  // 中文校验器:限制上下文长度[1,262144] —— 取区间上界
  /(?:上下文|context)[^[\]]{0,12}\[\s*\d+\s*[,,]\s*(\d+)\s*\]/i,
];

/**
 * 从超限错误原文里读出上下文上限。
 *
 * 两条路,**先句式后取最值**:
 *
 * 1. 原文点名了上限(`maximum context length is N`、`> limit N`)就直接采信 N。
 *    这条是后加的,因为盲取最大值在这种原文上会读错 —— ling-3.0-flash-fin-free
 *    的实测原文是「limit 262144 ... you requested about 1500001」,最大的那个数
 *    是**我发出去的量**。而错值会以 method=validator 落盘、且 run 只探没记录的,
 *    于是永不重探:面板显示 [1M],真值 256K。
 *
 *    反方向的写法(`input 1300000 tokens > limit 1048576`)同样得读出 limit。
 *    两种排列方向相反,所以单靠取最值必然错一边。
 *
 * 2. 没点名就退回**取最大的那个在合理区间内的整数**。下界 100_000 是刻意的:
 *    错误码本身就是个数字(`[1261] Prompt exceeds max length` 里那个 1261),
 *    不设下界会把错误码当成上下文上限。
 *
 *    句式那条路不套这个下界 —— 下界是给盲取防错误码用的,既然点了名就没有这个
 *    歧义,沿用的话 64K 级模型永远读不出上限。
 *
 * 两条都读不到就返回 null,交给 probeContext 去夹 —— x-preview-f-free 就是这种,
 * 它的原文压根没写上限是多少。
 *
 * 限流话术先摘掉(见 RATE_CLAUSE):它同样带「limit + 大数字」,但那是**配额**不是
 * 上下文容量。生产路径上 429 早被 informative() 挡掉了,这里再防一层是因为上游
 * 偶尔把配额话术塞进 400 —— 那种一旦读成上限就会以 validator 落盘,永不重探。
 */
export function parseCtx(msg) {
  const text = String(msg ?? '').replace(RATE_CLAUSE, ' ');
  for (const re of CTX_NAMED) {
    const n = Number(text.match(re)?.[1]);
    if (Number.isInteger(n) && n > 0 && n <= CTX_SANE_MAX) return n;
  }
  const nums = text.match(/\d{6,}/g) || [];
  const ok = nums.map(Number).filter((n) => n >= 100_000 && n <= CTX_SANE_MAX);
  return ok.length ? Math.max(...ok) : null;
}

// ── 探测 ────────────────────────────────────────────────

/**
 * 夹上下文上限时的候选值。全是**实际见过的**真值,不是等比数列 —— 于是 5 个候选
 * 二分 3 次就到底,而不是在 0..2M 之间盲搜十几次(每次都是几 MB 的出站)。
 *
 * 刻意不放 longcat 那个 1048580:它和 1048576 差 4,夹不出来(探测留了 200 token
 * 余量),而两者的面板后缀都是 `1M`。它的精确值在 SEED 里,那是手工量的。
 */
export const CTX_CANDIDATES = [196608, 256000, 262144, 1000000, 1048576];

/** 顶探用的大小:比最大的候选还大一截,一次就能分开「截断 / 报错 / 更大」三种情况 */
const CTX_PROBE_TOP = 1_200_000;

/** 夹的时候留出的余量,盖住 chat 模板那几十个 token(实测 88~97) */
const CTX_MARGIN = 200;

/**
 * 一次探测跑最多花多少出站流量。上下文探测是这个文件里唯一贵的操作:一个 1M
 * 模型的顶探就是 6MB,夹到底再加三次。机场流量是按量的,所以设个闸 —— 撞到闸
 * 就停下来记一行日志说清楚**哪些没探**,而不是悄悄少探几个装作探完了。
 */
const CTX_BUDGET_BYTES = 48 * 1024 * 1024;

/** 探测用的填充文本。'word ' 一个词约一个 token,于是 n ≈ token 数 */
const filler = (n) => 'word '.repeat(n);

/**
 * 这次失败是「上游的校验器在说话」,还是「压根没送到」?
 *
 * 只有可解释的业务 4xx 算前者。模型不可用、429、5xx 以及 status 0
 * (连不上、超时、TLS 失败)的错误原文里没有能力信息 —— 把它们当成「探到了:
 * 宽松、顶档 high」
 * 会往盘上写一条**假记录**,而且以后再也不会重探(run 只探没记录的),于是一次
 * 网络抖动能让某个模型永久按错的档位跑。宁可这一轮没探到:下次开机、或者面板
 * 上点一下「补探能力」就会再试。
 *
 * 429 也归这边:限流不是这个模型的属性,是这个出口 IP 此刻的状态。
 */
const informative = (e) => isCapabilityError(e?.status, e?.body)
  && classifyUpstreamError(e?.status, e?.body) === 'terminal';

/**
 * @param {object} o
 * @param {string} o.file              记录落盘的路径
 * @param {(body:object)=>Promise<object>} o.post  发一次非流式上游请求。
 *        成功 resolve 上游 JSON,失败 reject {status, body} —— 就是
 *        Gateway#forward 的形状,直接把它传进来。
 * @param {(level:string,msg:string)=>void} [o.logger]
 */
export class Capabilities {
  constructor({ file, post, logger = () => {} }) {
    this.file = file;
    this.post = post;
    this.logger = logger;
    this.records = this.load();
    this.probing = null;
  }

  /**
   * 读盘。读不到或读坏了就只用 SEED —— 记录是缓存,不是账本,丢了重探一次就有,
   * 不值得为它让进程起不来。
   *
   * SEED 垫在下面而不是盖在上面:盘上那份是探出来的新值,SEED 是搬家时的旧值,
   * 同一个 id 撞车时该信盘上的。
   */
  load() {
    let saved = {};
    try {
      if (fs.existsSync(this.file)) saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))?.models || {};
    } catch (e) {
      this.logger('warn', `[caps] 记录读取失败,只用内置那份: ${e.message}`);
    }
    return { ...SEED, ...saved };
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, models: this.records }, null, 2), 'utf8');
    } catch (e) {
      this.logger('warn', `[caps] 记录写盘失败(下次开机会重探): ${e.message}`);
    }
  }

  get(model) {
    return this.records[String(model ?? '').trim()] || null;
  }

  /** 只给出「id → 上下文上限」这一张扁表,面板要的就是它 */
  ctxMap(models = null) {
    const ids = models || Object.keys(this.records);
    const out = {};
    for (const id of ids) {
      const ctx = this.records[id]?.ctx;
      if (Number.isInteger(ctx) && ctx > 0) out[id] = ctx;
    }
    return out;
  }

  /** anthropic.mjs 要的那份:id → {top, efforts} */
  effortMap() {
    return effortMapOf(this.records);
  }

  /**
   * 探思考强度 + max_tokens 上限。**便宜**:两次几十字节的请求。
   *
   * 手法都是「故意发个非法值,让上游的校验器把合法范围报在错误原文里」——
   * 比逐档试快得多(逐档要 6 次,而且每次都真的算一遍),也更准:原文是上游
   * 自己说的,不是我们猜的。
   */
  async probeEfforts(model) {
    const ask = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };
    const out = {};

    // 非法档位。宽松的模型会把这个字段丢掉照常回答(200),严格的会 400 并点名合法档位
    try {
      await this.post({ ...ask, reasoning_effort: '__probe__' });
      out.efforts = null;                       // 200 = 不认也不报错,不用夹
    } catch (e) {
      if (!informative(e)) throw e;              // 连不上/限流/上游炸了都不是「探到了」
      out.efforts = parseEfforts(e?.body);
    }
    // 顶档:认 max 就用 max,不认就 high。宽松模型也得问 —— 发个它不认的 max
    // 会被丢成默认档,比 high 还弱
    out.top = out.efforts ? out.efforts[out.efforts.length - 1]
      : await this.topOf(model, ask);

    // max_tokens 上限。**best-effort**:这个值只是留档,没有任何地方拿它做判断
    // (夹档位靠 efforts/top,上下文靠 ctx),所以探不到就不记 —— 更不该因为它
    // 把上面已经探明白的 efforts/top 一起扔掉。
    //
    // 这不是理论上的顾虑:muse-spark-1.2-contributor-free(2026-08-21 上线)对
    // 什么请求都回怪状态码 —— 基线 400、非法档位 400、而 max_tokens=9e8 偏偏回
    // **429**,正文全是一个没有 error 字段的「成功壳子」。当时这一下把整轮探测
    // 掐了(429 被当成「出口被限流,停手」),于是它每次开机都探、每次都白探。
    // 真的出口限流会在上面那两次(更便宜、更正常的请求)就露出来,那两条还是照停。
    try {
      await this.post({ ...ask, max_tokens: 900_000_000 });
      out.maxOut = null;                        // 居然不校验,那就不记
    } catch (e) {
      out.maxOut = informative(e) ? parseMaxOut(e?.body) : null;
    }
    return out;
  }

  /** 宽松模型的顶档:max 打得通(且没被当成非法)就是 max */
  async topOf(model, ask) {
    try {
      await this.post({ ...ask, reasoning_effort: 'max' });
      return 'max';
    } catch (e) {
      if (!informative(e)) throw e;
      return 'high';
    }
  }

  /**
   * 探上下文上限。**贵**:一次顶探就是 6MB 出站,夹到底再加最多三次。
   * 所以只对没记录的模型探,探完就落盘,以后(包括下线又上线)直接复用。
   *
   * 一次顶探能分开三种情况,这是它值 6MB 的地方:
   *   200 且 prompt_tokens 明显少于发出去的 → 静默截断,回报的那个数就是上限
   *   400 且原文带数字                      → 校验器把上限说了,直接采信
   *   400 但原文没数字                      → 只知道「超了」,去候选表里夹
   *   200 且 prompt_tokens 对得上           → 比顶探还大,记不了准数(留 null)
   *
   * @returns {{ctx:number|null, method:string, spent:number}} spent = 花掉的出站字节
   */
  async probeContext(model, budget = CTX_BUDGET_BYTES) {
    let spent = 0;
    const send = async (n) => {
      const body = { model, messages: [{ role: 'user', content: filler(n) }], max_tokens: 1 };
      spent += JSON.stringify(body).length;
      return this.post(body);
    };

    if (JSON.stringify({ model, messages: [{ role: 'user', content: filler(CTX_PROBE_TOP) }] }).length > budget) {
      return { ctx: null, method: 'skipped-budget', spent: 0 };
    }

    let top;
    try {
      top = await send(CTX_PROBE_TOP);
    } catch (e) {
      if (!informative(e)) throw e;              // 没送到就是没探,别把网络故障记成上限
      const named = parseCtx(e?.body);
      if (named) return { ctx: named, method: 'validator', spent };
      // 原文没说上限,只能夹:候选表里最大的那个「能过」的就是答案
      const fits = async (c) => {
        if (spent >= budget) return false;
        try { await send(Math.max(1, c - CTX_MARGIN)); return true; } catch (err) {
          // 夹到一半连不上时不能把「这次没打通」当成「超限了」—— 那会夹出一个
          // 比真值小的上限,而且落盘之后不会再重探
          if (!informative(err)) throw err;
          return false;
        }
      };
      let lo = 0, hi = CTX_CANDIDATES.length - 1, best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (await fits(CTX_CANDIDATES[mid])) { best = CTX_CANDIDATES[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      return { ctx: best, method: best ? 'bracket' : 'unknown', spent };
    }

    // 没报错。截断型模型在这里露馅:它只读了前面一截,prompt_tokens 就是上限
    const got = Number(top?.usage?.prompt_tokens);
    if (Number.isInteger(got) && got > 0 && got < CTX_PROBE_TOP * 0.95) {
      return { ctx: got, method: 'truncate', spent };
    }
    return { ctx: null, method: 'over-probe', spent };
  }

  /**
   * 给清单里没有完整记录的模型补一次。开机拉完清单、内核就绪之后调这个。
   *
   * 并发调用共用同一次(和 refreshModels 一样的做法):面板上那个按钮点两下
   * 不该变成两轮出站。
   */
  probeMissing(models, { context = true } = {}) {
    if (this.probing) return this.probing;
    this.probing = this.run(models, { context }).finally(() => { this.probing = null; });
    return this.probing;
  }

  async run(models, { context }) {
    // 缺思考强度的必须补(折错档会让请求直接失败);缺上下文的只影响面板后缀。
    // 「探过但没探出数字」也算探过(ctxAt 有戳、ctx 是 null)—— 只看 ctx 是不是
    // 整数的话,over-probe / unknown 这两种**结论**会被当成故障,每次开机再花一次
    // 6MB 去问同一个问题
    const needEffort = models.filter((m) => !this.records[m]?.top);
    const needCtx = context
      ? models.filter((m) => !Number.isInteger(this.records[m]?.ctx) && !this.records[m]?.ctxAt)
      : [];
    if (!needEffort.length && !needCtx.length) return { probed: [], skipped: [], note: 'nothing-missing' };

    const probed = [];
    const skipped = [];
    let budget = CTX_BUDGET_BYTES;

    // 落盘 + 把这一轮的结果说出来,然后收工。撞限流那条路也走这里 ——
    // 早退时不记日志的话,「探到一半被限流停下」在面板上和「探完了」看起来一样,
    // 而这两件事的处置完全不同(前者点一下「补探能力」就好)
    const done = (note) => {
      this.save();
      if (probed.length) this.logger('info', `[caps] 探到 ${probed.length} 个:${probed.join(';')}`);
      // 没探到的更要说出来。少探一个模型的后果是面板少个后缀、或者档位按宽松处理,
      // 都不致命,但「悄悄少探」会让人以为表是全的
      if (skipped.length) this.logger('warn', `[caps] ${skipped.length} 个没探到:${skipped.join(',')}`);
      if (note === 'rate-limited') this.logger('warn', '[caps] 撞上限流,这一轮先停了 —— 换个出口以后点「补探能力」接着探');
      return { probed, skipped, note };
    };

    // 串行,不并发:这些请求都走同一个节点,几 MB 的并发上传只会互相拖慢,
    // 而且更容易把这个出口 IP 撞到限流上
    for (const model of needEffort) {
      try {
        const r = await this.probeEfforts(model);
        this.records[model] = { ...this.records[model], ...r, effortAt: this.stamp() };
        probed.push(`${model} 档位=${r.efforts ? r.efforts.join('/') : '宽松'} 顶档=${r.top}`);
      } catch (e) {
        skipped.push(`${model}(档位:${e?.status === 429 ? '限流' : e?.status || 'err'})`);
        if (e?.status === 429) return done('rate-limited');
      }
    }

    for (const model of needCtx) {
      try {
        const r = await this.probeContext(model, budget);
        budget -= r.spent;
        if (r.ctx) {
          this.records[model] = { ...this.records[model], ctx: r.ctx, method: r.method, ctxAt: this.stamp() };
          probed.push(`${model} 上下文=${r.ctx}(${r.method})`);
        } else {
          skipped.push(`${model}(上下文:${r.method})`);
          // 探过了,只是没探出数字。也要落一条(ctx 留 null)—— over-probe 和
          // unknown 都是**结论**,不是故障:前者说明上限比顶探还大,后者说明候选表里
          // 没有能过的。不记的话每次开机都要为它再花一次 6MB 问同一个问题。
          // skipped-budget 例外:那是「这轮没轮到」,下次该接着探。
          if (r.method !== 'skipped-budget') {
            this.records[model] = { ...this.records[model], ctx: null, method: r.method, ctxAt: this.stamp() };
          }
        }
      } catch (e) {
        skipped.push(`${model}(上下文:${e?.status === 429 ? '限流' : e?.status || 'err'})`);
        if (e?.status === 429) return done('rate-limited');
      }
    }

    return done('ok');
  }

  /** 单独一个方法是为了测试能盖掉它 —— 记录里的时间戳不该让测试变成不确定的 */
  stamp() {
    return Date.now();
  }
}
