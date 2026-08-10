# deploy/docker/proxy/spharmmt-proxy-common.inc
#
# Directivas partilhadas por TODOS os server{} da plataforma (o :80 de
# diagnóstico, o :80 público que redirecciona, e os dois :443). Incluído
# de dentro de cada server{} com:
#
#     include /etc/nginx/conf.d/spharmmt-proxy-common.inc;
#
# A extensão é `.inc` e NÃO `.conf` de propósito: o nginx.conf da imagem
# faz `include /etc/nginx/conf.d/*.conf`, e um ficheiro `.conf` com
# directivas de contexto `server` seria carregado ao nível `http` — erro
# de arranque. Com `.inc`, o glob ignora-o e só é lido onde o incluímos.
#
# Existe para haver UMA definição destes cabeçalhos. Com três server{} a
# repeti-los, bastava corrigir um e esquecer os outros para o domínio
# esquecido passar a comportar-se de forma diferente — e o sintoma seria
# ou uma resolução de tenant errada, ou "Invalid Server Actions request"
# num domínio só.

# ── Limites ──────────────────────────────────────────────────────────
# 64 MB: o agent on-premise envia lotes de movimentos em JSON e os
# maiores rondam as dezenas de MB. O default do nginx (1 MB) devolvia
# 413 e o agent registava um erro que não apontava para o proxy.
client_max_body_size 64m;
client_body_timeout 120s;

# Os jobs `/api/jobs/*` podem correr até 300s (ver maxDuration nos
# handlers). Um proxy_read_timeout mais curto corta a ligação a meio e
# deixa o SyncRun eternamente RUNNING.
proxy_read_timeout 310s;
proxy_send_timeout 310s;
proxy_connect_timeout 10s;

# ── Cabeçalhos ───────────────────────────────────────────────────────
proxy_http_version 1.1;
# `$host` e não `$proxy_host`: a resolução de tenant por subdomínio lê o
# Host original. Reescrevê-lo faria todos os pedidos resolverem para o
# mesmo tenant — ou para nenhum.
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $forwarded_proto;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header Connection        "";

# A aplicação nunca deve receber estes vindos de fora: são calculados
# aqui, e aceitá-los do cliente deixaria qualquer um escolher o seu
# próprio tenant.
#
# EXCEPÇÃO, para a API dos Agents (/api/ingest/, /api/outbox/): aí o
# X-Tenant-Slug NÃO é privilégio, é credencial. A chave é comparada por
# bcrypt contra o hash DAQUELE tenant, portanto declarar um slug sem ter
# a chave correspondente não dá acesso a nada. Apagá-lo cegamente fazia
# toda a API dos Agents responder 401 missing_credentials — a chave
# chegava, o tenant não.
#
# O valor vem de $spharmmt_tenant_slug, que cada `server` põe a "" e só
# as `location` da API dos Agents preenchem. Usar uma variável em vez de
# repetir esta lista dentro de cada location evita a armadilha descrita
# a seguir.
proxy_set_header X-Tenant-Slug   $spharmmt_tenant_slug;
proxy_set_header X-Tenant-Source "";

# ATENÇÃO, e não é intuitivo: em nginx, UM `proxy_set_header` dentro de
# um `location` CANCELA a herança de TODOS os `proxy_set_header` do nível
# acima — incluindo os deste ficheiro. Nenhuma `location` da plataforma
# pode declarar `proxy_set_header` sem repetir a lista inteira. Foi
# exactamente assim que o `Host` se perdeu uma vez e a aplicação passou a
# receber `Host: spharmmt_web` (o nome do upstream).

# ── Cabeçalhos de segurança ──────────────────────────────────────────
# `always` para que sejam enviados também nas respostas de erro.
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options        "SAMEORIGIN" always;
add_header Referrer-Policy        "strict-origin-when-cross-origin" always;
# HSTS deliberadamente FORA. Anunciá-lo tranca o browser em HTTPS para
# este domínio durante max-age, e não há rollback do lado do cliente —
# só entra depois de semanas de HTTPS estável.

# ── Compressão ───────────────────────────────────────────────────────
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_min_length 1024;
gzip_types
    text/plain text/css text/javascript
    application/javascript application/json application/xml
    image/svg+xml;
