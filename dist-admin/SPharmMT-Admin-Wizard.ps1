# SPharmMT-Admin-Wizard.ps1
#
# UI grafica (WinForms) para o admin gerir o piloto sem correr npm
# directamente. Substitui o onboarding-wizard.bat/ps1 como processo
# oficial. O BAT antigo continua a funcionar como fallback tecnico.
#
# Internamente apenas faz shell-out aos scripts npm existentes -- nao
# duplica logica de provisionamento, validacao ou seguranca.
#
# Compativel com Windows PowerShell 5.1 (default em Windows 10/11).
# Codigo ASCII only; strings de display em PT podem ter acentos.
#
# Convencoes:
#   - Confirmacoes destrutivas exigem "CONFIRMO" em maiusculas
#   - Secrets (passwords, ingest keys) so aparecem em dialog modal;
#     nunca sao escritos no log textual
#   - Logs append-only em logs\admin-wizard-YYYY-MM-DD.log
#   - Cada operacao com side-effect inclui o comando npm correspondente
#     no log (sem args sensiveis), para auditoria

$ErrorActionPreference = "Stop"

# --- Bootstrap ----------------------------------------------------

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

# Bootstrap robusto: resolve a pasta da app de forma que funcione em
# .ps1 directo (PSScriptRoot ok), .bat fallback (idem), e .exe compilado
# por ps2exe (onde PSScriptRoot vem null porque o script e executado a
# partir de uma assembly carregada em memoria; GetExecutingAssembly().Location
# pode tambem vir vazio nesses casos -- usar o caminho do processo e o
# argv[0] que sao sempre validos para a .exe host).
#
# Devolve sempre algo (worst case: cwd). Cada candidato e testado com
# Test-Path para confirmar que aponta para um directorio real.

function Get-AppRoot {
  # Sequencia de tentativas + diagnostico para o log. Devolve hashtable
  # @{ Path = <string>; Source = <nome do detector que ganhou> }.
  $candidates = @()

  try {
    if ($PSScriptRoot -and (Test-Path $PSScriptRoot)) {
      return @{ Path = $PSScriptRoot; Source = "PSScriptRoot" }
    }
    $candidates += "PSScriptRoot=null/missing"
  } catch { $candidates += "PSScriptRoot threw: $($_.Exception.Message)" }

  try {
    if ($PSCommandPath) {
      $p = Split-Path -Parent $PSCommandPath -ErrorAction Stop
      if ($p -and (Test-Path $p)) { return @{ Path = $p; Source = "PSCommandPath" } }
    }
    $candidates += "PSCommandPath=null/missing"
  } catch { $candidates += "PSCommandPath threw: $($_.Exception.Message)" }

  try {
    if ($MyInvocation -and $MyInvocation.MyCommand -and $MyInvocation.MyCommand.Path) {
      $p = Split-Path -Parent $MyInvocation.MyCommand.Path -ErrorAction Stop
      if ($p -and (Test-Path $p)) { return @{ Path = $p; Source = "MyInvocation.MyCommand.Path" } }
    }
    $candidates += "MyInvocation.MyCommand.Path=null/missing"
  } catch { $candidates += "MyInvocation threw: $($_.Exception.Message)" }

  # ps2exe: argv[0] e' o caminho da .exe (mais fiavel que GetExecutingAssembly)
  try {
    $argv = [Environment]::GetCommandLineArgs()
    if ($argv -and $argv.Length -gt 0 -and $argv[0]) {
      $p = Split-Path -Parent $argv[0] -ErrorAction Stop
      if ($p -and (Test-Path $p)) { return @{ Path = $p; Source = "Environment.GetCommandLineArgs[0]" } }
    }
    $candidates += "GetCommandLineArgs[0]=null/empty"
  } catch { $candidates += "GetCommandLineArgs threw: $($_.Exception.Message)" }

  # Process main module: pasta da .exe host (npm.exe ou powershell.exe ou wizard.exe)
  try {
    $proc = [System.Diagnostics.Process]::GetCurrentProcess()
    if ($proc -and $proc.MainModule -and $proc.MainModule.FileName) {
      $p = Split-Path -Parent $proc.MainModule.FileName -ErrorAction Stop
      if ($p -and (Test-Path $p)) { return @{ Path = $p; Source = "Process.MainModule.FileName" } }
    }
    $candidates += "MainModule.FileName=null/empty"
  } catch { $candidates += "MainModule threw: $($_.Exception.Message)" }

  # Fallback final: cwd. Quase sempre util mas pode estar errado em
  # shortcuts mal configurados.
  try {
    $cwd = (Get-Location).Path
    if ($cwd -and (Test-Path $cwd)) {
      return @{ Path = $cwd; Source = "Get-Location (fallback)"; Diagnostics = ($candidates -join "; ") }
    }
  } catch { $candidates += "Get-Location threw: $($_.Exception.Message)" }

  return @{ Path = $null; Source = "NONE"; Diagnostics = ($candidates -join "; ") }
}

function Find-RepoRoot {
  # Procura package.json a partir de $startDir, subindo no maximo $MaxLevels
  # niveis. Devolve string ou $null.
  param([string]$StartDir, [int]$MaxLevels = 6)
  if (-not $StartDir -or -not (Test-Path $StartDir)) { return $null }
  $current = $StartDir
  for ($i = 0; $i -le $MaxLevels; $i++) {
    try {
      $pkg = Join-Path $current "package.json" -ErrorAction Stop
      if (Test-Path $pkg) { return $current }
    } catch { return $null }
    try {
      $parent = Split-Path -Parent $current -ErrorAction Stop
    } catch { return $null }
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
  return $null
}

function Get-WizardConfigPath {
  # Caminho da config persistente local:
  #   %APPDATA%\SPharmMT\AdminWizard\config.json
  # Devolve string ou $null (se nem APPDATA estiver disponivel).
  $base = $env:APPDATA
  if (-not $base) {
    try { $base = [Environment]::GetFolderPath('ApplicationData') } catch {}
  }
  if (-not $base) { return $null }
  return (Join-Path (Join-Path (Join-Path $base "SPharmMT") "AdminWizard") "config.json")
}

function Get-SavedRepoRoot {
  # Le repoRoot guardado em config.json de uma execucao anterior.
  # So devolve o caminho se ainda for valido (existe e contem package.json);
  # caso contrario $null. Best-effort: nunca lanca.
  try {
    $cfgPath = Get-WizardConfigPath
    if (-not $cfgPath -or -not (Test-Path $cfgPath)) { return $null }
    $raw = Get-Content -Path $cfgPath -Raw -ErrorAction Stop
    if (-not $raw) { return $null }
    $cfg = $raw | ConvertFrom-Json -ErrorAction Stop
    $saved = $cfg.repoRoot
    if ($saved -and (Test-Path $saved) -and (Test-Path (Join-Path $saved "package.json"))) {
      return $saved
    }
  } catch {}
  return $null
}

function Save-RepoRoot {
  # Persiste a escolha do utilizador em config.json para as proximas
  # execucoes. Best-effort: se falhar (sem permissoes, disco cheio) nao
  # bloqueia o arranque -- o caminho ja esta resolvido em memoria.
  param([string]$Path)
  # Merge: preserva saasBaseUrl/adminToken se existirem (ver Save-Saas).
  $c = Read-WizardConfig
  $c["repoRoot"] = $Path
  [void](Write-WizardConfig -Config $c)
}

function Select-RepoRootDialog {
  # Abre um FolderBrowserDialog para o utilizador escolher a pasta raiz do
  # repo. Valida que contem package.json; se nao, oferece repetir. Devolve
  # uma pasta valida ou $null (utilizador cancelou).
  param([string]$InitialDir)
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  while ($true) {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "Escolha a pasta raiz do repo SPharm.MT (a que contem package.json)"
    $dlg.ShowNewFolderButton = $false
    if ($InitialDir -and (Test-Path $InitialDir)) { $dlg.SelectedPath = $InitialDir }
    $result = $dlg.ShowDialog()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
    $chosen = $dlg.SelectedPath
    if ($chosen -and (Test-Path (Join-Path $chosen "package.json"))) {
      return $chosen
    }
    $retry = [System.Windows.Forms.MessageBox]::Show(
      ("A pasta escolhida nao contem package.json:`r`n  {0}`r`n`r`nTentar de novo?" -f $chosen),
      "SPharm.MT Admin Wizard -- pasta invalida",
      "RetryCancel", "Warning")
    if ($retry -ne [System.Windows.Forms.DialogResult]::Retry) { return $null }
  }
}

# --- Config persistente (merge-aware) -----------------------------
# O config.json em %APPDATA%\SPharmMT\AdminWizard guarda tanto a escolha
# de repo (DEV) como o endpoint SaaS + admin token (STANDALONE). Ler e
# escrever fazem merge para nao apagar campos de outro modo.

function Read-WizardConfig {
  # Devolve hashtable com o conteudo do config.json (ou vazia). Nunca lanca.
  $h = @{}
  try {
    $cfgPath = Get-WizardConfigPath
    if (-not $cfgPath -or -not (Test-Path $cfgPath)) { return $h }
    $raw = Get-Content -Path $cfgPath -Raw -ErrorAction Stop
    if (-not $raw) { return $h }
    $obj = $raw | ConvertFrom-Json -ErrorAction Stop
    foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
  } catch {}
  return $h
}

function Write-WizardConfig {
  # Merge-write. Best-effort: falha silenciosa nao bloqueia o arranque.
  param([hashtable]$Config)
  try {
    $cfgPath = Get-WizardConfigPath
    if (-not $cfgPath) { return $false }
    $cfgDir = Split-Path -Parent $cfgPath
    if (-not (Test-Path $cfgDir)) { New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null }
    $Config["savedAt"] = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
    $Config["savedBy"] = "SPharmMT-Admin-Wizard"
    ([PSCustomObject]$Config) | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8
    return $true
  } catch { return $false }
}

# --- Proteccao do admin token (DPAPI) -----------------------------
# O token da API administrativa da acesso a criacao de tenants e a
# emissao de ingest keys. Em texto simples no %APPDATA% qualquer
# processo a correr como o utilizador -- ou quem copie o perfil, ou um
# backup do disco -- fica com ele. DPAPI CurrentUser cifra-o com a
# credencial de login do Windows: o blob so e legivel pelo MESMO
# utilizador na MESMA maquina, e um config.json copiado para outro sitio
# nao serve para nada.
#
# A entropia adicional e uma constante desta aplicacao. Nao e um segredo
# (esta aqui a vista); serve para que um blob DPAPI produzido por outra
# aplicacao do mesmo utilizador nao possa ser colado neste ficheiro e
# desencriptado por engano.

$script:DpapiEntropy = [System.Text.Encoding]::UTF8.GetBytes("SPharmMT.AdminWizard.v1")

function Protect-WizardSecret {
  # String em claro -> base64 do blob DPAPI. $null se falhar ou vazio.
  param([string]$Plain)
  if (-not $Plain) { return $null }
  try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Plain)
    $prot = [System.Security.Cryptography.ProtectedData]::Protect(
      $bytes, $script:DpapiEntropy,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Convert]::ToBase64String($prot)
  } catch { return $null }
}

function Unprotect-WizardSecret {
  # base64 do blob DPAPI -> string em claro. $null se nao for
  # desencriptavel (outro utilizador, outra maquina, blob corrompido).
  param([string]$Protected)
  if (-not $Protected) { return $null }
  try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $prot = [Convert]::FromBase64String($Protected)
    $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $prot, $script:DpapiEntropy,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [System.Text.Encoding]::UTF8.GetString($bytes)
  } catch { return $null }
}

function Get-SavedSaas {
  # @{ BaseUrl; Token } do config persistido. Campos null se ausentes.
  #
  # O token vem de adminTokenProtected (DPAPI). Instalacoes anteriores
  # gravaram-no em claro em adminToken: essas sao lidas uma ultima vez e
  # imediatamente migradas -- ver Convert-LegacyTokenToDpapi, chamada no
  # arranque. Nunca voltamos a escrever adminToken.
  $c = Read-WizardConfig
  $tok = $null
  if ($c.ContainsKey("adminTokenProtected")) {
    $tok = Unprotect-WizardSecret ([string]$c["adminTokenProtected"])
  }
  if (-not $tok -and $c.ContainsKey("adminToken")) {
    $tok = [string]$c["adminToken"]   # legado, a caminho de ser migrado
  }
  return @{
    BaseUrl = $(if ($c.ContainsKey("saasBaseUrl")) { [string]$c["saasBaseUrl"] } else { $null })
    Token   = $tok
  }
}

function Save-Saas {
  param([string]$BaseUrl, [string]$Token)
  $c = Read-WizardConfig
  $c["saasBaseUrl"] = $BaseUrl
  $prot = Protect-WizardSecret $Token
  if ($prot) {
    $c["adminTokenProtected"] = $prot
    # Nao deixar o valor em claro para tras quando se migra/actualiza.
    if ($c.ContainsKey("adminToken")) { [void]$c.Remove("adminToken") }
  } elseif ($Token) {
    # DPAPI indisponivel: preferimos nao persistir a gravar em claro. O
    # token continua em memoria, esta sessao funciona, a proxima volta a
    # pedir. Guardar em claro seria exactamente o que se quer evitar.
    if ($c.ContainsKey("adminToken")) { [void]$c.Remove("adminToken") }
    if ($c.ContainsKey("adminTokenProtected")) { [void]$c.Remove("adminTokenProtected") }
  }
  return (Write-WizardConfig -Config $c)
}

function Convert-LegacyTokenToDpapi {
  # Se existir um adminToken em claro de uma versao anterior, re-grava-o
  # protegido e apaga o campo em claro. Idempotente e silencioso.
  # Devolve $true se migrou alguma coisa.
  try {
    $c = Read-WizardConfig
    if (-not $c.ContainsKey("adminToken")) { return $false }
    $plain = [string]$c["adminToken"]
    if (-not $plain) { [void]$c.Remove("adminToken"); [void](Write-WizardConfig -Config $c); return $false }
    $url = $(if ($c.ContainsKey("saasBaseUrl")) { [string]$c["saasBaseUrl"] } else { "" })
    [void](Save-Saas -BaseUrl $url -Token $plain)
    return $true
  } catch { return $false }
}

# Modo escolhido pelo operador, persistido. Existe porque a
# auto-deteccao do repositorio nao e uma boa forma de decidir isto: a
# maquina do tecnico TEM o repositorio (e o .env dele aponta para o
# ambiente antigo), e mesmo assim o que se quer e falar com a VPS.
#
# Auto-detectar o repo passava a listar os tenants do control plane
# antigo -- demo-neon, grupo-silveira, piloto-demo -- em vez dos da VPS.
function Get-SavedMode {
  $c = Read-WizardConfig
  if ($c.ContainsKey("mode")) { return ([string]$c["mode"]).Trim().ToLower() }
  return ""
}

function Save-Mode {
  param([string]$Mode)
  $c = Read-WizardConfig
  $c["mode"] = ([string]$Mode).Trim().ToLower()
  return (Write-WizardConfig -Config $c)
}

# Wrap o bootstrap inteiro num try/catch que mostra dialogo de
# diagnostico em vez de stacktrace bruto se algo falhar.
$ScriptDir = $null
$RepoRoot = $null
$BootstrapDiagnostics = $null

