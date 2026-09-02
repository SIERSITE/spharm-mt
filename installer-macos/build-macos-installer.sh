#!/bin/bash
#
# build-macos-installer.sh — constrói o lançador macOS do SPharm.MT e o
# instalador .pkg para o tenant `silveira`.
#
# CORRE NUM MAC. Precisa de `sips`, `iconutil`, `pkgbuild`,
# `productbuild` e `plutil` — todos vêm com o macOS (os quatro últimos
# com as Command Line Tools). Não precisa de Xcode completo, não precisa
# de rede e não precisa de privilégios.
#
# Produz:
#   dist-macos/SPharm.MT.app
#   dist-macos/Instalador-SPharmMT-Silveira.pkg
#
# Uso:
#   bash installer-macos/build-macos-installer.sh
#
# Assinatura (opcional — ver README.md):
#   SPHARMMT_SIGN_ID="Developer ID Installer: Nome (TEAMID)" \
#     bash installer-macos/build-macos-installer.sh
#
# Sem SPHARMMT_SIGN_ID o .pkg sai por assinar. É tecnicamente funcional
# e instala-se; o Gatekeeper é que pede um passo extra ao utilizador.
# Isso está documentado no README e não bloqueia a construção.

set -euo pipefail

# ── Onde estamos ─────────────────────────────────────────────────────
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/.." && pwd)"
DIST="$RAIZ/dist-macos"

APP_NOME="SPharm.MT"
APP="$DIST/$APP_NOME.app"
PKG="$DIST/Instalador-SPharmMT-Silveira.pkg"
BUNDLE_ID="com.spharmmt.launcher.silveira"
VERSAO="1.0.0"
URL_ESPERADA="https://app.spharmmt.com/login?__tenant=silveira"

log() { printf '[macos-installer] %s\n' "$*"; }
erro() { printf '[macos-installer] ERRO: %s\n' "$*" >&2; exit 1; }

# ── Pré-requisitos ───────────────────────────────────────────────────
# Verificados todos de uma vez: descobrir à terceira ferramenta que
# falta uma quarta é perder três tentativas.
FALTAM=""
for cmd in sips iconutil pkgbuild productbuild plutil; do
  command -v "$cmd" >/dev/null 2>&1 || FALTAM="$FALTAM $cmd"
done
if [ -n "$FALTAM" ]; then
  erro "ferramentas em falta:$FALTAM
  Num Mac, instala as Command Line Tools:  xcode-select --install
  Este script não corre em Linux nem em Windows — pkgbuild é do macOS."
fi

# ── Limpar ───────────────────────────────────────────────────────────
log "a limpar $DIST"
rm -rf "$DIST"
mkdir -p "$DIST"

# ── 1. Estrutura do bundle ───────────────────────────────────────────
log "a montar $APP_NOME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$AQUI/src/Info.plist" "$APP/Contents/Info.plist"
cp "$AQUI/src/SPharmMT" "$APP/Contents/MacOS/SPharmMT"

# 755: o lançador é executado por qualquer utilizador da máquina, e o
# .app fica em /Applications, que é partilhado. 700 faria a aplicação
# funcionar só para quem a instalou.
chmod 755 "$APP/Contents/MacOS/SPharmMT"
chmod 644 "$APP/Contents/Info.plist"

# `PkgInfo` é opcional no macOS moderno mas alguns utilitários antigos
# ainda o procuram, e custa oito bytes.
printf 'APPL????' > "$APP/Contents/PkgInfo"
chmod 644 "$APP/Contents/PkgInfo"

# ── 2. Ícone ─────────────────────────────────────────────────────────
#
# A fonte é o PNG 256×256 extraído do SPharmMT.ico oficial que o
# instalador Windows usa — mesmo ficheiro de origem, para os dois
# instaladores mostrarem o mesmo ícone.
#
# Acima de 256 as fatias são ampliadas. Não é ideal, mas é o que o
# ícone oficial tem: 256 é a maior resolução dentro do .ico. Se algum
# dia aparecer um master de 1024, basta substituir assets/SPharmMT-256.png
# por assets/SPharmMT-1024.png e ajustar FONTE_ICONE aqui.
FONTE_ICONE="$AQUI/assets/SPharmMT-256.png"
[ -f "$FONTE_ICONE" ] || erro "ícone de origem não encontrado: $FONTE_ICONE"

log "a gerar SPharmMT.icns a partir de $(basename "$FONTE_ICONE")"
ICONSET="$DIST/SPharmMT.iconset"
mkdir -p "$ICONSET"
gerar() { sips -z "$1" "$1" "$FONTE_ICONE" --out "$ICONSET/$2" >/dev/null 2>&1; }
gerar 16   icon_16x16.png
gerar 32   icon_16x16@2x.png
gerar 32   icon_32x32.png
gerar 64   icon_32x32@2x.png
gerar 128  icon_128x128.png
gerar 256  icon_128x128@2x.png
gerar 256  icon_256x256.png
gerar 512  icon_256x256@2x.png
gerar 512  icon_512x512.png
gerar 1024 icon_512x512@2x.png
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/SPharmMT.icns"
chmod 644 "$APP/Contents/Resources/SPharmMT.icns"
rm -rf "$ICONSET"

