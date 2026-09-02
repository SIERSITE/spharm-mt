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

## Sem Mac à mão

O workflow **Instalador macOS** (`.github/workflows/macos-installer.yml`)
constrói, assina, notariza e grampeia o `.pkg` num runner
`macos-latest`, e só o publica se tudo isso passar. Corre o mesmo script
deste directório — o runner não tem receita própria, para não haver duas
verdades sobre como se constrói um instalador.

Executar: **Actions → Instalador macOS → Run workflow**. Corre também
sozinho a cada alteração em `installer-macos/**`.

O `.pkg` fica em **Artifacts**, com o nome `Instalador-SPharmMT-Silveira`
(a GitHub embrulha em `.zip`; o `.pkg` está lá dentro). 30 dias.

Sem os segredos da Apple configurados, o workflow **constrói e testa mas
não publica**. É deliberado: um `.pkg` por assinar com o nome de release
acabaria, mais dia menos dia, na mão de um cliente. Para uma build
interna por assinar há o input `publicar_sem_assinatura` na execução
manual, e o artefacto sai com um nome que o desaconselha.

---

## O que a Apple exige, e porquê tudo isso

Para o cliente fazer duplo clique e instalar — sem avisos, sem «clique
direito → Abrir» — não basta assinar. Desde o macOS 10.15 o Gatekeeper
exige **assinatura e notarização**. E sem `stapler staple` o Mac do
cliente tem de ir perguntar à Apple, online, se o pacote é bom: numa
farmácia com a rede fechada, isso falha. Grampeado, o recibo viaja dentro
do próprio `.pkg` e a validação é local.

São necessárias **duas identidades**, não uma:

| Certificado | Assina | Porquê |
|---|---|---|
| **Developer ID Application** | o `.app` dentro do pacote | A notarização abre o payload. Assinar só o instalador deixa o bundle nu lá dentro e a submissão volta rejeitada — depois de esperar pela fila |
| **Developer ID Installer** | o `.pkg` | É o que o Gatekeeper verifica ao duplo clique |

Mais uma **App Store Connect API key** para autenticar o `notarytool`.
Chave de API e não Apple ID + password: não tropeça em 2FA, é revogável
e tem âmbito próprio.

### Obter na Apple

1. **Apple Developer Program** — 99 USD/ano, conta de organização de
   preferência. Uma conta individual funciona, mas o nome que aparece ao
   cliente é o da pessoa.
2. **Os dois certificados** — em *Certificates, Identifiers & Profiles →
   Certificates*, criar **Developer ID Application** e **Developer ID
   Installer**. Instalar ambos no Porta-chaves de um Mac, seleccionar os
   dois e exportar num único `.p12` com password.
3. **Chave de API** — em *App Store Connect → Users and Access → Keys →
   Individual Keys*, criar uma chave com papel **Developer**. Descarregar
   o `AuthKey_XXXXXXXX.p8` (**só se descarrega uma vez**) e anotar o
   *Key ID* e o *Issuer ID*.

### Os sete segredos

Em *Settings → Secrets and variables → Actions*:

| Segredo | Conteúdo |
|---|---|
| `MACOS_CERT_P12` | o `.p12` com as duas identidades, em base64 |
| `MACOS_CERT_PASSWORD` | password do `.p12` |
| `MACOS_SIGN_ID_APP` | `Developer ID Application: Nome (TEAMID)` |
| `MACOS_SIGN_ID_INSTALLER` | `Developer ID Installer: Nome (TEAMID)` |
| `APPLE_API_KEY_ID` | Key ID da chave |
| `APPLE_API_ISSUER_ID` | Issuer ID |
| `APPLE_API_KEY_P8` | o `AuthKey_*.p8`, em base64 |

Para gerar os base64:

```bash
base64 -i certificados.p12   | pbcopy     # macOS
base64 -i AuthKey_XXXXXXXX.p8 | pbcopy
```

O nome exacto das identidades:

```bash
security find-identity -v -p codesigning
```

Nenhum destes valores entra no repositório. O workflow exige **os sete**
antes de tentar assinar: com metade, o build falharia no
`productbuild --sign` ou já dentro da fila da Apple, longe da causa.

### O que o workflow verifica antes de publicar

`pkgutil --check-signature` → `notarytool submit --wait` →
`stapler staple` → `stapler validate` → `pkgutil --check-signature` →
`spctl --assess --type install`. O último é o veredicto do próprio
Gatekeeper na mesma máquina: responde a «o cliente vai ver um aviso?»
antes de o pacote sair de lá. Se a notarização for recusada, o log da
Apple é obtido e impresso — sem ele fica-se com «Invalid» e mais nada.

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

## Gatekeeper

Com os sete segredos configurados, o `.pkg` que sai do workflow está
assinado, notarizado e grampeado: **duplo clique, instalar, usar.** Sem
avisos, e sem depender da rede do cliente para validar.

Sem eles, o workflow não publica instalador nenhum — mas uma build local
feita à mão (`bash installer-macos/build-macos-installer.sh` sem
variáveis) sai por assinar. Um `.pkg` não assinado **descarregado por
browser ou recebido por email** ganha o atributo de quarentena e o
Gatekeeper recusa-o com _«programador não identificado»_; copiado por pen
ou rede local não fica em quarentena e instala sem aviso. É a diferença
entre uma build de teste e um instalador de cliente, e é por isso que a
publicação está presa ao resultado da notarização.

Confirmar o estado de um `.pkg`:

```bash
pkgutil --check-signature Instalador-SPharmMT-Silveira.pkg
xcrun stapler validate    Instalador-SPharmMT-Silveira.pkg
spctl --assess --type install -vv Instalador-SPharmMT-Silveira.pkg
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

.github/workflows/macos-installer.yml   constrói o .pkg sem Mac à mão
```

O `dist-macos/` é gerado e está no `.gitignore`.
