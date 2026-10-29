<#
.SYNOPSIS
  Instala LADO A LADO o pacote de DIAGNOSTICO classification-audit (base rev98). NAO e um agent de producao.

.DESCRIPTION
  - Confirma pre-condicoes (tarefa agendada diaria NAO a correr e a apontar para a rev98; sem lock vivo; ZIP com o SHA-256
    esperado; destino inexistente). Qualquer falha termina com exit 1 ANTES de escrever o que quer que seja.
  - Extrai o ZIP para uma pasta INDEPENDENTE e copia para ela APENAS o agent.config.json da rev98.
  - NAO altera a tarefa agendada, NAO para nem substitui a rev98, NAO copia run, locks, logs nem output.
  - NUNCA mostra o conteudo do agent.config.json (nem segredos): so le/copia o ficheiro.
  - Texto ASCII de proposito (PowerShell 5.1 sem BOM).

.PARAMETER ZipPath          Caminho do spharmmt-agent-classification-audit.zip.
.PARAMETER Sha256Esperado   SHA-256 do ZIP (o valor entregue com o pacote). Obrigatorio.
.PARAMETER BaseDir          Pasta das instalacoes. Omissao: C:\SPharm_MT
.PARAMETER Rev98Dir         Pasta da rev98. Omissao: <BaseDir>\spharmmt-agent-base-rev98
.PARAMETER DestDir          Pasta do diagnostico. Omissao: <BaseDir>\spharmmt-classification-audit
.PARAMETER TaskName         Nome da tarefa agendada diaria. Omissao: 'SPharm.MT <travessao> Daily Pipeline'
.PARAMETER GetTask          (testes) scriptblock { param($nome) } que devolve a tarefa. Omissao: Get-ScheduledTask.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ZipPath,
  [Parameter(Mandatory = $true)][string]$Sha256Esperado,
  [string]$BaseDir = 'C:\SPharm_MT',
  [string]$Rev98Dir,
  [string]$DestDir,
  [string]$TaskName = ('SPharm.MT ' + [char]0x2014 + ' Daily Pipeline'),
  [scriptblock]$GetTask = { param($nome) Get-ScheduledTask -TaskName $nome -ErrorAction Stop }
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Falha([string]$msg) { throw "PRE-CONDICAO FALHOU: $msg" }
function Info([string]$msg) { Write-Host "  $msg" }

