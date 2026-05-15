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

  # Override via env var (util para shortcuts ou execucao a partir de
  # locais nao-standard). Tem precedencia sobre a deteccao automatica.
  if ($env:SPHARMMT_REPO_ROOT -and (Test-Path $env:SPHARMMT_REPO_ROOT)) {
    if (Test-Path (Join-Path $env:SPHARMMT_REPO_ROOT "package.json")) {
      $RepoRoot = $env:SPHARMMT_REPO_ROOT
      $BootstrapDiagnostics += " | override SPHARMMT_REPO_ROOT=$RepoRoot"
    }
  }

  if (-not $RepoRoot) {
    $RepoRoot = Find-RepoRoot -StartDir $ScriptDir -MaxLevels 6
  }

  if (-not $RepoRoot) {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $msg = "Nao consegui localizar o repo SPharm.MT (package.json) a partir de:`r`n  $ScriptDir`r`n`r`n"
    $msg += "O wizard precisa de estar dentro da arvore do projecto.`r`n`r`n"
    $msg += "Opcoes:`r`n"
    $msg += "  1. Mover a .exe para dist-admin/ dentro do repo`r`n"
    $msg += "  2. Definir variavel de ambiente SPHARMMT_REPO_ROOT=<caminho do repo>`r`n     antes de arrancar o wizard`r`n`r`n"
    $msg += "Diagnostico: $BootstrapDiagnostics"
    [System.Windows.Forms.MessageBox]::Show($msg, "SPharm.MT Admin Wizard -- repo nao encontrado", "OK", "Error") | Out-Null
    exit 2
  }

  Set-Location $RepoRoot

  $LogDir = Join-Path $RepoRoot "logs"
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
[System.Windows.Forms.Application]::EnableVisualStyles()

# --- Logging ------------------------------------------------------

function Write-WizardLog {
  param([string]$Msg, [string]$Level = "INFO")
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "$ts [$Level] $Msg"
  try { $line | Add-Content -Path $LogFile -Encoding UTF8 } catch {}
}

function Sanitize-LogArgs {
  # Remove valores apos = de flags sensiveis antes de escrever no log.
  param([string[]]$Args)
  $sensitive = @("--admin-password", "--password", "--key")
  $out = @()
  foreach ($a in $Args) {
    $kept = $a
    foreach ($s in $sensitive) {
      if ($a -like "$s=*") { $kept = "$s=[REDACTED]"; break }
    }
    $out += $kept
  }
  return $out
}

# --- Process runner ----------------------------------------------

# Executa `npm run <script> -- <args>` capturando stdout/stderr linha a
# linha. Chama -OnLine ao receber cada linha (UI thread via Form.Invoke
# se necessario). Devolve hashtable @{ ExitCode; Stdout (full text) }.
#
# Async: corre numa Process com OutputDataReceived/ErrorDataReceived
# para nao bloquear UI thread. Espera por WaitForExit no caller via
# polling de DoEvents.
function Invoke-NpmAsync {
  param(
    [Parameter(Mandatory)][string]$Script,
    [string[]]$ScriptArgs = @(),
    [Parameter(Mandatory)][scriptblock]$OnLine,
    [scriptblock]$OnExit
  )

  $allArgs = @("run", "--silent", $Script, "--") + $ScriptArgs
  $sanitized = Sanitize-LogArgs -Args $allArgs
  Write-WizardLog ("npm " + ($sanitized -join " "))

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "npm.cmd"
  foreach ($a in $allArgs) { $psi.ArgumentList.Add($a) | Out-Null }
  $psi.WorkingDirectory = $RepoRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $proc.EnableRaisingEvents = $true

  $script:_npmStdout = New-Object System.Text.StringBuilder
  $stdoutHandler = {
    param($s, $e)
    if ($null -ne $e.Data) {
      [void]$script:_npmStdout.AppendLine($e.Data)
      $line = $e.Data
      try { & $OnLine $line } catch {}
    }
  }
  $stderrHandler = {
    param($s, $e)
    if ($null -ne $e.Data) {
      [void]$script:_npmStdout.AppendLine($e.Data)
      $line = "[stderr] " + $e.Data
      try { & $OnLine $line } catch {}
    }
  }
  $null = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $stdoutHandler -SourceIdentifier "npm_stdout_$([guid]::NewGuid().ToString('N'))"
  $stdoutSrcId = (Get-EventSubscriber | Where-Object Action.Id -eq $null | Select-Object -Last 1).SourceIdentifier
  $null = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action $stderrHandler -SourceIdentifier "npm_stderr_$([guid]::NewGuid().ToString('N'))"

  $proc.Start() | Out-Null
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()

  while (-not $proc.HasExited) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
  }
  # Drenar buffers restantes
  $proc.WaitForExit()
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.Application]::DoEvents()

  $exit = $proc.ExitCode
  Get-EventSubscriber | Where-Object { $_.SourceObject -eq $proc } | Unregister-Event
  $proc.Dispose()

  $stdoutText = $script:_npmStdout.ToString()
  if ($OnExit) { try { & $OnExit $exit $stdoutText } catch {} }

  return @{ ExitCode = $exit; Stdout = $stdoutText }
}

