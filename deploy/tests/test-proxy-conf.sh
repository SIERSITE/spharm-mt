#!/usr/bin/env bash
# deploy/tests/test-proxy-conf.sh
#
# A configuração do nginx tem de estar DENTRO do directório que o compose
# monta em /etc/nginx/conf.d. Fora dele, o resultado é o pior possível:
#
#   · o container arranca;
#   · o `nginx -t` passa (verificado: um conf.d vazio é sintaxe válida);
#   · não existe nenhum `server {}`, logo o nginx não escuta em porto
#     nenhum;
#   · o healthcheck responde "Connection refused" — uma mensagem que não
#     diz nada sobre montagens nem sobre configuração em falta.
#
# Foi assim que o proxy ficou em baixo numa instalação real. Estas
# verificações fecham cada um dos elos: caminho único, instalação
# explícita (sem glob que possa não casar), conteúdo mínimo, e validação
# ANTES de o container ser recriado.
#
# Estruturais — correm sem Docker e sem rede.
#
# Saída: 0 todos os casos passaram · 1 pelo menos um falhou

# Os padrões de grep deste ficheiro procuram texto LITERAL no
# código-fonte dos scripts: as variáveis NÃO podem expandir. SC2016 é
# exactamente o comportamento pretendido, em todo o ficheiro.
# Directiva no topo, antes do primeiro comando — é o único sítio onde o
# ShellCheck a aplica ao ficheiro inteiro.
# shellcheck disable=SC2016

set -uo pipefail

DEPLOY_DIR=${DEPLOY_DIR:-/tmp/deploy}
SCRIPTS_DIR=${SCRIPTS_DIR:-${DEPLOY_DIR}/scripts}
DOCKER_DIR=${DOCKER_DIR:-${DEPLOY_DIR}/docker}
COMPOSE="${DOCKER_DIR}/docker-compose.yml"
NGINX="${DOCKER_DIR}/proxy/spharmmt.conf"
INSTALL="${SCRIPTS_DIR}/install-stack.sh"
COMMON="${SCRIPTS_DIR}/lib/common.sh"
VERIFY="${SCRIPTS_DIR}/verify-platform.sh"
PLATFORM="${SCRIPTS_DIR}/install-platform.sh"

pass=0; fail=0
C_G=$'\033[32m'; C_R=$'\033[31m'; C_0=$'\033[0m'
[ -t 1 ] || { C_G=""; C_R=""; C_0=""; }

ok_()   { printf '  %s✓%s %s\n' "$C_G" "$C_0" "$1"; pass=$((pass+1)); }
bad_()  { printf '  %s✗%s %s\n' "$C_R" "$C_0" "$1"; fail=$((fail+1)); }
assert(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then ok_ "$d"; else bad_ "$d"; fi; }
refute(){ local d=$1; shift; if "$@" >/dev/null 2>&1; then bad_ "$d"; else ok_ "$d"; fi; }
eq_()   { if [ "$2" = "$3" ]; then ok_ "$1"; else bad_ "$1 → esperado '${2}', obtido '${3}'"; fi; }

# ═════════════════════════════════════════════════════════════════════════
# 1. Um caminho canónico, uma definição
# ═════════════════════════════════════════════════════════════════════════
test_canonical_path() {
  printf '\n1. Caminho canónico\n'

  assert "common.sh define SPHARMMT_PROXY_CONF_DIR" \
    grep -q 'SPHARMMT_PROXY_CONF_DIR:=' "$COMMON"
  assert "common.sh define SPHARMMT_PROXY_CONF_FILE" \
    grep -q 'SPHARMMT_PROXY_CONF_FILE:=' "$COMMON"
  assert "o ficheiro fica DENTRO do directório montado" \
    grep -q 'SPHARMMT_PROXY_CONF_FILE:=${SPHARMMT_PROXY_CONF_DIR}/spharmmt.conf' "$COMMON"
  assert "o directório canónico é proxy/conf" \
    grep -q 'SPHARMMT_PROXY_CONF_DIR:=${SPHARMMT_ROOT}/proxy/conf' "$COMMON"

  # O caminho antigo só pode aparecer para ser detectado e removido.
  assert "caminho antigo declarado para remoção" \
    grep -q 'SPHARMMT_PROXY_CONF_LEGACY' "$COMMON"
  assert "install-stack remove o caminho antigo" \
    grep -q 'rm -f "$SPHARMMT_PROXY_CONF_LEGACY"' "$INSTALL"

  # Ninguém pode voltar a escrever fora do mount.
  refute "install-stack NÃO escreve em proxy/<ficheiro> fora de conf/" \
    grep -qE 'install .*\$\{SPHARMMT_ROOT\}/proxy/[a-z]+\.conf' "$INSTALL"
}

