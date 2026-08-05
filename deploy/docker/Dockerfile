# deploy/docker/Dockerfile
#
# Imagem da aplicação SPharm.MT. Contexto de build = raiz do repositório:
#   docker build -f deploy/docker/Dockerfile -t spharmmt-app:local .
#
# Três alvos, com fronteiras deliberadas:
#
#   runner    (default)  → web e worker. Build standalone do Next, sem
#                          devDependencies, sem CLI do Prisma, sem
#                          código-fonte. Corre como utilizador não-root.
#   migrator             → só para `prisma migrate deploy` e scripts de
#                          tenancy. Leva a toolchain completa porque
#                          precisa dela; nunca serve tráfego.
#   builder / deps       → intermédios.
#
# Porquê duas imagens: as migrations NÃO correm durante o build (era o
# que o script `build` fazia) nem no arranque do servidor web. Um build
# que aplica migrations obriga a ter a base acessível para compilar, faz
# de cada build um evento irreversível, e num deploy com várias réplicas
# fá-las competir pela mesma migration. Ficam num container próprio, que
# corre uma vez, é observável e cujo código de saída decide se a stack
# arranca.

# ═════════════════════════════════════════════════════════════════════
ARG NODE_IMAGE=node:24-bookworm-slim

# ═════════════════════════════════════════════════════════════════════
# base — o que todos os estágios partilham
# ═════════════════════════════════════════════════════════════════════
FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # O puppeteer NÃO descarrega o seu próprio Chromium: no runner usamos
    # o do sistema (ver PUPPETEER_EXECUTABLE_PATH mais abaixo). Sem isto,
    # cada `npm ci` puxa ~180 MB que depois não são usados.
    PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /app

# ═════════════════════════════════════════════════════════════════════
# deps — dependências completas (inclui dev: prisma CLI, tsx, tipos)
# ═════════════════════════════════════════════════════════════════════
FROM base AS deps
# `npm ci` exige o lockfile e respeita-o exactamente — é o que torna o
# build reproduzível. `--include=dev` porque o builder precisa do
# TypeScript e do CLI do Prisma.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# ═════════════════════════════════════════════════════════════════════
# builder — prisma generate + next build
# ═════════════════════════════════════════════════════════════════════
FROM deps AS builder

COPY . .

# Clientes Prisma. Correm em generate puro: não abrem ligação nenhuma,
# portanto não é preciso base de dados para construir a imagem.
RUN npx prisma generate --config prisma.config.ts \
 && npx prisma generate --config prisma-control.config.ts

# Revisão do código, visível em /api/health. Passada pelo install-stack.sh
# a partir do git.
ARG APP_REVISION=unknown
ENV APP_REVISION=${APP_REVISION}

# NENHUMA env de runtime é necessária aqui, e é assim de propósito: o
# URL público, o modo SSL e as flags de sessão são lidos em runtime
# (lib/runtime-config.ts), para que a MESMA imagem sirva a VPS, um
# domínio com TLS ou um ambiente de testes.
RUN npm run build

# ═════════════════════════════════════════════════════════════════════
# runner — web e worker
# ═════════════════════════════════════════════════════════════════════
FROM base AS runner

# Chromium do sistema para o puppeteer (relatórios PDF). Opcional: com
# --build-arg INSTALL_CHROMIUM=0 a imagem fica ~400 MB mais leve e a
# rota /api/reports/pdf passa a falhar — é a única coisa que perde.
ARG INSTALL_CHROMIUM=1
RUN if [ "$INSTALL_CHROMIUM" = "1" ]; then \
      apt-get update \
   && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
   && rm -rf /var/lib/apt/lists/* ; \
    else \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates \
   && rm -rf /var/lib/apt/lists/* ; \
    fi
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Utilizador não-root dedicado. UID/GID fixos para que os bind mounts de
# logs tenham dono previsível no host.
RUN groupadd --system --gid 10001 nodejs \
 && useradd --system --uid 10001 --gid nodejs --home /app --shell /usr/sbin/nologin nextjs

# O build standalone traz o `server.js` e apenas o subconjunto de
# node_modules que o traçado provou ser usado.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# `public/` e `.next/static` NÃO vêm no standalone — sem estas duas
# linhas a aplicação arranca e serve HTML sem CSS nem JS.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Scheduler (JS puro, sem dependências) e entrypoint.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/workers/scheduler.mjs ./scripts/workers/scheduler.mjs
COPY --chown=nextjs:nodejs deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

ARG APP_REVISION=unknown
ENV APP_REVISION=${APP_REVISION} \
    PORT=3000 \
    HOSTNAME=0.0.0.0

USER nextjs
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["web"]

# ═════════════════════════════════════════════════════════════════════
# migrator — prisma migrate deploy + scripts de tenancy
# ═════════════════════════════════════════════════════════════════════
FROM deps AS migrator

# O CLI do Prisma sonda a versão do OpenSSL para escolher o motor certo.
# Sem ele as migrations até correm, mas cada comando imprime duas linhas
# a pedir a instalação — ruído que faz um operador desconfiar de um
# `migrate deploy` que na verdade correu bem.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Só o que as migrations e os scripts de tenancy tocam. Copiar o
# repositório inteiro traria `.next`, notas e artefactos que nada disto
# usa, e tornaria o cache inútil a cada alteração de UI.
#
# `scripts/` é copiado por sub-directório e não inteiro: destes dois saem
# todos os caminhos de migração (ver deploy/tests/test-dockerfile-copy.sh,
# que verifica que cada COPY existe mesmo em HEAD). Os restantes ~100
# scripts ad-hoc de investigação não têm nada que ver com migrations.
COPY package.json package-lock.json tsconfig.json ./
COPY prisma.config.ts ./
COPY prisma-control.config.ts ./
COPY prisma ./prisma
COPY prisma-control ./prisma-control
COPY lib ./lib
COPY scripts/control ./scripts/control
COPY scripts/tenancy ./scripts/tenancy
COPY --from=builder /app/generated ./generated

COPY deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Corre como root de propósito: é um container efémero, sem porto
# aberto, que só existe durante a migration e cujo único interlocutor é
# o PostgreSQL na rede interna.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["migrate"]
