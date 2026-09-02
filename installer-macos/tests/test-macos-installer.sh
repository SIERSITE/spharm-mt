#!/bin/bash
#
# test-macos-installer.sh — verificações do lançador macOS do SPharm.MT.
#
# Duas camadas, de propósito:
#
#   A. ESTÁTICAS — sobre as fontes em installer-macos/src/. Correm em
#      qualquer sistema, incluindo a máquina Windows onde isto foi
#      escrito. É o que garante que as fontes não regridem entre builds.
#
#   B. ARTEFACTOS — sobre dist-macos/. Só correm num Mac, depois do
#      build-macos-installer.sh. Saltam com aviso se o dist não existir,
#      em vez de falharem: não ter construído ainda não é um defeito.
#
# Uso:
#   bash installer-macos/tests/test-macos-installer.sh
#
# Exit 0 se nada falhou.

set -u

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$(cd "$AQUI/.." && pwd)"
RAIZ="$(cd "$BASE/.." && pwd)"
DIST="$RAIZ/dist-macos"
APP="$DIST/SPharm.MT.app"
PKG="$DIST/Instalador-SPharmMT-Silveira.pkg"

URL="https://app.spharmmt.com/login?__tenant=silveira"

ok=0; ko=0; saltados=0
v() {
  if [ "$1" = "0" ]; then ok=$((ok+1)); printf '  [OK]    %s\n' "$2"
  else ko=$((ko+1)); printf '  [FALHA] %s%s\n' "$2" "${3:+  — $3}"; fi
}
salta() { saltados=$((saltados+1)); printf '  [SALTA] %s%s\n' "$1" "${2:+  — $2}"; }

# ═════════════════════════════════════════════════════════════════════
# A. ESTÁTICAS — fontes
# ═════════════════════════════════════════════════════════════════════
echo ""
echo "=== A1. ficheiros de origem presentes ==="
for f in src/Info.plist src/SPharmMT build-macos-installer.sh assets/SPharmMT-256.png; do
  [ -f "$BASE/$f" ]; v $? "existe $f"
done

echo ""
echo "=== A2. Info.plist é XML válido e coerente ==="
PLIST="$BASE/src/Info.plist"
# `command -v python3` nao chega: no Windows encontra o stub da
# Microsoft Store, que existe no PATH e imprime um erro em vez de
# correr. Testa-se a execucao.
PY=""
for cand in python3 python py; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import sys" >/dev/null 2>&1; then
    PY="$cand"; break
  fi
done

if [ -n "$PY" ]; then
  # `plutil` só existe no macOS. Um parse de XML mais uma leitura das
  # chaves cobre o mesmo em qualquer sistema, e é isso que permite
  # apanhar um plist partido antes de chegar ao Mac.
  "$PY" - "$PLIST" <<'PYEOF'
import sys, plistlib, xml.etree.ElementTree as ET
caminho = sys.argv[1]
ET.parse(caminho)                       # rebenta se o XML for inválido
with open(caminho, "rb") as fh:
    d = plistlib.load(fh)
esperado = {
    "CFBundleName": "SPharm.MT",
    "CFBundleDisplayName": "SPharm.MT",
    "CFBundleExecutable": "SPharmMT",
    "CFBundleIconFile": "SPharmMT",
    "CFBundleIdentifier": "com.spharmmt.launcher.silveira",
    "CFBundlePackageType": "APPL",
}
erros = [f"{k}={d.get(k)!r} (esperado {esp!r})"
         for k, esp in esperado.items() if d.get(k) != esp]
if d.get("NSHighResolutionCapable") is not True:
    erros.append("NSHighResolutionCapable não é true")
if not d.get("LSMinimumSystemVersion"):
    erros.append("LSMinimumSystemVersion em falta")
if erros:
    print("; ".join(erros)); sys.exit(1)
sys.exit(0)
PYEOF
  v $? "XML válido e as chaves do bundle estão certas"
else
  salta "validação do Info.plist" "sem python disponível"
fi

