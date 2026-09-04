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

# Origens autorizadas a invocar Server Actions. É a ÚNICA configuração
# que tem mesmo de entrar no build: o Next fixa-a no bundle do servidor e
# não há forma de a ler em runtime.
#
# Sem ela, atrás do reverse proxy o `Origin` do browser não bate com o
# `Host` e cada submissão de formulário morre em "Invalid Server Actions
# request". Com NODE_ENV=production e nada definido, o build FALHA — de
# propósito: mais vale falhar aqui do que entregar uma imagem onde
# ninguém consegue autenticar-se.
ARG SERVER_ACTIONS_ALLOWED_ORIGINS=""
ARG PUBLIC_APP_URL=""
ENV SERVER_ACTIONS_ALLOWED_ORIGINS=${SERVER_ACTIONS_ALLOWED_ORIGINS} \
    PUBLIC_APP_URL=${PUBLIC_APP_URL}

# As RESTANTES envs de runtime não são precisas aqui, e é assim de
# propósito: o modo SSL e as flags de sessão são lidos em runtime
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

# ── CLI do Prisma e migrations ───────────────────────────────────────
# POST /api/admin/v1/tenants cria um cliente, e criar um cliente inclui
# aplicar o schema à base nova. O workflow faz isso com
# `npx prisma migrate deploy` (ver scripts/tenancy/_shared.ts,
# runPrismaForTenant) — um subprocesso, não uma API programática: o
# Prisma 7 não expõe migrate de forma programática estável.
#
# O standalone do Next traz só o que o traçado provou ser usado em
# runtime, e o CLI do Prisma não entra nisso. Sem estas linhas a criação
# falha no passo `apply-migrations` com a base já criada — o pior sítio
# possível para falhar. Reproduzido em stack real antes de acrescentar.
#
# Custo assumido: ~150 MB de imagem, e o processo que serve tráfego passa
# a ter ferramentas de DDL. Não é privilégio novo — o `web` já tem o role
# de aprovisionamento (CREATEDB+CREATEROLE) desde que a criação de
# clientes passou a ser feita por API. O que muda é a conveniência de
# quem já tivesse execução de código lá dentro.
# O CLI é instalado numa ÁRVORE PRÓPRIA, e não copiado pacote a pacote
# de `deps`. Duas tentativas falhadas explicam porquê:
#
#   1. copiar `node_modules/prisma` + `@prisma` deixava de fora as
#      dependências transitivas → "Cannot find module 'pathe'";
#   2. copiar `node_modules/.bin/prisma` desreferenciava o symlink e o
#      CLI procurava os seus assets dentro de `.bin/` →
#      "ENOENT ... .bin/prisma_schema_build_bg.wasm".
#
# Perseguir a lista de dependências à mão é um jogo sem fim. Um `npm
# install` isolado resolve a árvore correctamente, e em /opt não pode
# colidir com o node_modules traçado do standalone.
#
# A versão vem do package.json (mesmo intervalo do lockfile). O CLI aqui
# só corre `migrate deploy`.
#
# Os dois symlinks para /app/node_modules existem porque o CLI carrega
# `prisma.config.ts` a partir do cwd, e esse ficheiro faz
# `import "dotenv/config"` e `import { defineConfig } from "prisma/config"`
# — os dois têm de resolver a partir de /app. O Node resolve pelo
# realpath, portanto as dependências de cada um continuam a vir de /opt,
# sem contaminar o node_modules traçado do standalone.
#
# E o config É mesmo preciso: `prisma/schema.prisma` NÃO declara `url` no
# bloco datasource — quem a fornece é o config, a partir de DATABASE_URL.
COPY --chown=nextjs:nodejs package.json ./package.json
RUN PRISMA_VERSION=$(node -p "require('/app/package.json').devDependencies.prisma || require('/app/package.json').dependencies.prisma") \
 && DOTENV_VERSION=$(node -p "require('/app/package.json').dependencies.dotenv") \
 && npm install --prefix /opt/prisma-cli --no-save --no-audit --no-fund \
      "prisma@${PRISMA_VERSION}" "dotenv@${DOTENV_VERSION}" \
 && mkdir -p /app/node_modules/.bin \
 && ln -sf /opt/prisma-cli/node_modules/prisma/build/index.js /app/node_modules/.bin/prisma \
 && rm -rf /app/node_modules/prisma /app/node_modules/dotenv \
 && ln -sfn /opt/prisma-cli/node_modules/prisma /app/node_modules/prisma \
 && ln -sfn /opt/prisma-cli/node_modules/dotenv /app/node_modules/dotenv \
 && chown -h nextjs:nodejs /app/node_modules/.bin/prisma \
      /app/node_modules/prisma /app/node_modules/dotenv