try {
  $rootInfo = Get-AppRoot
  $ScriptDir = $rootInfo.Path
  $BootstrapDiagnostics = "AppRoot=$ScriptDir (via $($rootInfo.Source))"
  if ($rootInfo.Diagnostics) { $BootstrapDiagnostics += " | candidates: $($rootInfo.Diagnostics)" }

  if (-not $ScriptDir) {
    throw "Get-AppRoot nao conseguiu resolver qualquer caminho. Diagnostico: $($rootInfo.Diagnostics)"
  }

  # ─── Resolver repo root (so para detectar DEV) ────────────────────
  # Em STANDALONE nao precisamos do repo. So o procuramos para perceber
  # se estamos a correr a partir da arvore de desenvolvimento. SEM dialogo.
  if ($env:SPHARMMT_REPO_ROOT -and (Test-Path $env:SPHARMMT_REPO_ROOT) `
      -and (Test-Path (Join-Path $env:SPHARMMT_REPO_ROOT "package.json"))) {
    $RepoRoot = $env:SPHARMMT_REPO_ROOT
    $BootstrapDiagnostics += " | SPHARMMT_REPO_ROOT=$RepoRoot"
  }
  if (-not $RepoRoot) {
    $RepoRoot = Find-RepoRoot -StartDir $ScriptDir -MaxLevels 6
    if ($RepoRoot) { $BootstrapDiagnostics += " | walk-up RepoRoot=$RepoRoot" }
  }

  # ─── Determinar o modo ────────────────────────────────────────────
  # STANDALONE (default no .exe distribuido): cliente HTTPS contra o SaaS.
  #   Nao exige repo/package.json/Node/npm/Git. NUNCA pede a pasta do repo.
  # DEV: shell-out aos scripts npm. So quando ha repo (ou forcado).
  # Override explicito: SPHARMMT_WIZARD_MODE = dev | standalone.
  # STANDALONE (API) e o modo do produto. DEV existe para quem
  # desenvolve, e passou a exigir um pedido EXPLICITO:
  #
  #   1. SPHARMMT_WIZARD_MODE=dev        variavel de ambiente
  #   2. escolha guardada = dev          botao "Modo..." no cabecalho
  #   3. tudo o resto                    STANDALONE
  #
  # A auto-deteccao do repositorio deixou de decidir seja o que for.
  # Ter o repositorio na maquina nao significa querer usa-lo: o .env
  # local aponta para outro control plane, e o wizard acabava a listar os
  # tenants de la (demo-neon, grupo-silveira, piloto-demo) contra uma VPS
  # nova e vazia. O repositorio continua a ser localizado -- e preciso
  # para o modo DEV quando alguem o escolhe -- mas nao manda no modo.
  $forcedMode = ""
  if ($env:SPHARMMT_WIZARD_MODE) { $forcedMode = ([string]$env:SPHARMMT_WIZARD_MODE).Trim().ToLower() }
  $savedMode = ""
  try { $savedMode = Get-SavedMode } catch { $savedMode = "" }

  $script:ModeSource = ""
  if ($forcedMode -eq "dev")             { $script:Mode = "DEV";        $script:ModeSource = "SPHARMMT_WIZARD_MODE" }
  elseif ($forcedMode -eq "standalone")  { $script:Mode = "STANDALONE"; $script:ModeSource = "SPHARMMT_WIZARD_MODE" }
  elseif ($savedMode -eq "dev")          { $script:Mode = "DEV";        $script:ModeSource = "escolha guardada" }
  elseif ($savedMode -eq "standalone")   { $script:Mode = "STANDALONE"; $script:ModeSource = "escolha guardada" }
  else                                   { $script:Mode = "STANDALONE"; $script:ModeSource = "default" }
  $BootstrapDiagnostics += " | mode=$($script:Mode) (origem: $($script:ModeSource))"

  # DEV forcado sem repo: oferecer escolher a pasta (util ao developer).
  # Se recusar, cai para STANDALONE em vez de abortar. Em STANDALONE puro
  # este ramo nunca corre -> nenhum dialogo de repo aparece.
  if ($script:Mode -eq "DEV" -and -not $RepoRoot) {
    $chosen = Select-RepoRootDialog -InitialDir $ScriptDir
    if ($chosen) {
      $RepoRoot = $chosen
      Save-RepoRoot -Path $RepoRoot
      $BootstrapDiagnostics += " | escolha manual RepoRoot=$RepoRoot"
    } else {
      $script:Mode = "STANDALONE"
      $BootstrapDiagnostics += " | DEV sem repo -> fallback STANDALONE"
    }
  }

  # ─── Directorios de dados + logs (mode-aware) ─────────────────────
  if ($script:Mode -eq "DEV") {
    Set-Location $RepoRoot
    $script:DataDir = $RepoRoot
    $LogDir = Join-Path $RepoRoot "logs"
    $script:OutputDir = Join-Path $RepoRoot "dist-agent\clients"
  } else {
    # STANDALONE: tudo sob %APPDATA%\SPharmMT\AdminWizard (sem repo).
    $cfgPath = Get-WizardConfigPath
    $base = if ($cfgPath) { Split-Path -Parent $cfgPath } else { Join-Path $env:TEMP "SPharmMT-AdminWizard" }
    $script:DataDir = $base
    $LogDir = Join-Path $base "logs"
    $script:OutputDir = Join-Path $base "output"
    # Migrar um token em claro de uma versao anterior ANTES de o ler, para
    # que o ficheiro deixe de o conter logo neste arranque.
    $script:TokenMigrated = Convert-LegacyTokenToDpapi
    $saas = Get-SavedSaas
    $script:SaasBaseUrl = $saas.BaseUrl
    $script:AdminToken = $saas.Token
    # TLS 1.2 para Invoke-RestMethod/Invoke-WebRequest contra SaaS moderno.
    try {
      [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {}
  }
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  $LogFile = Join-Path $LogDir ("admin-wizard-" + (Get-Date -Format "yyyy-MM-dd") + ".log")
} catch {
  # Bootstrap catastrofico. Mostra dialogo amigavel + dump completo.
  $err = $_
  $stack = if ($err.ScriptStackTrace) { $err.ScriptStackTrace } else { "(sem stack)" }
  $msg = "Erro no arranque do wizard:`r`n`r`n"
  $msg += "  $($err.Exception.Message)`r`n`r`n"
  $msg += "Diagnostico de bootstrap:`r`n  $BootstrapDiagnostics`r`n`r`n"
  $msg += "Stack:`r`n$stack"
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show($msg, "SPharm.MT Admin Wizard -- erro de arranque", "OK", "Error") | Out-Null
  } catch {
    # Sem WinForms: ultimo recurso, escreve no Application event log (silencioso)
    try { Write-EventLog -LogName Application -Source "Windows PowerShell" -EventId 999 -EntryType Error -Message $msg -ErrorAction SilentlyContinue } catch {}
  }
  exit 3
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# ZIP via .NET (sem o modulo opcional Microsoft.PowerShell.Archive). Usado
# pelo Agent ZIP standalone (New-AgentZipLocal). Best-effort aqui; a funcao
# volta a tentar carregar antes de usar.
Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
[System.Windows.Forms.Application]::EnableVisualStyles()

# --- Logging ------------------------------------------------------

function Write-WizardLog {
  param([string]$Msg, [string]$Level = "INFO")
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "$ts [$Level] $Msg"
  try { $line | Add-Content -Path $LogFile -Encoding UTF8 } catch {}
}

function Sanitize-CommandArgs {
  # Redact values after = for sensitive flags before writing to log.
  # IMPORTANT: param renamed from $Args (clashes with PowerShell's
  # automatic $Args variable; binding would silently fail and the
  # function received nothing -- that was the root cause of empty
  # "npm" lines in the log).
  param([string[]]$CmdArgs)
  if ($null -eq $CmdArgs) { return @() }
  $sensitive = @("--admin-password", "--password", "--key")
  $out = @()
  foreach ($a in $CmdArgs) {
    if ($null -eq $a) { continue }
    $kept = [string]$a
    foreach ($s in $sensitive) {
      if ($a -like "$s=*") { $kept = "$s=[REDACTED]"; break }
    }
    $out += $kept
  }
  return $out
}

function Format-ArgumentString {
  # Build a Windows command-line arguments string from an array.
  # Each arg is quoted only if it contains whitespace, tab, or quote.
  # Internal quotes are escaped as \" (Microsoft C runtime convention,
  # which Node.js/npm follow). Used instead of ProcessStartInfo.ArgumentList
  # because the latter does NOT exist in .NET Framework 4.x (Windows
  # PowerShell 5.1 + ps2exe runtime).
  param([string[]]$CmdArgs)
  if ($null -eq $CmdArgs -or $CmdArgs.Length -eq 0) { return "" }
  $parts = foreach ($a in $CmdArgs) {
    if ([string]::IsNullOrEmpty($a)) {
      '""'
    } elseif ($a -match '[\s"]') {
      '"' + ($a -replace '"', '\"') + '"'
    } else {
      $a
    }
  }
  return ($parts -join " ")
}

function Find-NpmCommand {
  # Locate npm in PATH. Returns full path or $null. Prefers npm.cmd on
  # Windows (the shim) since npm itself is a JS file there.
  foreach ($name in @("npm.cmd", "npm")) {
    try {
      $c = Get-Command $name -ErrorAction SilentlyContinue
      if ($c -and $c.Source) { return [string]$c.Source }
    } catch {}
  }
  return $null
}

# --- Process runner ----------------------------------------------

# Unified executor used by every command this wizard runs.
#
# Returns a structured pscustomobject with Success/ExitCode/StdOut/StdErr/
# ParsedJson/Exception/ElapsedMs/CommandLine -- never null-valued fields.
# Logs START + DONE + (truncated) stdout/stderr at every call.
#
# Async approach: uses Register-ObjectEvent to enqueue lines into a
# thread-safe ConcurrentQueue; the main loop drains the queue while
# pumping DoEvents() so the UI stays responsive. This pattern avoids
# the .NET Framework 4.x trap that broke v1 (ProcessStartInfo.ArgumentList
# does not exist there).
function Invoke-AdminCommand {
  param(
    [Parameter(Mandatory)][string]$Command,
    [string[]]$CmdArgs = @(),
    [string]$WorkDir = $null,
    [string]$Label = "(no-label)",
    [bool]$ExpectJson = $false,
    [scriptblock]$OnLine = $null
  )

  # Null-safety on inputs
  if ($null -eq $CmdArgs) { $CmdArgs = @() }
  if (-not $WorkDir -or -not (Test-Path $WorkDir)) {
    try { $WorkDir = (Get-Location).Path } catch { $WorkDir = "." }
  }

  $sanitized = Sanitize-CommandArgs -CmdArgs $CmdArgs
  $cmdLineSan = "$Command " + (($sanitized) -join " ")

  Write-WizardLog "[$Label] START cwd=$WorkDir cmd=$cmdLineSan"

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $result = [pscustomobject]@{
    Success     = $false
    ExitCode    = -1
    StdOut      = ""
    StdErr      = ""
    ParsedJson  = $null
    Exception   = $null
    ElapsedMs   = 0L
    CommandLine = $cmdLineSan
  }

  # Order-preserving streams: use ReadToEndAsync (single reader per stream
  # internally; .NET guarantees in-order reads). Previous version used
  # Register-ObjectEvent which dispatches -Action on the PS engine event
  # queue; with high event frequency, multiple PSEventJob runs could
  # enqueue out of order, scrambling JSON output. ReadToEndAsync removes
  # the ambiguity. Trade-off: no real-time streaming output -- the
  # OnLine callback is invoked AFTER process exit, replaying the
  # captured lines in order. Acceptable for admin operations (typical
  # workflow is 1-10s and the user gets the full transcript at end).
  $proc = $null
  $stdoutText = ""
  $stderrText = ""

  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Command
    # .NET Framework 4.x: ArgumentList does NOT exist. MUST use Arguments string.
    $psi.Arguments = Format-ArgumentString -CmdArgs $CmdArgs
    $psi.WorkingDirectory = $WorkDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    try { $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
    try { $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8 } catch {}

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    $started = $proc.Start()
    if (-not $started) {
      throw "Process.Start retornou false sem excepcao."
    }

    # Kick off async readers IMMEDIATELY after Start to drain pipes
    # continuously (avoids deadlock if child writes > 64KB to either stream).
    $soTask = $proc.StandardOutput.ReadToEndAsync()
    $seTask = $proc.StandardError.ReadToEndAsync()

    # Pump UI while child runs
    while (-not $proc.HasExited) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 50
    }
    $proc.WaitForExit()

    # Esperar pelos readers terminarem (geralmente já terminaram quando
    # HasExited é true porque .NET fecha as pipes)
    $soTask.Wait(5000) | Out-Null
    $seTask.Wait(5000) | Out-Null

    $stdoutText = if ($soTask.IsCompleted -and $null -ne $soTask.Result) { [string]$soTask.Result } else { "" }
    $stderrText = if ($seTask.IsCompleted -and $null -ne $seTask.Result) { [string]$seTask.Result } else { "" }

    # Invocar OnLine retrospectivamente (mantém API compatível)
    if ($OnLine) {
      foreach ($line in ($stdoutText -split "`r?`n")) {
        if ($null -ne $line -and $line.Length -gt 0) { try { & $OnLine $line $false } catch {} }
      }
      foreach ($line in ($stderrText -split "`r?`n")) {
        if ($null -ne $line -and $line.Length -gt 0) { try { & $OnLine $line $true } catch {} }
      }
    }

    $result.ExitCode = $proc.ExitCode
  } catch {
    $result.Exception = $_
    Write-WizardLog ("[$Label] EXCEPTION: " + $_.Exception.Message + " | stack: " + $_.ScriptStackTrace) "ERROR"
  } finally {
    if ($proc) { try { $proc.Dispose() } catch {} }
  }

  $sw.Stop()
  $result.ElapsedMs = $sw.ElapsedMilliseconds

  # Null-safety on outputs
  if ($null -eq $stdoutText) { $stdoutText = "" }
  if ($null -eq $stderrText) { $stderrText = "" }
  $result.StdOut = $stdoutText
  $result.StdErr = $stderrText

  Write-WizardLog ("[$Label] DONE exit={0} elapsed={1}ms stdout={2}B stderr={3}B" -f $result.ExitCode, $result.ElapsedMs, $stdoutText.Length, $stderrText.Length)
  if ($stdoutText.Length -gt 0) {
    $clip = $stdoutText.Substring(0, [Math]::Min(2000, $stdoutText.Length))
    Write-WizardLog ("[$Label] STDOUT[0..2000]:`n$clip")
  }
  if ($stderrText.Length -gt 0) {
    $clip = $stderrText.Substring(0, [Math]::Min(2000, $stderrText.Length))
    Write-WizardLog ("[$Label] STDERR[0..2000]:`n$clip")
  }

  if ($ExpectJson -and $stdoutText.Length -gt 0 -and $null -eq $result.Exception) {
    try {
      $result.ParsedJson = Extract-Json -Text $stdoutText
      if ($null -eq $result.ParsedJson) {
        Write-WizardLog ("[$Label] JSON parse: extracted no valid object/array from stdout") "WARN"
      }
    } catch {
      Write-WizardLog ("[$Label] JSON parse threw: " + $_.Exception.Message) "WARN"
    }
  }

  $result.Success = ($result.ExitCode -eq 0 -and $null -eq $result.Exception)
  return $result
}