function Extract-Json {
  # Tenta parse de JSON num bloco de stdout. Procura primeiro `{`
  # e ultimo `}` que casem.
  param([string]$Text)
  if (-not $Text) { return $null }
  $start = $Text.IndexOf("{")
  $end = $Text.LastIndexOf("}")
  if ($start -lt 0 -or $end -le $start) { return $null }
  $candidate = $Text.Substring($start, $end - $start + 1)
  try { return $candidate | ConvertFrom-Json } catch { return $null }
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
$repoLbl.Text = "repo: $RepoRoot"
$repoLbl.Location = New-Object System.Drawing.Point(12, 34)
$repoLbl.Size = New-Object System.Drawing.Size(700, 16)
$repoLbl.ForeColor = [System.Drawing.Color]::Gray
$header.Controls.Add($repoLbl)

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
$aProvider.SelectedIndex = 0
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
$dFarmacia = New-TextBox 140 46 460
$tabD.Controls.Add($dFarmacia)
$tabD.Controls.Add((New-Label "(nome exacto, igual ao de B)" 610 48 300))

$tabD.Controls.Add((New-Label "Endpoint SaaS:" 12 80 120))
$dEndpoint = New-TextBox 140 78 460 "https://app.spharmmt.app"
$tabD.Controls.Add($dEndpoint)

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
    $r = Invoke-NpmAsync -Script "tenancy:list" -ScriptArgs @("--json") -OnLine { param($l) }
    if ($r.ExitCode -ne 0) {
      [System.Windows.Forms.MessageBox]::Show("tenancy:list falhou (exit=$($r.ExitCode))", "Erro", "OK", "Error") | Out-Null
      return
    }
    $combined = $r.Stdout
    $startIdx = $combined.IndexOf("[")
    $endIdx = $combined.LastIndexOf("]")
    $list = @()
    if ($startIdx -ge 0 -and $endIdx -gt $startIdx) {
      $candidate = $combined.Substring($startIdx, $endIdx - $startIdx + 1)
      try { $list = $candidate | ConvertFrom-Json } catch { $list = @() }
    }
    $tenantCb.Items.Clear()
    foreach ($t in $list) { [void]$tenantCb.Items.Add($t.slug) }
    if ($tenantCb.Items.Count -gt 0) { $tenantCb.SelectedIndex = 0 }
    Sync-TenantLabels
    Set-Status ("$($tenantCb.Items.Count) tenant(s) carregados.")
  } finally {
    Set-AllButtonsEnabled $true
  }
}

$refreshBtn.Add_Click({ Refresh-Tenants })
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
  # Wrapper unificado: corre npm, escreve linhas no output box do tab,
  # actualiza statusbar, desactiva botoes durante a execucao.
  param(
    [string]$Script,
    [string[]]$Args,
    [System.Windows.Forms.RichTextBox]$Box,
    [string]$Label
  )
  Set-Status "A correr: $Label" ([System.Drawing.Color]::DarkBlue)
  Set-AllButtonsEnabled $false
  Append-Output $Box ">>> $Label" ([System.Drawing.Color]::Cyan)
  $cmdSanitized = "npm run $Script -- " + ((Sanitize-LogArgs -Args $Args) -join " ")
  Append-Output $Box ("    " + $cmdSanitized) ([System.Drawing.Color]::DarkGray)
  $r = $null
  try {
    $r = Invoke-NpmAsync -Script $Script -ScriptArgs $Args -OnLine {
      param($line)
      $color = [System.Drawing.Color]::Gainsboro
      if ($line -like "*[stderr]*") { $color = [System.Drawing.Color]::Salmon }
      elseif ($line -like "*[X]*" -or $line -like "*FAIL*" -or $line -like "*Erro*") { $color = [System.Drawing.Color]::IndianRed }
      elseif ($line -like "*[OK]*" -or $line -like "*Status: *OK*" -or $line -like "*[v]*") { $color = [System.Drawing.Color]::LightGreen }
      Append-Output $Box $line $color
    }
  } finally {
    Set-AllButtonsEnabled $true
  }
  if ($null -eq $r) {
    Set-Status "Erro: processo nao retornou." ([System.Drawing.Color]::DarkRed)
    return $null
  }
  if ($r.ExitCode -eq 0) {
    Append-Output $Box "<<< OK (exit=0)" ([System.Drawing.Color]::LightGreen)
    Set-Status "OK." ([System.Drawing.Color]::DarkGreen)
  } else {
    Append-Output $Box "<<< FAIL (exit=$($r.ExitCode))" ([System.Drawing.Color]::IndianRed)
    Set-Status "Falhou (exit=$($r.ExitCode))." ([System.Drawing.Color]::DarkRed)
  }
  return $r
}