# ═════════════════════════════════════════════════════════════════════════
# 1b. Permissões — a causa confirmada na VPS
# ═════════════════════════════════════════════════════════════════════════
#
#   /opt/spharmmt/proxy/conf  2750 deploy:spharmmt  →  Permission denied
#
# Com `cap_drop: ALL` o nginx perde DAC_OVERRIDE, e nem o root do
# container passa por cima dos bits. Reproduzido em live-proxy.sh.
test_permissions() {
  printf '\n1b. Permissões do conf.d\n'

  assert "política numa função única em common.sh" grep -q '^ensure_proxy_dirs()' "$COMMON"
  assert "conf a 0755"  grep -q 'ensure_dir "$SPHARMMT_PROXY_CONF_DIR" 0755' "$COMMON"
  assert "certs a 0750" grep -q 'ensure_dir "${SPHARMMT_ROOT}/proxy/certs" 0750' "$COMMON"
  assert "ficheiros .conf a 0644"                  grep -q 'chmod 0644 "$f"' "$COMMON"
  assert "chaves TLS a 0640 ou mais restrito"      grep -q '^enforce_tls_key_modes()' "$COMMON"
  assert "nunca afrouxa uma chave já mais fechada" grep -q '600|400|640|440' "$COMMON"
  assert "o mecanismo (DAC_OVERRIDE) está documentado" grep -q 'DAC_OVERRIDE' "$COMMON"

  # A política genérica 2750 não pode voltar a apanhar proxy/conf.
  refute "install-platform NÃO põe proxy/conf no laço 2750" \
    bash -c "grep -A8 'local dirs=(' '$PLATFORM' | grep -q 'proxy/conf'"
  assert "install-platform usa ensure_proxy_dirs"  grep -q 'ensure_proxy_dirs' "$PLATFORM"
  assert "install-stack usa ensure_proxy_dirs"     grep -q 'ensure_proxy_dirs' "$INSTALL"

  # A validação tem de olhar para isto ANTES de recriar o container.
  assert "install-stack recusa conf.d sem r-x para others" \
    grep -q 'sem r-x para others o nginx do container não a consegue ler' "$INSTALL"
  assert "install-stack prova com o utilizador nginx real" \
    grep -q 'utilizador nginx consegue listar /etc/nginx/conf.d' "$INSTALL"
}

# ═════════════════════════════════════════════════════════════════════════
# 2. Instalação explícita, sem glob silencioso
# ═════════════════════════════════════════════════════════════════════════
test_explicit_install() {
  printf '\n2. Instalação da configuração\n'

  assert "instala no caminho canónico" \
    grep -q 'install .*"\$src" "\$SPHARMMT_PROXY_CONF_FILE"' "$INSTALL"
  # Um `for f in .../*.conf` que não casa com nada não instala nada e não
  # se queixa — foi assim que o conf.d podia acabar vazio.
  refute "sem glob a decidir se há configuração" \
    grep -qE 'for f in .*DOCKER_SRC.*/proxy/\*\.conf' "$INSTALL"
  assert "falha se a origem não existir" \
    grep -q 'configuração do nginx não encontrada' "$INSTALL"
}