echo ""
echo "=== A3. o lançador ==="
LAUNCHER="$BASE/src/SPharmMT"
bash -n "$LAUNCHER" 2>/dev/null; v $? "sintaxe de shell válida"
head -1 "$LAUNCHER" | grep -q '^#!/bin/bash$'; v $? "shebang /bin/bash"
grep -qF "$URL" "$LAUNCHER"; v $? "aponta para a URL do tenant silveira"

# A ordem importa: Chrome tem de ser procurado ANTES do Edge.
LINHA_CHROME="$(grep -n 'Google Chrome' "$LAUNCHER" | head -1 | cut -d: -f1)"
LINHA_EDGE="$(grep -n 'Microsoft Edge' "$LAUNCHER" | head -1 | cut -d: -f1)"
[ -n "$LINHA_CHROME" ] && [ -n "$LINHA_EDGE" ] && [ "$LINHA_CHROME" -lt "$LINHA_EDGE" ]
v $? "Chrome é procurado antes do Edge" "chrome=$LINHA_CHROME edge=$LINHA_EDGE"

grep -q -- '--app=' "$LAUNCHER"; v $? "usa modo aplicação (--app=)"
grep -q -- '--user-data-dir=' "$LAUNCHER"; v $? "usa perfil dedicado (--user-data-dir)"
grep -q 'Application Support/SPharm.MT' "$LAUNCHER"; v $? "o perfil vive fora do perfil normal do browser"
grep -q '/usr/bin/open' "$LAUNCHER"; v $? "cai no browser predefinido quando não há Chrome nem Edge"
grep -q 'password_manager_enabled' "$LAUNCHER"; v $? "desliga o gestor de passwords do perfil"
grep -q -- '--password-store=basic' "$LAUNCHER"; v $? "não pede acesso ao Porta-chaves"

echo ""
echo "=== A4. o que NÃO pode lá estar ==="
# Este lançador não é o agent. Se alguma destas aparecer, alguém
# misturou o instalador da aplicação com o de recolha de dados.
for proibido in ingestKey ingest_key INGEST_KEY tenantSlug sqlServer BLOB_READ_WRITE_TOKEN; do
  ! grep -qi "$proibido" "$LAUNCHER"
  v $? "sem \"$proibido\" no lançador"
done

# `password` nao pode ser proibida em bruto: as unicas ocorrencias
# legitimas sao precisamente as que DESLIGAM a gravacao de passwords.
# Proibir a palavra fazia falhar a medida que se queria garantir. O que
# nao pode existir e uma password com valor.
RESTO="$(sed -e 's/password_manager_leak_detection//g'              -e 's/password_manager_enabled//g'              -e 's/--password-store=basic//g'              -e 's/passwords//g'              -e 's/password do utilizador//g'              -e 's/a password é escrita//g' "$LAUNCHER" | grep -ic password)"
[ "$RESTO" -eq 0 ]
v $? "sem qualquer password além das opções que a desligam" "restantes=$RESTO"
! grep -rqi "spharmmt\.app" "$BASE"; v $? "sem o domínio antigo em installer-macos/"

echo ""
echo "=== A5. o script de build ==="
BUILD="$BASE/build-macos-installer.sh"
bash -n "$BUILD" 2>/dev/null; v $? "sintaxe de shell válida"
grep -q 'pkgbuild' "$BUILD"; v $? "usa pkgbuild"
grep -q 'productbuild' "$BUILD"; v $? "usa productbuild"
grep -q -- '--install-location /Applications' "$BUILD"; v $? "instala em /Applications"
grep -q 'Instalador-SPharmMT-Silveira.pkg' "$BUILD"; v $? "produz o nome de .pkg pedido"
grep -q 'chmod 755' "$BUILD"; v $? "torna o lançador executável"
grep -q 'SPHARMMT_SIGN_ID' "$BUILD"; v $? "aceita assinatura, sem a exigir"
! grep -qi 'electron\|node_modules\|\.dmg' "$BUILD"; v $? "sem Electron nem runtimes pesados"