# Fotografia (caminho relativo, tamanho, data) de uma pasta: so para detetar se algo externo mexeu na rev98.
function Get-Foto([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return '' }
  $raiz = (Resolve-Path -LiteralPath $dir).Path.TrimEnd('\')
  $linhas = Get-ChildItem -LiteralPath $dir -Recurse -Force -File -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    ForEach-Object { '{0}|{1}|{2}' -f $_.FullName.Substring($raiz.Length), $_.Length, $_.LastWriteTimeUtc.Ticks }
  return ($linhas -join "`n")
}

function Test-DentroDe([string]$filho, [string]$pai) {
  $f = [IO.Path]::GetFullPath($filho).TrimEnd('\') + '\'
  $p = [IO.Path]::GetFullPath($pai).TrimEnd('\') + '\'
  return $f.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

$criouDest = $false
try {
  if (-not $Rev98Dir) { $Rev98Dir = Join-Path $BaseDir 'spharmmt-agent-base-rev98' }
  if (-not $DestDir) { $DestDir = Join-Path $BaseDir 'spharmmt-classification-audit' }
  $Rev98Dir = [IO.Path]::GetFullPath($Rev98Dir).TrimEnd('\')
  $DestDir = [IO.Path]::GetFullPath($DestDir).TrimEnd('\')

  Write-Host '== Instalacao LADO A LADO do pacote de DIAGNOSTICO classification-audit (base rev98, read-only, nao instalavel como agent) =='
  Info "rev98   : $Rev98Dir (so leitura)"
  Info "destino : $DestDir (novo)"
  Info "tarefa  : $TaskName (so leitura)"

  # --- 1) rev98 -----------------------------------------------------------------------------------------------
  if (-not (Test-Path -LiteralPath $Rev98Dir -PathType Container)) { Falha "pasta da rev98 nao encontrada: $Rev98Dir" }
  $cfgOrigem = Join-Path $Rev98Dir 'agent.config.json'
  if (-not (Test-Path -LiteralPath $cfgOrigem -PathType Leaf)) { Falha 'a rev98 nao tem agent.config.json' }
  $manifest98 = Join-Path $Rev98Dir 'MANIFEST.json'
  if (-not (Test-Path -LiteralPath $manifest98 -PathType Leaf)) { Falha 'a pasta indicada nao tem MANIFEST.json (nao parece a rev98)' }
  $m98 = Get-Content -LiteralPath $manifest98 -Raw | ConvertFrom-Json
  if ("$($m98.rev)" -ne '98') { Falha "a pasta indicada nao e a rev98 (MANIFEST rev=$($m98.rev))" }

  # --- 2) destino independente --------------------------------------------------------------------------------
  if ($DestDir -ieq $Rev98Dir -or (Test-DentroDe $DestDir $Rev98Dir) -or (Test-DentroDe $Rev98Dir $DestDir)) {
    Falha 'o destino do diagnostico tem de ser uma pasta INDEPENDENTE da rev98 (nao pode ser a mesma, nem conter/estar dentro dela)'
  }
  if (Test-Path -LiteralPath $DestDir) { Falha "o destino ja existe: $DestDir. NAO se sobrescreve: remove-o com Remove-ClassificationAudit.ps1 ou escolhe outro." }

  # --- 3) tarefa agendada: nao a correr, e a apontar para a rev98 ---------------------------------------------
  $tarefa = $null
  try { $tarefa = & $GetTask $TaskName } catch { Falha "tarefa agendada '$TaskName' nao encontrada ou ilegivel ($($_.Exception.Message))" }
  if (-not $tarefa) { Falha "tarefa agendada '$TaskName' nao encontrada" }
  if ("$($tarefa.State)" -eq 'Running') { Falha "a tarefa '$TaskName' esta A CORRER. Espera que termine." }
  $acao = @($tarefa.Actions)[0]
  if (-not $acao) { Falha 'a tarefa nao tem acoes' }
  $textoAcao = "$($acao.Execute) $($acao.Arguments) $($acao.WorkingDirectory)"
  $apontaRev98 = $textoAcao.IndexOf($Rev98Dir, [StringComparison]::OrdinalIgnoreCase) -ge 0
  if (-not $apontaRev98) { Falha "a tarefa NAO aponta para a rev98 ($Rev98Dir). Acao atual: $textoAcao" }
  if ($textoAcao -match 'classification') { Falha 'a tarefa menciona classification-audit: nao e suposto' }
  Info "tarefa: estado=$($tarefa.State), acao aponta para a rev98 [ok]"

  # --- 4) sem execucao da rev98 em curso (lock vivo / node.exe da pasta) --------------------------------------
  $lock = Join-Path $Rev98Dir 'run\pipeline.lock'
  if (Test-Path -LiteralPath $lock -PathType Leaf) {
    $pidLock = $null
    try { $pidLock = [int]((Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json).pid) } catch { $pidLock = $null }
    if ($pidLock) {
      $p = Get-Process -Id $pidLock -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq 'node') { Falha "a rev98 esta a correr (lock com pid $pidLock vivo). Espera que termine." }
    }
    Info 'lock da rev98 presente mas sem processo vivo (nao e tocado)'
  }
  $emCurso = @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
      $c = $null; try { $c = $_.Path } catch { $c = $null }
      $c -and (Test-DentroDe $c $Rev98Dir)
    })
  if ($emCurso.Count -gt 0) { Falha "ha $($emCurso.Count) processo(s) node.exe a correr a partir da rev98" }

  # --- 5) ZIP e hash ------------------------------------------------------------------------------------------
  if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { Falha "ZIP nao encontrado: $ZipPath" }
  $hash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash
  if ($hash -ne $Sha256Esperado.Trim().ToUpper()) { Falha "SHA-256 do ZIP nao confere (obtido $hash, esperado $($Sha256Esperado.Trim().ToUpper()))" }
  Info "ZIP: SHA-256 confere ($hash)"

  # --- tudo validado: fotografia da rev98 e instalacao --------------------------------------------------------
  $antes = Get-Foto $Rev98Dir
  $criouDest = $true
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $DestDir

  $manifestPath = Join-Path $DestDir 'MANIFEST.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'o ZIP nao tem MANIFEST.json' }
  $m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($m.diagnostico -ne $true -or $m.instalavel -ne $false -or "$($m.baseRev)" -ne '98') {
    throw 'o MANIFEST nao identifica um pacote de diagnostico (diagnostico=true, instalavel=false, baseRev=98)'
  }
  foreach ($prop in $m.files.PSObject.Properties) {
    $f = Join-Path $DestDir ($prop.Name -replace '/', '\')
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "ficheiro do MANIFEST em falta: $($prop.Name)" }
    if ((Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash -ne $prop.Value.sha256.ToUpper()) { throw "SHA-256 do ficheiro nao confere com o MANIFEST: $($prop.Name)" }
  }
  foreach ($proibido in @('agent.config.json', 'run', 'logs', 'pipeline.lock')) {
    if (Test-Path -LiteralPath (Join-Path $DestDir $proibido)) { throw "o ZIP traz '$proibido', que nao devia existir" }
  }
  Info "extraido: $($m.pacote) $($m.versao) (base rev$($m.baseRev), commit $("$($m.commit)".Substring(0, 7)))"

  # APENAS o agent.config.json. Copy-Item sem -Force; nunca mostra o conteudo.
  Copy-Item -LiteralPath $cfgOrigem -Destination (Join-Path $DestDir 'agent.config.json')
  try { $null = Get-Content -LiteralPath (Join-Path $DestDir 'agent.config.json') -Raw | ConvertFrom-Json } catch { throw 'o agent.config.json copiado nao e JSON valido' }
  Info ('agent.config.json copiado ({0} bytes; conteudo NAO mostrado). Mais nada foi copiado da rev98.' -f (Get-Item -LiteralPath (Join-Path $DestDir 'agent.config.json')).Length)

  # --- conferencias finais ------------------------------------------------------------------------------------
  $depois = Get-Foto $Rev98Dir
  if ($antes -ne $depois) { Write-Host '  AVISO: a pasta da rev98 mudou durante a instalacao (este script nao lhe toca: provavelmente a tarefa agendada correu). Confirma que a rev98 esta saudavel.' }
  else { Info 'rev98: nenhuma alteracao detetada (so foi lida)' }
  $t2 = & $GetTask $TaskName
  Info "tarefa: estado=$($t2.State) (nao foi alterada)"

  Write-Host ''
  Write-Host 'Instalado. Para executar o diagnostico (so leitura):'
  Write-Host "  cd '$DestDir'"
  Write-Host '  .\Run-ClassificationAudit.ps1            # ou: .\node.exe agent.cjs classification-audit --out .\output\auditoria-classificacao.json'
  Write-Host 'Para recolher o relatorio:  .\Collect-ClassificationAuditReport.ps1'
  Write-Host 'Para remover tudo depois:   Remove-ClassificationAudit.ps1 -Confirmar'
  exit 0
}
catch {
  Write-Host ''
  Write-Host "ERRO: $($_.Exception.Message)"
  # Limpa SO a pasta que este script acabou de criar (validada como nova e independente da rev98).
  if ($criouDest -and $DestDir -and (Test-Path -LiteralPath $DestDir -PathType Container)) {
    try { Remove-Item -LiteralPath $DestDir -Recurse -Force; Write-Host "  (pasta de destino incompleta removida: $DestDir)" } catch { Write-Host "  AVISO: nao foi possivel remover $DestDir" }
  }
  exit 1
}