# A. Criar tenant
$aBtn.Add_Click({
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

  $args = @("--slug=$slug", "--name=$nome", "--admin-email=$email", "--provider=$provider", "--json", "--quiet")
  if ($region) { $args += "--region=$region" }
  if ($farmacias) { $args += "--farmacias=$farmacias" }
  if ($provider -eq "manual" -and $dbUrl) { $args += "--database-url=$dbUrl" }
  if ($dryRun) { $args += "--dry-run" }

  $r = Run-NpmInTab -Script "tenancy:create" -Args $args -Box $aOut -Label "tenancy:create $slug"
  if (-not $r) { return }
  if ($r.ExitCode -ne 0) { return }

  $j = Extract-Json -Text $r.Stdout
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
})

# B. Adicionar farmacia
$bAddBtn.Add_Click({
  $t = Get-SelectedTenant
  if (-not $t) { return }
  $nome = $bNome.Text.Trim()
  if (-not $nome) { [System.Windows.Forms.MessageBox]::Show("Nome da farmacia em falta.", "Validacao", "OK", "Warning") | Out-Null; return }

  $args = @("--tenant=$t", "--nome=$nome")
  if ($bCodigo.Text.Trim()) { $args += "--codigo=$($bCodigo.Text.Trim())" }
  if ($bMorada.Text.Trim()) { $args += "--morada=$($bMorada.Text.Trim())" }
  if ($bContacto.Text.Trim()) { $args += "--contacto=$($bContacto.Text.Trim())" }

  $body = "Adicionar farmacia '$nome' ao tenant '$t'?"
  if (-not (Show-Confirm -Title "Confirmar adicao" -Body $body)) {
    Append-Output $bOut "Abortado." ([System.Drawing.Color]::Yellow)
    return
  }
  $r = Run-NpmInTab -Script "tenancy:add-farmacia" -Args $args -Box $bOut -Label "add-farmacia $t / $nome"
  if ($r -and $r.ExitCode -eq 0) {
    $bNome.Text = ""; $bCodigo.Text = ""; $bMorada.Text = ""; $bContacto.Text = ""
  }
})

$bListBtn.Add_Click({
  $t = Get-SelectedTenant
  if (-not $t) { return }
  Run-NpmInTab -Script "tenancy:status" -Args @("--tenant=$t") -Box $bOut -Label "status $t" | Out-Null
})