echo ""
echo "=== A6. o ícone de origem é o oficial do Windows ==="
ICO="$RAIZ/installer/SPharmMT.Installer/assets/SPharmMT.ico"
PNG="$BASE/assets/SPharmMT-256.png"
if [ -n "$PY" ] && [ -f "$ICO" ]; then
  "$PY" - "$ICO" "$PNG" <<'PYEOF'
import sys, struct, hashlib
ico, png = sys.argv[1], sys.argv[2]
d = open(ico, "rb").read()
_, _, n = struct.unpack("<HHH", d[:6])
melhor = None
for i in range(n):
    off = 6 + i * 16
    w, h, _, _, _, _, size, offset = struct.unpack("<BBBBHHII", d[off:off+16])
    w = w or 256
    if d[offset:offset+8] == b"\x89PNG\r\n\x1a\n" and (melhor is None or w > melhor[0]):
        melhor = (w, d[offset:offset+size])
if melhor is None:
    print("o .ico oficial não tem nenhuma fatia PNG"); sys.exit(1)
esperado = hashlib.sha256(melhor[1]).hexdigest()
obtido = hashlib.sha256(open(png, "rb").read()).hexdigest()
if esperado != obtido:
    print(f"o PNG divergiu do .ico oficial ({obtido[:12]} != {esperado[:12]})")
    sys.exit(1)
sys.exit(0)
PYEOF
  v $? "byte-a-byte igual à maior fatia do SPharmMT.ico oficial"
else
  salta "comparação com o .ico oficial" "sem python ou sem o .ico"
fi

echo ""
echo "=== A7. comportamento do lançador (simulação) ==="
# O lançador procura em "/Applications" e em "$HOME/Applications".
# `$HOME` controla-se; `/Applications` não — e num runner macOS da
# GitHub o Chrome e o Edge REAIS estão instalados lá. Sem isolar a
# primeira base, o caso "só Edge instalado" escolheria o Chrome
# verdadeiro da máquina e falharia por razões alheias ao código.
#
# Corre-se por isso uma CÓPIA do lançador com a base de sistema apontada
# para dentro do temporário. É a substituição de uma cadeia; tudo o resto
# é o ficheiro real. A verificação logo abaixo garante que a substituição
# aconteceu — sem ela, o teste passaria a medir a máquina em vez do
# lançador, e a passar por engano.
SIM="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/sim-spharmmt-$$")"
mkdir -p "$SIM/Sistema"

# O `/usr/bin/open` do ramo de recurso tem o mesmo problema, ao
# contrário: num Mac EXISTE, e o teste abriria mesmo um browser na
# máquina de CI. Substituído por um duplo que regista o que recebeu — o
# que também torna a verificação mais forte: deixa de bastar chegar ao
# ramo, passa a ser preciso passar-lhe a URL certa.
LANCADOR_SIM="$SIM/SPharmMT.sim"
sed -e 's|"/Applications"|"$HOME/Sistema"|'     -e 's|/usr/bin/open|"$HOME/open-falso"|' "$LAUNCHER" > "$LANCADOR_SIM"
printf '#!/bin/bash
printf "ABERTO=%%s\n" "$1"
' > "$SIM/open-falso"
chmod +x "$SIM/open-falso"

grep -q '"\$HOME/Sistema"' "$LANCADOR_SIM"   && ! grep -q '"/Applications"' "$LANCADOR_SIM"   && ! grep -q '/usr/bin/open' "$LANCADOR_SIM"
v $? "a simulação isola as bases de procura e o browser predefinido"

falso() {  # falso <base> <nome>
  local d="$SIM/$1/$2.app/Contents/MacOS"
  mkdir -p "$d"
  printf '#!/bin/bash\nprintf "ESCOLHIDO=%s\n" "$0"\nfor a in "$@"; do printf "ARG=%%s\n" "$a"; done\n' "$2" > "$d/$2"
  chmod +x "$d/$2"
}

correr() {  # correr -> saida do lancador simulado, com HOME=$SIM
  ( HOME="$SIM" bash "$LANCADOR_SIM" 2>&1 )
}

limpar_sim() {
  rm -rf "$SIM/Sistema" "$SIM/Applications" "$SIM/Library"
  mkdir -p "$SIM/Sistema"
}

