<#
.SYNOPSIS
  Gera o pacote EXTERIOR de distribuicao SPharmMT-ClassificationAudit-Delivery.zip (so empacota; nao altera codigo).

.DESCRIPTION
  O pacote exterior contem EXATAMENTE 5 ficheiros:
    1. spharmmt-agent-classification-audit.zip   (o ZIP de diagnostico ja construido e selado - NAO e reconstruido)
    2. Install-ClassificationAudit.ps1
    3. Remove-ClassificationAudit.ps1
    4. SHA256SUMS.txt                            (hash dos outros 4 ficheiros)
    5. LEIAME-INSTALACAO.txt
  Recusa continuar se o hash do ZIP interior nao for o esperado. Nunca inclui agent.config.json, logs, output, run nem
  locks. Escreve o pacote exterior em -OutDir (+ ficheiro .sha256 ao lado, FORA do pacote). Texto ASCII.

.PARAMETER InnerZip           ZIP de diagnostico ja construido (dist-agent\spharmmt-agent-classification-audit.zip).
.PARAMETER InnerSha256Esperado  SHA-256 esperado do ZIP interior.
.PARAMETER OutDir             Pasta de saida do pacote exterior.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InnerZip,
  [string]$InnerSha256Esperado = '3e621aa8a803b567ae37c1c749f674b08b8b823ed491b80546c23f06c202169e',
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'
$audit = $PSScriptRoot
$nomeExterior = 'SPharmMT-ClassificationAudit-Delivery.zip'
$nomeInterior = 'spharmmt-agent-classification-audit.zip'

try {
  if (-not (Test-Path -LiteralPath $InnerZip -PathType Leaf)) { throw "ZIP interior nao encontrado: $InnerZip" }
  $hashInterior = (Get-FileHash -LiteralPath $InnerZip -Algorithm SHA256).Hash.ToLower()
  if ($hashInterior -ne $InnerSha256Esperado.Trim().ToLower()) { throw "SHA-256 do ZIP interior nao confere (obtido $hashInterior, esperado $($InnerSha256Esperado.Trim().ToLower()))" }

  $fontes = [ordered]@{
    $nomeInterior                    = $InnerZip
    'Install-ClassificationAudit.ps1' = Join-Path $audit 'Install-ClassificationAudit.ps1'
    'Remove-ClassificationAudit.ps1'  = Join-Path $audit 'Remove-ClassificationAudit.ps1'
    'LEIAME-INSTALACAO.txt'           = Join-Path $audit 'entrega\LEIAME-INSTALACAO.txt'
  }
  foreach ($k in $fontes.Keys) { if (-not (Test-Path -LiteralPath $fontes[$k] -PathType Leaf)) { throw "ficheiro de origem em falta: $($fontes[$k])" } }
  if (Select-String -LiteralPath $fontes['LEIAME-INSTALACAO.txt'] -SimpleMatch -Pattern $InnerSha256Esperado.Trim().ToLower() -Quiet) { } else { throw 'o LEIAME nao menciona o hash esperado do ZIP interior' }

  $stage = Join-Path ([IO.Path]::GetTempPath()) ('delivery-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    foreach ($k in $fontes.Keys) {
      $destino = Join-Path $stage $k
      if ($k -like '*.ps1' -or $k -like '*.txt') {
        # texto: fim de linha CRLF (Windows PowerShell 5.1 / Bloco de Notas), sem BOM; conteudo ASCII
        $t = [IO.File]::ReadAllText($fontes[$k]) -replace "`r`n", "`n" -replace "`n", "`r`n"
        if ($t -match '[^\x00-\x7F]') { throw "o ficheiro $k tem caracteres nao-ASCII" }
        [IO.File]::WriteAllText($destino, $t, (New-Object Text.ASCIIEncoding))
      } else { Copy-Item -LiteralPath $fontes[$k] -Destination $destino }
    }
    $linhas = foreach ($k in $fontes.Keys) { '{0}  {1}' -f (Get-FileHash -LiteralPath (Join-Path $stage $k) -Algorithm SHA256).Hash.ToLower(), $k }
    [IO.File]::WriteAllText((Join-Path $stage 'SHA256SUMS.txt'), (($linhas -join "`r`n") + "`r`n"), (New-Object Text.ASCIIEncoding))

    # defesa final: nada de config/logs/run/locks/output nem segredos no stage
    $esperados = @($nomeInterior, 'Install-ClassificationAudit.ps1', 'Remove-ClassificationAudit.ps1', 'SHA256SUMS.txt', 'LEIAME-INSTALACAO.txt')
    $reais = @(Get-ChildItem -LiteralPath $stage -Recurse -Force | ForEach-Object { $_.Name } | Sort-Object)
    if ((($reais -join '|')) -ne ((@($esperados) | Sort-Object) -join '|')) { throw "conteudo inesperado no pacote exterior: $($reais -join ', ')" }

    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $saida = Join-Path $OutDir $nomeExterior
    if (Test-Path -LiteralPath $saida) { Remove-Item -LiteralPath $saida -Force }
    Compress-Archive -Path (@($esperados | ForEach-Object { Join-Path $stage $_ })) -DestinationPath $saida
  } finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }

  $h = (Get-FileHash -LiteralPath $saida -Algorithm SHA256).Hash.ToLower()
  $tam = (Get-Item -LiteralPath $saida).Length
  [IO.File]::WriteAllText("$saida.sha256", ("{0}  {1}`r`n" -f $h, $nomeExterior), (New-Object Text.ASCIIEncoding))
  Write-Host "Pacote exterior: $saida"
  Write-Host "Tamanho: $tam bytes"
  Write-Host "SHA-256: $h"
  exit 0
}
catch {
  Write-Host "ERRO: $($_.Exception.Message)"
  exit 1
}