# ═════════════════════════════════════════════════════════════════════════
# 3. Validação ANTES de recriar o proxy
# ═════════════════════════════════════════════════════════════════════════
test_validation_before_recreate() {
  printf '\n3. Validação antes do arranque\n'

  assert "existe validate_proxy_conf"        grep -q '^validate_proxy_conf()' "$INSTALL"
  assert "recusa conf.d vazio"               grep -q 'conf.d ficaria vazio' "$INSTALL"
  assert "exige server/listen/location/proxy_pass" \
    grep -q "for directive in 'server' 'listen' 'location' 'proxy_pass'" "$INSTALL"
  assert "corre nginx -t"                    grep -q 'nginx -t' "$INSTALL"
  assert "nginx -t usa o mount do compose" \
    grep -q 'SPHARMMT_PROXY_CONF_DIR}:/etc/nginx/conf.d:ro' "$INSTALL"
  # O nginx resolve os upstream ao carregar a configuração; sem isto o
  # `nginx -t` falhava por `web` não estar de pé, que é ordem de arranque
  # e não configuração.
  assert "nginx -t resolve o upstream sem a web de pé" \
    grep -q 'add-host "web:127.0.0.1"' "$INSTALL"

  # O `nginx -t` ABRE os ficheiros do ssl_certificate. Sem o mount dos
  # certificados, um deploy com TLS instalado abortava com "cannot load
  # certificate /etc/nginx/certs/fullchain.pem" — a acusar certificados
  # em falta que o proxy real tinha e servia. O defeito era do ambiente
  # do teste, e travava o deploy de uma configuração válida.
  assert "nginx -t monta os certificados como o compose" \
    grep -q 'proxy/certs:/etc/nginx/certs:ro' "$INSTALL"
  assert "nginx -t monta o webroot do ACME" \
    grep -q 'proxy/acme:/var/www/acme:ro' "$INSTALL"
  # Só monta o que existe: um bind mount cujo caminho falta é criado pelo
  # Docker como root, e proxy/certs root:root é uma regressão de
  # permissões — não um mount em falta.
  assert "não cria proxy/certs por engano com um mount incondicional" \
    grep -q 'if \[ -d "${SPHARMMT_ROOT}/proxy/certs" \]' "$INSTALL"
  # Com TLS instalado, a ausência dos .pem tem de ter mensagem própria: a
  # do nginx aponta um caminho de dentro do container e não diz onde ir.
  assert "diagnostica certificados em falta com TLS instalado" \
    grep -q 'spharmmt-tls.conf está instalado mas falta' "$INSTALL"

  # A ordem é o que interessa: validar depois de recriar não serve de nada.
  local n_validate n_up
  n_validate=$(grep -n '^  validate_proxy_conf$' "$INSTALL" | cut -d: -f1)
  n_up=$(grep -n '^  start_stack$' "$INSTALL" | cut -d: -f1)
  if [ -n "$n_validate" ] && [ -n "$n_up" ] && [ "$n_validate" -lt "$n_up" ]; then
    ok_ "validação corre ANTES de start_stack (${n_validate} < ${n_up})"
  else
    bad_ "validação não corre antes de start_stack (validate=${n_validate:-?} up=${n_up:-?})"
  fi
}

# ═════════════════════════════════════════════════════════════════════════
# 4. O mount do compose
# ═════════════════════════════════════════════════════════════════════════
test_compose_mount() {
  printf '\n4. Mount do compose\n'

  assert "monta PROXY_CONF_DIR em /etc/nginx/conf.d" \
    grep -q 'PROXY_CONF_DIR:-/opt/spharmmt/proxy/conf}:/etc/nginx/conf.d:ro' "$COMPOSE"
  assert "install-stack exporta PROXY_CONF_DIR" \
    grep -q 'PROXY_CONF_DIR=${SPHARMMT_PROXY_CONF_DIR}' "$INSTALL"
  assert "install-stack exporta PROXY_CERTS_DIR" \
    grep -q 'PROXY_CERTS_DIR=' "$INSTALL"
  # O default do compose tem de casar com o canónico do common.sh: são
  # dois sítios, e divergirem repõe exactamente o bug.
  assert "default do compose casa com o canónico" \
    grep -q '/opt/spharmmt/proxy/conf' "$COMPOSE"
}