function Extract-Json {
  # Tolerant JSON extractor. Handles both object ({...}) and array ([...])
  # at the top level. Returns $null if neither parses cleanly.
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $null }

  $startO = $Text.IndexOf("{")
  $endO = $Text.LastIndexOf("}")
  $startA = $Text.IndexOf("[")
  $endA = $Text.LastIndexOf("]")

  # Decide top-level: whichever opening char appears first in the stream.
  $tryArrayFirst = ($startA -ge 0) -and (($startO -lt 0) -or ($startA -lt $startO))

  if ($tryArrayFirst -and $startA -ge 0 -and $endA -gt $startA) {
    $cand = $Text.Substring($startA, $endA - $startA + 1)
    try { return ($cand | ConvertFrom-Json) } catch {}
  }
  if ($startO -ge 0 -and $endO -gt $startO) {
    $cand = $Text.Substring($startO, $endO - $startO + 1)
    try { return ($cand | ConvertFrom-Json) } catch {}
  }
  if ($startA -ge 0 -and $endA -gt $startA) {
    $cand = $Text.Substring($startA, $endA - $startA + 1)
    try { return ($cand | ConvertFrom-Json) } catch {}
  }
  return $null
}

# Resolve npm once at startup; null means PATH miss.
$script:NpmCommand = Find-NpmCommand

function Show-HandlerError {
  # Unified error path for UI event handlers: log + friendly dialog,
  # never let a raw PowerShell exception bubble to a Watson dialog.
  param($Err, [string]$Label = "(handler)")
  $msg = "(sem mensagem)"
  $stack = ""
  try {
    if ($Err -and $Err.Exception) { $msg = $Err.Exception.Message }
    elseif ($Err) { $msg = [string]$Err }
    if ($Err -and $Err.ScriptStackTrace) { $stack = $Err.ScriptStackTrace }
  } catch {}
  try { Write-WizardLog ("[$Label] HANDLER EXCEPTION: $msg | stack: $stack") "ERROR" } catch {}
  try {
    [System.Windows.Forms.MessageBox]::Show(
      "Falhou: $msg`r`n`r`nVer logs\admin-wizard-$(Get-Date -Format 'yyyy-MM-dd').log para detalhes.",
      "SPharm.MT Admin Wizard -- erro", "OK", "Error") | Out-Null
  } catch {}
  try { Set-AllButtonsEnabled $true } catch {}
}

# --- UI helpers ---------------------------------------------------

function Append-Output {
  param([System.Windows.Forms.RichTextBox]$Box, [string]$Text, [System.Drawing.Color]$Color = [System.Drawing.Color]::Black)
  if (-not $Box) { return }
  $action = {
    $Box.SelectionStart = $Box.TextLength
    $Box.SelectionLength = 0
    $Box.SelectionColor = $Color
    $Box.AppendText($Text + "`r`n")
    $Box.SelectionColor = $Box.ForeColor
    $Box.SelectionStart = $Box.TextLength
    $Box.ScrollToCaret()
  }
  if ($Box.InvokeRequired) { $Box.Invoke($action) | Out-Null } else { & $action }
}

function Show-Confirm {
  param([string]$Title, [string]$Body, [string]$RequireText = "CONFIRMO")
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title
  $form.Size = New-Object System.Drawing.Size(560, 280)
  $form.StartPosition = "CenterParent"
  $form.FormBorderStyle = "FixedDialog"
  $form.MinimizeBox = $false
  $form.MaximizeBox = $false

  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Text = $Body
  $lbl.Location = New-Object System.Drawing.Point(12, 12)
  $lbl.Size = New-Object System.Drawing.Size(520, 140)
  $lbl.ForeColor = [System.Drawing.Color]::DarkRed
  $form.Controls.Add($lbl)

  $instr = New-Object System.Windows.Forms.Label
  $instr.Text = "Escrever '$RequireText' (maiusculas, sem aspas) para confirmar:"
  $instr.Location = New-Object System.Drawing.Point(12, 160)
  $instr.Size = New-Object System.Drawing.Size(520, 20)
  $form.Controls.Add($instr)

  $txt = New-Object System.Windows.Forms.TextBox
  $txt.Location = New-Object System.Drawing.Point(12, 185)
  $txt.Size = New-Object System.Drawing.Size(520, 24)
  $form.Controls.Add($txt)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = "Confirmar"
  $ok.Location = New-Object System.Drawing.Point(360, 220)
  $ok.Size = New-Object System.Drawing.Size(80, 26)
  $ok.DialogResult = "OK"
  $form.AcceptButton = $ok
  $form.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = "Cancelar"
  $cancel.Location = New-Object System.Drawing.Point(450, 220)
  $cancel.Size = New-Object System.Drawing.Size(80, 26)
  $cancel.DialogResult = "Cancel"
  $form.CancelButton = $cancel
  $form.Controls.Add($cancel)

  $result = $form.ShowDialog()
  $entered = $txt.Text
  $form.Dispose()
  return ($result -eq "OK" -and $entered -eq $RequireText)
}

function Show-Secrets {
  # Dialog modal para mostrar secrets uma vez, com copy-to-clipboard.
  param(
    [string]$Title,
    [string]$Header,
    [hashtable]$Fields  # ordered: chave = label, valor = secret
  )
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title
  $form.Size = New-Object System.Drawing.Size(620, (160 + (60 * $Fields.Count)))
  $form.StartPosition = "CenterParent"
  $form.FormBorderStyle = "FixedDialog"

  $hdr = New-Object System.Windows.Forms.Label
  $hdr.Text = $Header
  $hdr.Location = New-Object System.Drawing.Point(12, 12)
  $hdr.Size = New-Object System.Drawing.Size(580, 50)
  $hdr.ForeColor = [System.Drawing.Color]::DarkRed
  $form.Controls.Add($hdr)

  $y = 70
  foreach ($k in $Fields.Keys) {
    $lab = New-Object System.Windows.Forms.Label
    $lab.Text = "$k :"
    $lab.Location = New-Object System.Drawing.Point(12, $y)
    $lab.Size = New-Object System.Drawing.Size(110, 22)
    $form.Controls.Add($lab)

    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Text = [string]$Fields[$k]
    $tb.Location = New-Object System.Drawing.Point(125, $y)
    $tb.Size = New-Object System.Drawing.Size(370, 22)
    $tb.ReadOnly = $true
    $tb.Font = New-Object System.Drawing.Font("Consolas", 9)
    $form.Controls.Add($tb)

    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = "Copiar"
    $btn.Location = New-Object System.Drawing.Point(500, ($y - 2))
    $btn.Size = New-Object System.Drawing.Size(80, 26)
    $btn.Tag = [string]$Fields[$k]
    $btn.Add_Click({
      try { [System.Windows.Forms.Clipboard]::SetText($this.Tag) } catch {}
    })
    $form.Controls.Add($btn)
    $y += 32
  }

  $warn = New-Object System.Windows.Forms.Label
  $warn.Text = "Estas credenciais NAO sao recuperaveis -- copia tudo antes de fechar."
  $warn.Location = New-Object System.Drawing.Point(12, ($y + 10))
  $warn.Size = New-Object System.Drawing.Size(580, 24)
  $warn.ForeColor = [System.Drawing.Color]::DarkRed
  $form.Controls.Add($warn)

  $close = New-Object System.Windows.Forms.Button
  $close.Text = "Fechei a copia"
  $close.Location = New-Object System.Drawing.Point(480, ($y + 40))
  $close.Size = New-Object System.Drawing.Size(110, 28)
  $close.DialogResult = "OK"
  $form.Controls.Add($close)
  $form.AcceptButton = $close

  [void]$form.ShowDialog()
  $form.Dispose()
}

# --- Form construction --------------------------------------------

$form = New-Object System.Windows.Forms.Form
$form.Text = "SPharm.MT Admin Wizard v1"
$form.Size = New-Object System.Drawing.Size(1080, 760)
$form.MinimumSize = New-Object System.Drawing.Size(960, 660)
$form.StartPosition = "CenterScreen"
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

# ── Header panel ──────────────────────────────────────────────────
$header = New-Object System.Windows.Forms.Panel
$header.Dock = "Top"
$header.Height = 56
$header.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)
$form.Controls.Add($header)

$titleLbl = New-Object System.Windows.Forms.Label
$titleLbl.Text = "SPharm.MT Admin Wizard"
$titleLbl.Font = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$titleLbl.Location = New-Object System.Drawing.Point(12, 8)
$titleLbl.Size = New-Object System.Drawing.Size(260, 26)
$header.Controls.Add($titleLbl)

$repoLbl = New-Object System.Windows.Forms.Label
$repoLbl.Text = $(if ($script:Mode -eq "DEV") {
    "modo: DEV (npm) | repo: $RepoRoot"
  } else {
    "modo: STANDALONE (HTTPS) | SaaS: " + $(if ($script:SaasBaseUrl) { $script:SaasBaseUrl } else { "(nao configurado)" })
  })
$repoLbl.Location = New-Object System.Drawing.Point(12, 34)
$repoLbl.Size = New-Object System.Drawing.Size(680, 16)
$repoLbl.ForeColor = [System.Drawing.Color]::Gray
$header.Controls.Add($repoLbl)

function Sync-HeaderLabel {
  $repoLbl.Text = $(if ($script:Mode -eq "DEV") {
      "modo: DEV (npm) | repo: $RepoRoot"
    } else {
      # Nota: a Base URL fica VISIVEL no cabecalho. Saber contra que
      # servidor se esta a trabalhar nao pode exigir abrir um dialogo.
      "modo: STANDALONE (API) | Base URL: " + $(if ($script:SaasBaseUrl) { $script:SaasBaseUrl } else { "(nao configurada)" })
    })
}

$tenantLbl = New-Object System.Windows.Forms.Label
$tenantLbl.Text = "Tenant activo:"
$tenantLbl.Location = New-Object System.Drawing.Point(700, 10)
$tenantLbl.Size = New-Object System.Drawing.Size(90, 22)
$header.Controls.Add($tenantLbl)

$tenantCb = New-Object System.Windows.Forms.ComboBox
$tenantCb.Location = New-Object System.Drawing.Point(790, 7)
$tenantCb.Size = New-Object System.Drawing.Size(200, 26)
$tenantCb.DropDownStyle = "DropDownList"
$header.Controls.Add($tenantCb)

$modeBtn = New-Object System.Windows.Forms.Button
$modeBtn.Text = "Modo..."
$modeBtn.Location = New-Object System.Drawing.Point(995, 34)
$modeBtn.Size = New-Object System.Drawing.Size(68, 24)
$header.Controls.Add($modeBtn)

$refreshBtn = New-Object System.Windows.Forms.Button
$refreshBtn.Text = "Refresh"
$refreshBtn.Location = New-Object System.Drawing.Point(995, 6)
$refreshBtn.Size = New-Object System.Drawing.Size(68, 28)
$header.Controls.Add($refreshBtn)

$statusLbl = New-Object System.Windows.Forms.Label
$statusLbl.Text = "Pronto."
$statusLbl.Location = New-Object System.Drawing.Point(700, 34)
$statusLbl.Size = New-Object System.Drawing.Size(370, 16)
$statusLbl.ForeColor = [System.Drawing.Color]::DarkGreen
$header.Controls.Add($statusLbl)

# ── Tabs ──────────────────────────────────────────────────────────
$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = "Fill"
$tabs.Padding = New-Object System.Drawing.Point(12, 6)
$form.Controls.Add($tabs)
$tabs.BringToFront()

function New-Tab {
  param([string]$Text)
  $t = New-Object System.Windows.Forms.TabPage
  $t.Text = $Text
  $t.Padding = New-Object System.Windows.Forms.Padding(10)
  return $t
}

function New-Label {
  param([string]$Text, [int]$X, [int]$Y, [int]$W = 130)
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $Text
  $l.Location = New-Object System.Drawing.Point($X, $Y)
  $l.Size = New-Object System.Drawing.Size($W, 22)
  return $l
}

function New-TextBox {
  param([int]$X, [int]$Y, [int]$W = 280, [string]$Default = "")
  $t = New-Object System.Windows.Forms.TextBox
  $t.Location = New-Object System.Drawing.Point($X, $Y)
  $t.Size = New-Object System.Drawing.Size($W, 24)
  $t.Text = $Default
  return $t
}

function New-OutputBox {
  param([int]$X, [int]$Y, [int]$W, [int]$H)
  $r = New-Object System.Windows.Forms.RichTextBox
  $r.Location = New-Object System.Drawing.Point($X, $Y)
  $r.Size = New-Object System.Drawing.Size($W, $H)
  $r.ReadOnly = $true
  $r.BackColor = [System.Drawing.Color]::FromArgb(20, 20, 30)
  $r.ForeColor = [System.Drawing.Color]::Gainsboro
  $r.Font = New-Object System.Drawing.Font("Consolas", 9)
  $r.WordWrap = $false
  $r.ScrollBars = "Both"
  return $r
}

# ── Tab A: Criar tenant ───────────────────────────────────────────
$tabA = New-Tab "A. Grupo / Tenant"
$tabs.TabPages.Add($tabA)

$tabA.Controls.Add((New-Label "Slug:" 12 16 120))
$aSlug = New-TextBox 140 14 260
$tabA.Controls.Add($aSlug)
$tabA.Controls.Add((New-Label "(lowercase + hifens)" 410 16 200))
$tabA.Controls.Add((New-Label "Nome grupo:" 12 48 120))
$aNome = New-TextBox 140 46 460
$tabA.Controls.Add($aNome)
$tabA.Controls.Add((New-Label "Email admin:" 12 80 120))
$aEmail = New-TextBox 140 78 460
$tabA.Controls.Add($aEmail)

$tabA.Controls.Add((New-Label "Provider:" 12 112 120))
$aProvider = New-Object System.Windows.Forms.ComboBox
$aProvider.Location = New-Object System.Drawing.Point(140, 110)
$aProvider.Size = New-Object System.Drawing.Size(160, 24)
$aProvider.DropDownStyle = "DropDownList"
[void]$aProvider.Items.Add("neon")
[void]$aProvider.Items.Add("manual")
[void]$aProvider.Items.Add("local")
# Default = local: e o provider da stack self-hosted (PostgreSQL da VPS).
# `neon` continua na lista e funciona na mesma para quem o use.
$aProvider.SelectedIndex = 2
$tabA.Controls.Add($aProvider)

$tabA.Controls.Add((New-Label "Database URL:" 12 144 120))
$aDbUrl = New-TextBox 140 142 720 ""
$aDbUrl.Enabled = $false
$tabA.Controls.Add($aDbUrl)
$tabA.Controls.Add((New-Label "(so para provider=manual)" 870 144 180))

$aProvider.Add_SelectedIndexChanged({
  $aDbUrl.Enabled = ($aProvider.SelectedItem -eq "manual")
})

$tabA.Controls.Add((New-Label "Region:" 12 176 120))
$aRegion = New-TextBox 140 174 160 "eu-west-2"
$tabA.Controls.Add($aRegion)

