<#
.SYNOPSIS
  Executa a auditoria READ-ONLY da classificacao do produto (pacote de DIAGNOSTICO, base rev98).

.DESCRIPTION
  Equivale a:  .\node.exe agent.cjs classification-audit --out .\output\auditoria-classificacao.json [--cnps ...] [--cnps-mt-ficheiro f]
  Grava output\auditoria-classificacao.json e .md. So executa SELECT; nao toca na tarefa agendada, no lock da rev98,
  nem no SaaS. Requer agent.config.json nesta pasta (copiado pelo Install-ClassificationAudit.ps1). Texto ASCII.

.PARAMETER Cnps           CNPs conhecidos a comparar (so digitos): -Cnps 1234567,7654321. Opcional.
.PARAMETER CnpsFicheiro   Ficheiro de texto com CNPs. Opcional.
.PARAMETER CnpsMtFicheiro Ficheiro LOCAL com os CNPs dos produtos que EXISTEM no MT (exportado do MT: uma linha `cnp`,
                          `cnp;flagGenerico` ou `cnp;flagGenerico;manual`, 0/1). O diagnostico so le este ficheiro (nao chama
                          o MT) e consulta o ERP em blocos de ate 1000 CNPs (so SELECT agregado). Sem ele, os universos
                          "existente no MT" e a cobertura ficam "nao calculado". Caminho relativo = a esta pasta. Opcional.
.PARAMETER MaxTabelas     Tabelas candidatas listadas (omissao 5000). Opcional.
.PARAMETER MaxPares       Pares de colunas cruzados (omissao 150). Opcional.
.PARAMETER Out            Relatorio. Omissao: .\output\auditoria-classificacao.json (grava tambem o .md)
#>
[CmdletBinding()]
param(
  [string[]]$Cnps,
  [string]$CnpsFicheiro,
  [string]$CnpsMtFicheiro,
  [string]$Out = '.\output\auditoria-classificacao.json',
  [int]$Top = 0,
  [int]$MaxColunas = 0,
  [int]$MaxTabelas = 0,
  [int]$MaxPares = 0
)
$ErrorActionPreference = 'Stop'
$aqui = $PSScriptRoot
try {
  $manifestPath = Join-Path $aqui 'MANIFEST.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'MANIFEST.json em falta: esta pasta nao e o pacote de diagnostico.' }
  $m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($m.diagnostico -ne $true -or $m.instalavel -ne $false) { throw 'esta pasta nao e um pacote de diagnostico (MANIFEST).' }
  if (-not (Test-Path -LiteralPath (Join-Path $aqui 'agent.config.json') -PathType Leaf)) {
    throw 'agent.config.json nao encontrado nesta pasta. Corre primeiro o Install-ClassificationAudit.ps1 (copia o da rev98).'
  }
  foreach ($f in @('node.exe', 'agent.cjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $aqui $f) -PathType Leaf)) { throw "$f em falta" }
  }
  if ($CnpsMtFicheiro) {
    $mt = if ([IO.Path]::IsPathRooted($CnpsMtFicheiro)) { $CnpsMtFicheiro } else { Join-Path $aqui $CnpsMtFicheiro }
    if (-not (Test-Path -LiteralPath $mt -PathType Leaf)) { throw 'o ficheiro indicado em -CnpsMtFicheiro nao existe (copia para esta pasta o ficheiro exportado do MT).' }
    $CnpsMtFicheiro = [IO.Path]::GetFullPath($mt)
  }
  Push-Location $aqui
  try {
    New-Item -ItemType Directory -Path (Join-Path $aqui 'output') -Force | Out-Null
    $argsNode = @('agent.cjs', 'classification-audit', '--out', $Out)
    if ($Cnps) { $argsNode += @('--cnps', ($Cnps -join ',')) }
    if ($CnpsFicheiro) { $argsNode += @('--cnps-ficheiro', $CnpsFicheiro) }
    if ($Top -gt 0) { $argsNode += @('--top', "$Top") }
    if ($MaxColunas -gt 0) { $argsNode += @('--max-colunas', "$MaxColunas") }
    if ($MaxTabelas -gt 0) { $argsNode += @('--max-tabelas', "$MaxTabelas") }
    if ($MaxPares -gt 0) { $argsNode += @('--max-pares', "$MaxPares") }
    if ($CnpsMtFicheiro) { $argsNode += @('--cnps-mt-ficheiro', $CnpsMtFicheiro) }
    & (Join-Path $aqui 'node.exe') @argsNode
    $codigo = $LASTEXITCODE
  } finally { Pop-Location }
  exit $codigo
}
catch {
  Write-Host "ERRO: $($_.Exception.Message)"
  exit 1
}
