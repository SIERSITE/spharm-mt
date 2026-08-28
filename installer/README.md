# Instalador Windows — SPharm.MT · Farmácia Silveirense

Gera um único ficheiro **`Instalar-SPharmMT-Silveira.msi`** para enviar ao
cliente. Sem scripts, sem passos manuais no PC dele.

---

## Antes de compilar: o ícone

O repositório traz um **ícone provisório** — um quadrado verde com «S+» — só
para o projecto compilar e ser verificável. **A compilação recusa-se a produzir
o MSI enquanto ele lá estiver.**

Substitui `SPharmMT.Installer/assets/SPharmMT.ico` pelo ícone real. Tem de ser
um `.ico` a sério, não um `.png` com outra extensão. A partir do PNG do logótipo:

- **ImageMagick:** `magick logo.png -define icon:auto-resize=256,128,64,48,32,16 SPharmMT.ico`
- ou qualquer conversor online que produza `.ico` multi-resolução.

Inclui os tamanhos **16, 32, 48 e 256**. O Windows usa o de 16 na barra de
tarefas e o de 256 nos ícones grandes; um `.ico` só com 256 fica desfocado em
tamanho pequeno.

A verificação é pelo conteúdo do ficheiro (SHA-256), por isso **desliga-se
sozinha** assim que o substituíres. Não há nada para lembrar.

---

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
  `C:\projetos`, `C:\Users\...`, `spharm-mt`, `BuildTools` e afins, em ASCII e
  UTF-16, nos 163 840 bytes do MSI incluindo o CAB: zero ocorrências.
- O alvo do atalho é `[NAVEGADOR]`, uma propriedade preenchida no PC do cliente
  a partir de cinco pesquisas ao registo (`App Paths`, Chrome e Edge, HKCU e
  HKLM, vistas de 32 e 64 bits).
- O caminho do perfil é `[LocalAppDataFolder]SPharmMT\ChromeProfile`, resolvido
  pelo Windows Installer no PC do cliente.
- `msiexec /a` extrai `LocalApp\Programs\SPharmMT\SPharmMT.ico` com o mesmo
  SHA-256 do ficheiro de origem — o ícone viaja dentro do MSI.
- A guarda do ícone provisório bloqueia a compilação **antes** de qualquer MSI
  ser escrito no disco.

---

## Actualizar o instalador

Ao mudar seja o que for, subir `Version` no `Package.wxs` (por exemplo para
`1.0.1.0`). O `MajorUpgrade` faz a nova versão substituir a anterior em vez de
acumular entradas em Definições › Aplicações.

O `UpgradeCode` **nunca muda** — é ele que liga as versões umas às outras.