$tabA.Controls.Add((New-Label "Farmacias iniciais:" 12 208 120))
$aFarmacias = New-TextBox 140 206 720 ""
$tabA.Controls.Add($aFarmacias)
$tabA.Controls.Add((New-Label "(opcional; nomes separados por virgula)" 12 230 600))

$aDryRun = New-Object System.Windows.Forms.CheckBox
$aDryRun.Text = "Dry-run (valida sem criar)"
$aDryRun.Location = New-Object System.Drawing.Point(140, 256)
$aDryRun.Size = New-Object System.Drawing.Size(220, 24)
$tabA.Controls.Add($aDryRun)

$aBtn = New-Object System.Windows.Forms.Button
$aBtn.Text = "Criar tenant"
$aBtn.Location = New-Object System.Drawing.Point(140, 290)
$aBtn.Size = New-Object System.Drawing.Size(180, 32)
$aBtn.BackColor = [System.Drawing.Color]::FromArgb(220, 60, 60)
$aBtn.ForeColor = [System.Drawing.Color]::White
$aBtn.FlatStyle = "Flat"
$tabA.Controls.Add($aBtn)

$aOut = New-OutputBox 12 340 1020 320
$aOut.Anchor = "Top,Left,Right,Bottom"
$tabA.Controls.Add($aOut)

# ── Tab B: Farmacias ──────────────────────────────────────────────
$tabB = New-Tab "B. Farmacias"
$tabs.TabPages.Add($tabB)

$tabB.Controls.Add((New-Label "Tenant:" 12 16 120))
$bTenant = New-Object System.Windows.Forms.Label
$bTenant.Location = New-Object System.Drawing.Point(140, 16)
$bTenant.Size = New-Object System.Drawing.Size(300, 22)
$bTenant.Text = "(seleccionar no cabecalho)"
$bTenant.Font = New-Object System.Drawing.Font("Consolas", 9, [System.Drawing.FontStyle]::Bold)
$tabB.Controls.Add($bTenant)

$tabB.Controls.Add((New-Label "Nome:" 12 48 120))
$bNome = New-TextBox 140 46 460
$tabB.Controls.Add($bNome)
$tabB.Controls.Add((New-Label "Codigo ANF:" 12 80 120))
$bCodigo = New-TextBox 140 78 200
$tabB.Controls.Add($bCodigo)
$tabB.Controls.Add((New-Label "Morada:" 12 112 120))
$bMorada = New-TextBox 140 110 720
$tabB.Controls.Add($bMorada)
$tabB.Controls.Add((New-Label "Contacto:" 12 144 120))
$bContacto = New-TextBox 140 142 460
$tabB.Controls.Add($bContacto)

$bAddBtn = New-Object System.Windows.Forms.Button
$bAddBtn.Text = "Adicionar farmacia"
$bAddBtn.Location = New-Object System.Drawing.Point(140, 180)
$bAddBtn.Size = New-Object System.Drawing.Size(180, 32)
$tabB.Controls.Add($bAddBtn)

$bListBtn = New-Object System.Windows.Forms.Button
$bListBtn.Text = "Listar farmacias (via status)"
$bListBtn.Location = New-Object System.Drawing.Point(330, 180)
$bListBtn.Size = New-Object System.Drawing.Size(200, 32)
$tabB.Controls.Add($bListBtn)

$bOut = New-OutputBox 12 230 1020 430
$bOut.Anchor = "Top,Left,Right,Bottom"
$tabB.Controls.Add($bOut)

# ── Tab C: Utilizadores ───────────────────────────────────────────
$tabC = New-Tab "C. Utilizadores"
$tabs.TabPages.Add($tabC)

$tabC.Controls.Add((New-Label "Tenant:" 12 16 120))
$cTenant = New-Object System.Windows.Forms.Label
$cTenant.Location = New-Object System.Drawing.Point(140, 16)
$cTenant.Size = New-Object System.Drawing.Size(300, 22)
$cTenant.Text = "(seleccionar no cabecalho)"
$cTenant.Font = New-Object System.Drawing.Font("Consolas", 9, [System.Drawing.FontStyle]::Bold)
$tabC.Controls.Add($cTenant)

$tabC.Controls.Add((New-Label "Email:" 12 48 120))
$cEmail = New-TextBox 140 46 460
$tabC.Controls.Add($cEmail)
$tabC.Controls.Add((New-Label "Nome:" 12 80 120))
$cNome = New-TextBox 140 78 460
$tabC.Controls.Add($cNome)
$tabC.Controls.Add((New-Label "Role:" 12 112 120))
$cRole = New-Object System.Windows.Forms.ComboBox
$cRole.Location = New-Object System.Drawing.Point(140, 110)
$cRole.Size = New-Object System.Drawing.Size(200, 24)
$cRole.DropDownStyle = "DropDownList"
[void]$cRole.Items.Add("ADMINISTRADOR")
[void]$cRole.Items.Add("GESTOR_GRUPO")
[void]$cRole.Items.Add("GESTOR_FARMACIA")
[void]$cRole.Items.Add("OPERADOR")
$cRole.SelectedIndex = 3
$tabC.Controls.Add($cRole)

$tabC.Controls.Add((New-Label "Farmacia:" 12 144 120))
$cFarmacia = New-TextBox 140 142 460
$tabC.Controls.Add($cFarmacia)
$cFarmaciaHint = New-Object System.Windows.Forms.Label
$cFarmaciaHint.Location = New-Object System.Drawing.Point(610, 144)
$cFarmaciaHint.Size = New-Object System.Drawing.Size(400, 22)
$cFarmaciaHint.ForeColor = [System.Drawing.Color]::Gray
$cFarmaciaHint.Text = "Obrigatorio para GESTOR_FARMACIA/OPERADOR"
$tabC.Controls.Add($cFarmaciaHint)

$tabC.Controls.Add((New-Label "Password manual:" 12 176 120))
$cPassword = New-TextBox 140 174 280
$tabC.Controls.Add($cPassword)
$tabC.Controls.Add((New-Label "(deixar vazio para gerar)" 430 176 240))

$cAddBtn = New-Object System.Windows.Forms.Button
$cAddBtn.Text = "Criar utilizador"
$cAddBtn.Location = New-Object System.Drawing.Point(140, 214)
$cAddBtn.Size = New-Object System.Drawing.Size(180, 32)
$tabC.Controls.Add($cAddBtn)

$cOut = New-OutputBox 12 260 1020 400
$cOut.Anchor = "Top,Left,Right,Bottom"
$tabC.Controls.Add($cOut)

# ── Tab D: Agent ZIP ──────────────────────────────────────────────
$tabD = New-Tab "D. Agent ZIP"
$tabs.TabPages.Add($tabD)

$tabD.Controls.Add((New-Label "Tenant:" 12 16 120))
$dTenant = New-Object System.Windows.Forms.Label
$dTenant.Location = New-Object System.Drawing.Point(140, 16)
$dTenant.Size = New-Object System.Drawing.Size(300, 22)
$dTenant.Text = "(seleccionar no cabecalho)"
$dTenant.Font = New-Object System.Drawing.Font("Consolas", 9, [System.Drawing.FontStyle]::Bold)
$tabD.Controls.Add($dTenant)

$tabD.Controls.Add((New-Label "Farmacia:" 12 48 120))
$dFarmacia = New-Object System.Windows.Forms.ComboBox
$dFarmacia.Location = New-Object System.Drawing.Point(140, 46)
$dFarmacia.Size = New-Object System.Drawing.Size(360, 24)
$dFarmacia.DropDownStyle = "DropDown"   # editavel: lista + escrita livre (fallback)
$tabD.Controls.Add($dFarmacia)
$dFarmLoadBtn = New-Object System.Windows.Forms.Button
$dFarmLoadBtn.Text = "Carregar"
$dFarmLoadBtn.Location = New-Object System.Drawing.Point(505, 45)
$dFarmLoadBtn.Size = New-Object System.Drawing.Size(95, 26)
$tabD.Controls.Add($dFarmLoadBtn)
$tabD.Controls.Add((New-Label "(escolher da lista; envia por ID)" 610 48 300))
# Mapa nome -> id das farmacias do tenant carregado (selecao por ID,
# imune a encoding de acentos). Vazio = envia por nome (fallback).
$script:dFarmaciaMap = @{}

$tabD.Controls.Add((New-Label "Endpoint SaaS:" 12 80 120))
# VAZIO de proposito. Com um default aqui, o ZIP saia configurado para
# esse endereco mesmo contra outro servidor -- e este campo tem
# PRECEDENCIA sobre o SPHARMMT_PUBLIC_ENDPOINT do servidor. Era assim que
# um ZIP gerado a partir da VPS ficava a apontar para o ambiente antigo.
#
# Vazio = o servidor decide, a partir da sua propria configuracao, que e
# a resposta certa em praticamente todos os casos. Preencher aqui e a
# excepcao, nao a regra.
$dEndpoint = New-TextBox 140 78 460 ""
$tabD.Controls.Add($dEndpoint)
$tabD.Controls.Add((New-Label "(vazio = usa o endpoint configurado no servidor)" 140 102 460))

$tabD.Controls.Add((New-Label "Healthcheck URL:" 12 112 120))
$dHealth = New-TextBox 140 110 720 ""
$tabD.Controls.Add($dHealth)
$tabD.Controls.Add((New-Label "(https://hc-ping.com/<uuid>; opcional)" 12 134 600))

$dKeyGroup = New-Object System.Windows.Forms.GroupBox
$dKeyGroup.Text = "Ingest key"
$dKeyGroup.Location = New-Object System.Drawing.Point(12, 162)
$dKeyGroup.Size = New-Object System.Drawing.Size(1020, 130)
$dKeyGroup.Anchor = "Top,Left,Right"
$tabD.Controls.Add($dKeyGroup)

$dKeyExisting = New-Object System.Windows.Forms.RadioButton
$dKeyExisting.Text = "Usar key existente (cola abaixo) -- nao invalida agents existentes"
$dKeyExisting.Location = New-Object System.Drawing.Point(12, 22)
$dKeyExisting.Size = New-Object System.Drawing.Size(700, 22)
$dKeyExisting.Checked = $true
$dKeyGroup.Controls.Add($dKeyExisting)

$dKeyText = New-TextBox 32 46 700
$dKeyText.PasswordChar = "*"
$dKeyGroup.Controls.Add($dKeyText)

$dKeyRotate = New-Object System.Windows.Forms.RadioButton
$dKeyRotate.Text = "Rotacionar (INVALIDA agents existentes do tenant -- precisa re-instalar todos)"
$dKeyRotate.Location = New-Object System.Drawing.Point(12, 80)
$dKeyRotate.Size = New-Object System.Drawing.Size(800, 22)
$dKeyRotate.ForeColor = [System.Drawing.Color]::DarkRed
$dKeyGroup.Controls.Add($dKeyRotate)

$dKeyText.Add_Enter({ $dKeyExisting.Checked = $true })

$dSqlGroup = New-Object System.Windows.Forms.GroupBox
$dSqlGroup.Text = "Pre-fill SQL Server (opcional)"
$dSqlGroup.Location = New-Object System.Drawing.Point(12, 300)
$dSqlGroup.Size = New-Object System.Drawing.Size(1020, 90)
$dSqlGroup.Anchor = "Top,Left,Right"
$tabD.Controls.Add($dSqlGroup)

$dSqlGroup.Controls.Add((New-Label "Host:" 12 22 60))
$dSqlHost = New-TextBox 70 20 180
$dSqlGroup.Controls.Add($dSqlHost)
$dSqlGroup.Controls.Add((New-Label "Port:" 260 22 50))
$dSqlPort = New-TextBox 310 20 80 "1433"
$dSqlGroup.Controls.Add($dSqlPort)
$dSqlGroup.Controls.Add((New-Label "Database:" 400 22 70))
$dSqlDatabase = New-TextBox 470 20 180 "SPHARM"
$dSqlGroup.Controls.Add($dSqlDatabase)
$dSqlGroup.Controls.Add((New-Label "User:" 660 22 50))
$dSqlUser = New-TextBox 710 20 200 "spharm_readonly"
$dSqlGroup.Controls.Add($dSqlUser)

$dPkgBtn = New-Object System.Windows.Forms.Button
$dPkgBtn.Text = "Gerar ZIP agent"
$dPkgBtn.Location = New-Object System.Drawing.Point(140, 400)
$dPkgBtn.Size = New-Object System.Drawing.Size(180, 32)
$tabD.Controls.Add($dPkgBtn)

$dOpenBtn = New-Object System.Windows.Forms.Button
$dOpenBtn.Text = "Abrir pasta dos ZIPs"
$dOpenBtn.Location = New-Object System.Drawing.Point(330, 400)
$dOpenBtn.Size = New-Object System.Drawing.Size(180, 32)
$tabD.Controls.Add($dOpenBtn)

$dOut = New-OutputBox 12 442 1020 218
$dOut.Anchor = "Top,Left,Right,Bottom"
$tabD.Controls.Add($dOut)

# ── Tab E: Status / Precheck ──────────────────────────────────────
$tabE = New-Tab "E. Status / Precheck"
$tabs.TabPages.Add($tabE)

$tabE.Controls.Add((New-Label "Tenant:" 12 16 120))
$eTenant = New-Object System.Windows.Forms.Label
$eTenant.Location = New-Object System.Drawing.Point(140, 16)
$eTenant.Size = New-Object System.Drawing.Size(300, 22)
$eTenant.Text = "(seleccionar no cabecalho)"
$eTenant.Font = New-Object System.Drawing.Font("Consolas", 9, [System.Drawing.FontStyle]::Bold)
$tabE.Controls.Add($eTenant)

$eStatusBtn = New-Object System.Windows.Forms.Button
$eStatusBtn.Text = "Ver status"
$eStatusBtn.Location = New-Object System.Drawing.Point(140, 52)
$eStatusBtn.Size = New-Object System.Drawing.Size(180, 32)
$tabE.Controls.Add($eStatusBtn)

$ePrecheckBtn = New-Object System.Windows.Forms.Button
$ePrecheckBtn.Text = "Rodar pilot:precheck"
$ePrecheckBtn.Location = New-Object System.Drawing.Point(330, 52)
$ePrecheckBtn.Size = New-Object System.Drawing.Size(180, 32)
$tabE.Controls.Add($ePrecheckBtn)

$eZipsBtn = New-Object System.Windows.Forms.Button
$eZipsBtn.Text = "Abrir pasta dos ZIPs"
$eZipsBtn.Location = New-Object System.Drawing.Point(520, 52)
$eZipsBtn.Size = New-Object System.Drawing.Size(180, 32)
$tabE.Controls.Add($eZipsBtn)

$eLogsBtn = New-Object System.Windows.Forms.Button
$eLogsBtn.Text = "Abrir logs"
$eLogsBtn.Location = New-Object System.Drawing.Point(710, 52)
$eLogsBtn.Size = New-Object System.Drawing.Size(180, 32)
$tabE.Controls.Add($eLogsBtn)

$eOut = New-OutputBox 12 100 1020 560
$eOut.Anchor = "Top,Left,Right,Bottom"
$tabE.Controls.Add($eOut)

# ── Footer ────────────────────────────────────────────────────────
$footer = New-Object System.Windows.Forms.Panel
$footer.Dock = "Bottom"
$footer.Height = 24
$footer.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)
$form.Controls.Add($footer)

