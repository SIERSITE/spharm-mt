<#
.SYNOPSIS
  Executa a auditoria READ-ONLY da classificacao do produto (pacote de DIAGNOSTICO, base rev98).

.DESCRIPTION
  Equivale a:  .\node.exe agent.cjs classification-audit --out .\output\auditoria-classificacao.json [--cnps ...]
  Grava output\auditoria-classificacao.json e .md. So executa SELECT; nao toca na tarefa agendada, no lock da rev98,
  nem no SaaS. Requer agent.config.json nesta pasta (copiado pelo Install-ClassificationAudit.ps1). Texto ASCII.

.PARAMETER Cnps           CNPs conhecidos a comparar (so digitos): -Cnps 1234567,7654321. Opcional.
.PARAMETER CnpsFicheiro   Ficheiro de texto com CNPs. Opcional.
.PARAMETER Out            Relatorio. Omissao: .\output\auditoria-classificacao.json (grava tambem o .md)
#>
[CmdletBinding()]
param(
  [string[]]$Cnps,
  [string]$CnpsFicheiro,
  [string]$Out = '.\output\auditoria-classificacao.json',
  [int]$Top = 0,
  [int]$MaxColunas = 0
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
  Push-Location $aqui
  try {
    New-Item -ItemType Directory -Path (Join-Path $aqui 'output') -Force | Out-Null
    $argsNode = @('agent.cjs', 'classification-audit', '--out', $Out)
    if ($Cnps) { $argsNode += @('--cnps', ($Cnps -join ',')) }
    if ($CnpsFicheiro) { $argsNode += @('--cnps-ficheiro', $CnpsFicheiro) }
    if ($Top -gt 0) { $argsNode += @('--top', "$Top") }
    if ($MaxColunas -gt 0) { $argsNode += @('--max-colunas', "$MaxColunas") }
    & (Join-Path $aqui 'node.exe') @argsNode
    $codigo = $LASTEXITCODE
  } finally { Pop-Location }
  exit $codigo
}
catch {
  Write-Host "ERRO: $($_.Exception.Message)"
  exit 1
}
