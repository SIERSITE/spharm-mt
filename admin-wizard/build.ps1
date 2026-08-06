# admin-wizard/build.ps1
#
# Empacota SPharmMT-Admin-Wizard.ps1 num .exe via PS2EXE.
# Output: dist-admin/SPharmMT-Admin-Wizard.exe + launcher .bat fallback.
#
# Pre-requisitos:
#   - Windows PowerShell 5.1+ (default em Win10/11)
#   - Modulo ps2exe (este script tenta instalar via Install-Module se
#     em falta; precisa de internet ou de pre-instalacao manual)
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File admin-wizard\build.ps1
#
# Modos:
#   -SkipExe       so gera o .bat launcher (sem .exe)
#   -Force         re-instala ps2exe mesmo que ja exista
#
# O .bat launcher e sempre gerado (fallback caso o .exe nao build).

[CmdletBinding()]
param(
  [switch]$SkipExe,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }
$RepoRoot = (Get-Item $ScriptDir).Parent.FullName
$DistDir = Join-Path $RepoRoot "dist-admin"

if (-not (Test-Path $DistDir)) { New-Item -ItemType Directory -Path $DistDir -Force | Out-Null }

$Src = Join-Path $ScriptDir "SPharmMT-Admin-Wizard.ps1"
if (-not (Test-Path $Src)) {
  Write-Host "[X] Source nao encontrado: $Src" -ForegroundColor Red
  exit 2
}

$OutExe = Join-Path $DistDir "SPharmMT-Admin-Wizard.exe"
$OutBat = Join-Path $DistDir "SPharmMT-Admin-Wizard.bat"
$OutPs1 = Join-Path $DistDir "SPharmMT-Admin-Wizard.ps1"

Write-Host "─── SPharm.MT Admin Wizard build ───" -ForegroundColor Cyan
Write-Host "  Src       : $Src"
Write-Host "  Out (exe) : $OutExe"
Write-Host "  Out (bat) : $OutBat"
Write-Host ""

# ─── 1. Copiar .ps1 para dist-admin/ (usado por bat e como source da exe) ───
Copy-Item -Path $Src -Destination $OutPs1 -Force
Write-Host "[OK] Copy ps1 -> $OutPs1" -ForegroundColor Green

# ─── 2. Bat launcher (sempre gerado) ─────────────────────────────────────
$batContent = @'
@echo off
REM SPharm.MT Admin Wizard -- launcher fallback
REM Se o .exe estiver presente, usa-o. Senao, lanca via PowerShell.

setlocal
cd /d "%~dp0"

if exist "%~dp0SPharmMT-Admin-Wizard.exe" (
  start "" "%~dp0SPharmMT-Admin-Wizard.exe"
  exit /b 0
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo ERRO: nem .exe nem powershell.exe disponivel.
  pause
  exit /b 1
)

start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0SPharmMT-Admin-Wizard.ps1"
exit /b 0
'@
Set-Content -Path $OutBat -Value $batContent -Encoding ASCII
Write-Host "[OK] Bat launcher -> $OutBat" -ForegroundColor Green

if ($SkipExe) {
  Write-Host ""
  Write-Host "[!] -SkipExe activo. Pula geracao de .exe." -ForegroundColor Yellow
  Write-Host "    Usar $OutBat para arrancar." -ForegroundColor Yellow
  exit 0
}

# ─── 3. ps2exe ────────────────────────────────────────────────────────
$module = Get-Module -ListAvailable -Name ps2exe | Select-Object -First 1
$needInstall = (-not $module) -or $Force.IsPresent

if ($needInstall) {
  Write-Host ""
  Write-Host "ps2exe nao detectado. A tentar instalar (CurrentUser scope)..." -ForegroundColor Yellow
  Write-Host "Pode demorar 1-2 min na primeira execucao (instala NuGet provider + ps2exe)." -ForegroundColor Yellow
  try {
    # 1. Pre-install NuGet provider (evita prompt interactivo do Install-Module)
    try {
      $nuget = Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue
      if (-not $nuget -or $nuget.Version -lt [version]"2.8.5.201") {
        Write-Host "  - A instalar NuGet provider..." -ForegroundColor Gray
        Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force -Confirm:$false -ErrorAction Stop | Out-Null
      }
    } catch {
      Write-Host "  (NuGet provider step falhou: $($_.Exception.Message))" -ForegroundColor DarkYellow
    }

    # 2. Garantir PSGallery trusted (evita prompt interactivo do Install-Module)
    $repo = Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue
    if ($repo -and $repo.InstallationPolicy -ne "Trusted") {
      Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
    }

    # 3. Install ps2exe -- -Confirm:$false adicional para garantir nao-interactivo
    Write-Host "  - A instalar ps2exe via PSGallery..." -ForegroundColor Gray
    Install-Module -Name ps2exe -Scope CurrentUser -Force -AllowClobber -Confirm:$false -ErrorAction Stop
    $module = Get-Module -ListAvailable -Name ps2exe | Select-Object -First 1
    Write-Host "[OK] ps2exe instalado." -ForegroundColor Green
  } catch {
    Write-Host ""
    Write-Host "[!] Nao foi possivel instalar ps2exe automaticamente:" -ForegroundColor Yellow
    Write-Host "    $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Alternativas:" -ForegroundColor Yellow
    Write-Host "  1. Instalar manualmente como Administrador:" -ForegroundColor Yellow
    Write-Host "       Install-Module -Name ps2exe -Scope CurrentUser -Force" -ForegroundColor Yellow
    Write-Host "  2. Usar o .bat fallback ($OutBat) directamente." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "[~] Build terminado com fallback bat (sem .exe)." -ForegroundColor Yellow
    exit 0
  }
}

