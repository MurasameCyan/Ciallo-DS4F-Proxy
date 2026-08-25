/**
 * proxy.mjs —— 经本地 mihomo 出站的 HTTPS 通道。
 *
 * 这个文件存在的理由是修一个真 bug。desktop-app/gateway.js 里两处这样写:
 *
 *   agent: new https.Agent({ proxy: `http://127.0.0.1:${MIHOMO_PROXY_PORT}` })
 *
 * 而 https.Agent 没有 proxy 这个选项 —— 键被存进对象里,Agent 实现从没读过它。
 * 所以桌面版所有"经节点出站"的请求实际都是直连,mihomo 被完全绕过,
 * 429 换节点换了也没用:出口 IP 一直是本机。整个项目的立论功能是空转的。
 *
 * 正确做法是自己走 HTTP CONNECT:先让 mihomo 把 TCP 打到目标,再在这条隧道
 * 之上做 TLS。两个 caller(非流式 / 流式)共用这里一份实现,不各改一遍。
 */

import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';

/** 向本地 mihomo 的 mixed-port 发 CONNECT,拿到一条通往 host:port 的裸 TCP 隧道 */
export function connectTunnel({ proxyPort, host, port = 443, timeout = 15_000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: proxyPort });
    let buf = '';
    let done = false;

    const fail = (msg) => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(new Error(msg));
    };

    sock.setTimeout(timeout);
    sock.once('timeout', () => fail(`CONNECT 超时(mihomo ${proxyPort} 无响应)`));
    sock.once('error', (e) => fail(`连不上 mihomo ${proxyPort}: ${e.message}`));

    sock.once('connect', () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });

    // 刻意用 readable + read() 而不是 'data' 事件:'data' 会把流切到 flowing 模式,
    // 那种模式下 unshift 回去的字节没有消费者接,会被直接丢掉 —— TLS 于是永远
    // 等不到 ServerHello,整条请求挂死。paused 模式下 unshift 的数据会留在缓冲里,
    // 等 tls.connect 接手时照常读到。
    const onReadable = () => {
      let chunk;
      while ((chunk = sock.read()) !== null) {
        buf += chunk.toString('latin1');
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) {
          // 正常响应头就百来字节,超了说明对端不是 HTTP 代理
          // (比如把 external-controller 的端口填到这儿了)
          if (buf.length > 8192) return fail('CONNECT 响应头异常(对端可能不是 HTTP 代理)');
          continue;
        }
        const status = Number(buf.slice(0, end).split('\r\n')[0].split(' ')[1]);
        if (status !== 200) return fail(`代理拒绝 CONNECT: HTTP ${status}`);

        done = true;
        sock.removeListener('readable', onReadable);
        sock.setTimeout(0);
        // read() 很可能连响应头后面的 TLS 字节一起读进来了,得还回去
        const rest = buf.slice(end + 4);
        if (rest) sock.unshift(Buffer.from(rest, 'latin1'));
        return resolve(sock);
      }
    };
    sock.on('readable', onReadable);
  });
}

/**
 * 把隧道包成 Agent,给 https.request 用。
 *
 * keepAlive 必须关:换节点后旧隧道还挂在旧节点的出口 IP 上,复用它等于没换。
 * 每个请求开一条新隧道,慢一点点,但换 IP 这件事才是真的。
 */
export class MihomoAgent extends https.Agent {
  constructor(proxyPort) {
    super({ keepAlive: false, maxSockets: 32 });
    this.proxyPort = proxyPort;
  }

  createConnection(options, cb) {
    const host = options.host;
    const port = Number(options.port) || 443;
    connectTunnel({ proxyPort: this.proxyPort, host, port })
      .then((sock) => {
        // TCP 层 keepalive:推理模型思考几分钟一个字节都不吐,中间的 NAT/防火墙
        // 会把「没流量」的连接当死链掐掉 —— 日志里的 [stream] 中断: aborted 就是
        // 这个。keepalive 探测包让链路一直被认成活跃。连接复用是关着的,这只影响
        // 当前请求自己的隧道。
        sock.setKeepAlive(true, 15_000);
        cb(null, tls.connect({
          ...options,                   // 把调用方的 TLS 选项(ca / rejectUnauthorized 等)带上
          socket: sock,
          servername: options.servername || host,  // 自建 socket 时 SNI 不会自动带,得显式给
          ALPNProtocols: ['http/1.1'],  // Node 的 https 客户端不会 h2,别让上游谈上去
        }));
      })
      .catch(cb);
  }
}
