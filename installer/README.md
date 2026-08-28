# Instalador Windows — SPharm.MT · Farmácia Silveirense

Gera um único ficheiro **`Instalar-SPharmMT-Silveira.msi`** para enviar ao
cliente. Sem scripts, sem passos manuais no PC dele.

---

## O ícone

`SPharmMT.Installer/assets/SPharmMT.ico` é o logotipo real, gerado a partir do
PNG original de 1254×1254 com sete tamanhos: **256, 128, 64, 48, 32, 24 e 16 px**
— 256 em PNG (o que o Windows Vista+ espera no tamanho grande) e os restantes em
DIB de 32 bits, que qualquer versão do Windows lê sem dúvidas.

Desenho, cores, texto e proporções são os do PNG. **Uma coisa mudou, e é de
formato e não de desenho:** o PNG é de 24 bits, sem canal alfa, e por isso os
quatro cantos exteriores ao rectângulo arredondado são **preto opaco**. Num
`.ico` isso dá um quadrado preto à volta do logotipo no Ambiente de Trabalho. O
preto ligado aos cantos passou a transparente, por preenchimento a partir das
quatro esquinas — a moldura dourada bloqueia o preenchimento, por isso nada do
interior é tocado.

Para regenerar a partir de outro PNG, com ImageMagick:

```
magick logo.png -define icon:auto-resize=256,128,64,48,32,24,16 SPharmMT.ico
```

O `magick` não trata dos cantos pretos; se o PNG de origem os tiver, convém
remover o fundo antes.

A compilação **recusa-se a produzir o MSI** se o ficheiro voltar a ser o ícone
provisório que aqui esteve durante o desenvolvimento — a comparação é por
SHA-256, para o caso de um merge ou um revert o repor sem ninguém dar conta.

## Compilar

### No Visual Studio

1. Abrir `installer/SPharmMT.Installer.sln`.
2. Configuração **Release**, plataforma **x64**.
3. **Compilar › Compilar Solução**.

O NuGet traz o WiX na primeira compilação — não é preciso instalar nada à mão.
Para editar `.wxs` com realce de sintaxe e IntelliSense, a extensão **HeatWave
for VS2022** ajuda, mas **não é precisa para compilar**.

### Pela linha de comandos

```powershell
$msbuild = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe"
cd installer\SPharmMT.Installer
& $msbuild SPharmMT.Installer.wixproj -restore -p:Configuration=Release -p:Platform=x64
```

Resultado:

```
installer\SPharmMT.Installer\bin\x64\Release\Instalar-SPharmMT-Silveira.msi
```

É esse o ficheiro a enviar. Não precisa de mais nada ao lado.

**Requisitos da máquina de compilação:** MSBuild (Visual Studio ou Build Tools),
.NET 8 Runtime e acesso ao nuget.org. Não é preciso o .NET SDK.

---

## O que o instalador faz no PC do cliente

| | |
|---|---|
| Nome | SPharm.MT - Farmácia Silveirense |
| Instala em | `%LOCALAPPDATA%\Programs\SPharmMT\` |
| Guarda lá | `SPharmMT.ico` |
| Atalhos | Ambiente de Trabalho e Menu Iniciar, ambos «SPharm.MT» |
| Abre | `https://app.spharmmt.com/login?__tenant=silveira` |
| Navegador | Google Chrome se existir; caso contrário Microsoft Edge |
| Modo | Janela de aplicação (`--app`), **não** incógnito |
| Perfil | `%LOCALAPPDATA%\SPharmMT\ChromeProfile` |
| Janela | Maximizada à primeira abertura |
| Desinstalação | Definições › Aplicações |

Sessão e cookies mantêm-se entre utilizações — é o objectivo do perfil dedicado.
`F5` e `Ctrl+R` funcionam normalmente.

---

## Decisões que valem a pena conhecer

### Por utilizador, não em `Program Files`

