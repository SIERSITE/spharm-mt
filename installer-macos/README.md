# Instalador macOS — SPharm.MT (tenant Silveira)

Equivalente do instalador Windows (`installer/SPharmMT.Installer`), para
os Macs da Silveira. Instala **um lançador**, não uma aplicação: abre
`https://app.spharmmt.com/login?__tenant=silveira` num browser Chromium
em modo aplicação, com um perfil só dele.

> `installer/` (singular) é a solução WiX/Visual Studio do instalador
> Windows e não é tocada aqui. Este directório é o do macOS.

**Não instala o agent de sincronização.** O agent recolhe dados do ERP,
corre em Windows e vive noutro pacote. Isto é só a porta de entrada na
aplicação web — não conhece ingest keys, não fala com o SQL Server e não
guarda passwords.

---

## O único comando

Num Mac, na raiz do repositório:

```bash
bash installer-macos/build-macos-installer.sh
```

Produz:

```
dist-macos/SPharm.MT.app
dist-macos/Instalador-SPharmMT-Silveira.pkg
```

Precisa das Command Line Tools (`sips`, `iconutil`, `pkgbuild`,
`productbuild`, `plutil`). Se faltarem:

```bash
xcode-select --install
```

Não precisa de Xcode completo, de rede, nem de privilégios. O script
verifica as cinco ferramentas de uma vez e diz quais faltam.

Verificar antes de distribuir:

```bash
bash installer-macos/tests/test-macos-installer.sh
```

---

## Intel e Apple Silicon

O mesmo `.pkg` serve os dois, e não por acaso: o executável do bundle é
um **script de shell**, não um binário. Não há arquitectura para
escolher, não há binário universal para manter, e não há Rosetta pelo
meio.

Há um segundo ganho, menos óbvio. Em Apple Silicon, **todo o código
Mach-O tem de estar assinado** para correr — nem que seja com assinatura
ad-hoc. Um lançador compilado sem certificado seria morto pelo sistema
no arranque. Um script não passa por essa regra.

---

## O que o lançador faz

Por esta ordem, a mesma do instalador Windows:

1. **Google Chrome** — `/Applications` ou `~/Applications`
2. **Microsoft Edge** — idem
3. **Browser predefinido** — via `/usr/bin/open`, sem modo aplicação

Com Chrome ou Edge:

```
--app=https://app.spharmmt.com/login?__tenant=silveira
--user-data-dir=~/Library/Application Support/SPharm.MT/BrowserProfile
--password-store=basic
--no-first-run --no-default-browser-check --start-maximized
```

`--app=` abre uma janela sem barra de endereço nem separadores.

O **perfil dedicado** não é cosmético. Sem ele, o Chromium reaproveita a
instância já aberta do utilizador, o `--app=` é ignorado, e a sessão do
SPharm.MT passa a viver nos cookies do perfil pessoal — onde uma limpeza
de dados de navegação a apaga sem aviso.

**Passwords.** Na primeira execução o lançador semeia
`Preferences` no perfil com `credentials_enable_service: false` e
`password_manager_enabled: false`. É um ficheiro e não flags de linha de
comandos de propósito: as flags equivalentes mudaram de nome entre
versões do Chromium e falham em silêncio quando deixam de existir. O
`--password-store=basic` evita ainda que o browser peça acesso ao
Porta-chaves — pedido que só serviria para o utilizador ter de decidir
sobre uma caixa de diálogo que não devia aparecer.

**Sem privilégios depois da instalação.** O `.pkg` não leva scripts de
pré nem de pós-instalação — o teste B6 verifica isso. Copia o `.app`
para `/Applications` e termina. O perfil do browser é criado no primeiro
arranque, dentro da pasta pessoal do utilizador.

---

## Ícone

Vem do **mesmo ficheiro** que o instalador Windows usa:
`installer/SPharmMT.Installer/assets/SPharmMT.ico`. A maior fatia PNG lá
dentro (256×256) foi extraída para `assets/SPharmMT-256.png`, e o teste
A6 compara os dois por SHA-256 — se alguém trocar o ícone oficial sem
actualizar este, o teste acusa.

O `.icns` é gerado no Mac pelo `iconutil`, a partir de um `iconset` que
o `sips` produz. As fatias acima de 256 são ampliadas, porque 256 é a
maior resolução que o ícone oficial tem. Se aparecer um master de 1024,
substitui-se o PNG e ajusta-se `FONTE_ICONE` no script de build.