# ═════════════════════════════════════════════════════════════════════════
# 5. A configuração serve mesmo alguma coisa
# ═════════════════════════════════════════════════════════════════════════
test_conf_content() {
  printf '\n5. Conteúdo da configuração\n'
  local d
  for d in server listen location proxy_pass; do
    assert "contém ${d}" grep -qE "^[[:space:]]*${d}[[:space:]{]" "$NGINX"
  done
  assert "healthz não toca no upstream" \
    bash -c "grep -A4 'location = /healthz' '$NGINX' | grep -q 'return 200'"

  # ── A armadilha da herança ───────────────────────────────────────────
  # Em nginx, UM `proxy_set_header` num `location` cancela a herança de
  # TODOS os do nível acima. O `location /` tinha um, e com ele perdia o
  # Host: o nginx caía no default `$proxy_host` e a aplicação recebia
  # `Host: spharmmt_web` — o nome do bloco upstream. Daí o
  # "Invalid Server Actions request" e, em silêncio, a resolução de
  # tenant por subdomínio a ler um host inexistente.
  refute "location / NÃO tem proxy_set_header (cancelaria a herança)" \
    bash -c "sed -n '/^    location \/ {/,/^    }/p' '$NGINX' | grep -qE '^\s*proxy_set_header'"
  assert "a armadilha está documentada no ficheiro" \
    bash -c "grep -q 'CANCELA a herança' '$NGINX'"
  # Os cabeçalhos essenciais têm de estar no nível `server`, onde são
  # herdados por todos os locations que não os redefinam.
  local h
  for h in 'Host' 'X-Real-IP' 'X-Forwarded-For' 'X-Forwarded-Proto'; do
    assert "server define ${h}" \
      bash -c "awk '/^server \{/,/^\}/' '$NGINX' | grep -qE '^\s*proxy_set_header\s+${h}\s'"
  done
  assert "proxy_pass aponta para o upstream da web" grep -q 'proxy_pass http://spharmmt_web' "$NGINX"
}

# ═════════════════════════════════════════════════════════════════════════
# 6. O verificador olha para DENTRO do container
# ═════════════════════════════════════════════════════════════════════════
test_verify_checks() {
  printf '\n6. verify-platform\n'

  assert "verifica a fonte real do bind mount" \
    grep -q 'Destination "/etc/nginx/conf.d"' "$VERIFY"
  assert "verifica o ficheiro DENTRO do container" \
    grep -q 'test -f /etc/nginx/conf.d/spharmmt.conf' "$VERIFY"
  assert "verifica que nginx -T tem server {}" \
    grep -q "nginx -T .*grep -c 'server {'" "$VERIFY"
  assert "verifica proxy_pass em nginx -T" \
    grep -q "nginx -T .*grep -q 'proxy_pass'" "$VERIFY"
  assert "/healthz tem de devolver 200"   grep -q '/healthz responde 200' "$VERIFY"
  assert "/api/health tem de devolver 200" grep -q '/api/health responde 200' "$VERIFY"
  assert "verifica conf.d atravessável por others"   grep -q 'conf.d atravessável por others' "$VERIFY"
  assert "verifica .conf legíveis por others"        grep -q 'legíveis por others' "$VERIFY"
  assert "verifica certs restrito"                   grep -q 'proxy/certs sem acesso para others' "$VERIFY"
  assert "verifica chaves TLS a 0640"                grep -q 'chaves privadas TLS a 0640' "$VERIFY"
  assert "prova com o utilizador nginx real"         grep -q 'docker exec --user nginx' "$VERIFY"
}