$footerLbl = New-Object System.Windows.Forms.Label
$footerLbl.Text = "Logs: $LogFile"
$footerLbl.Dock = "Fill"
$footerLbl.TextAlign = "MiddleLeft"
$footerLbl.ForeColor = [System.Drawing.Color]::Gray
$footerLbl.Padding = New-Object System.Windows.Forms.Padding(12, 0, 12, 0)
$footer.Controls.Add($footerLbl)

# --- Helpers para sync de tenant seleccionado ---------------------

function Sync-TenantLabels {
  $sel = $tenantCb.SelectedItem
  $txt = if ($sel) { [string]$sel } else { "(seleccionar no cabecalho)" }
  foreach ($l in @($bTenant, $cTenant, $dTenant, $eTenant)) { $l.Text = $txt }
}

function Set-AllButtonsEnabled {
  param([bool]$Enabled)
  foreach ($b in @($aBtn, $bAddBtn, $bListBtn, $cAddBtn, $dPkgBtn, $eStatusBtn, $ePrecheckBtn, $refreshBtn)) {
    $b.Enabled = $Enabled
  }
  # SEM excepcao para o "Criar tenant". Existia uma -- o botao ficava
  # desactivado em STANDALONE -- de quando criar tenants so era possivel
  # por npm no repositorio. Com POST /api/admin/v1/tenants deixou de o
  # ser: e mais uma operacao da API, como todas as outras desta lista.
}

function Set-Status {
  param([string]$Msg, [System.Drawing.Color]$Color = [System.Drawing.Color]::DarkGreen)
  $action = { $statusLbl.Text = $Msg; $statusLbl.ForeColor = $Color }
  if ($statusLbl.InvokeRequired) { $statusLbl.Invoke($action) | Out-Null } else { & $action }
}

# --- Carregar tenants ---------------------------------------------

function Refresh-Tenants {
  Set-Status "A carregar tenants..." ([System.Drawing.Color]::DarkBlue)
  Set-AllButtonsEnabled $false
  try {
    if ($script:Mode -eq "STANDALONE") {
      if (-not (Ensure-SaasConfigured)) {
        Set-Status "SaaS nao configurado." ([System.Drawing.Color]::DarkRed)
        return
      }
      $r = Invoke-AdminApi -Method GET -Path "/api/admin/v1/tenants" -Label "tenants"
      if (-not $r.Success) {
        $em = if ($r.Error) { $r.Error } else { "status=$($r.StatusCode)" }
        Set-Status ("Falhou a carregar tenants: $em") ([System.Drawing.Color]::DarkRed)
        $ask = [System.Windows.Forms.MessageBox]::Show(
          ("Falhou a ligar ao SaaS:`r`n  $em`r`n`r`nReconfigurar endpoint/token?"),
          "SaaS -- erro de ligacao", "YesNo", "Warning")
        if ($ask -eq [System.Windows.Forms.DialogResult]::Yes) {
          if (Show-SaasConfigDialog -InitialUrl $script:SaasBaseUrl -InitialToken $script:AdminToken) {
            $r = Invoke-AdminApi -Method GET -Path "/api/admin/v1/tenants" -Label "tenants-retry"
          }
        }
        if (-not $r.Success) { return }
      }
      $tenantCb.Items.Clear()
      $arr = @()
      if ($r.Json -and $r.Json.tenants) { $arr = @($r.Json.tenants) }
      foreach ($t in $arr) { if ($t -and $t.slug) { [void]$tenantCb.Items.Add([string]$t.slug) } }
      if ($tenantCb.Items.Count -gt 0) { $tenantCb.SelectedIndex = 0 }
      Sync-TenantLabels
      Set-Status ("$($tenantCb.Items.Count) tenant(s) carregados.")
      return
    }
    if (-not $script:NpmCommand) {
      Set-Status "npm nao encontrado no PATH" ([System.Drawing.Color]::DarkRed)
      [System.Windows.Forms.MessageBox]::Show(
        "Nao foi possivel encontrar 'npm' no PATH do sistema.`r`n`r`nInstala o Node.js (https://nodejs.org/) ou verifica que o PATH contem o directorio onde 'npm.cmd' esta. Depois reinicia o wizard.",
        "SPharm.MT Admin Wizard -- npm em falta", "OK", "Error") | Out-Null
      return
    }
    $r = Invoke-AdminCommand -Command $script:NpmCommand -CmdArgs @("run","--silent","tenancy:list","--","--json") -WorkDir $RepoRoot -Label "tenancy:list" -ExpectJson $true
    if (-not $r.Success) {
      $msg = "tenancy:list falhou (exit=$($r.ExitCode))."
      if ($r.Exception) { $msg += " Excepcao: $($r.Exception.Exception.Message)" }
      $msg += "`r`n`r`nVer logs\admin-wizard-$(Get-Date -Format 'yyyy-MM-dd').log para detalhes."
      [System.Windows.Forms.MessageBox]::Show($msg, "Erro a carregar tenants", "OK", "Error") | Out-Null
      Set-Status "Falhou a carregar tenants." ([System.Drawing.Color]::DarkRed)
      return
    }
    $list = @()
    if ($r.ParsedJson -is [System.Collections.IEnumerable] -and $r.ParsedJson -isnot [string]) {
      $list = @($r.ParsedJson)
    }
    $tenantCb.Items.Clear()
    foreach ($t in $list) {
      if ($t -and $t.slug) { [void]$tenantCb.Items.Add([string]$t.slug) }
    }
    if ($tenantCb.Items.Count -gt 0) { $tenantCb.SelectedIndex = 0 }
    Sync-TenantLabels
    Set-Status ("$($tenantCb.Items.Count) tenant(s) carregados.")
  } catch {
    Write-WizardLog ("Refresh-Tenants threw: " + $_.Exception.Message + " | " + $_.ScriptStackTrace) "ERROR"
    Set-Status "Erro a carregar tenants -- ver log." ([System.Drawing.Color]::DarkRed)
  } finally {
    Set-AllButtonsEnabled $true
  }
}

$refreshBtn.Add_Click({ Refresh-Tenants })

function Show-ModeDialog {
  # Escolha explicita do modo, persistida. O reinicio e exigido de
  # proposito: o modo decide directorios de dados, de logs e de output,
  # todos fixados no arranque. Trocar a meio deixaria o wizard num estado
  # meio-inicializado -- pior do que pedir para reabrir.
  $f = New-Object System.Windows.Forms.Form
  $f.Text = "Modo de funcionamento"
  $f.Size = New-Object System.Drawing.Size(560, 300)
  $f.StartPosition = "CenterParent"
  $f.FormBorderStyle = "FixedDialog"
  $f.MaximizeBox = $false; $f.MinimizeBox = $false

  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Text = "Modo actual: $($script:Mode)   (origem: $($script:ModeSource))"
  $lbl.Location = New-Object System.Drawing.Point(14, 14)
  $lbl.Size = New-Object System.Drawing.Size(520, 20)
  $f.Controls.Add($lbl)

  $rbStand = New-Object System.Windows.Forms.RadioButton
  $rbStand.Text = "STANDALONE (API) -- fala com a Base URL. Nao usa o repositorio."
  $rbStand.Location = New-Object System.Drawing.Point(14, 48)
  $rbStand.Size = New-Object System.Drawing.Size(520, 24)
  $rbStand.Checked = ($script:Mode -eq "STANDALONE")
  $f.Controls.Add($rbStand)

  $rbDev = New-Object System.Windows.Forms.RadioButton
  $rbDev.Text = "DEV (npm) -- corre comandos npm no repositorio local."
  $rbDev.Location = New-Object System.Drawing.Point(14, 76)
  $rbDev.Size = New-Object System.Drawing.Size(520, 24)
  $rbDev.Checked = ($script:Mode -eq "DEV")
  $f.Controls.Add($rbDev)

  $warn = New-Object System.Windows.Forms.Label
  $warn.Location = New-Object System.Drawing.Point(14, 108)
  $warn.Size = New-Object System.Drawing.Size(520, 76)
  $warn.ForeColor = [System.Drawing.Color]::DarkRed
  $warn.Text = "DEV usa o .env do repositorio, que pode apontar para outro servidor.`r`nPara trabalhar contra a VPS self-hosted, escolhe STANDALONE (API)."
  $f.Controls.Add($warn)

  $envLbl = New-Object System.Windows.Forms.Label
  $envLbl.Location = New-Object System.Drawing.Point(14, 186)
  $envLbl.Size = New-Object System.Drawing.Size(520, 20)
  $envLbl.ForeColor = [System.Drawing.Color]::Gray
  $envLbl.Text = $(if ($env:SPHARMMT_WIZARD_MODE) {
      "SPHARMMT_WIZARD_MODE=$($env:SPHARMMT_WIZARD_MODE) -- tem precedencia sobre esta escolha."
    } else { "SPHARMMT_WIZARD_MODE nao esta definida." })
  $f.Controls.Add($envLbl)

  $okBtn = New-Object System.Windows.Forms.Button
  $okBtn.Text = "Guardar"; $okBtn.Location = New-Object System.Drawing.Point(330, 218)
  $okBtn.Size = New-Object System.Drawing.Size(90, 28)
  $okBtn.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $f.Controls.Add($okBtn); $f.AcceptButton = $okBtn

  $cancelBtn = New-Object System.Windows.Forms.Button
  $cancelBtn.Text = "Cancelar"; $cancelBtn.Location = New-Object System.Drawing.Point(430, 218)
  $cancelBtn.Size = New-Object System.Drawing.Size(90, 28)
  $cancelBtn.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $f.Controls.Add($cancelBtn); $f.CancelButton = $cancelBtn

  if ($f.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }

  $chosen = $(if ($rbDev.Checked) { "dev" } else { "standalone" })
  [void](Save-Mode -Mode $chosen)
  Write-WizardLog "modo guardado: $chosen"
  [System.Windows.Forms.MessageBox]::Show(
    "Modo guardado: $($chosen.ToUpper()).`r`n`r`nFecha e reabre o wizard para aplicar.",
    "Modo de funcionamento", "OK", "Information") | Out-Null
}

$modeBtn.Add_Click({ try { Show-ModeDialog } catch { Show-HandlerError $_ "dialogo-modo" } })
$tenantCb.Add_SelectedIndexChanged({ Sync-TenantLabels })

# --- Operacoes ----------------------------------------------------

function Get-SelectedTenant {
  if (-not $tenantCb.SelectedItem) {
    [System.Windows.Forms.MessageBox]::Show("Selecciona um tenant no cabecalho primeiro.", "Tenant em falta", "OK", "Warning") | Out-Null
    return $null
  }
  return [string]$tenantCb.SelectedItem
}

function Run-NpmInTab {
  # Unified UI wrapper around Invoke-AdminCommand for npm scripts.
  # IMPORTANT: param renamed from $Args (clashes with automatic var).
  param(
    [string]$Script,
    [string[]]$CmdArgs,
    [System.Windows.Forms.RichTextBox]$Box,
    [string]$Label,
    [bool]$ExpectJson = $false
  )
  if ($null -eq $CmdArgs) { $CmdArgs = @() }

  # GUARDA ESTRUTURAL. Cada handler ja faz `return` depois do ramo da
  # API, mas isso e uma promessa que se perde quando alguem acrescentar
  # um handler novo e esquecer o return. Aqui a promessa e verificada.
  #
  # Em STANDALONE nao ha repositorio de confianca: correr `npm run` usava
  # o .env local, que aponta para OUTRO control plane. E assim que
  # apareciam tenants que nao existem na VPS.
  if ($script:Mode -eq "STANDALONE") {
    $msg = "BLOQUEADO: '$Script' e um comando npm e o wizard esta em modo STANDALONE (API)."
    Append-Output $Box $msg ([System.Drawing.Color]::IndianRed)
    Append-Output $Box "Em STANDALONE tudo passa pela Base URL configurada. Nenhum npm e executado." ([System.Drawing.Color]::Gainsboro)
    Write-WizardLog "[$Label] BLOQUEADO: tentativa de npm em modo STANDALONE" "ERROR"
    Set-Status "Comando npm bloqueado em modo STANDALONE." ([System.Drawing.Color]::DarkRed)
    return $null
  }

  Set-Status "A correr: $Label" ([System.Drawing.Color]::DarkBlue)
  Set-AllButtonsEnabled $false
  Append-Output $Box ">>> $Label" ([System.Drawing.Color]::Cyan)

  if (-not $script:NpmCommand) {
    Append-Output $Box "[X] npm nao encontrado no PATH" ([System.Drawing.Color]::IndianRed)
    Set-Status "npm em falta -- ver log." ([System.Drawing.Color]::DarkRed)
    Write-WizardLog "[$Label] ABORTED: NpmCommand=null" "ERROR"
    [System.Windows.Forms.MessageBox]::Show(
      "Nao foi possivel encontrar 'npm' no PATH do sistema.",
      "npm em falta", "OK", "Error") | Out-Null
    Set-AllButtonsEnabled $true
    return $null
  }

  $allArgs = @("run","--silent",$Script,"--") + ($CmdArgs)
  $sanitized = Sanitize-CommandArgs -CmdArgs $allArgs
  Append-Output $Box ("    " + ([System.IO.Path]::GetFileName($script:NpmCommand)) + " " + (($sanitized) -join " ")) ([System.Drawing.Color]::DarkGray)

  $r = $null
  try {
    $r = Invoke-AdminCommand -Command $script:NpmCommand -CmdArgs $allArgs -WorkDir $RepoRoot -Label $Label -ExpectJson $ExpectJson -OnLine {
      param($line, $isErr)
      if ($null -eq $line) { return }
      $color = if ($isErr) { [System.Drawing.Color]::Salmon }
        elseif ($line -like "*[X]*" -or $line -like "*FAIL*" -or $line -like "*Erro*") { [System.Drawing.Color]::IndianRed }
        elseif ($line -like "*[OK]*" -or $line -like "*Status: *OK*" -or $line -like "*[v]*" -or $line -like "*[ok]*") { [System.Drawing.Color]::LightGreen }
        else { [System.Drawing.Color]::Gainsboro }
      Append-Output $Box $line $color
    }
  } catch {
    Write-WizardLog ("[$Label] Run-NpmInTab threw: " + $_.Exception.Message + " | " + $_.ScriptStackTrace) "ERROR"
    Append-Output $Box ("[X] EXCEPTION: " + $_.Exception.Message) ([System.Drawing.Color]::IndianRed)
  } finally {
    Set-AllButtonsEnabled $true
  }

  if ($null -eq $r) {
    Set-Status "Erro -- ver log." ([System.Drawing.Color]::DarkRed)
    return $null
  }
  if ($r.Success) {
    Append-Output $Box ("<<< OK (exit=0, {0}ms)" -f $r.ElapsedMs) ([System.Drawing.Color]::LightGreen)
    Set-Status ("OK ({0}ms)." -f $r.ElapsedMs) ([System.Drawing.Color]::DarkGreen)
  } else {
    $tail = if ($r.Exception) { "EXCEPTION: " + $r.Exception.Exception.Message } else { "exit=$($r.ExitCode)" }
    Append-Output $Box ("<<< FAIL ({0}, {1}ms)" -f $tail, $r.ElapsedMs) ([System.Drawing.Color]::IndianRed)
    Set-Status ("Falhou ({0}) -- ver log." -f $tail) ([System.Drawing.Color]::DarkRed)
  }
  return $r
}