# --- 1. só Edge ---
limpar_sim
falso Sistema "Microsoft Edge"
OUT="$(correr)"
printf '%s' "$OUT" | grep -q 'Microsoft Edge'
v $? "só Edge instalado → escolhe Edge"

# --- 2. Chrome e Edge: Chrome ganha ---
limpar_sim
falso Sistema "Microsoft Edge"; falso Sistema "Google Chrome"
OUT="$(correr)"
printf '%s' "$OUT" | grep -q 'Google Chrome'
v $? "Chrome e Edge instalados → escolhe Chrome"
! printf '%s' "$OUT" | grep -q 'ESCOLHIDO=.*Microsoft Edge'
v $? "…e não lança o Edge"

# --- 3. argumentos ---
printf '%s' "$OUT" | grep -q -- "ARG=--app=$URL"
v $? "passa --app com a URL do tenant"
printf '%s' "$OUT" | grep -q -- "ARG=--user-data-dir=$SIM/Library/Application Support/SPharm.MT/BrowserProfile"
v $? "passa --user-data-dir para o perfil dedicado"
printf '%s' "$OUT" | grep -q -- 'ARG=--password-store=basic'
v $? "passa --password-store=basic"

# --- 4. o perfil é semeado com as passwords desligadas ---
PREFS="$SIM/Library/Application Support/SPharm.MT/BrowserProfile/Default/Preferences"
[ -f "$PREFS" ]; v $? "cria Preferences no primeiro arranque"
if [ -f "$PREFS" ] && [ -n "$PY" ]; then
  "$PY" - "$PREFS" <<'PYEOF'
import sys, json
d = json.load(open(sys.argv[1], encoding="utf-8"))
mau = []
if d.get("credentials_enable_service") is not False: mau.append("credentials_enable_service")
if d.get("profile", {}).get("password_manager_enabled") is not False: mau.append("password_manager_enabled")
if mau: print(", ".join(mau)); sys.exit(1)
sys.exit(0)
PYEOF
  v $? "Preferences é JSON válido e desliga a gravação de passwords"
else
  salta "conteúdo do Preferences" "sem python ou sem ficheiro"
fi

# --- 5. sem Chrome nem Edge: browser predefinido ---
limpar_sim
OUT="$(correr)"
printf '%s' "$OUT" | grep -qF "ABERTO=$URL"
v $? "sem Chrome nem Edge → entrega a URL ao browser predefinido" "$OUT"

rm -rf "$SIM"

echo ""
echo "=== A8. o workflow do GitHub Actions ==="
WF="$RAIZ/.github/workflows/macos-installer.yml"
[ -f "$WF" ]; v $? "existe .github/workflows/macos-installer.yml"

if [ -f "$WF" ]; then
  grep -q 'workflow_dispatch:' "$WF";           v $? "pode ser executado manualmente"
  grep -q 'runs-on: macos-latest' "$WF";        v $? "corre em macos-latest"
  grep -q 'bash installer-macos/build-macos-installer.sh' "$WF"
  v $? "usa o script de build existente"
  grep -q 'npm run test:macos-installer' "$WF"; v $? "corre os testes"
  grep -q 'path: dist-macos/Instalador-SPharmMT-Silveira.pkg' "$WF"
  v $? "o artefacto vem de dist-macos/"
  grep -q 'if-no-files-found: error' "$WF"
  v $? "falha em vez de publicar um artefacto vazio"

  # Nenhum segredo pode viver no ficheiro. As referências a
  # `secrets.` são ponteiros para o cofre da GitHub, não valores.
  ! grep -qE 'BEGIN (CERTIFICATE|PRIVATE KEY)|-----BEGIN' "$WF"
  v $? "sem certificados embutidos"
  ! grep -qiE '(password|token|secret)[[:space:]]*[:=][[:space:]]*["'"'"'][^$"'"'"']' "$WF"
  v $? "sem passwords nem tokens literais"

  if [ -n "$PY" ]; then
    "$PY" - "$WF" <<'PYEOF'
