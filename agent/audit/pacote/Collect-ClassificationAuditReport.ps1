<#
.SYNOPSIS
  Recolhe SO o relatorio da auditoria (output\auditoria-classificacao.*) + o hash, sem config, logs nem run.

.DESCRIPTION
  Cria <Destino>\auditoria-classificacao-<UTC>.zip com output\auditoria-classificacao.json e .md e um SHA256.txt, e
  <zip>.sha256 ao lado. NUNCA inclui agent.config.json, logs, run ou locks. Recusa recolher se o relatorio contiver
  algo com ar de credencial (password/ingestKey/Bearer/connection string). Texto ASCII.

.PARAMETER Destino   Pasta onde fica o ZIP do relatorio. Omissao: .\entrega (dentro da pasta de diagnostico)
#>
[CmdletBinding()]
param([string]$Destino)
$ErrorActionPreference = 'Stop'
$aqui = $PSScriptRoot
try {
  if (-not $Destino) { $Destino = Join-Path $aqui 'entrega' }
  $saida = Join-Path $aqui 'output'
  $relatorios = @(Get-ChildItem -LiteralPath $saida -File -Filter 'auditoria-classificacao.*' -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in @('.json', '.md') })
  if ($relatorios.Count -eq 0) { throw 'nao ha relatorio em output\auditoria-classificacao.* (corre primeiro o Run-ClassificationAudit.ps1)' }
  if (-not ($relatorios | Where-Object { $_.Extension -eq '.json' })) { throw 'falta output\auditoria-classificacao.json' }

  $suspeito = '(?i)(password\s*["'']?\s*[:=]\s*["'']?\w|ingestkey\s*["'']?\s*[:=]|bearer\s+[a-z0-9._~+/=-]{8,}|user\s+id\s*=|;\s*pwd\s*=|connectionstring)'
  foreach ($f in $relatorios) {
    if ((Get-Content -LiteralPath $f.FullName -Raw) -match $suspeito) { throw "o relatorio $($f.Name) contem algo com ar de credencial: NAO foi recolhido. Reve-o." }
  }

  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  New-Item -ItemType Directory -Path $Destino -Force | Out-Null
  $zip = Join-Path $Destino "auditoria-classificacao-$stamp.zip"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("recolha-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $linhas = @()
    foreach ($f in $relatorios) {
      Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $tmp $f.Name)
      $linhas += ('{0}  {1}' -f (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower(), $f.Name)
    }
    Set-Content -LiteralPath (Join-Path $tmp 'SHA256.txt') -Value $linhas -Encoding ASCII
    Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $zip
  } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }

  $h = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
  Set-Content -LiteralPath "$zip.sha256" -Value ('{0}  {1}' -f $h, (Split-Path -Leaf $zip)) -Encoding ASCII
  Write-Host "Relatorio recolhido: $zip"
  Write-Host "SHA-256: $h"
  Write-Host 'Conteudo: so auditoria-classificacao.json/.md + SHA256.txt (sem config, logs, run nem locks).'
  exit 0
}
catch {
  Write-Host "ERRO: $($_.Exception.Message)"
  exit 1
}