---

## Instalar

Duplo clique no `Instalador-SPharmMT-Silveira.pkg`, ou:

```bash
sudo installer -pkg dist-macos/Instalador-SPharmMT-Silveira.pkg -target /
```

A aplicação fica em `/Applications/SPharm.MT.app`.

---

## Gatekeeper — o que falta para distribuir sem avisos

O `.pkg` sai **por assinar**. Instala-se e funciona; o que muda é o
atrito na primeira abertura.

Um `.pkg` não assinado, **descarregado por browser ou recebido por
email**, ganha o atributo de quarentena e o Gatekeeper recusa-o com
_«não pode ser aberto porque é de um programador não identificado»_. O
utilizador contorna com **clique direito → Abrir → Abrir**, uma vez. Um
`.pkg` copiado por pen ou por rede local não fica em quarentena e
instala sem aviso nenhum.

Para eliminar o atrito de vez são precisas três coisas que hoje não
existem:

1. **Conta Apple Developer** (99 €/ano) e um certificado
   **Developer ID Installer**, no Porta-chaves da máquina que constrói.
2. **Assinar**, passando a identidade ao script:

   ```bash
   SPHARMMT_SIGN_ID="Developer ID Installer: Nome (TEAMID)" \
     bash installer-macos/build-macos-installer.sh
   ```

3. **Notarizar** — submeter o `.pkg` à Apple e grampear o recibo:

   ```bash
   xcrun notarytool submit dist-macos/Instalador-SPharmMT-Silveira.pkg \
     --apple-id <email> --team-id <TEAMID> --password <app-specific-password> \
     --wait
   xcrun stapler staple dist-macos/Instalador-SPharmMT-Silveira.pkg
   ```

Sem notarização, assinar sozinho **não** chega desde o macOS 10.15: o
Gatekeeper continua a avisar. Ou se faz o conjunto, ou se distribui por
um canal que não põe quarentena.

Verificar o estado de um `.pkg`:

```bash
pkgutil --check-signature dist-macos/Instalador-SPharmMT-Silveira.pkg
```

---

## Desinstalar

Três coisas, e nenhuma exige o instalador:

```bash
# 1. A aplicação
sudo rm -rf "/Applications/SPharm.MT.app"

# 2. O perfil do browser (sessão, cookies, preferências) — por utilizador
rm -rf "$HOME/Library/Application Support/SPharm.MT"

# 3. O registo do pacote (o macOS não tem desinstalador de .pkg;
#    isto só apaga o recibo, não ficheiros)
sudo pkgutil --forget com.spharmmt.launcher.silveira
```

O passo 2 é o que apaga a sessão: enquanto lá estiver, quem abrir a
aplicação nesse Mac entra sem voltar a autenticar-se, até o token de 8
horas expirar. **Numa máquina que muda de dono, é o passo obrigatório.**

O passo 3 é opcional. Sem ele fica um recibo órfão em
`/var/db/receipts`, invisível e inofensivo — mas uma reinstalação futura
julga-se uma actualização em vez de uma instalação limpa.

Confirmar que ficou tudo:

```bash
ls -d "/Applications/SPharm.MT.app" 2>/dev/null || echo "app removida"
ls -d "$HOME/Library/Application Support/SPharm.MT" 2>/dev/null || echo "perfil removido"
pkgutil --pkg-info com.spharmmt.launcher.silveira 2>/dev/null || echo "recibo removido"
```

---

## Outro tenant

Três valores, todos no mesmo sítio:

| Onde | O quê |
|---|---|
| `src/SPharmMT` | `URL=` e o caminho do perfil |
| `src/Info.plist` | `CFBundleIdentifier` |
| `build-macos-installer.sh` | `PKG`, `BUNDLE_ID`, `URL_ESPERADA` |

O `CFBundleIdentifier` **tem** de mudar. Partilhado entre tenants, o
LaunchServices trata dois lançadores diferentes como a mesma aplicação e
o último a instalar ganha.

---

## Estrutura

```
installer-macos/
  build-macos-installer.sh      o único comando
  README.md                     este ficheiro
  assets/SPharmMT-256.png       PNG extraído do .ico oficial do Windows
  src/Info.plist                metadados do bundle
  src/SPharmMT                  o lançador
  tests/test-macos-installer.sh verificações (estáticas + artefactos)
```

O `dist-macos/` é gerado e está no `.gitignore`.
