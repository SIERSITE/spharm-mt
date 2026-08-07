#!/usr/bin/env bash
# deploy/scripts/renew-hook.sh
#
# Deploy-hook do certbot. Instalado em
# /etc/letsencrypt/renewal-hooks/deploy/spharmmt.sh, corre depois de CADA
# renovação bem sucedida.
#
# Porque é obrigatório: o certbot escreve em /etc/letsencrypt/live/, que
# NÃO está montado no container do nginx. Sem este hook a renovação corre
# com sucesso, o certbot regista "Congratulations", e o nginx continua a
# servir o certificado antigo até ele expirar. É uma falha silenciosa com
# 90 dias de atraso entre a causa e o sintoma — e o sintoma é o site
# inteiro a ser recusado pelos browsers.
#
# Idempotente: pode ser corrido à mão a qualquer momento (é assim que se
# faz a primeira cópia, antes de haver renovação nenhuma).
#
# Testar sem esperar 60 dias:
#     sudo certbot renew --dry-run
# (o --dry-run corre os deploy-hooks a sério)

set -euo pipefail

DOMAIN="${SPHARMMT_CERT_DOMAIN:-admin.spharmmt.pt}"
LIVE_DIR="/etc/letsencrypt/live/${DOMAIN}"
CERTS_DIR="${SPHARMMT_ROOT:-/opt/spharmmt}/proxy/certs"
PROXY_CONTAINER="${SPHARMMT_PROXY_CONTAINER:-spharmmt-proxy}"
GROUP="${SPHARMMT_GROUP:-spharmmt}"

log() { printf '[renew-hook] %s\n' "$1"; }
die() { printf '[renew-hook] ERRO: %s\n' "$1" >&2; exit 1; }

[ -d "$LIVE_DIR" ]  || die "não existe ${LIVE_DIR} — o certificado foi emitido para outro nome? (SPHARMMT_CERT_DOMAIN)"
[ -d "$CERTS_DIR" ] || die "não existe ${CERTS_DIR} — é o directório montado em /etc/nginx/certs"

# `install` copia com o modo final numa operação, sem passar por um
# instante em que a chave privada esteja legível a mais gente.
#
# 0640 na chave e não 0644: o verify-platform.sh reprova qualquer
# ficheiro de chave com permissões para `others` neste directório.
install -m 0644 -o root -g "$GROUP" "${LIVE_DIR}/fullchain.pem" "${CERTS_DIR}/fullchain.pem"
install -m 0640 -o root -g "$GROUP" "${LIVE_DIR}/privkey.pem"   "${CERTS_DIR}/privkey.pem"
log "certificados copiados para ${CERTS_DIR}"

# Se o proxy não estiver a correr não é erro: na primeira execução ainda
# pode não estar de pé, e os ficheiros já ficaram no sítio certo.
if ! docker ps --format '{{.Names}}' | grep -qx "$PROXY_CONTAINER"; then
  log "container ${PROXY_CONTAINER} não está a correr — ficheiros copiados, sem reload"
  exit 0
fi

# Validar ANTES de recarregar. Um `nginx -s reload` com configuração
# inválida deixa o processo antigo a servir (bom), mas mascara o
# problema até ao próximo restart (mau) — é aí que ele reaparece, já sem
# ninguém a olhar.
if ! docker exec "$PROXY_CONTAINER" nginx -t >/dev/null 2>&1; then
  docker exec "$PROXY_CONTAINER" nginx -t || true
  die "configuração do nginx inválida — NÃO foi recarregada"
fi

docker exec "$PROXY_CONTAINER" nginx -s reload
log "nginx recarregado"

# Confirmar que o que está a ser servido é mesmo o certificado novo.
# Sem isto o hook podia terminar com sucesso tendo o nginx ficado com o
# antigo em memória — que é exactamente a falha que este ficheiro existe
# para impedir.
served=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null \
         | openssl x509 -noout -enddate 2>/dev/null || true)
ondisk=$(openssl x509 -noout -enddate -in "${CERTS_DIR}/fullchain.pem" 2>/dev/null || true)
if [ -n "$served" ] && [ -n "$ondisk" ] && [ "$served" != "$ondisk" ]; then
  die "o nginx continua a servir um certificado diferente do que está em disco (servido: ${served}; disco: ${ondisk})"
fi
[ -n "$served" ] && log "validade servida: ${served}"

log "concluído"