import sys, re
# Sem pyyaml garantido, valida-se o que interessa por leitura directa:
# que cada bloco `run:` é shell sintacticamente plausível não se testa
# aqui (fá-lo o bash -n no passo seguinte); testa-se a indentação, que é
# onde os workflows partem em silêncio.
texto = open(sys.argv[1], encoding="utf-8").read()
erros = []
if "\t" in texto:
    erros.append("contém tabulações (YAML não as aceita para indentar)")
for n, linha in enumerate(texto.split("\n"), 1):
    if linha.rstrip() != linha.rstrip("\n") and linha.strip():
        pass
if not re.search(r"^on:\s*$", texto, re.M):
    erros.append("falta o bloco `on:`")
if erros:
    print("; ".join(erros)); sys.exit(1)
sys.exit(0)
PYEOF
    v $? "indentação e estrutura básicas"
  else
    salta "estrutura do workflow" "sem python"
  fi

  # Os blocos `run:` correm em bash no runner. Extraí-los e passá-los
  # pelo `bash -n` apanha aqui o erro de sintaxe que de outra forma só
  # aparecia a meio de um job.
  if [ -n "$PY" ]; then
    TMPWF="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/wf-$$")"
    mkdir -p "$TMPWF"
    "$PY" - "$WF" "$TMPWF" >/dev/null <<'PYEOF'
import sys, re, os
texto = open(sys.argv[1], encoding="utf-8").read().split("\n")
destino = sys.argv[2]
n = 0
i = 0
while i < len(texto):
    m = re.match(r"^(\s*)run: \|\s*$", texto[i])
    if m:
        base = len(m.group(1)) + 2
        corpo = []
        i += 1
        while i < len(texto) and (texto[i].strip() == "" or len(texto[i]) - len(texto[i].lstrip()) >= base):
            corpo.append(texto[i][base:] if texto[i].strip() else "")
            i += 1
        n += 1
        # As expressões ${{ ... }} são resolvidas pelo Actions antes do
        # shell as ver; substituem-se por um literal para o bash -n não
        # tropeçar numa sintaxe que não é dele.
        texto_corpo = re.sub(r"\$\{\{[^}]*\}\}", "SUBSTITUIDO", "\n".join(corpo))
        open(os.path.join(destino, f"run{n}.sh"), "w", encoding="utf-8").write(texto_corpo + "\n")
        continue
    i += 1
print(n)
PYEOF
    N_BLOCOS="$("$PY" - "$WF" "$TMPWF" <<'PYEOF'
import sys, re
texto = open(sys.argv[1], encoding="utf-8").read()
print(len(re.findall(r"^\s*run: \|\s*$", texto, re.M)))
PYEOF
)"
    [ "${N_BLOCOS:-0}" -ge 3 ]; v $? "encontrou os blocos run:" "n=$N_BLOCOS"
    MAU=0
    for r in "$TMPWF"/run*.sh; do
      [ -f "$r" ] || continue
      bash -n "$r" 2>/dev/null || MAU=$((MAU+1))
    done
    [ "$MAU" -eq 0 ]; v $? "todos os blocos run: são shell válido" "com erro=$MAU"
    rm -rf "$TMPWF"
  else
    salta "sintaxe dos blocos run:" "sem python"
  fi
fi

# ═════════════════════════════════════════════════════════════════════
# B. ARTEFACTOS — só num Mac, depois do build
# ═════════════════════════════════════════════════════════════════════
echo ""
echo "=== B. artefactos construídos ==="
if [ ! -d "$APP" ] || [ ! -f "$PKG" ]; then
  salta "verificação de dist-macos/" "corre primeiro build-macos-installer.sh num Mac"
elif [ "$(uname -s)" != "Darwin" ]; then
  salta "verificação de dist-macos/" "precisa do macOS (pkgutil/plutil)"