# Prova, no build, de que o CLI carrega mesmo. Sem isto a falha aparecia
# em produção, a meio de uma criação de cliente, com a base do tenant já
# criada — e cada diagnóstico custava reconstruir a stack inteira.
#
# Foram precisas cinco voltas para lá chegar: symlink desreferenciado,
# `.bin` inexistente, dependências transitivas em falta, e por fim o
# `dotenv` que o Next traça PARCIALMENTE (fica com `lib/` e sem
# `config.js`), sobre o qual um `ln -sfn` criava um link aninhado em vez
# de substituir. Nenhuma delas era visível sem correr.
RUN cd /app \
 && node -e "require.resolve('dotenv/config')" \
 && node -e "require.resolve('prisma/config')" \
 && node node_modules/.bin/prisma --version >/dev/null \
 && echo "[build] CLI do Prisma operacional no runner"
COPY --chown=nextjs:nodejs prisma ./prisma
COPY --chown=nextjs:nodejs prisma-control ./prisma-control
COPY --chown=nextjs:nodejs prisma.config.ts prisma-control.config.ts ./

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

# Só o que as migrations e os comandos operacionais tocam. Copiar o
# repositório inteiro traria `.next`, notas e artefactos que nada disto
# usa, e tornaria o cache inútil a cada alteração de UI.
#
# `scripts/` é copiado por sub-directório e não inteiro (ver
# deploy/tests/test-dockerfile-copy.sh, que verifica que cada COPY existe
# mesmo em HEAD). O que entra é o que os comandos de
# deploy/docker/tools-scripts.txt precisam — e o RUN de auditoria no fim
# deste estágio prova que não falta nenhum.
#
# `scripts/admin` faltava, e o sintoma só aparecia na VPS, ao criar o
# primeiro cliente:
#   npm run tenant:create → ERR_MODULE_NOT_FOUND /app/scripts/admin/create-client.ts
#
# Copiam-se FICHEIROS e não a pasta: `scripts/admin` tem 45 ficheiros e
# 43 são ad-hoc de investigação, que nada têm que ver com operar a stack.
# Os dois que entram são os que os comandos operacionais usam — e não é
# palpite: `audit-tools-entrypoints.mjs --list` calcula o fecho
# transitivo dos imports e diz exactamente quais são.
COPY package.json package-lock.json tsconfig.json ./
COPY prisma.config.ts ./
COPY prisma-control.config.ts ./
COPY prisma ./prisma
COPY prisma-control ./prisma-control
COPY lib ./lib
COPY scripts/control ./scripts/control
COPY scripts/tenancy ./scripts/tenancy
COPY scripts/admin/create-client.ts scripts/admin/reset-user-password.ts \
     scripts/admin/package-agent.ts ./scripts/admin/