# --- STANDALONE (HTTPS) transport ---------------------------------
# Em STANDALONE o wizard nao corre npm: fala HTTPS com os endpoints
# /api/admin/v1/* do SaaS. PowerShell faz HTTPS nativamente, logo o PC
# de instalacao nao precisa de repo/Node/npm/Git.

function Read-ResponseUtf8 {
  # Le o corpo de uma resposta Invoke-WebRequest SEMPRE como UTF-8,
  # independentemente do charset que o servidor declarou (Next pode omitir
  # charset; o default do PS 5.1 corromperia acentos).
  param($Resp)
  try {
    if ($Resp.RawContentStream) {
      $ms = $Resp.RawContentStream
      try { $ms.Position = 0 } catch {}
      $sr = New-Object System.IO.StreamReader($ms, [System.Text.Encoding]::UTF8)
      return $sr.ReadToEnd()
    }
  } catch {}
  try { if ($Resp.Content) { return [string]$Resp.Content } } catch {}
  return $null
}

function Invoke-AdminApi {
  # UTF-8 end-to-end. Devolve pscustomobject
  # @{ Success; StatusCode; Json; Error; ElapsedMs }. Nunca lanca.
  param(
    [string]$Method = "GET",
    [Parameter(Mandatory)][string]$Path,
    $Body = $null,
    [string]$Label = "(api)",
    [int]$TimeoutSec = 180
  )
  $res = [pscustomobject]@{ Success = $false; StatusCode = 0; Json = $null; Error = $null; ElapsedMs = 0L }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  if (-not $script:SaasBaseUrl -or -not $script:AdminToken) {
    $res.Error = "SaaS endpoint/token nao configurados"
    return $res
  }
  $uri = ($script:SaasBaseUrl.TrimEnd('/')) + $Path
  $headers = @{ Authorization = "Bearer $($script:AdminToken)"; Accept = "application/json" }
  Write-WizardLog "[$Label] API $Method $uri"
  try {
    $params = @{
      Method          = $Method
      Uri             = $uri
      Headers         = $headers
      TimeoutSec      = $TimeoutSec
      UseBasicParsing = $true
    }
    if ($null -ne $Body) {
      # CRUCIAL: enviar o corpo como BYTES UTF-8. Uma string -Body iria, no
      # PS 5.1, em Latin-1/ASCII e corromper acentos (ex.: "Farmácia" ->
      # "Farm?cia"/"Farm�cia"). charset explicito no Content-Type.
      $json = $Body | ConvertTo-Json -Depth 8
      $params["Body"] = [System.Text.Encoding]::UTF8.GetBytes($json)
      $params["ContentType"] = "application/json; charset=utf-8"
    }
    $resp = Invoke-WebRequest @params
    $res.StatusCode = [int]$resp.StatusCode
    $text = Read-ResponseUtf8 $resp
    if ($text) { try { $res.Json = $text | ConvertFrom-Json } catch {} }
    $res.Success = ($res.StatusCode -ge 200 -and $res.StatusCode -lt 300)
  } catch {
    $res.Error = $_.Exception.Message
    $httpResp = $null
    try { $httpResp = $_.Exception.Response } catch {}
    if ($httpResp) { try { $res.StatusCode = [int]$httpResp.StatusCode } catch {} }
    # Corpo do erro em UTF-8: ler o stream da resposta; fallback ErrorDetails.
    $bodyText = $null
    try {
      if ($httpResp) {
        $stream = $httpResp.GetResponseStream()
        $sr = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $bodyText = $sr.ReadToEnd()
        $sr.Close()
      }
    } catch {}
    if (-not $bodyText) {
      try { if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $bodyText = [string]$_.ErrorDetails.Message } } catch {}
    }
    if ($bodyText) {
      try {
        $parsed = $bodyText | ConvertFrom-Json
        $res.Json = $parsed
        if ($parsed.message) { $res.Error = [string]$parsed.message }
      } catch {}
    }
    Write-WizardLog ("[$Label] API ERROR status=$($res.StatusCode): $($res.Error)") "ERROR"
  }
  $sw.Stop(); $res.ElapsedMs = $sw.ElapsedMilliseconds
  Write-WizardLog ("[$Label] API DONE status={0} ok={1} {2}ms" -f $res.StatusCode, $res.Success, $res.ElapsedMs)
  return $res
}

function Run-ApiInTab {
  # Wrapper UI para Invoke-AdminApi (analogo a Run-NpmInTab). Devolve $r.
  param(
    [string]$Method = "GET",
    [Parameter(Mandatory)][string]$Path,
    $Body = $null,
    [System.Windows.Forms.RichTextBox]$Box,
    [string]$Label
  )
  Set-Status "A correr: $Label" ([System.Drawing.Color]::DarkBlue)
  Set-AllButtonsEnabled $false
  Append-Output $Box ">>> $Label" ([System.Drawing.Color]::Cyan)
  Append-Output $Box ("    $Method $Path") ([System.Drawing.Color]::DarkGray)
  $r = $null
  try {
    $r = Invoke-AdminApi -Method $Method -Path $Path -Body $Body -Label $Label
  } catch {
    Write-WizardLog ("[$Label] Run-ApiInTab threw: " + $_.Exception.Message) "ERROR"
  } finally {
    Set-AllButtonsEnabled $true
  }
  if ($null -eq $r) {
    Set-Status "Erro -- ver log." ([System.Drawing.Color]::DarkRed)
    return $null
  }
  if ($r.Success) {
    Append-Output $Box ("<<< OK ({0}ms)" -f $r.ElapsedMs) ([System.Drawing.Color]::LightGreen)
    Set-Status ("OK ({0}ms)." -f $r.ElapsedMs) ([System.Drawing.Color]::DarkGreen)
  } else {
    $msg = if ($r.Error) { $r.Error } else { "status=$($r.StatusCode)" }
    Append-Output $Box ("<<< FALHOU ($msg)") ([System.Drawing.Color]::IndianRed)
    Set-Status ("Falhou ($msg) -- ver log.") ([System.Drawing.Color]::DarkRed)
  }
  return $r
}

function Show-SaasConfigDialog {
  # Pede endpoint SaaS + admin token. Testa via /ping antes de guardar.
  # Em sucesso actualiza $script:SaasBaseUrl/$script:AdminToken + persiste.
  # Devolve $true se configurado e validado.
  param([string]$InitialUrl, [string]$InitialToken)
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = "SPharm.MT Admin Wizard -- ligacao ao SaaS"
  $dlg.Size = New-Object System.Drawing.Size(620, 280)
  $dlg.StartPosition = "CenterParent"
  $dlg.FormBorderStyle = "FixedDialog"
  $dlg.MinimizeBox = $false
  $dlg.MaximizeBox = $false

  $info = New-Object System.Windows.Forms.Label
  $info.Text = "Configura o endpoint do SaaS e o admin token. O wizard testa a ligacao antes de guardar. Token: ADMIN_API_TOKENS definido no servidor."
  $info.Location = New-Object System.Drawing.Point(12, 12)
  $info.Size = New-Object System.Drawing.Size(580, 44)
  $dlg.Controls.Add($info)

  $lblU = New-Object System.Windows.Forms.Label
  $lblU.Text = "SaaS endpoint:"
  $lblU.Location = New-Object System.Drawing.Point(12, 66)
  $lblU.Size = New-Object System.Drawing.Size(110, 22)
  $dlg.Controls.Add($lblU)
  $txtU = New-Object System.Windows.Forms.TextBox
  $txtU.Location = New-Object System.Drawing.Point(125, 64)
  $txtU.Size = New-Object System.Drawing.Size(465, 24)
  # Sem default: o operador escreve o endereco do servidor a que se quer
  # ligar. Um endereco pre-preenchido convida a aceita-lo sem ler, e era
  # o do ambiente antigo.
  $txtU.Text = $(if ($InitialUrl) { $InitialUrl } else { "" })
  $dlg.Controls.Add($txtU)

  $lblT = New-Object System.Windows.Forms.Label
  $lblT.Text = "Admin token:"
  $lblT.Location = New-Object System.Drawing.Point(12, 100)
  $lblT.Size = New-Object System.Drawing.Size(110, 22)
  $dlg.Controls.Add($lblT)
  $txtT = New-Object System.Windows.Forms.TextBox
  $txtT.Location = New-Object System.Drawing.Point(125, 98)
  $txtT.Size = New-Object System.Drawing.Size(465, 24)
  $txtT.UseSystemPasswordChar = $true
  $txtT.Text = $(if ($InitialToken) { $InitialToken } else { "" })
  $dlg.Controls.Add($txtT)

  $statusDlg = New-Object System.Windows.Forms.Label
  $statusDlg.Text = ""
  $statusDlg.Location = New-Object System.Drawing.Point(12, 134)
  $statusDlg.Size = New-Object System.Drawing.Size(580, 40)
  $dlg.Controls.Add($statusDlg)

  $btnTest = New-Object System.Windows.Forms.Button
  $btnTest.Text = "Testar e guardar"
  $btnTest.Location = New-Object System.Drawing.Point(360, 200)
  $btnTest.Size = New-Object System.Drawing.Size(130, 28)
  $dlg.Controls.Add($btnTest)
  $btnTest.Add_Click({
    $u = $txtU.Text.Trim()
    $tk = $txtT.Text.Trim()
    if (-not $u -or $u -notmatch '^https?://') {
      $statusDlg.Text = "Endpoint invalido (https://...)."
      $statusDlg.ForeColor = [System.Drawing.Color]::DarkRed
      return
    }
    if (-not $tk) {
      $statusDlg.Text = "Token em falta."
      $statusDlg.ForeColor = [System.Drawing.Color]::DarkRed
      return
    }
    $statusDlg.Text = "A testar ligacao..."
    $statusDlg.ForeColor = [System.Drawing.Color]::DarkBlue
    $dlg.Refresh()
    $prevUrl = $script:SaasBaseUrl; $prevTok = $script:AdminToken
    $script:SaasBaseUrl = $u
    $script:AdminToken = $tk
    $ping = Invoke-AdminApi -Method GET -Path "/api/admin/v1/ping" -Label "ping" -TimeoutSec 30
    if ($ping.Success) {
      Save-Saas -BaseUrl $u -Token $tk | Out-Null
      $dlg.DialogResult = "OK"
      $dlg.Close()
    } else {
      # Restaurar valores anteriores: nao deixar credenciais invalidas "activas".
      $script:SaasBaseUrl = $prevUrl; $script:AdminToken = $prevTok
      $msg = if ($ping.Error) { $ping.Error } else { "status=$($ping.StatusCode)" }
      $statusDlg.Text = "Falhou: $msg"
      $statusDlg.ForeColor = [System.Drawing.Color]::DarkRed
    }
  })

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = "Cancelar"
  $btnCancel.Location = New-Object System.Drawing.Point(500, 200)
  $btnCancel.Size = New-Object System.Drawing.Size(90, 28)
  $btnCancel.DialogResult = "Cancel"
  $dlg.CancelButton = $btnCancel
  $dlg.Controls.Add($btnCancel)

  $result = $dlg.ShowDialog()
  $dlg.Dispose()
  $okSaved = ($result -eq "OK")
  if ($okSaved) { Sync-HeaderLabel }
  return $okSaved
}

function Ensure-SaasConfigured {
  # Garante endpoint+token validos. Abre o dialogo se preciso.
  if ($script:SaasBaseUrl -and $script:AdminToken) { return $true }
  return (Show-SaasConfigDialog -InitialUrl $script:SaasBaseUrl -InitialToken $script:AdminToken)
}

function New-AgentZipLocal {
  # Monta o Agent ZIP final localmente: descarrega o template base (object
  # storage), injecta agent.config.json e zipa para $script:OutputDir.
  # Devolve o caminho do .zip ou $null.
  param(
    $Config,
    [string]$BaseUrl,
    [string]$SuggestedName,
    [System.Windows.Forms.RichTextBox]$Box
  )
  if (-not $BaseUrl) {
    Append-Output $Box "[X] Servidor nao devolveu baseAgentUrl (AGENT_BASE_ZIP_URL nao configurado no SaaS)." ([System.Drawing.Color]::IndianRed)
    return $null
  }
  if (-not (Test-Path $script:OutputDir)) { New-Item -ItemType Directory -Path $script:OutputDir -Force | Out-Null }
  $work = Join-Path $env:TEMP ("spharmmt-agent-" + [guid]::NewGuid().ToString('N'))
  $baseZip = "$work.zip"
  $stage = Join-Path $work "pkg"
  try {
    # ZIP via .NET (System.IO.Compression.ZipFile) — NÃO depende do modulo
    # opcional Microsoft.PowerShell.Archive (Expand-Archive/Compress-Archive
    # falham com "module could not be loaded" em ambientes restritos/exe).
    Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue

    New-Item -ItemType Directory -Path $work -Force | Out-Null
    Append-Output $Box "  v Descarregar template base do agente..." ([System.Drawing.Color]::Gainsboro)
    Invoke-WebRequest -Uri $BaseUrl -OutFile $baseZip -UseBasicParsing -TimeoutSec 600

    Append-Output $Box "  v Extrair template (.NET ZipFile)..." ([System.Drawing.Color]::Gainsboro)
    [System.IO.Compression.ZipFile]::ExtractToDirectory($baseZip, $stage)

    # Se o zip tiver uma unica pasta de topo, usar essa como raiz do agente.
    $top = @(Get-ChildItem -Path $stage)
    $agentRoot = $stage
    if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $agentRoot = $top[0].FullName }

    $cfgPath = Join-Path $agentRoot "agent.config.json"
    # UTF-8 SEM BOM: o agent (Node) faz JSON.parse e um BOM inicial parte-o.
    $cfgJson = ($Config | ConvertTo-Json -Depth 8)
    [System.IO.File]::WriteAllText($cfgPath, $cfgJson, (New-Object System.Text.UTF8Encoding($false)))
    Append-Output $Box "  v Escrever agent.config.json (UTF-8)" ([System.Drawing.Color]::Gainsboro)

    $zipOut = Join-Path $script:OutputDir ("$SuggestedName.zip")
    if (Test-Path $zipOut) { Remove-Item $zipOut -Force }
    Append-Output $Box "  v Zipar pacote final (.NET ZipFile)..." ([System.Drawing.Color]::Gainsboro)
    # includeBaseDirectory=$false → conteudo de $agentRoot na RAIZ do zip
    # (mesmo layout do template base; node.exe/agent.cjs no topo).
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
      $agentRoot, $zipOut,
      [System.IO.Compression.CompressionLevel]::Optimal, $false)
    return $zipOut
  } catch {
    Append-Output $Box ("[X] Falha a montar o ZIP: " + $_.Exception.Message) ([System.Drawing.Color]::IndianRed)
    Write-WizardLog ("[agent-zip] " + $_.Exception.Message + " | " + $_.ScriptStackTrace) "ERROR"
    return $null
  } finally {
    try { if (Test-Path $baseZip) { Remove-Item $baseZip -Force -ErrorAction SilentlyContinue } } catch {}
    try { if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue } } catch {}
  }
}