# ─── 4. Compilar para .exe ────────────────────────────────────────────
Write-Host ""
Write-Host "A compilar para .exe..." -ForegroundColor Cyan

Import-Module ps2exe -Force

try {
  Invoke-PS2EXE `
    -InputFile $Src `
    -OutputFile $OutExe `
    -NoConsole `
    -Title "SPharm.MT Admin Wizard" `
    -Description "SPharm.MT Admin Wizard v1" `
    -Company "SPharm.MT" `
    -Product "SPharmMT-Admin-Wizard" `
    -Version "1.0.0.0" `
    -ErrorAction Stop
} catch {
  Write-Host ""
  Write-Host "[X] ps2exe falhou: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
  Write-Host "Continua a poder usar $OutBat como fallback." -ForegroundColor Yellow
  exit 1
}

if (Test-Path $OutExe) {
  $size = (Get-Item $OutExe).Length / 1024
  Write-Host ("[OK] EXE gerado: $OutExe ({0:N0} KB)" -f $size) -ForegroundColor Green
} else {
  Write-Host "[X] EXE nao foi gerado (sem erro mas ficheiro ausente)." -ForegroundColor Red
  exit 1
}

# ─── Registo de correspondencia fonte <-> EXE ─────────────────────────
#
# O .exe e um binario opaco: ninguem, a olhar para HEAD, consegue dizer
# de que .ps1 saiu. Ja aconteceu ficar em HEAD um .exe sem o .ps1 ao lado
# -- e o .exe e precisamente o que o tecnico executa por duplo-click.
#
# Este ficheiro fecha essa lacuna: guarda o SHA-256 da fonte e do
# binario no momento do build. O teste deploy/tests/test-wizard-build.sh
# recusa um HEAD onde a fonte tenha mudado sem rebuild.
#
# O que isto NAO prova: que o .exe foi mesmo compilado a partir daquela
# fonte (o ps2exe nao e reprodutivel -- embute timestamps). Prova que o
# par (fonte, binario) commitado e o par que existia no build. Para
# garantia forte, reconstruir e comparar comportamento.
$srcHash = (Get-FileHash -Algorithm SHA256 -Path $Src).Hash.ToLower()
$exeHash = (Get-FileHash -Algorithm SHA256 -Path $OutExe).Hash.ToLower()
$commit = ""
try { $commit = (& git rev-parse --short HEAD 2>$null) } catch {}
$info = [ordered]@{
  source       = "admin-wizard/SPharmMT-Admin-Wizard.ps1"
  sourceSha256 = $srcHash
  exe          = "dist-admin/SPharmMT-Admin-Wizard.exe"
  exeSha256    = $exeHash
  ps2exe       = [string]$module.Version
  builtAtUtc   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  gitCommit    = [string]$commit
}
$infoPath = Join-Path (Split-Path $OutExe -Parent) "BUILD-INFO.json"
# UTF-8 sem BOM: o teste le isto com ferramentas POSIX.
[System.IO.File]::WriteAllText(
  $infoPath,
  (($info | ConvertTo-Json -Depth 4) + "`n"),
  (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[OK] BUILD-INFO.json -> $infoPath" -ForegroundColor Green
Write-Host "     fonte: $srcHash"
Write-Host "     exe  : $exeHash"

Write-Host ""
Write-Host "─── Build concluido ───" -ForegroundColor Cyan
Write-Host "  Executavel : $OutExe"
Write-Host "  Fallback   : $OutBat"
Write-Host "  Source     : $OutPs1"
Write-Host ""
Write-Host "Para arrancar: duplo-click em SPharmMT-Admin-Wizard.exe" -ForegroundColor Green
