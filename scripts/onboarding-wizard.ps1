# SPharm.MT -- Onboarding Wizard v1
#
# Wrapper interactivo para onboarding de grupos/farmacias. Chama os
# comandos npm existentes (tenancy:create, tenancy:add-farmacia,
# tenancy:status, admin:package-agent, pilot:precheck) com prompts
# claros, plan-before-execute + confirmacao CONFIRMO.
#
# Compativel com Windows PowerShell 5.1 (no `??` operator, no
# fancy box-drawing) e PowerShell 7+. Codigo apenas ASCII; strings
# de display podem ter acentos PT.
#
# Principios:
#   - Operador NUNCA decora comandos npm
#   - Plano sempre mostrado antes da execucao
#   - CONFIRMO obrigatorio para accoes destrutivas (create, package, rotate)
#   - Secrets (ingest key, admin password) nunca escritos no log
#   - Logs append-only em logs\onboarding-YYYY-MM-DD.log
#   - Multi-farmacia no mesmo grupo reutiliza a key emitida em create
#     (sem --rotate por farmacia)

# --- Setup ---------------------------------------------------------
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}
try { $OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

$RepoRoot = (Get-Item $PSScriptRoot).Parent.FullName
Set-Location $RepoRoot

$LogDir = Join-Path $RepoRoot "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$Today = Get-Date -Format "yyyy-MM-dd"
$LogFile = Join-Path $LogDir "onboarding-$Today.log"

function Coalesce {
  param($A, $B)
  if ($null -ne $A -and $A -ne "") { return $A }
  return $B
}

function Write-Log {
  param([string]$Msg, [string]$Level = "INFO")
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts [$Level] $Msg" | Add-Content -Path $LogFile -Encoding UTF8
}

function Write-Header {
  param([string]$Text)
  $line = ("-" * 72)
  Write-Host ""
  Write-Host $line -ForegroundColor Cyan
  Write-Host $Text -ForegroundColor Cyan
  Write-Host $line -ForegroundColor Cyan
}

function Read-Confirm {
  param([string]$Prompt = "Escreve CONFIRMO (maiusculas) para prosseguir")
  $r = Read-Host $Prompt
  return ($r -eq "CONFIRMO")
}

function Read-NonEmpty {
  param([string]$Prompt)
  while ($true) {
    $v = Read-Host $Prompt
    if ($v -and $v.Trim() -ne "") { return $v.Trim() }
    Write-Host "  (vazio -- tenta de novo)" -ForegroundColor Yellow
  }
}

function Read-Optional {
  param([string]$Prompt)
  $v = Read-Host "$Prompt (vazio = saltar)"
  if ($v -and $v.Trim() -ne "") { return $v.Trim() }
  return $null
}

# URL publico da plataforma, mesma ordem que lib/runtime-config.ts usa em
# runtime. Substituiu um dominio literal que sobreviveu a mudanca de
# dominio de producao: o wizard oferecia o antigo como default e o
# operador aceitava-o sem reparar.
function Get-PublicAppUrl {
  foreach ($n in @("PUBLIC_APP_URL", "NEXT_PUBLIC_APP_URL")) {
    $v = [Environment]::GetEnvironmentVariable($n)
    if ($v -and $v.Trim() -ne "") { return $v.Trim().TrimEnd("/") }
  }
  return $null
}

function Read-IntInRange {
  param([string]$Prompt, [int]$Min, [int]$Max)
  while ($true) {
    $v = Read-Host $Prompt
    if ($v -match '^\d+$') {
      $n = [int]$v
      if ($n -ge $Min -and $n -le $Max) { return $n }
    }
    Write-Host "  (deve ser inteiro entre $Min e $Max)" -ForegroundColor Yellow
  }
}

function Invoke-Npm {
  # Executa `npm run <script> -- <args>` capturando exit code.
  # Imprime stdout/stderr no ecra em tempo real (sem buffer).
  param(
    [Parameter(Mandatory)][string]$Script,
    [string[]]$ScriptArgs = @()
  )
  $allArgs = @("run", "--silent", $Script, "--") + $ScriptArgs
  Write-Log "npm $($allArgs -join ' ')"
  & npm.cmd @allArgs
  return $LASTEXITCODE
}

function Invoke-NpmJson {
  # Igual a Invoke-Npm mas captura stdout para parse JSON.
  param(
    [Parameter(Mandatory)][string]$Script,
    [string[]]$ScriptArgs = @()
  )
  $allArgs = @("run", "--silent", $Script, "--") + $ScriptArgs
  Write-Log "npm $($allArgs -join ' ')"
  $rawLines = @(& npm.cmd @allArgs 2>&1)
  $exit = $LASTEXITCODE
  $combined = ($rawLines -join "`n")
  $start = $combined.IndexOf('{')
  $end = $combined.LastIndexOf('}')
  $json = $null
  if ($start -ge 0 -and $end -gt $start) {
    $candidate = $combined.Substring($start, $end - $start + 1)
    try { $json = $candidate | ConvertFrom-Json } catch { $json = $null }
  }
  return [pscustomobject]@{
    ExitCode = $exit
    Json = $json
    Raw = $combined
  }
}

# --- Operacoes ----------------------------------------------------

function Op-CreateTenant {
  param([string]$ProvidedSlug, [string]$ProvidedName, [string]$ProvidedEmail)

  Write-Header "1. Criar grupo / tenant"

  $slug = Coalesce $ProvidedSlug (Read-NonEmpty "Slug do grupo (ex: grupo-pilot)")
  $name = Coalesce $ProvidedName (Read-NonEmpty "Nome do grupo (ex: Grupo Pilot, Lda)")
  $email = Coalesce $ProvidedEmail (Read-NonEmpty "Email do admin (ex: admin@grupo.pt)")

  Write-Host ""
  Write-Host "Plano:" -ForegroundColor Yellow
  Write-Host "  - Criar BD Neon para tenant '$slug'"
  Write-Host "  - Aplicar migrations"
  Write-Host "  - Criar utilizador admin '$email'"
  Write-Host "  - Emitir ingest key (mostrada no fim)"
  Write-Host "  - Marcar tenant ACTIVE"
  Write-Host ""
  if (-not (Read-Confirm)) {
    Write-Host "Abortado pelo operador." -ForegroundColor Red
    Write-Log "create-tenant abortado pelo operador (slug=$slug)"
    return $null
  }

  $args = @("--slug=$slug", "--name=$name", "--admin-email=$email", "--provider=neon", "--json", "--quiet")
  $result = Invoke-NpmJson -Script "tenancy:create" -ScriptArgs $args

  if ($result.ExitCode -ne 0 -or -not $result.Json -or -not $result.Json.ok) {
    Write-Host ""
    Write-Host "[X] tenancy:create falhou (exit=$($result.ExitCode))." -ForegroundColor Red
    if ($result.Json -and $result.Json.error) {
      Write-Host "  erro: $($result.Json.error)"
    } elseif ($result.Raw) {
      Write-Host "  output:"
      Write-Host ($result.Raw | Out-String).Trim()
    }
    Write-Log "create-tenant FAIL slug=$slug exit=$($result.ExitCode)" "ERROR"
    return $null
  }

  Write-Host ""
  Write-Host "[OK] Tenant criado." -ForegroundColor Green
  Write-Host "  Tenant id      : $($result.Json.tenantId)"
  Write-Host "  Schema version : $($result.Json.schemaVersion)"
  Write-Host "  Smoke          : $($result.Json.smokeOk)"

  Write-Log "create-tenant OK slug=$slug tenantId=$($result.Json.tenantId)"

  return [pscustomobject]@{
    Slug = $slug
    TenantId = $result.Json.tenantId
    IngestKey = $result.Json.ingestKey
    AdminEmail = $result.Json.adminEmail
    AdminPassword = $result.Json.adminPassword
  }
}

function Op-AddFarmacia {
  param([string]$ProvidedTenant)

  Write-Header "2. Adicionar farmacia a grupo existente"

  $tenant = Coalesce $ProvidedTenant (Read-NonEmpty "Slug do grupo")
  $nome = Read-NonEmpty "Nome da farmacia (ex: Farmacia Internacional)"
  $codigo = Read-Optional "Codigo ANF"
  $morada = Read-Optional "Morada"
  $contacto = Read-Optional "Contacto"

  $codigoDisp = Coalesce $codigo "(vazio)"
  $moradaDisp = Coalesce $morada "(vazio)"
  $contactoDisp = Coalesce $contacto "(vazio)"

  Write-Host ""
  Write-Host "Plano:" -ForegroundColor Yellow
  Write-Host "  - INSERT Farmacia '$nome' em tenant '$tenant'"
  Write-Host "  - codigo=$codigoDisp morada=$moradaDisp contacto=$contactoDisp"
  Write-Host ""
  if (-not (Read-Confirm)) {
    Write-Host "Abortado pelo operador." -ForegroundColor Red
    return $null
  }

  $args = @("--tenant=$tenant", "--nome=$nome")
  if ($codigo) { $args += "--codigo=$codigo" }
  if ($morada) { $args += "--morada=$morada" }
  if ($contacto) { $args += "--contacto=$contacto" }
  $exit = Invoke-Npm -Script "tenancy:add-farmacia" -ScriptArgs $args
  if ($exit -ne 0) {
    Write-Host ""
    if ($exit -eq 2) {
      Write-Host "[!] Duplicado detectado -- a farmacia ja existe (exit 2)." -ForegroundColor Yellow
    } else {
      Write-Host "[X] tenancy:add-farmacia falhou (exit=$exit)." -ForegroundColor Red
    }
    Write-Log "add-farmacia FAIL tenant=$tenant nome=$nome exit=$exit" "ERROR"
    return $null
  }
  Write-Log "add-farmacia OK tenant=$tenant nome=$nome"
  return [pscustomobject]@{ Tenant = $tenant; Nome = $nome }
}

function Op-PackageAgent {
  param([string]$ProvidedTenant, [string]$ProvidedFarmacia, [string]$ProvidedKey, [string]$ProvidedEndpoint)

  Write-Header "3. Gerar ZIP agent"

  $tenant = Coalesce $ProvidedTenant (Read-NonEmpty "Slug do grupo")
  $farmacia = Coalesce $ProvidedFarmacia (Read-NonEmpty "Nome exacto da farmacia")
  $endpoint = $ProvidedEndpoint
  $endpointDefault = Get-PublicAppUrl
  if (-not $endpoint) { $endpoint = Read-Optional "Endpoint SaaS$(if ($endpointDefault) { " (default $endpointDefault)" })" }
  if (-not $endpoint) { $endpoint = $endpointDefault }
  if (-not $endpoint) { throw "Endpoint SaaS nao indicado e PUBLIC_APP_URL nao esta definida." }
  $healthcheckUrl = Read-Optional "Healthcheck URL (https://hc-ping.com/<uuid>, opcional mas recomendado)"

  $key = $ProvidedKey
  $rotate = $false
  if (-not $key) {
    Write-Host ""
    Write-Host "Tens a ingest key actual do grupo?"
    Write-Host "  Y = colar a key (nao rotaciona -- agents existentes continuam a funcionar)"
    Write-Host "  N = rotacionar (INVALIDA agents existentes do grupo -- vai precisar de re-instalar todos)"
    $r = Read-Host "Y/N"
    if ($r -match '^[Yy]') {
      $secure = Read-Host "Cola a key (64 hex chars; nao vai ser logada)" -AsSecureString
      $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try {
        $key = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
      } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      }
      if ($key -notmatch '^[0-9a-fA-F]{64}$') {
        Write-Host "[X] Key invalida (deve ser 64 hex chars). Aborto." -ForegroundColor Red
        return $null
      }
    } else {
      Write-Host ""
      Write-Host "[!] ROTACIONAR vai invalidar a key actual do grupo '$tenant'." -ForegroundColor Yellow
      Write-Host "   Todos os agents ja instalados deste grupo vao comecar a receber 401."
      Write-Host "   Vais ter de re-gerar e re-instalar os ZIPs deles."
      Write-Host ""
      if (-not (Read-Confirm)) {
        Write-Host "Abortado." -ForegroundColor Red
        return $null
      }
      $rotate = $true
    }
  }

  $hcDisp = Coalesce $healthcheckUrl "(nao)"
  Write-Host ""
  Write-Host "Plano:" -ForegroundColor Yellow
  Write-Host "  - Gerar pacote para tenant='$tenant' farmacia='$farmacia'"
  Write-Host "  - Endpoint: $endpoint"
  Write-Host "  - Healthcheck: $hcDisp"
  if ($rotate) {
    Write-Host "  - ROTACIONAR ingest key (key existente fica invalida)"
  } else {
    Write-Host "  - Usar key existente (sem rotacao)"
  }
  Write-Host ""
  if (-not (Read-Confirm)) {
    Write-Host "Abortado." -ForegroundColor Red
    return $null
  }

  $args = @("--tenant=$tenant", "--farmacia=$farmacia", "--endpoint=$endpoint")
  if ($healthcheckUrl) { $args += "--healthcheck-url=$healthcheckUrl" }
  if ($rotate) {
    $args += "--rotate"
  } else {
    $args += "--key=$key"
  }
  $exit = Invoke-Npm -Script "admin:package-agent" -ScriptArgs $args
  if ($exit -ne 0) {
    Write-Host "[X] admin:package-agent falhou (exit=$exit)." -ForegroundColor Red
    Write-Log "package-agent FAIL tenant=$tenant farmacia=$farmacia exit=$exit" "ERROR"
    return $null
  }
  Write-Log "package-agent OK tenant=$tenant farmacia=$farmacia rotate=$rotate"

  $clientsDir = Join-Path $RepoRoot "dist-agent\clients"
  $zip = $null
  if (Test-Path $clientsDir) {
    $zip = Get-ChildItem -Path $clientsDir -Filter "$tenant-*.zip" -File |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if ($zip) {
    Write-Host ""
    Write-Host "[OK] ZIP gerado: $zip" -ForegroundColor Green
  }
  return [pscustomobject]@{ Tenant = $tenant; Farmacia = $farmacia; ZipPath = $zip }
}

function Op-Status {
  param([string]$ProvidedTenant)
  Write-Header "4. Status do grupo"
  $tenant = Coalesce $ProvidedTenant (Read-NonEmpty "Slug do grupo")
  Invoke-Npm -Script "tenancy:status" -ScriptArgs @("--tenant=$tenant") | Out-Null
  Write-Log "status tenant=$tenant"
}

function Op-Precheck {
  param([string]$ProvidedTenant)
  Write-Header "5. Precheck pilot"
  $tenant = Coalesce $ProvidedTenant (Read-NonEmpty "Slug do grupo")
  Invoke-Npm -Script "pilot:precheck" -ScriptArgs @("--tenant=$tenant") | Out-Null
  Write-Log "precheck tenant=$tenant"
}

function Op-FullFlow {
  Write-Header "6. FLUXO COMPLETO: novo grupo + N farmacias + ZIPs"
  Write-Host "Este fluxo cria um novo grupo do zero, adiciona as farmacias e gera os"
  Write-Host "ZIPs reutilizando a MESMA ingest key (sem rotacao a meio do fluxo)."
  Write-Host ""

  $slug = Read-NonEmpty "Slug do grupo (ex: grupo-pilot)"
  $name = Read-NonEmpty "Nome do grupo"
  $email = Read-NonEmpty "Email do admin"
  $endpointDefault = Get-PublicAppUrl
  $endpoint = Read-Optional "Endpoint SaaS$(if ($endpointDefault) { " (default $endpointDefault)" })"
  if (-not $endpoint) { $endpoint = $endpointDefault }
  if (-not $endpoint) { throw "Endpoint SaaS nao indicado e PUBLIC_APP_URL nao esta definida." }
  $nFarmacias = Read-IntInRange "Quantas farmacias (1-20)" 1 20

  $farmaciasPlan = @()
  for ($i = 1; $i -le $nFarmacias; $i++) {
    Write-Host ""
    Write-Host "Farmacia $i de $nFarmacias" -ForegroundColor Cyan
    $fNome = Read-NonEmpty "  Nome"
    $fCodigo = Read-Optional "  Codigo ANF"
    $fHealth = Read-Optional "  Healthcheck URL (recomendado)"
    $farmaciasPlan += [pscustomobject]@{ Nome = $fNome; Codigo = $fCodigo; Healthcheck = $fHealth }
  }

  Write-Host ""
  Write-Host "Plano completo:" -ForegroundColor Yellow
  Write-Host "  1. Criar tenant '$slug' (BD + migrations + ingest key)"
  Write-Host "  2. Adicionar $nFarmacias farmacia(s):"
  foreach ($f in $farmaciasPlan) {
    $codigoDisp = Coalesce $f.Codigo "--"
    Write-Host "       * $($f.Nome) (codigo=$codigoDisp)"
  }
  Write-Host "  3. Gerar $nFarmacias ZIP(s) reutilizando a mesma key (sem --rotate)"
  Write-Host "  Endpoint: $endpoint"
  Write-Host ""
  if (-not (Read-Confirm "Pronto para executar tudo? Escreve CONFIRMO")) {
    Write-Host "Abortado." -ForegroundColor Red
    return
  }

  $tenant = Op-CreateTenant -ProvidedSlug $slug -ProvidedName $name -ProvidedEmail $email
  if (-not $tenant) {
    Write-Host "[X] Fluxo abortado -- create falhou." -ForegroundColor Red
    return
  }
  $key = $tenant.IngestKey
  Write-Log "full-flow tenant created slug=$slug"

  $createdFarmacias = @()
  $zips = @()
  foreach ($f in $farmaciasPlan) {
    Write-Host ""
    Write-Host "--- Farmacia: $($f.Nome) ---" -ForegroundColor Cyan
    $args = @("--tenant=$slug", "--nome=$($f.Nome)")
    if ($f.Codigo) { $args += "--codigo=$($f.Codigo)" }
    $exit = Invoke-Npm -Script "tenancy:add-farmacia" -ScriptArgs $args
    if ($exit -ne 0) {
      Write-Host "[X] add-farmacia falhou para '$($f.Nome)' (exit=$exit). Continuando para proxima." -ForegroundColor Red
      Write-Log "full-flow add-farmacia FAIL nome=$($f.Nome) exit=$exit" "ERROR"
      continue
    }
    $createdFarmacias += $f.Nome
    Write-Log "full-flow add-farmacia OK nome=$($f.Nome)"

    $pkgArgs = @(
      "--tenant=$slug",
      "--farmacia=$($f.Nome)",
      "--endpoint=$endpoint",
      "--key=$key"
    )
    if ($f.Healthcheck) { $pkgArgs += "--healthcheck-url=$($f.Healthcheck)" }
    $exit = Invoke-Npm -Script "admin:package-agent" -ScriptArgs $pkgArgs
    if ($exit -ne 0) {
      Write-Host "[X] package-agent falhou para '$($f.Nome)' (exit=$exit)." -ForegroundColor Red
      Write-Log "full-flow package-agent FAIL nome=$($f.Nome) exit=$exit" "ERROR"
      continue
    }
    Write-Log "full-flow package-agent OK nome=$($f.Nome)"
    $clientsDir = Join-Path $RepoRoot "dist-agent\clients"
    if (Test-Path $clientsDir) {
      $zipPath = Get-ChildItem -Path $clientsDir -Filter "$slug-*.zip" -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
      if ($zipPath) { $zips += [pscustomobject]@{ Farmacia = $f.Nome; Path = $zipPath } }
    }
  }

  Write-Header "Resumo"
  Write-Host "Grupo criado: $slug"
  Write-Host "Tenant id:    $($tenant.TenantId)"
  Write-Host ""
  Write-Host "Farmacias criadas:"
  foreach ($n in $createdFarmacias) { Write-Host "  * $n" }
  Write-Host ""
  Write-Host "ZIPs gerados:"
  foreach ($z in $zips) {
    Write-Host "  * $($z.Farmacia)"
    Write-Host "      $($z.Path)" -ForegroundColor Green
  }
  Write-Host ""
  Write-Host "Credenciais do admin (anotar AGORA -- nao recuperaveis):" -ForegroundColor Yellow
  Write-Host "  email    : $($tenant.AdminEmail)"
  Write-Host "  password : $($tenant.AdminPassword)"
  Write-Host ""
  Write-Host "Ingest key (mesma em todos os ZIPs deste grupo):" -ForegroundColor Yellow
  Write-Host "  $key"
  Write-Host ""
  Write-Host "Proximos passos no PC de cada farmacia:" -ForegroundColor Cyan
  Write-Host "  1. Copiar o ZIP correspondente e extrair em C:\spharmmt\agent\"
  Write-Host "  2. Editar agent.config.json apenas para completar sqlServer.password"
  Write-Host "  3. Correr run-test-connection.bat"
  Write-Host "  4. Criar Task Scheduler com run-daily-pipeline-auto.bat"
  Write-Host "     (ver docs/daily-pipeline-task-scheduler.md)"
  Write-Host ""
  Write-Log "full-flow DONE slug=$slug nFarmacias=$($createdFarmacias.Count) nZips=$($zips.Count)"
}

# --- Main menu ----------------------------------------------------

function Show-Menu {
  Clear-Host
  $eq = ("=" * 67)
  Write-Host ""
  Write-Host $eq -ForegroundColor Cyan
  Write-Host "  SPharm.MT -- Onboarding Wizard" -ForegroundColor Cyan
  Write-Host $eq -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  1. Criar novo grupo / tenant"
  Write-Host "  2. Adicionar farmacia a grupo existente"
  Write-Host "  3. Gerar ZIP agent para farmacia"
  Write-Host "  4. Ver status de grupo"
  Write-Host "  5. Rodar pilot:precheck"
  Write-Host "  6. FLUXO COMPLETO: novo grupo + N farmacias + ZIPs"
  Write-Host "  0. Sair"
  Write-Host ""
  Write-Host "  Logs do dia : $LogFile"
  Write-Host ""
}

# --- Main loop ----------------------------------------------------

Write-Log "wizard arrancado"
while ($true) {
  Show-Menu
  $choice = Read-Host "Opcao"
  switch ($choice) {
    "1" {
      $r = Op-CreateTenant
      if ($r) {
        Write-Host ""
        Write-Host "Credenciais (anotar AGORA, nao recuperaveis):" -ForegroundColor Yellow
        Write-Host "  admin email    : $($r.AdminEmail)"
        Write-Host "  admin password : $($r.AdminPassword)"
        Write-Host "  ingest key     : $($r.IngestKey)"
        Write-Host ""
        Write-Host "(secrets NAO foram escritos no log)" -ForegroundColor DarkGray
      }
      Read-Host "Enter para continuar"
    }
    "2" { Op-AddFarmacia | Out-Null; Read-Host "Enter para continuar" }
    "3" { Op-PackageAgent | Out-Null; Read-Host "Enter para continuar" }
    "4" { Op-Status; Read-Host "Enter para continuar" }
    "5" { Op-Precheck; Read-Host "Enter para continuar" }
    "6" { Op-FullFlow; Read-Host "Enter para continuar" }
    "0" {
      Write-Log "wizard terminado pelo operador"
      Write-Host "Bye." -ForegroundColor Cyan
      exit 0
    }
    default { Write-Host "Opcao invalida." -ForegroundColor Yellow; Start-Sleep -Milliseconds 800 }
  }
}