function Render-StatusJson {
  param($J, [System.Windows.Forms.RichTextBox]$Box)
  if (-not $J) { return }
  $cp = $J.controlPlane
  Append-Output $Box ("Tenant: " + $J.slug + "  estado=" + $cp.estado) ([System.Drawing.Color]::Cyan)
  Append-Output $Box ("  nome       : " + $cp.nome) ([System.Drawing.Color]::Gainsboro)
  Append-Output $Box ("  DB         : " + $cp.dbName + "@" + $cp.dbHost) ([System.Drawing.Color]::Gainsboro)
  Append-Output $Box ("  ingest key : " + $(if ($cp.ingestKeyIssued) { "emitida" } else { "(nao emitida)" })) ([System.Drawing.Color]::Gainsboro)
  $db = $J.tenantDb
  if (-not $db) { Append-Output $Box "  (tenant nao ACTIVE -- sem dados de BD)" ([System.Drawing.Color]::Khaki); return }
  if (-not $db.reachable) { Append-Output $Box ("  BD inacessivel: " + $db.error) ([System.Drawing.Color]::IndianRed); return }
  Append-Output $Box ("  migrations : " + $db.migrationsTotal + " (ultima: " + $db.lastMigration + ")") ([System.Drawing.Color]::Gainsboro)
  Append-Output $Box ("  farmacias  : " + $db.farmaciasAtivas + " ATIVO / " + $db.farmaciasTotal + " total") ([System.Drawing.Color]::Gainsboro)
  foreach ($f in @($db.farmacias)) { Append-Output $Box ("     - " + $f.nome + " [" + $f.estado + "]") ([System.Drawing.Color]::DarkGray) }
  Append-Output $Box ("  VendaMensal: " + $db.vendaMensalRows + " rows (ultimo mes: " + $db.vendaMensalLastMonth + ")") ([System.Drawing.Color]::Gainsboro)
  Append-Output $Box ("  staging    : UNKNOWN=" + $db.stagingUnknowns + " orphans=" + $db.stagingOperationalOrphans) ([System.Drawing.Color]::Gainsboro)
}

function Render-PrecheckJson {
  param($J, [System.Windows.Forms.RichTextBox]$Box)
  if (-not $J) { return }
  foreach ($c in @($J.checks)) {
    $g = switch ($c.status) { "ok" { "[v]" } "warn" { "[!]" } default { "[X]" } }
    $color = switch ($c.status) {
      "ok" { [System.Drawing.Color]::LightGreen }
      "warn" { [System.Drawing.Color]::Khaki }
      default { [System.Drawing.Color]::IndianRed }
    }
    $line = "  $g " + $c.label
    if ($c.detail) { $line += " -- " + $c.detail }
    Append-Output $Box $line $color
  }
  if ($J.summary) {
    Append-Output $Box ("Resumo: " + $J.summary.oks + " ok, " + $J.summary.warns + " warn, " + $J.summary.fails + " fail  ->  " + $J.status) ([System.Drawing.Color]::Gainsboro)
  }
}

# A. Criar tenant
$aBtn.Add_Click({
  try {
  # Criar tenant passou a ser API-first, como todas as outras tabs.
  #
  # Antes: `npm run tenancy:create` NA MAQUINA DO TECNICO. Isso exigia o
  # repositorio, o Node e -- pior -- CONTROL_DATABASE_URL com alcance a
  # base. Na stack self-hosted o PostgreSQL nao publica porto nenhum, por
  # desenho, portanto esse caminho deixou de existir e a tab ficava
  # bloqueada em modo STANDALONE.
  #
  # Agora: POST /api/admin/v1/tenants. A logica e exactamente a mesma --
  # o servidor chama lib/admin/create-client-workflow.ts, que e o que o
  # `tenant:create` sempre usou. Nada foi duplicado.
  if (-not (Ensure-SaasConfigured)) {
    Append-Output $aOut "SaaS endpoint/token nao configurados." ([System.Drawing.Color]::Yellow)
    return
  }
  $slug = $aSlug.Text.Trim()
  $nome = $aNome.Text.Trim()
  $email = $aEmail.Text.Trim()
  $provider = [string]$aProvider.SelectedItem
  $dbUrl = $aDbUrl.Text.Trim()
  $region = $aRegion.Text.Trim()
  $farmacias = $aFarmacias.Text.Trim()
  $dryRun = $aDryRun.Checked

  if (-not $slug -or $slug -notmatch '^[a-z0-9][a-z0-9-]*$') {
    [System.Windows.Forms.MessageBox]::Show("Slug invalido. Use lowercase + hifens, comeco com letra ou digito.", "Validacao", "OK", "Warning") | Out-Null
    return
  }
  if (-not $nome) { [System.Windows.Forms.MessageBox]::Show("Nome do grupo em falta.", "Validacao", "OK", "Warning") | Out-Null; return }
  if (-not $email -or $email -notmatch '@') { [System.Windows.Forms.MessageBox]::Show("Email do admin invalido.", "Validacao", "OK", "Warning") | Out-Null; return }
  if ($provider -eq "manual" -and -not $dbUrl) { [System.Windows.Forms.MessageBox]::Show("Database URL obrigatorio para provider=manual.", "Validacao", "OK", "Warning") | Out-Null; return }

  # Detectar duplicado (slug ja existente)
  foreach ($it in $tenantCb.Items) {
    if ([string]$it -eq $slug) {
      [System.Windows.Forms.MessageBox]::Show("Slug '$slug' ja existe na lista de tenants. Aborto.", "Duplicado", "OK", "Warning") | Out-Null
      return
    }
  }

  if (-not $dryRun) {
    $body = "Vai criar:`r`n  Slug   : $slug`r`n  Nome   : $nome`r`n  Email  : $email`r`n  Prov.  : $provider`r`n  Region : $region`r`n  Farms  : $(if ($farmacias) { $farmacias } else { '(nenhuma)' })`r`n`r`nIsto cria uma BD nova + admin + ingest key. Operacao com side-effects no control plane."
    if (-not (Show-Confirm -Title "Confirmar criacao de tenant" -Body $body)) {
      Append-Output $aOut "Operacao abortada." ([System.Drawing.Color]::Yellow)
      return
    }
  }

  $reqBody = @{
    slug       = $slug
    name       = $nome
    adminEmail = $email
    provider   = $provider
  }
  if ($region)    { $reqBody["region"] = $region }
  if ($farmacias) { $reqBody["farmacias"] = $farmacias }
  if ($provider -eq "manual" -and $dbUrl) { $reqBody["databaseUrl"] = $dbUrl }
  if ($provider -eq "local") { $reqBody["createDb"] = $true }
  if ($dryRun)    { $reqBody["dryRun"] = $true }

  $r = Run-ApiInTab -Method POST -Path "/api/admin/v1/tenants" -Body $reqBody -Box $aOut -Label "criar tenant $slug"
  if (-not $r) { return }

  $j = $r.Json

  # 409 = slug ja em uso. Merece mensagem propria: repetir a criacao e um
  # engano comum e "falhou" nao diz ao tecnico que o cliente ja existe.
  if ($r.StatusCode -eq 409) {
    [System.Windows.Forms.MessageBox]::Show(
      "O cliente '$slug' JA EXISTE no control plane.`r`n`r`n" +
      "Nada foi criado nem alterado.`r`n`r`n" +
      "Se a criacao anterior falhou a meio, limpa-a primeiro (no servidor):`r`n" +
      "  tenancy:cleanup-failed -- --slug $slug --confirm",
      "Cliente duplicado", "OK", "Warning") | Out-Null
    Append-Output $aOut "Slug '$slug' ja existe -- nada foi criado." ([System.Drawing.Color]::Yellow)
    Refresh-Tenants
    return
  }
  if ($r.StatusCode -eq 429) {
    $wait = if ($j -and $j.retryAfterSec) { [string]$j.retryAfterSec } else { "?" }
    [System.Windows.Forms.MessageBox]::Show(
      "Demasiadas criacoes seguidas. Tenta outra vez daqui a $wait segundos.",
      "Limite de taxa", "OK", "Warning") | Out-Null
    return
  }

  if (-not $r.Success) {
    # Failure path: surface accionable dialog. Workflow returns structured
    # error in ParsedJson (step + error string). Cleanup hint includes
    # the slug already-known. The output box has the full stderr/stdout.
    $step = if ($j -and $j.step) { [string]$j.step } else { "(?)" }
    $errTxt = if ($j -and $j.error) { [string]$j.error } else { "(ver output do tab e log)" }
    $dlg = "Criar tenant '$slug' FALHOU.`r`n`r`n"
    $dlg += "Step: $step`r`n"
    $dlg += "Erro: $errTxt`r`n"
    if ($errTxt -match "Cleanup autom" -or $errTxt -match "tenancy:cleanup-failed") {
      $dlg += "`r`nO erro indica que recursos Neon podem ter ficado em estado parcial. `r`n"
      $dlg += "Le a seccao 'Cleanup automatico' acima -- se algum cleanup FALHOU, `r`n"
      $dlg += "remove DB/role manualmente em https://console.neon.tech/ antes de re-tentar.`r`n`r`n"
      $dlg += "Antes de re-tentar com o mesmo slug, corre:`r`n"
      $dlg += "  npm run tenancy:cleanup-failed -- --slug $slug --confirm`r`n"
    } else {
      $dlg += "`r`nVer o output do tab e logs\admin-wizard-$(Get-Date -Format 'yyyy-MM-dd').log para detalhes."
    }
    [System.Windows.Forms.MessageBox]::Show($dlg, "Criar tenant falhou", "OK", "Error") | Out-Null
    return
  }

  if ($j -and $j.ok -and $j.dryRun) {
    Append-Output $aOut "Dry-run OK -- nada foi criado. Desmarca 'dry-run' para executar." ([System.Drawing.Color]::LightGreen)
    return
  }

  if ($j -and $j.ok -and $j.step -eq "done") {
    $fields = [ordered]@{
      "Admin email"    = [string]$j.adminEmail
      "Admin password" = [string]$j.adminPassword
      "Ingest key"     = [string]$j.ingestKey
      "Tenant id"      = [string]$j.tenantId
    }
    Show-Secrets -Title "Credenciais criadas" -Header "Tenant '$slug' criado com sucesso.`r`nCopia estas credenciais AGORA -- nao sao recuperaveis. Nao foram escritas no log." -Fields $fields
    Refresh-Tenants
    # Pre-seleccionar o tenant criado
    for ($i = 0; $i -lt $tenantCb.Items.Count; $i++) {
      if ([string]$tenantCb.Items[$i] -eq $slug) { $tenantCb.SelectedIndex = $i; break }
    }
  }
  } catch { Show-HandlerError $_ "tab-A-criar-tenant" }
})

# B. Adicionar farmacia
$bAddBtn.Add_Click({
  try {
  $t = Get-SelectedTenant
  if (-not $t) { return }
  $nome = $bNome.Text.Trim()
  if (-not $nome) { [System.Windows.Forms.MessageBox]::Show("Nome da farmacia em falta.", "Validacao", "OK", "Warning") | Out-Null; return }

  $cmdArgs = @("--tenant=$t", "--nome=$nome")
  if ($bCodigo.Text.Trim()) { $cmdArgs += "--codigo=$($bCodigo.Text.Trim())" }
  if ($bMorada.Text.Trim()) { $cmdArgs += "--morada=$($bMorada.Text.Trim())" }
  if ($bContacto.Text.Trim()) { $cmdArgs += "--contacto=$($bContacto.Text.Trim())" }

  $body = "Adicionar farmacia '$nome' ao tenant '$t'?"
  if (-not (Show-Confirm -Title "Confirmar adicao" -Body $body)) {
    Append-Output $bOut "Abortado." ([System.Drawing.Color]::Yellow)
    return
  }
  if ($script:Mode -eq "STANDALONE") {
    $reqBody = @{ nome = $nome }
    if ($bCodigo.Text.Trim()) { $reqBody["codigo"] = $bCodigo.Text.Trim() }
    if ($bMorada.Text.Trim()) { $reqBody["morada"] = $bMorada.Text.Trim() }
    if ($bContacto.Text.Trim()) { $reqBody["contacto"] = $bContacto.Text.Trim() }
    $r = Run-ApiInTab -Method POST -Path "/api/admin/v1/tenants/$t/farmacias" -Body $reqBody -Box $bOut -Label "add-farmacia $t / $nome"
    if ($r -and $r.Success) {
      Append-Output $bOut ("  v farmacia criada: " + $r.Json.created.nome) ([System.Drawing.Color]::LightGreen)
      if ($r.Json.farmacias) { Append-Output $bOut ("  farmacias no tenant: " + @($r.Json.farmacias).Count) ([System.Drawing.Color]::Gainsboro) }
      $bNome.Text = ""; $bCodigo.Text = ""; $bMorada.Text = ""; $bContacto.Text = ""
    }
    return
  }
  $r = Run-NpmInTab -Script "tenancy:add-farmacia" -CmdArgs $cmdArgs -Box $bOut -Label "add-farmacia $t / $nome"
  if ($r -and $r.Success) {
    $bNome.Text = ""; $bCodigo.Text = ""; $bMorada.Text = ""; $bContacto.Text = ""
  }
  } catch { Show-HandlerError $_ "tab-B-add-farmacia" }
})

$bListBtn.Add_Click({
  try {
    $t = Get-SelectedTenant
    if (-not $t) { return }
    if ($script:Mode -eq "STANDALONE") {
      $r = Run-ApiInTab -Method GET -Path "/api/admin/v1/tenants/$t/status" -Box $bOut -Label "status $t"
      if ($r -and $r.Success) { Render-StatusJson -J $r.Json -Box $bOut }
      return
    }
    Run-NpmInTab -Script "tenancy:status" -CmdArgs @("--tenant=$t") -Box $bOut -Label "status $t" | Out-Null
  } catch { Show-HandlerError $_ "tab-B-list" }
})