# ═════════════════════════════════════════════════════════════════════════
# 7. Sobrevive a install-platform e a um force-recreate
# ═════════════════════════════════════════════════════════════════════════
#
# O install-platform.sh recria a estrutura de directórios e reescreve o
# platform.env. Não pode apagar nem mover a configuração do proxy, senão
# um `update-platform.sh` a seguir recria o container sobre um conf.d
# vazio.
test_survives_reinstall() {
  printf '\n7. Sobrevive a reinstalação e recriação\n'

  # proxy/conf saiu do laço genérico de propósito (ver 1b); quem o cria,
  # com os modos certos, é o ensure_proxy_dirs chamado do ensure_structure.
  assert "install-platform cria proxy/conf via ensure_proxy_dirs" \
    bash -c "sed -n '/^ensure_structure/,/^}/p' '$PLATFORM' | grep -q 'ensure_proxy_dirs'"
  refute "install-platform NÃO apaga conteúdo de proxy/" \
    grep -qE 'rm -rf .*proxy' "$PLATFORM"
  # ensure_dir nunca apaga conteúdo — é o contrato da função.
  assert "ensure_dir declara que não apaga conteúdo" \
    grep -q 'Nunca apaga conteúdo' "$COMMON"

  # O update-platform recria containers; a configuração vem do bind mount
  # do host, não da imagem, portanto sobrevive — desde que o mount aponte
  # ao sítio certo, que é o que o ponto 4 garante.
  assert "update-platform usa o mesmo compose instalado" \
    grep -q 'SPHARMMT_COMPOSE_FILE' "${SCRIPTS_DIR}/update-platform.sh"
  assert "update-platform passa o stack.env (onde vive PROXY_CONF_DIR)" \
    grep -q 'SPHARMMT_STACK_ENV_FILE' "${SCRIPTS_DIR}/update-platform.sh"
}

# ═════════════════════════════════════════════════════════════════════════
# 8. POLICY.md no caminho canónico
# ═════════════════════════════════════════════════════════════════════════
#
# Mesma classe de problema: o bootstrap escreve-a quando
# SPHARMMT_BACKUP_DIR ainda é /opt/spharmmt/backups; depois da
# convergência para /data, o verificador procurava-a em /data/backups e
# não a encontrava.
test_backup_policy() {
  printf '\n8. POLICY.md dos backups\n'

  assert "install-platform garante a POLICY.md"   grep -q '^ensure_backup_policy()' "$PLATFORM"
  assert "corre depois da convergência do data root" \
    bash -c "[ \$(grep -n 'ensure_backup_policy$' '$PLATFORM' | head -1 | cut -d: -f1) -gt \$(grep -n '^converge_data_root()' '$PLATFORM' | cut -d: -f1) ]"
  assert "escreve no caminho canónico" \
    grep -q 'canonical="${SPHARMMT_BACKUP_DIR}/POLICY.md"' "$PLATFORM"
  assert "move a cópia do layout antigo"          grep -q 'POLICY.md movida do layout antigo' "$PLATFORM"
  assert "não sobrepõe uma existente"             grep -q 'POLICY.md já existe' "$PLATFORM"
  assert "validado no postflight"                 grep -q 'política de backups no caminho canónico' "$PLATFORM"
  assert "verify-platform continua a exigi-la"    grep -q 'POLICY.md' "$VERIFY"
}

# ═════════════════════════════════════════════════════════════════════════
main() {
  printf '\n=== Teste: configuração do reverse proxy ===\n'
  local f
  for f in "$COMPOSE" "$NGINX" "$INSTALL" "$COMMON" "$VERIFY" "$PLATFORM"; do
    if [ ! -f "$f" ]; then
      printf '  ficheiro em falta: %s\n' "$f"
      return 1
    fi
  done

  test_canonical_path
  test_permissions
  test_explicit_install
  test_validation_before_recreate
  test_compose_mount
  test_conf_content
  test_verify_checks
  test_survives_reinstall
  test_backup_policy

  printf '\n════════════════════════════════════════════\n'
  printf ' %s ok · %s falhas\n' "$pass" "$fail"
  printf '════════════════════════════════════════════\n'
  [ "$fail" -eq 0 ] || return 1
  return 0
}

main "$@"