O pedido admitia as duas. A escolha é por utilizador, e não por preguiça: o
perfil do navegador vive em `%LOCALAPPDATA%`, que é **por utilizador**. Num
instalador para toda a máquina o instalador corre elevado, e o caminho do perfil
resolveria para o perfil de **quem instalou** — tipicamente o administrador. Um
segundo utilizador do mesmo PC abriria o atalho e escreveria no perfil do
primeiro.

Em troca: **não há UAC**, o cliente instala sem pedir permissões a ninguém, e a
desinstalação aparece na mesma em Definições › Aplicações.

Se um dia for mesmo preciso instalar para todos os utilizadores da máquina, o
caminho não é mudar `Scope` — é mudar também a forma como o perfil é resolvido,
e isso implica um atalho que aponta para um pequeno lançador em vez de apontar
directamente ao navegador.

### x64

Um MSI de 32 bits num Windows de 64 bits lê o registo pela vista redireccionada
(`WOW6432Node`), e o Chrome e o Edge registam o seu caminho na vista nativa. Um
pacote x86 simplesmente **não os encontrava**.

Consequência: **não instala em Windows de 32 bits.** O Windows 11 não existe em
32 bits e o Windows 10 de 32 bits saiu de suporte em Outubro de 2025.

### Um MSI e não um `.exe` de bundle

Um `.exe` (Burn) serve para instalar pré-requisitos antes do MSI. Aqui não há
nenhum: o Edge faz parte do Windows. Um bundle acrescentaria um invólucro, mais
uma camada de erros possíveis, e nada de útil.

---

## Desinstalação

Definições › Aplicações › **SPharm.MT - Farmácia Silveirense** › Desinstalar.

Remove os atalhos, o `.ico` e a pasta de instalação.

**Não remove** `%LOCALAPPDATA%\SPharmMT\ChromeProfile`. É uma decisão, não um
esquecimento: essa pasta são os dados de sessão do utilizador, e apagá-los numa
reinstalação obrigava a fazer login outra vez. Para os remover, apagar a pasta à
mão.

---

## Verificado

Contra o MSI compilado, não por leitura do código:

- **Nenhum caminho da máquina de compilação** aparece no ficheiro. Procurados
  `C:\projetos`, `C:\Users\...`, `spharm-mt`, `Downloads`, `BuildTools` e
  `AppData`, em ASCII e UTF-16, nos 536 576 bytes do MSI incluindo o CAB. A
  única ocorrência é `LocalAppDataFolder`, que é a propriedade do Windows
  Installer resolvida no PC do cliente — aparece nos argumentos do atalho e na
  tabela `Directory`, e é suposto lá estar.
- O alvo do atalho é `[NAVEGADOR]`, uma propriedade preenchida no PC do cliente
  a partir de cinco pesquisas ao registo (`App Paths`, Chrome e Edge, HKCU e
  HKLM, vistas de 32 e 64 bits).
- O caminho do perfil é `[LocalAppDataFolder]SPharmMT\ChromeProfile`, resolvido
  pelo Windows Installer no PC do cliente.
- O `MsiFileHash` do `SPharmMT.ico` dentro do MSI bate certo, nas quatro
  parcelas, com o hash calculado sobre o ficheiro de origem — o ícone viaja
  dentro do MSI e é o mesmo. Tamanho registado: 216 767 bytes.
- O `.ico` foi aberto pelo Windows nos sete tamanhos; os cantos saem
  transparentes (alfa 0) e o centro com a cor do símbolo.
- A guarda do ícone bloqueia a compilação **antes** de qualquer MSI ser
  escrito no disco — verificado repondo o provisório e voltando a compilar.

---

## Actualizar o instalador

Ao mudar seja o que for, subir `Version` no `Package.wxs` (por exemplo para
`1.0.1.0`). O `MajorUpgrade` faz a nova versão substituir a anterior em vez de
acumular entradas em Definições › Aplicações.

O `UpgradeCode` **nunca muda** — é ele que liga as versões umas às outras.