# Idem para `scripts/catalog-master`: a maioria dos ficheiros é de
# investigação do catálogo (builders, matrizes, relatórios, simulador) e
# corre na máquina de quem analisa. Os que entram são os operacionais —
# o bootstrap do catálogo por ordem de execução, a auditoria de
# pré-selecção e os três comandos do catálogo global — e todos correm no
# servidor contra a base do tenant, resolvida por `--tenant=<slug>`
# (ver lib/catalog/target-db.ts). A lista autoritativa é
# `tools-scripts.txt`, e o `RUN` de auditoria abaixo obriga-as a bater
# certo.
#
# O `knowledge-enrich` já faltou aqui, com o mesmo sintoma do
# `scripts/admin`: ERR_MODULE_NOT_FOUND, só na VPS, ao correr o canary.
COPY scripts/catalog-master/seed-utilizacoes.ts \
     scripts/catalog-master/classify-backfill.ts \
     scripts/catalog-master/fill-rules.ts \
     scripts/catalog-master/backfill-utilizacoes.ts \
     scripts/catalog-master/audit-knowledge-preselection.ts \
     scripts/catalog-master/project-global-catalog.ts \
     scripts/catalog-master/bootstrap-global-catalog.ts \
     scripts/catalog-master/forma-canary.ts \
     scripts/catalog-master/promote-global-knowledge.ts \
     scripts/catalog-master/knowledge-enrich.ts ./scripts/catalog-master/
# Diagnosticos read-only. Nao estao em tools-scripts.txt de proposito:
# nao sao comandos oficiais, sao instrumentos de medicao pontual,
# corridos com `run --rm migrate npx tsx scripts/diagnostics/<x>.ts`.
# Vao na imagem para nao ser preciso monta-los de fora a cada vez.
COPY scripts/diagnostics ./scripts/diagnostics
COPY scripts/env-doctor.ts ./scripts/env-doctor.ts
# `seed-taxonomy` é o PRIMEIRO passo do bootstrap do catálogo e vive na
# raiz de scripts/, não em catalog-master/. Sem ele, o `fill-rules`
# encontra "0 nível 1, 0 nível 2" e não classifica nada.
COPY scripts/seed-taxonomy.ts ./scripts/seed-taxonomy.ts
# A sequência de vendas: classificar o tipo de documento, propagar a
# classificação ao staging já ingerido, reagregar e reconciliar.
#
# `classify-tipodoc` faltava, e o sintoma foi o de sempre — só na VPS, a
# meio da correcção do universo de vendas:
#   npm run ingest:classify-tipodoc → ERR_MODULE_NOT_FOUND /app/scripts/classify-tipodoc.ts
#
# `scripts/vendas/` entra inteiro porque tem exactamente estes dois
# ficheiros e ambos são operacionais — ao contrário de `scripts/admin`
# e `scripts/catalog-master`, onde a maioria é investigação.
COPY scripts/classify-tipodoc.ts ./scripts/classify-tipodoc.ts
COPY scripts/reclassify-ingest-vendas.ts ./scripts/reclassify-ingest-vendas.ts
COPY scripts/vendas ./scripts/vendas
COPY --from=builder /app/generated ./generated

# Auditoria: cada comando de tools-scripts.txt tem de ter o seu ficheiro
# de entrada AQUI. Falhar agora custa um build; não falhar custa
# descobrir na VPS, com o operador a meio de um onboarding.
COPY deploy/docker/tools-scripts.txt deploy/docker/audit-tools-entrypoints.mjs ./deploy/docker/
RUN node deploy/docker/audit-tools-entrypoints.mjs /app

COPY deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# A revisão, para que a imagem se identifique:
#
#     docker image inspect spharmmt-app:local-migrator \
#       --format '{{range .Config.Env}}{{println .}}{{end}}' | grep APP_REVISION
#
# O `runner` já carimbava a sua (serve-a em /api/health); esta faltava, e
# a falta custou caro. Como o `deploy-app.sh` constrói apenas `web`, a
# imagem do migrator fica para trás a cada deploy rápido — e não havia
# forma de saber ONDE ficou. O sintoma foi um `Cannot find module
# '../../lib/operational/motor-stock'` a meio de um diagnóstico: código
# de uma revisão sobre bibliotecas de outra, sem nada que o dissesse.
# Uma imagem que não sabe dizer o que traz obriga a adivinhar.
ARG APP_REVISION=unknown
ENV APP_REVISION=${APP_REVISION}

# Corre como root de propósito: é um container efémero, sem porto
# aberto, que só existe durante a migration e cujo único interlocutor é
# o PostgreSQL na rede interna.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["migrate"]
