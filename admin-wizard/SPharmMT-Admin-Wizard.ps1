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

  $stdoutSb = New-Object System.Text.StringBuilder
  $stderrSb = New-Object System.Text.StringBuilder
  $outQueue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
  $errQueue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
  $eventSubIds = @()
  $proc = $null

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
    $proc.EnableRaisingEvents = $true

    # Event handlers: only enqueue (minimal work, thread-safe). The main
    # loop dequeues in the caller's scope where $OnLine is accessible.
    $sid1 = "wiz_out_$([guid]::NewGuid().ToString('N'))"
    $sid2 = "wiz_err_$([guid]::NewGuid().ToString('N'))"
    Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -SourceIdentifier $sid1 -MessageData $outQueue -Action {
      if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue([string]$EventArgs.Data) }
    } | Out-Null
    Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -SourceIdentifier $sid2 -MessageData $errQueue -Action {
      if ($null -ne $EventArgs.Data) { $Event.MessageData.Enqueue([string]$EventArgs.Data) }
    } | Out-Null
    $eventSubIds = @($sid1, $sid2)

    $started = $proc.Start()
    if (-not $started) {
      throw "Process.Start retornou false sem excepcao."
    }
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    while (-not $proc.HasExited) {
      $line = $null
      while ($outQueue.TryDequeue([ref]$line)) {
        [void]$stdoutSb.AppendLine($line)
        if ($OnLine) { try { & $OnLine $line $false } catch {} }
      }
      while ($errQueue.TryDequeue([ref]$line)) {
        [void]$stderrSb.AppendLine($line)
        if ($OnLine) { try { & $OnLine $line $true } catch {} }
      }
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 40
    }
    $proc.WaitForExit()
    Start-Sleep -Milliseconds 120  # let trailing events arrive

    # Drain remaining buffered lines
    $line = $null
    while ($outQueue.TryDequeue([ref]$line)) {
      [void]$stdoutSb.AppendLine($line)
      if ($OnLine) { try { & $OnLine $line $false } catch {} }
    }
    while ($errQueue.TryDequeue([ref]$line)) {
      [void]$stderrSb.AppendLine($line)
      if ($OnLine) { try { & $OnLine $line $true } catch {} }
    }

    $result.ExitCode = $proc.ExitCode
  } catch {
    $result.Exception = $_
    Write-WizardLog ("[$Label] EXCEPTION: " + $_.Exception.Message + " | stack: " + $_.ScriptStackTrace) "ERROR"
  } finally {
    foreach ($sid in $eventSubIds) {
      try { Unregister-Event -SourceIdentifier $sid -ErrorAction SilentlyContinue } catch {}
      try { Get-Job -Name $sid -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue } catch {}
    }
    if ($proc) { try { $proc.Dispose() } catch {} }
  }

  $sw.Stop()
  $result.ElapsedMs = $sw.ElapsedMilliseconds

  # Null-safety on outputs
  $stdoutText = $stdoutSb.ToString()
  if ($null -eq $stdoutText) { $stdoutText = "" }
  $stderrText = $stderrSb.ToString()
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

# A. Criar tenant
$aBtn.Add_Click({
  try {
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

  $cmdArgs = @("--slug=$slug", "--name=$nome", "--admin-email=$email", "--provider=$provider", "--json", "--quiet")
  if ($region) { $cmdArgs += "--region=$region" }
  if ($farmacias) { $cmdArgs += "--farmacias=$farmacias" }
  if ($provider -eq "manual" -and $dbUrl) { $cmdArgs += "--database-url=$dbUrl" }
  if ($dryRun) { $cmdArgs += "--dry-run" }

  $r = Run-NpmInTab -Script "tenancy:create" -CmdArgs $cmdArgs -Box $aOut -Label "tenancy:create $slug" -ExpectJson $true
  if (-not $r) { return }
  if (-not $r.Success) { return }

  $j = $r.ParsedJson
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

# D. Gerar ZIP agent
$dPkgBtn.Add_Click({
  try {
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

  $cmdArgs = @("--tenant=$t", "--farmacia=$farm", "--endpoint=$endpoint")
  if ($health) { $cmdArgs += "--healthcheck-url=$health" }
  if ($rotate) { $cmdArgs += "--rotate" } else { $cmdArgs += "--key=$key" }
  if ($dSqlHost.Text.Trim()) { $cmdArgs += "--sql-host=$($dSqlHost.Text.Trim())" }
  if ($dSqlPort.Text.Trim()) { $cmdArgs += "--sql-port=$($dSqlPort.Text.Trim())" }
  if ($dSqlDatabase.Text.Trim()) { $cmdArgs += "--sql-database=$($dSqlDatabase.Text.Trim())" }
  if ($dSqlUser.Text.Trim()) { $cmdArgs += "--sql-user=$($dSqlUser.Text.Trim())" }

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
    $p = Join-Path $RepoRoot "dist-agent\clients"
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    Start-Process explorer.exe -ArgumentList $p
  } catch { Show-HandlerError $_ "tab-D-open-folder" }
})

# E. Status / precheck / abrir pastas
$eStatusBtn.Add_Click({
  try {
    $t = Get-SelectedTenant
    if (-not $t) { return }
    Run-NpmInTab -Script "tenancy:status" -CmdArgs @("--tenant=$t") -Box $eOut -Label "status $t" | Out-Null
  } catch { Show-HandlerError $_ "tab-E-status" }
})
$ePrecheckBtn.Add_Click({
  try {
    $t = Get-SelectedTenant
    if (-not $t) { return }
    Run-NpmInTab -Script "pilot:precheck" -CmdArgs @("--tenant=$t") -Box $eOut -Label "pilot:precheck $t" | Out-Null
  } catch { Show-HandlerError $_ "tab-E-precheck" }
})
$eZipsBtn.Add_Click({
  try {
    $p = Join-Path $RepoRoot "dist-agent\clients"
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

Write-WizardLog "wizard arrancado (repo=$RepoRoot)"
Write-WizardLog "bootstrap: $BootstrapDiagnostics"
Write-WizardLog ("runtime: PSVersion={0} PSEdition={1} HostName={2} CompiledExe={3}" -f `
  $PSVersionTable.PSVersion, `
  $PSVersionTable.PSEdition, `
  $Host.Name, `
  [bool]([Environment]::GetCommandLineArgs()[0] -match '\.exe$'))
Write-WizardLog ("npm: " + $(if ($script:NpmCommand) { $script:NpmCommand } else { "NOT FOUND in PATH" }))
$form.Add_Shown({
  $form.Activate()
  try { Refresh-Tenants } catch { Set-Status "Erro a carregar tenants: $($_.Exception.Message)" ([System.Drawing.Color]::DarkRed) }
})
$form.Add_FormClosing({ Write-WizardLog "wizard terminado" })

[void][System.Windows.Forms.Application]::Run($form)