else
  echo ""
  echo "--- B1. estrutura do bundle ---"
  [ -f "$APP/Contents/Info.plist" ];               v $? "Contents/Info.plist"
  [ -f "$APP/Contents/MacOS/SPharmMT" ];           v $? "Contents/MacOS/SPharmMT"
  [ -f "$APP/Contents/Resources/SPharmMT.icns" ];  v $? "Contents/Resources/SPharmMT.icns"
  [ -f "$APP/Contents/PkgInfo" ];                  v $? "Contents/PkgInfo"

  echo ""
  echo "--- B2. permissões ---"
  MODO_EXEC="$(stat -f '%Lp' "$APP/Contents/MacOS/SPharmMT")"
  [ "$MODO_EXEC" = "755" ]; v $? "o lançador é 755" "obtido=$MODO_EXEC"
  MODO_PLIST="$(stat -f '%Lp' "$APP/Contents/Info.plist")"
  [ "$MODO_PLIST" = "644" ]; v $? "Info.plist é 644" "obtido=$MODO_PLIST"
  MODO_ICNS="$(stat -f '%Lp' "$APP/Contents/Resources/SPharmMT.icns")"
  [ "$MODO_ICNS" = "644" ]; v $? "o ícone é 644" "obtido=$MODO_ICNS"

  echo ""
  echo "--- B3. Info.plist instalado ---"
  plutil -lint "$APP/Contents/Info.plist" >/dev/null 2>&1; v $? "plutil -lint passa"
  EXEC_DECL="$(plutil -extract CFBundleExecutable raw -o - "$APP/Contents/Info.plist" 2>/dev/null)"
  [ -x "$APP/Contents/MacOS/$EXEC_DECL" ]; v $? "CFBundleExecutable existe e é executável"
  ICONE_DECL="$(plutil -extract CFBundleIconFile raw -o - "$APP/Contents/Info.plist" 2>/dev/null)"
  [ -f "$APP/Contents/Resources/$ICONE_DECL.icns" ]; v $? "CFBundleIconFile aponta para um .icns existente"

  echo ""
  echo "--- B4. o ícone é um .icns válido ---"
  MAGIC="$(head -c 4 "$APP/Contents/Resources/SPharmMT.icns")"
  [ "$MAGIC" = "icns" ]; v $? "assinatura icns" "obtido=$MAGIC"

  echo ""
  echo "--- B5. conteúdo do .pkg ---"
  PAYLOAD="$(pkgutil --payload-files "$PKG" 2>/dev/null)"
  printf '%s' "$PAYLOAD" | grep -q 'SPharm.MT.app/Contents/MacOS/SPharmMT'
  v $? "o payload traz o lançador"
  printf '%s' "$PAYLOAD" | grep -q 'SPharm.MT.app/Contents/Resources/SPharmMT.icns'
  v $? "o payload traz o ícone"
  N_APPS="$(printf '%s' "$PAYLOAD" | grep -c '\.app$')"
  [ "$N_APPS" -le 1 ]; v $? "o payload traz um único .app" "n=$N_APPS"
  ! printf '%s' "$PAYLOAD" | grep -qi 'agent\|node\.exe\|\.zip'
  v $? "o payload não traz o agent de sincronização"

  echo ""
  echo "--- B6. destino da instalação ---"
  pkgutil --expand "$PKG" "$DIST/.expandido" 2>/dev/null
  if [ -d "$DIST/.expandido" ]; then
    grep -q 'install-location="/Applications"\|installKBytes' "$DIST/.expandido/Distribution" 2>/dev/null
    v $? "o Distribution existe e é legível"
    ! ls "$DIST/.expandido"/*/scripts >/dev/null 2>&1
    v $? "sem scripts de pré/pós-instalação (não pede privilégios extra)"
    rm -rf "$DIST/.expandido"
  else
    v 1 "pkgutil --expand" "falhou a expandir o .pkg"
  fi

  echo ""
  echo "--- B7. assinatura ---"
  if pkgutil --check-signature "$PKG" 2>/dev/null | grep -q 'Status: signed'; then
    printf '  [INFO]  .pkg ASSINADO\n'
  else
    printf '  [INFO]  .pkg POR ASSINAR — ver README.md, secção Gatekeeper\n'
  fi
fi

echo ""
echo "RESULTADO: $ok ok, $ko falhas, $saltados saltados"
[ "$ko" -eq 0 ]