# ── 3. Validar o que se acabou de montar ─────────────────────────────
# Antes de empacotar, não depois: um .pkg com um bundle partido
# instala-se na mesma e a falha só aparece no Mac do utilizador.
log "a validar o bundle"
plutil -lint "$APP/Contents/Info.plist" >/dev/null \
  || erro "Info.plist inválido"

EXEC_DECLARADO="$(plutil -extract CFBundleExecutable raw -o - "$APP/Contents/Info.plist")"
[ -x "$APP/Contents/MacOS/$EXEC_DECLARADO" ] \
  || erro "CFBundleExecutable='$EXEC_DECLARADO' não existe ou não é executável"

grep -q "$URL_ESPERADA" "$APP/Contents/MacOS/SPharmMT" \
  || erro "o lançador não aponta para $URL_ESPERADA"

# ── 3b. Assinar o bundle (opcional) ──────────────────────────────────
#
# ADITIVO: sem `SPHARMMT_APP_SIGN_ID` este bloco não faz nada e o
# resultado é byte-a-byte o de antes. Nada da lógica que já passou os
# testes muda.
#
# Existe porque a notarização não olha só para o .pkg: a Apple abre o
# payload e espera que o que lá está dentro venha assinado com Developer
# ID. Assinar só o instalador deixa o bundle nu lá dentro, e a submissão
# volta rejeitada — depois de esperar pela fila da Apple, que é o pior
# sítio para descobrir isto.
#
# São por isso DUAS identidades, não uma:
#   · Developer ID Application  → assina o .app        (aqui)
#   · Developer ID Installer    → assina o .pkg        (passo 5)
#
# `--options runtime` liga o hardened runtime. Num bundle sem Mach-O não
# muda o que corre, mas é o que a notarização verifica, e um bundle sem
# essa flag é motivo documentado de rejeição.
if [ -n "${SPHARMMT_APP_SIGN_ID:-}" ]; then
  log "a assinar o bundle: $SPHARMMT_APP_SIGN_ID"
  codesign --force --timestamp --options runtime     --sign "$SPHARMMT_APP_SIGN_ID" "$APP"     || erro "codesign do bundle falhou"
  codesign --verify --strict --verbose=2 "$APP"     || erro "o bundle não passa a verificação depois de assinado"
  ASSINATURA_APP="$SPHARMMT_APP_SIGN_ID"
else
  ASSINATURA_APP="nenhuma (bundle por assinar)"
fi

# ── 4. Componente ────────────────────────────────────────────────────
#
# `--install-location /Applications` com `--component` faz o .pkg
# instalar exactamente uma coisa, no sítio certo, sem scripts.
#
# Sem `--component` o pkgbuild leva a árvore inteira do directório e o
# .pkg passaria a conter o dist-macos/ todo, incluindo o próprio .pkg se
# ele já lá estivesse.
log "a construir o componente"
COMPONENTE="$DIST/.componente.pkg"
pkgbuild \
  --component "$APP" \
  --identifier "$BUNDLE_ID" \
  --version "$VERSAO" \
  --install-location /Applications \
  "$COMPONENTE" >/dev/null

# ── 5. Distribuição ──────────────────────────────────────────────────
#
# `productbuild --synthesize` gera o Distribution a partir do
# componente, garantindo que o identificador e a versão batem certo.
# Escrever o XML à mão é a forma habitual de eles divergirem.
log "a construir o instalador"
DIST_XML="$DIST/.distribution.xml"
productbuild --synthesize --package "$COMPONENTE" "$DIST_XML" >/dev/null

# Título que aparece na janela do Installer.app. O --synthesize não o
# põe, e sem ele o instalador identifica-se pelo nome do ficheiro.
/usr/bin/sed -i '' 's|</installer-gui-script>|    <title>SPharm.MT — Silveira</title>\
</installer-gui-script>|' "$DIST_XML"

ASSINATURA="nenhuma (por assinar)"
if [ -n "${SPHARMMT_SIGN_ID:-}" ]; then
  log "a assinar com: $SPHARMMT_SIGN_ID"
  productbuild \
    --distribution "$DIST_XML" \
    --package-path "$DIST" \
    --sign "$SPHARMMT_SIGN_ID" \
    "$PKG" >/dev/null
  ASSINATURA="$SPHARMMT_SIGN_ID"
else
  productbuild \
    --distribution "$DIST_XML" \
    --package-path "$DIST" \
    "$PKG" >/dev/null
fi

rm -f "$COMPONENTE" "$DIST_XML"

# ── 6. Resumo ────────────────────────────────────────────────────────
TAM="$(du -h "$PKG" | cut -f1)"
log ""
log "────────────────────────────────────────────────────────────"
log "APP        : $APP"
log "PKG        : $PKG  ($TAM)"
log "URL        : $URL_ESPERADA"
log "bundle id  : $BUNDLE_ID"
log "assina .app : $ASSINATURA_APP"
log "assina .pkg : $ASSINATURA"
log "────────────────────────────────────────────────────────────"
log ""
log "Verificar antes de distribuir:"
log "  bash installer-macos/tests/test-macos-installer.sh"
log ""
log "Instalar localmente para testar:"
log "  sudo installer -pkg \"$PKG\" -target /"
log ""