# C. Criar utilizador
$cAddBtn.Add_Click({
  $t = Get-SelectedTenant
  if (-not $t) { return }
  $email = $cEmail.Text.Trim().ToLower()
  $nome = $cNome.Text.Trim()
  $role = [string]$cRole.SelectedItem
  $farm = $cFarmacia.Text.Trim()
  $pwd = $cPassword.Text.Trim()

  if (-not $email -or $email -notmatch '@') { [System.Windows.Forms.MessageBox]::Show("Email invalido.", "Validacao", "OK", "Warning") | Out-Null; return }
  if (-not $nome) { [System.Windows.Forms.MessageBox]::Show("Nome em falta.", "Validacao", "OK", "Warning") | Out-Null; return }
  if (($role -eq "GESTOR_FARMACIA" -or $role -eq "OPERADOR") -and -not $farm) {
    [System.Windows.Forms.MessageBox]::Show("Role $role exige --farmacia.", "Validacao", "OK", "Warning") | Out-Null
    return
  }

  $args = @("--tenant=$t", "--email=$email", "--nome=$nome", "--role=$role")
  if ($farm) { $args += "--farmacia=$farm" }
  if ($pwd) { $args += "--password=$pwd" }

  $body = "Criar utilizador '$email' ($role) no tenant '$t'?"
  if ($pwd) { $body += "`r`nPassword: fornecida manualmente." } else { $body += "`r`nPassword: vai ser GERADA (mostrada uma vez)." }
  if (-not (Show-Confirm -Title "Confirmar criacao de utilizador" -Body $body)) {
    Append-Output $cOut "Abortado." ([System.Drawing.Color]::Yellow)
    return
  }
  $r = Run-NpmInTab -Script "tenancy:add-user" -Args $args -Box $cOut -Label "add-user $t / $email"
  if ($r -and $r.ExitCode -eq 0 -and -not $pwd) {
    # add-user imprime "Password (anotar AGORA...):" seguido da linha com a password.
    # Extrair com regex tolerante.
    $stdout = $r.Stdout
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
  if ($r -and $r.ExitCode -eq 0) {
    $cEmail.Text = ""; $cNome.Text = ""; $cFarmacia.Text = ""; $cPassword.Text = ""
  }
})

# D. Gerar ZIP agent
$dPkgBtn.Add_Click({
  $t = Get-SelectedTenant
  if (-not $t) { return }
  $farm = $dFarmacia.Text.Trim()
  $endpoint = $dEndpoint.Text.Trim()
  $health = $dHealth.Text.Trim()
  if (-not $farm) { [System.Windows.Forms.MessageBox]::Show("Nome da farmacia em falta.", "Validacao", "OK", "Warning") | Out-Null; return }
  if (-not $endpoint -or $endpoint -notmatch '^https?://') { [System.Windows.Forms.MessageBox]::Show("Endpoint invalido.", "Validacao", "OK", "Warning") | Out-Null; return }

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

  $args = @("--tenant=$t", "--farmacia=$farm", "--endpoint=$endpoint")
  if ($health) { $args += "--healthcheck-url=$health" }
  if ($rotate) { $args += "--rotate" } else { $args += "--key=$key" }
  if ($dSqlHost.Text.Trim()) { $args += "--sql-host=$($dSqlHost.Text.Trim())" }
  if ($dSqlPort.Text.Trim()) { $args += "--sql-port=$($dSqlPort.Text.Trim())" }
  if ($dSqlDatabase.Text.Trim()) { $args += "--sql-database=$($dSqlDatabase.Text.Trim())" }
  if ($dSqlUser.Text.Trim()) { $args += "--sql-user=$($dSqlUser.Text.Trim())" }

  $r = Run-NpmInTab -Script "admin:package-agent" -Args $args -Box $dOut -Label "package-agent $t / $farm"
  if ($r -and $r.ExitCode -eq 0 -and $rotate) {
    # Extrair a nova key do stdout
    $stdout = $r.Stdout
    $m = [regex]::Match($stdout, "INGEST KEY (?:ROTATED|ISSUED)[^\r\n]*\r?\n[-]+\r?\n\s+([0-9a-fA-F]{64})")
    if ($m.Success) {
      $newKey = $m.Groups[1].Value
      $fields = [ordered]@{ "Nova ingest key" = $newKey }
      Show-Secrets -Title "Ingest key rotacionada" -Header "Tenant '$t': nova key emitida.`r`nA key anterior foi INVALIDADA.`r`nGuarda esta nova key -- vai precisar dela para outras farmacias do mesmo tenant." -Fields $fields
    }
  }
})

$dOpenBtn.Add_Click({
  $p = Join-Path $RepoRoot "dist-agent\clients"
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
  Start-Process explorer.exe -ArgumentList $p
})

# E. Status / precheck / abrir pastas
$eStatusBtn.Add_Click({
  $t = Get-SelectedTenant
  if (-not $t) { return }
  Run-NpmInTab -Script "tenancy:status" -Args @("--tenant=$t") -Box $eOut -Label "status $t" | Out-Null
})
$ePrecheckBtn.Add_Click({
  $t = Get-SelectedTenant
  if (-not $t) { return }
  Run-NpmInTab -Script "pilot:precheck" -Args @("--tenant=$t") -Box $eOut -Label "pilot:precheck $t" | Out-Null
})
$eZipsBtn.Add_Click({
  $p = Join-Path $RepoRoot "dist-agent\clients"
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
  Start-Process explorer.exe -ArgumentList $p
})
$eLogsBtn.Add_Click({
  Start-Process explorer.exe -ArgumentList $LogDir
})

# --- Arrancar ----------------------------------------------------

Write-WizardLog "wizard arrancado (repo=$RepoRoot)"
Write-WizardLog "bootstrap: $BootstrapDiagnostics"
Write-WizardLog ("runtime: PSVersion={0} PSEdition={1} HostName={2} CompiledExe={3}" -f `
  $PSVersionTable.PSVersion, `
  $PSVersionTable.PSEdition, `
  $Host.Name, `
  [bool]([Environment]::GetCommandLineArgs()[0] -match '\.exe$'))
$form.Add_Shown({
  $form.Activate()
  try { Refresh-Tenants } catch { Set-Status "Erro a carregar tenants: $($_.Exception.Message)" ([System.Drawing.Color]::DarkRed) }
})
$form.Add_FormClosing({ Write-WizardLog "wizard terminado" })

[void][System.Windows.Forms.Application]::Run($form)
