<#
.SYNOPSIS
  Remove a pasta do pacote de DIAGNOSTICO classification-audit (e SO essa). Nunca toca na rev98.

.DESCRIPTION
  Antes de apagar valida o caminho: tem de ser uma pasta com MANIFEST.json de um pacote de diagnostico
  (pacote=classification-audit, diagnostico=true, instalavel=false), com nome spharmmt-classification-audit*, que nao seja
  a rev98, nem esteja dentro/contenha a rev98, nem seja uma raiz de disco ou um ponto de juncao. Sem -Confirmar so mostra
  o que removeria. Recusa se houver um node.exe a correr a partir da pasta. Texto ASCII.

.PARAMETER DestDir    Pasta do diagnostico. Omissao: <BaseDir>\spharmmt-classification-audit
.PARAMETER BaseDir    Omissao: C:\SPharm_MT
.PARAMETER Rev98Dir   Omissao: <BaseDir>\spharmmt-agent-base-rev98
.PARAMETER Confirmar  Obrigatorio para apagar de facto.
#>
[CmdletBinding()]
param(
  [string]$BaseDir = 'C:\SPharm_MT',
  [string]$DestDir,
  [string]$Rev98Dir,
  [switch]$Confirmar
)
$ErrorActionPreference = 'Stop'
function Test-DentroDe([string]$filho, [string]$pai) {
  $f = [IO.Path]::GetFullPath($filho).TrimEnd('\') + '\'
  $p = [IO.Path]::GetFullPath($pai).TrimEnd('\') + '\'
  return $f.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}
try {
  if (-not $DestDir) { $DestDir = Join-Path $BaseDir 'spharmmt-classification-audit' }
  if (-not $Rev98Dir) { $Rev98Dir = Join-Path $BaseDir 'spharmmt-agent-base-rev98' }
  $alvo = [IO.Path]::GetFullPath($DestDir).TrimEnd('\')
  $rev98 = [IO.Path]::GetFullPath($Rev98Dir).TrimEnd('\')

  if (-not (Test-Path -LiteralPath $alvo -PathType Container)) { throw "a pasta nao existe (nada a remover): $alvo" }
  if ($alvo -match '^[A-Za-z]:$' -or $alvo.Length -lt 8) { throw "caminho demasiado curto/raiz: $alvo" }
  if ((Split-Path -Leaf $alvo) -notlike 'spharmmt-classification-audit*') { throw "o nome da pasta tem de comecar por 'spharmmt-classification-audit': $alvo" }
  if ($alvo -ieq $rev98 -or (Test-DentroDe $alvo $rev98) -or (Test-DentroDe $rev98 $alvo)) { throw 'RECUSADO: o caminho coincide com a rev98, esta dentro dela ou contem-na.' }
  $item = Get-Item -LiteralPath $alvo -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RECUSADO: a pasta e um ponto de juncao/link (nao se apaga recursivamente).' }
  $mp = Join-Path $alvo 'MANIFEST.json'
  if (-not (Test-Path -LiteralPath $mp -PathType Leaf)) { throw 'RECUSADO: sem MANIFEST.json - nao e uma pasta do pacote de diagnostico.' }
  $m = Get-Content -LiteralPath $mp -Raw | ConvertFrom-Json
  if ("$($m.pacote)" -ne 'classification-audit' -or $m.diagnostico -ne $true -or $m.instalavel -ne $false) { throw 'RECUSADO: o MANIFEST nao e o de um pacote de diagnostico.' }
  $emCurso = @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
      $c = $null; try { $c = $_.Path } catch { $c = $null }
      $c -and (Test-DentroDe $c $alvo)
    })
  if ($emCurso.Count -gt 0) { throw 'ha um node.exe a correr a partir da pasta do diagnostico; espera que termine.' }

  $ficheiros = @(Get-ChildItem -LiteralPath $alvo -Recurse -Force -File -ErrorAction SilentlyContinue)
  Write-Host "Pasta do diagnostico: $alvo ($($ficheiros.Count) ficheiros)"
  $rel = @(Get-ChildItem -LiteralPath (Join-Path $alvo 'output') -File -ErrorAction SilentlyContinue)
  if ($rel.Count -gt 0) { Write-Host "  ATENCAO: output\ tem $($rel.Count) ficheiro(s) (relatorios). Recolhe-os antes (Collect-ClassificationAuditReport.ps1)." }
  if (-not $Confirmar) {
    Write-Host 'Nada foi removido. Para remover esta pasta (e so esta), repete com -Confirmar.'
    exit 2
  }
  Remove-Item -LiteralPath $alvo -Recurse -Force
  Write-Host "Removida: $alvo"
  Write-Host "A rev98 ($rev98) nao foi tocada."
  exit 0
}
catch {
  Write-Host "ERRO: $($_.Exception.Message)"
  exit 1
}