# C. Criar utilizador
$cAddBtn.Add_Click({
  try {
  $t = Get-SelectedTenant
  if (-not $t) { return }
  $email = $cEmail.Text.Trim().ToLower()
  $nome = $cNome.Text.Trim()
  $role = [string]$cRole.SelectedItem
  $farm = $cFarmacia.Text.Trim()
  $userPwd = $cPassword.Text.Trim()  # renamed: $pwd is an automatic var ($PWD)

  if (-not $email -or $email -notmatch '@') { [System.Windows.Forms.MessageBox]::Show("Email invalido.", "Validacao", "OK", "Warning") | Out-Null; return }
  if (-not $nome) { [System.Windows.Forms.MessageBox]::Show("Nome em falta.", "Validacao", "OK", "Warning") | Out-Null; return }
  if (($role -eq "GESTOR_FARMACIA" -or $role -eq "OPERADOR") -and -not $farm) {
    [System.Windows.Forms.MessageBox]::Show("Role $role exige --farmacia.", "Validacao", "OK", "Warning") | Out-Null
    return
  }

  $cmdArgs = @("--tenant=$t", "--email=$email", "--nome=$nome", "--role=$role")
  if ($farm) { $cmdArgs += "--farmacia=$farm" }
  if ($userPwd) { $cmdArgs += "--password=$userPwd" }

  $body = "Criar utilizador '$email' ($role) no tenant '$t'?"
  if ($userPwd) { $body += "`r`nPassword: fornecida manualmente." } else { $body += "`r`nPassword: vai ser GERADA (mostrada uma vez)." }
  if (-not (Show-Confirm -Title "Confirmar criacao de utilizador" -Body $body)) {
    Append-Output $cOut "Abortado." ([System.Drawing.Color]::Yellow)
    return
  }
  if ($script:Mode -eq "STANDALONE") {
    $reqBody = @{ email = $email; nome = $nome; role = $role }
    if ($farm) { $reqBody["farmacia"] = $farm }
    if ($userPwd) { $reqBody["password"] = $userPwd }
    $r = Run-ApiInTab -Method POST -Path "/api/admin/v1/tenants/$t/users" -Body $reqBody -Box $cOut -Label "add-user $t / $email"
    if ($r -and $r.Success) {
      if ($r.Json.passwordGenerated -and $r.Json.password) {
        $fields = [ordered]@{ "Email" = $email; "Password" = [string]$r.Json.password }
        Show-Secrets -Title "Password gerada" -Header "Utilizador '$email' criado.`r`nCopia a password AGORA -- nao e recuperavel.`r`nO utilizador vai ser obrigado a trocar no primeiro login." -Fields $fields
      }
      $cEmail.Text = ""; $cNome.Text = ""; $cFarmacia.Text = ""; $cPassword.Text = ""
    }
    return
  }
  $r = Run-NpmInTab -Script "tenancy:add-user" -CmdArgs $cmdArgs -Box $cOut -Label "add-user $t / $email"
  if ($r -and $r.Success -and -not $userPwd) {
    # add-user imprime "Password (anotar AGORA...):" seguido da linha com a password.
    # Extrair com regex tolerante.
    $stdout = $r.StdOut
    $m = [regex]::Match($stdout, "Password \(anotar AGORA[^)]*\):\s*\r?\n\s+([^\r\n]+)")
    if ($m.Success) {
      $genPwd = $m.Groups[1].Value.Trim()
      $fields = [ordered]@{
        "Email"    = $email
        "Password" = $genPwd
      }
      Show-Secrets -Title "Password gerada" -Header "Utilizador '$email' criado.`r`nCopia a password AGORA -- nao e recuperavel.`r`nO utilizador vai ser obrigado a trocar no primeiro login." -Fields $fields
    }
  }
  if ($r -and $r.Success) {
    $cEmail.Text = ""; $cNome.Text = ""; $cFarmacia.Text = ""; $cPassword.Text = ""
  }
  } catch { Show-HandlerError $_ "tab-C-add-user" }
})

# D. Carregar farmacias do tenant (popula dropdown + mapa nome->id)
$dFarmLoadBtn.Add_Click({
  try {
    $t = Get-SelectedTenant
    if (-not $t) { return }
    $script:dFarmaciaMap = @{}
    $dFarmacia.Items.Clear()
    if ($script:Mode -ne "STANDALONE") {
      Append-Output $dOut "Carregar farmacias so em STANDALONE; em DEV escreve o nome." ([System.Drawing.Color]::Khaki)
      return
    }
    $r = Invoke-AdminApi -Method GET -Path "/api/admin/v1/tenants/$t/status" -Label "farmacias $t"
    if ($r.Success -and $r.Json.tenantDb -and $r.Json.tenantDb.farmacias) {
      foreach ($f in @($r.Json.tenantDb.farmacias)) {
        if ($f.nome) {
          [void]$dFarmacia.Items.Add([string]$f.nome)
          if ($f.id) { $script:dFarmaciaMap[[string]$f.nome] = [string]$f.id }
        }
      }
      Append-Output $dOut ("Farmacias carregadas: " + $dFarmacia.Items.Count + " (selecao envia por ID)") ([System.Drawing.Color]::Gainsboro)
      if ($dFarmacia.Items.Count -gt 0) { $dFarmacia.SelectedIndex = 0 }
    } else {
      $em = if ($r.Error) { $r.Error } else { "status=$($r.StatusCode)" }
      Append-Output $dOut ("Nao foi possivel carregar farmacias: $em") ([System.Drawing.Color]::Khaki)
    }
  } catch { Show-HandlerError $_ "tab-D-load-farmacias" }
})

# D. Gerar ZIP agent
$dPkgBtn.Add_Click({
  try {
  $t = Get-SelectedTenant
  if (-not $t) { return }
  $farm = $dFarmacia.Text.Trim()
  $endpoint = $dEndpoint.Text.Trim()
  $health = $dHealth.Text.Trim()
  if (-not $farm) { [System.Windows.Forms.MessageBox]::Show("Nome da farmacia em falta.", "Validacao", "OK", "Warning") | Out-Null; return }
  # Vazio e VALIDO: significa "usa o endpoint do servidor". So se preencher
  # e que tem de ser um URL -- meio-preenchido e engano, nao intencao.
  if ($endpoint -and $endpoint -notmatch '^https?://') {
    [System.Windows.Forms.MessageBox]::Show("Endpoint invalido: tem de comecar por http:// ou https://.`r`n`r`nDeixa vazio para usar o endpoint configurado no servidor.", "Validacao", "OK", "Warning") | Out-Null
    return
  }

  $rotate = $dKeyRotate.Checked
  $key = $dKeyText.Text.Trim()

  if (-not $rotate -and -not $key) {
    [System.Windows.Forms.MessageBox]::Show("Cola a ingest key existente (64 hex chars) ou escolhe Rotacionar.", "Validacao", "OK", "Warning") | Out-Null
    return
  }
  if (-not $rotate -and $key -notmatch '^[0-9a-fA-F]{64}$') {
    [System.Windows.Forms.MessageBox]::Show("Ingest key invalida: deve ser 64 caracteres hex.", "Validacao", "OK", "Warning") | Out-Null
    return
  }

  if ($rotate) {
    $body = "ROTACIONAR a ingest key do tenant '$t'?`r`n`r`nA key actual fica IMEDIATAMENTE invalida.`r`nAgents ja instalados deste tenant vao receber 401 e parar de funcionar ate re-instalar com a nova key.`r`n`r`nFarmacia para este ZIP: $farm"
    if (-not (Show-Confirm -Title "ROTACIONAR ingest key" -Body $body -RequireText "ROTACIONAR")) {
      Append-Output $dOut "Abortado." ([System.Drawing.Color]::Yellow)
      return
    }
  } else {
    $body = "Gerar ZIP para farmacia '$farm' (tenant '$t')?`r`nKey: existente (sem rotacao)."
    if (-not (Show-Confirm -Title "Confirmar gerar ZIP" -Body $body)) {
      Append-Output $dOut "Abortado." ([System.Drawing.Color]::Yellow)
      return
    }
  }

  $cmdArgs = @("--tenant=$t", "--farmacia=$farm")
  if ($endpoint) { $cmdArgs += "--endpoint=$endpoint" }
  if ($health) { $cmdArgs += "--healthcheck-url=$health" }
  if ($rotate) { $cmdArgs += "--rotate" } else { $cmdArgs += "--key=$key" }
  if ($dSqlHost.Text.Trim()) { $cmdArgs += "--sql-host=$($dSqlHost.Text.Trim())" }
  if ($dSqlPort.Text.Trim()) { $cmdArgs += "--sql-port=$($dSqlPort.Text.Trim())" }
  if ($dSqlDatabase.Text.Trim()) { $cmdArgs += "--sql-database=$($dSqlDatabase.Text.Trim())" }
  if ($dSqlUser.Text.Trim()) { $cmdArgs += "--sql-user=$($dSqlUser.Text.Trim())" }

  if ($script:Mode -eq "STANDALONE") {
    # `endpoint` so entra no corpo se o operador o tiver escrito. Ausente,
    # o servidor usa o SPHARMMT_PUBLIC_ENDPOINT dele.
    $reqBody = @{}
    if ($endpoint) { $reqBody["endpoint"] = $endpoint }
    # Preferir ID (imune a encoding); fallback para nome livre.
    $fid = $null
    if ($script:dFarmaciaMap -and $script:dFarmaciaMap.ContainsKey($farm)) { $fid = $script:dFarmaciaMap[$farm] }
    if ($fid) {
      $reqBody["farmaciaId"] = $fid
      Append-Output $dOut ("  v farmacia por ID: $fid") ([System.Drawing.Color]::Gainsboro)
    } else {
      $reqBody["farmacia"] = $farm
    }
    if ($health) { $reqBody["healthcheckUrl"] = $health }
    if ($rotate) { $reqBody["rotate"] = $true } else { $reqBody["key"] = $key }
    if ($dSqlHost.Text.Trim()) { $reqBody["sqlHost"] = $dSqlHost.Text.Trim() }
    if ($dSqlPort.Text.Trim()) { $reqBody["sqlPort"] = $dSqlPort.Text.Trim() }
    if ($dSqlDatabase.Text.Trim()) { $reqBody["sqlDatabase"] = $dSqlDatabase.Text.Trim() }
    if ($dSqlUser.Text.Trim()) { $reqBody["sqlUser"] = $dSqlUser.Text.Trim() }
    $r = Run-ApiInTab -Method POST -Path "/api/admin/v1/tenants/$t/agent-package" -Body $reqBody -Box $dOut -Label "agent-package $t / $farm"
    if ($r -and $r.Success) {
      $j = $r.Json
      Append-Output $dOut ("  v farmacia: " + $j.farmaciaNome + " (id=" + $j.farmaciaId + ")") ([System.Drawing.Color]::Gainsboro)
      $zip = New-AgentZipLocal -Config $j.config -BaseUrl $j.baseAgentUrl -SuggestedName $j.suggestedName -Box $dOut
      if ($zip) {
        Append-Output $dOut ("  v ZIP criado: " + $zip) ([System.Drawing.Color]::LightGreen)
        if ($j.sqlPasswordIsPlaceholder) { Append-Output $dOut "  ! password SQL placeholder -- operador completa no PC da farmacia" ([System.Drawing.Color]::Khaki) }
      }
      if ($j.keyAction -ne "provided" -and $j.key) {
        $fields = [ordered]@{ "Nova ingest key" = [string]$j.key }
        $hdr = if ($j.keyAction -eq "rotated") { "Tenant '$t': key ROTACIONADA (a anterior foi INVALIDADA)." } else { "Tenant '$t': nova ingest key emitida." }
        Show-Secrets -Title "Ingest key" -Header ($hdr + "`r`nGuarda esta key -- nao e recuperavel.") -Fields $fields
      }
    }
    return
  }
  $r = Run-NpmInTab -Script "admin:package-agent" -CmdArgs $cmdArgs -Box $dOut -Label "package-agent $t / $farm"
  if ($r -and $r.Success -and $rotate) {
    # Extrair a nova key do stdout
    $stdout = $r.StdOut
    $m = [regex]::Match($stdout, "INGEST KEY (?:ROTATED|ISSUED)[^\r\n]*\r?\n[-]+\r?\n\s+([0-9a-fA-F]{64})")
    if ($m.Success) {
      $newKey = $m.Groups[1].Value
      $fields = [ordered]@{ "Nova ingest key" = $newKey }
      Show-Secrets -Title "Ingest key rotacionada" -Header "Tenant '$t': nova key emitida.`r`nA key anterior foi INVALIDADA.`r`nGuarda esta nova key -- vai precisar dela para outras farmacias do mesmo tenant." -Fields $fields
    }
  }
  } catch { Show-HandlerError $_ "tab-D-package-agent" }
})

$dOpenBtn.Add_Click({
  try {
    $p = $script:OutputDir
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    Start-Process explorer.exe -ArgumentList $p
  } catch { Show-HandlerError $_ "tab-D-open-folder" }
})

# E. Status / precheck / abrir pastas
$eStatusBtn.Add_Click({
  try {
    $t = Get-SelectedTenant
    if (-not $t) { return }
    if ($script:Mode -eq "STANDALONE") {
      $r = Run-ApiInTab -Method GET -Path "/api/admin/v1/tenants/$t/status" -Box $eOut -Label "status $t"
      if ($r -and $r.Success) { Render-StatusJson -J $r.Json -Box $eOut }
      return
    }
    Run-NpmInTab -Script "tenancy:status" -CmdArgs @("--tenant=$t") -Box $eOut -Label "status $t" | Out-Null
  } catch { Show-HandlerError $_ "tab-E-status" }
})
$ePrecheckBtn.Add_Click({
  try {
    $t = Get-SelectedTenant
    if (-not $t) { return }
    if ($script:Mode -eq "STANDALONE") {
      $r = Run-ApiInTab -Method GET -Path "/api/admin/v1/tenants/$t/precheck" -Box $eOut -Label "precheck $t"
      if ($r -and $r.Success) { Render-PrecheckJson -J $r.Json -Box $eOut }
      return
    }
    Run-NpmInTab -Script "pilot:precheck" -CmdArgs @("--tenant=$t") -Box $eOut -Label "pilot:precheck $t" | Out-Null
  } catch { Show-HandlerError $_ "tab-E-precheck" }
})
$eZipsBtn.Add_Click({
  try {
    $p = $script:OutputDir
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    Start-Process explorer.exe -ArgumentList $p
  } catch { Show-HandlerError $_ "tab-E-open-zips" }
})
$eLogsBtn.Add_Click({
  try {
    Start-Process explorer.exe -ArgumentList $LogDir
  } catch { Show-HandlerError $_ "tab-E-open-logs" }
})

# --- Arrancar ----------------------------------------------------

Write-WizardLog "wizard arrancado (mode=$($script:Mode) repo=$RepoRoot saas=$($script:SaasBaseUrl))"
Write-WizardLog "bootstrap: $BootstrapDiagnostics"
Write-WizardLog ("runtime: PSVersion={0} PSEdition={1} HostName={2} CompiledExe={3}" -f `
  $PSVersionTable.PSVersion, `
  $PSVersionTable.PSEdition, `
  $Host.Name, `
  [bool]([Environment]::GetCommandLineArgs()[0] -match '\.exe$'))
Write-WizardLog ("npm: " + $(if ($script:NpmCommand) { $script:NpmCommand } else { "NOT FOUND in PATH" }))

if ($script:Mode -eq "STANDALONE") {
  try {
    Append-Output $aOut "Criar tenant: POST /api/admin/v1/tenants (servidor configurado no cabecalho)." ([System.Drawing.Color]::Gainsboro)
    Append-Output $aOut "A senha do administrador e a ingest key sao mostradas UMA vez, no fim." ([System.Drawing.Color]::Gainsboro)
  } catch {}
}

$form.Add_Shown({
  $form.Activate()
  try {
    if ($script:Mode -eq "STANDALONE") {
      # Garantir endpoint+token antes de carregar tenants. Se o utilizador
      # cancelar, o wizard abre na mesma (pode configurar depois via Refresh).
      if (-not (Ensure-SaasConfigured)) {
        Set-Status "SaaS nao configurado -- usa Refresh apos configurar." ([System.Drawing.Color]::DarkRed)
        return
      }
      Sync-HeaderLabel
    }
    Refresh-Tenants
  } catch {
    Set-Status "Erro a carregar tenants: $($_.Exception.Message)" ([System.Drawing.Color]::DarkRed)
  }
})
$form.Add_FormClosing({ Write-WizardLog "wizard terminado" })

[void][System.Windows.Forms.Application]::Run($form)
