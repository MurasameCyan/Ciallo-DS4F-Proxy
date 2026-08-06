# syntax=docker/dockerfile:1
#
# 两段:第一段只为下内核,让它不进最终层(.gz 和 curl 都留在这儿)。
# 第二段是运行时,内容就是 node + mihomo + 本仓库的 js。
#
# 内核在构建时下载而不是入库 —— .gitignore 里 bin/ 已经这么定了。

# 这段刻意跑在目标平台(而不是 --platform=$BUILDPLATFORM)。QEMU 模拟慢,
# 但换来的是最后那句 `./mihomo -v` 真的在目标架构上执行了一次 ——
# 资产名拼错、下到半截、拿到不匹配的架构,都会在构建时当场暴露,
# 而不是等用户 docker run 之后收到 exec format error。
# 代价只有一次 gunzip 和一次 -v,可以忽略。
FROM alpine:3.20 AS kernel
ARG MIHOMO_VERSION=v1.19.29
ARG TARGETARCH
RUN apk add --no-cache curl
WORKDIR /out
RUN set -eux; \
    case "$TARGETARCH" in \
      # amd64 取 compatible:普通 amd64 包会用较新的 CPU 指令集,
      # 老机器和一些虚拟化平台上会直接 illegal instruction。
      amd64) asset="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz" ;; \
      arm64) asset="mihomo-linux-arm64-${MIHOMO_VERSION}.gz" ;; \
      *) echo "不支持的架构: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o mihomo.gz \
      "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${asset}"; \
    gunzip mihomo.gz; \
    chmod +x mihomo; \
    ./mihomo -v

FROM node:22-alpine
# ca-certificates 是给 mihomo 的:Go 从 /etc/ssl/certs 读根证书,
# 没有它拉 https 订阅会失败。Node 自己带了一套编进去的,不受影响。
RUN apk add --no-cache ca-certificates

COPY --from=kernel /out/mihomo /usr/local/bin/mihomo

WORKDIR /app
# 没有依赖要装(本项目零 npm 依赖),直接拷源码
COPY package.json ./
COPY server ./server
COPY web ./web

# 用镜像自带的 node 用户,不跑 root。只用 mixed-port 不开 TUN,
# 所以不需要 NET_ADMIN 之类的权限。
# 这里先建好 /data 并归属 node:命名卷首次创建时会继承这个属主,
# 挂上去才写得进(换成 bind mount 就得自己 chown,见 README)。
RUN mkdir -p /data && chown -R node:node /data
USER node

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=9527

# 构建标识。面板右上角显示它,「检查更新」拿它和 GitHub 上 beta 的 HEAD 比。
# 刻意放在最后:这个值每次提交都变,放前面会把后面所有层的缓存全打掉。
# 不传也能构建,只是面板显示 unknown 且不会报「有新版本」(见 server/build.mjs)。
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT

EXPOSE 9527
VOLUME ["/data"]

# 用 node 自己探活,省得为 curl/wget 再装一个包(alpine 的 wget 是 busybox 版,
# 行为和常见写法不一样)。端口由 node 读 env,不靠 shell 展开。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9527)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
