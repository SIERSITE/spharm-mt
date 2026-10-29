<#
  Teste PONTA A PONTA do pacote EXTERIOR de distribuicao (SPharmMT-ClassificationAudit-Delivery.zip), usando
  EXCLUSIVAMENTE os ficheiros extraidos desse pacote (nunca os do repositorio):
    extrai -> valida conteudo e hashes -> simula a rev98 (pasta, config com segredos sentinela, tarefa simulada) ->
    Install -> Run (node.exe REAL do ZIP interior, sem SQL Server: host .invalid) -> Collect -> Remove.
  Prova que a rev98, a tarefa agendada e o respetivo agent.config.json ficam byte a byte inalterados.
  Nenhuma tarefa agendada real e nenhum SQL Server real sao usados.
  Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File Test-Delivery.ps1 -DeliveryZip <SPharmMT-ClassificationAudit-Delivery.zip>
  Texto ASCII.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$DeliveryZip)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$script:ok = 0; $script:falhas = 0
function Check([bool]$cond, [string]$nome, [string]$detalhe = '') {
  if ($cond) { $script:ok++; Write-Host "  [OK]    $nome" }
  else { $script:falhas++; Write-Host "  [FALHA] $nome"; if ($detalhe) { Write-Host "            $detalhe" } }
}
function Invoke-Filho([string]$texto) {
  # Ficheiro temporario + -File (nao -EncodedCommand): evita o canal de erro CLIXML do powershell.exe filho.
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('filho-' + [guid]::NewGuid().ToString('N') + '.ps1')
  [IO.File]::WriteAllText($tmp, "`$ErrorActionPreference='Continue'`r`n$texto`r`nexit `$LASTEXITCODE`r`n", (New-Object Text.UTF8Encoding($true)))
  try {
    $out = & cmd.exe /c "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$tmp`" 2>&1" | Out-String
    return @{ Exit = $LASTEXITCODE; Out = $out }
  } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}
function Get-Impressao([string]$dir) {
  $raiz = (Resolve-Path -LiteralPath $dir).Path.TrimEnd('\')
  $itens = Get-ChildItem -LiteralPath $dir -Recurse -Force | Sort-Object FullName | ForEach-Object {
    if ($_.PSIsContainer) { 'D|' + $_.FullName.Substring($raiz.Length) }
    else { 'F|{0}|{1}|{2}|{3}' -f $_.FullName.Substring($raiz.Length), $_.Length, (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash, $_.LastWriteTimeUtc.Ticks }
  }
  [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes(($itens -join "`n"))))
}
function Get-NomesZip([string]$zip) {
  $z = [IO.Compression.ZipFile]::OpenRead($zip)
  try { return @($z.Entries | ForEach-Object { $_.FullName } | Sort-Object) } finally { $z.Dispose() }
}

$SEGREDOS = @('SENTINEL_PWD_5d8e!x', 'sentinel_user_91c2', 'SENTINEL_INGEST_KEY_aa11bb22cc33dd44', 'sentinel-host-7f3a.example.invalid', 'sentinel-tenant-x9')
$INTERIOR_ESPERADO = '3e621aa8a803b567ae37c1c749f674b08b8b823ed491b80546c23f06c202169e'
$raiz = Join-Path ([IO.Path]::GetTempPath()) ('delivery-e2e-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $raiz | Out-Null
try {
  # ---------------------------------------------------------------- 1. pacote exterior
  Write-Host "`n=== 1. Pacote exterior: conteudo e hashes ==="
  Check (Test-Path -LiteralPath $DeliveryZip -PathType Leaf) 'pacote exterior existe'
  $esperados = @('Install-ClassificationAudit.ps1', 'LEIAME-INSTALACAO.txt', 'Remove-ClassificationAudit.ps1', 'SHA256SUMS.txt', 'spharmmt-agent-classification-audit.zip')
  $nomes = Get-NomesZip $DeliveryZip
  Check (($nomes -join '|') -eq ($esperados -join '|')) 'o pacote exterior tem EXATAMENTE os 5 ficheiros esperados' ($nomes -join ', ')
  Check (-not ($nomes | Where-Object { $_ -match '(?i)agent\.config|\.log$|(^|/)run(/|$)|(^|/)output(/|$)|\.lock' })) 'sem agent.config.json, logs, run, output nem locks'

  $entrega = Join-Path $raiz 'Entregas\classification-audit'
  New-Item -ItemType Directory -Path $entrega -Force | Out-Null
  [IO.Compression.ZipFile]::ExtractToDirectory($DeliveryZip, $entrega)
  $zipInt = Join-Path $entrega 'spharmmt-agent-classification-audit.zip'
  $sums = @{}
  foreach ($l in (Get-Content -LiteralPath (Join-Path $entrega 'SHA256SUMS.txt'))) { if ($l -match '^([0-9a-f]{64})  (.+)$') { $sums[$Matches[2]] = $Matches[1] } }
  Check ($sums.Count -eq 4) 'SHA256SUMS.txt tem 4 linhas (todos os ficheiros menos ele proprio)' ($sums.Keys -join ', ')
  foreach ($n in @($esperados | Where-Object { $_ -ne 'SHA256SUMS.txt' })) {
    $h = (Get-FileHash -LiteralPath (Join-Path $entrega $n) -Algorithm SHA256).Hash.ToLower()
    Check ($sums.ContainsKey($n) -and $sums[$n] -eq $h) "hash de $n confere com SHA256SUMS.txt"
  }
  Check ($sums['spharmmt-agent-classification-audit.zip'] -eq $INTERIOR_ESPERADO) "hash interno do ZIP de auditoria = $INTERIOR_ESPERADO"
  $leiame = Get-Content -LiteralPath (Join-Path $entrega 'LEIAME-INSTALACAO.txt') -Raw
  $ordem = @('PASSO 0', 'PASSO 1', 'PASSO 2', 'PASSO 3', 'PASSO 4', 'PASSO 5') | ForEach-Object { $leiame.IndexOf($_) }
  Check (-not ($ordem | Where-Object { $_ -lt 0 }) -and (($ordem -join ',') -eq (($ordem | Sort-Object) -join ',')) -and $leiame.Contains($INTERIOR_ESPERADO)) 'LEIAME: passos 0..5 por ordem e o hash do ZIP de auditoria'
  Check ($leiame -match 'validar a tarefa|Validar a tarefa' -and $leiame -match 'Instalar lado a lado' -and $leiame -match 'UMA unica auditoria' -and $leiame -match 'Recolher o relatorio' -and $leiame -match 'Remover o diagnostico') 'LEIAME: validar tarefa/rev98 -> instalar -> uma auditoria -> recolher -> remover'

  $nomesInt = Get-NomesZip $zipInt
  $esperadosInt = @('Collect-ClassificationAuditReport.ps1', 'LEIAME.txt', 'MANIFEST.json', 'Run-ClassificationAudit.ps1', 'agent.cjs', 'node.exe', 'run-classification-audit.bat') | Sort-Object
  Check (($nomesInt -join '|') -eq ($esperadosInt -join '|')) 'ZIP interior: 7 ficheiros esperados' ($nomesInt -join ', ')
  Check (-not ($nomesInt | Where-Object { $_ -match '(?i)agent\.config|\.log$|run/|output/|\.lock|Install-|Remove-' })) 'ZIP interior sem config/logs/run/output/locks'

  # ---------------------------------------------------------------- 2. sandbox da rev98 + tarefa simulada
  Write-Host "`n=== 2. Sandbox: rev98 simulada, config com segredos sentinela, tarefa simulada ==="
  $base = Join-Path $raiz 'SPharm_MT'
  $rev98 = Join-Path $base 'spharmmt-agent-base-rev98'
  $dest = Join-Path $base 'spharmmt-classification-audit'
  New-Item -ItemType Directory -Path "$rev98\run", "$rev98\logs", "$rev98\output" -Force | Out-Null
  $cfg = @{ saas = @{ endpoint = 'https://saas.sentinel.invalid'; tenantSlug = 'sentinel-tenant-x9'; ingestKey = 'SENTINEL_INGEST_KEY_aa11bb22cc33dd44' }
            sqlServer = @{ host = 'sentinel-host-7f3a.example.invalid'; port = 1433; database = 'SPharm'; user = 'sentinel_user_91c2'; password = 'SENTINEL_PWD_5d8e!x'; requestTimeoutMs = 3000 } } | ConvertTo-Json -Depth 5
  Set-Content -LiteralPath "$rev98\agent.config.json" -Value $cfg -Encoding UTF8
  Set-Content -LiteralPath "$rev98\MANIFEST.json" -Value '{ "name": "spharmmt-agent-base", "rev": "98", "commit": "beb5fa7c008cb33238b3e644ec1165caf99fb648", "dirty": false }' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\node.exe" -Value 'fake-node-rev98' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\agent.cjs" -Value 'console.log("rev98")' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\run\pipeline.lock" -Value '{"versao":2,"runId":"abc","pid":999999,"modo":"daily-pipeline"}' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\logs\pipeline-2026-10-28.log" -Value 'LOG REAL com SENTINEL_PWD_5d8e!x' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\output\iva-audit-x.json" -Value '{"decoy":true}' -Encoding ASCII
  $tarefa = "{ param(`$n) [pscustomobject]@{ State = 'Ready'; Actions = @([pscustomobject]@{ Execute = '$rev98\node.exe'; Arguments = 'agent.cjs daily-pipeline'; WorkingDirectory = '$rev98' }) } }"
  $cfgHashAntes = (Get-FileHash -LiteralPath "$rev98\agent.config.json" -Algorithm SHA256).Hash
  $cfgBytesAntes = [IO.File]::ReadAllBytes("$rev98\agent.config.json")
  $impAntes = Get-Impressao $rev98
  $tarefaAntes = $tarefa
  Check $true 'sandbox criada (rev98 simulada com run/, logs/, output/, lock e config com segredos sentinela)'

  # ---------------------------------------------------------------- 3. Install (script extraido do pacote)
  Write-Host "`n=== 3. Install (so com os ficheiros extraidos do pacote exterior) ==="
  $txtInstall = Get-Content -LiteralPath (Join-Path $entrega 'Install-ClassificationAudit.ps1') -Raw
  $txtRemove = Get-Content -LiteralPath (Join-Path $entrega 'Remove-ClassificationAudit.ps1') -Raw
  $proibidos = '(?i)(Set|Register|Unregister|Start|Stop|Disable|Enable)-ScheduledTask|Stop-Process|schtasks|Stop-Service'
  Check ($txtInstall -notmatch $proibidos -and $txtRemove -notmatch $proibidos) 'Install/Remove: nenhum cmdlet que altere/pare tarefas, servicos ou processos'
  $r = Invoke-Filho "& '$entrega\Install-ClassificationAudit.ps1' -ZipPath '$zipInt' -Sha256Esperado '$($INTERIOR_ESPERADO.ToUpper())' -BaseDir '$base' -Rev98Dir '$rev98' -DestDir '$dest' -GetTask $tarefa"
  Check ($r.Exit -eq 0) 'Install: exit 0' $r.Out
  $nomesDest = (Get-ChildItem -LiteralPath $dest -Force | Select-Object -ExpandProperty Name | Sort-Object) -join ','
  Check ($nomesDest -eq ((@($esperadosInt) + 'agent.config.json' | Sort-Object) -join ',')) 'destino = 7 ficheiros do pacote + agent.config.json (so isso)' $nomesDest
  Check ((Get-FileHash -LiteralPath "$dest\agent.config.json" -Algorithm SHA256).Hash -eq $cfgHashAntes) 'agent.config.json copiado identico ao da rev98'
  Check (-not (Test-Path "$dest\run") -and -not (Test-Path "$dest\logs") -and -not (Test-Path "$dest\output")) 'NAO copiou run, logs nem output'
  Check (-not ($SEGREDOS | Where-Object { $r.Out.Contains($_) })) 'nenhum segredo na saida do Install'
  Check ((Get-Impressao $rev98) -eq $impAntes) 'rev98 INTACTA depois do Install (impressao digital)'

  # ---------------------------------------------------------------- 4. Run (node.exe REAL do pacote; sem SQL Server real)
  Write-Host "`n=== 4. Run: node.exe real do pacote, SEM SQL Server (host .invalid) ==="
  $r = Invoke-Filho "Set-Location '$dest'; & '$dest\Run-ClassificationAudit.ps1'"
  Check ($r.Exit -ne 0) 'sem SQL Server alcancavel o diagnostico termina com erro (exit != 0), sem pendurar' ("exit=" + $r.Exit)
  Check ($r.Out -match '(?i)diagn[o]stico|classification-audit|read-only|somente|leitura') 'mensagem identifica o pacote de diagnostico' $r.Out
  Check (-not ($SEGREDOS | Where-Object { $r.Out.Contains($_) })) 'nenhum segredo (password, user, host, tenant, chave) na saida do Run' ($SEGREDOS | Where-Object { $r.Out.Contains($_) })
  Check (-not (Test-Path "$dest\run") -and -not (Test-Path "$rev98\run\pipeline.lock.novo")) 'o diagnostico nao criou pasta run/ nem lock'
  $semSegredosDest = -not ((Get-ChildItem -LiteralPath $dest -Recurse -File -Force | Where-Object { $_.Name -notin @('agent.config.json', 'node.exe', 'agent.cjs') } | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue }) | Out-String | ForEach-Object { $t = $_; $SEGREDOS | Where-Object { $t.Contains($_) } })
  Check $semSegredosDest 'nenhum segredo em ficheiros gerados no destino (so o config copiado os tem)'
  Check ((Get-Impressao $rev98) -eq $impAntes) 'rev98 INTACTA depois do Run'

  # ---------------------------------------------------------------- 5. Collect (relatorio sintetico, sem segredos)
  Write-Host "`n=== 5. Collect ==="
  New-Item -ItemType Directory -Path "$dest\output" -Force | Out-Null
  Set-Content -LiteralPath "$dest\output\auditoria-classificacao.json" -Value '{ "pacote": "classification-audit", "diagnostico": true, "sintetico": true }' -Encoding ASCII
  Set-Content -LiteralPath "$dest\output\auditoria-classificacao.md" -Value '# Relatorio sintetico do teste' -Encoding ASCII
  Set-Content -LiteralPath "$dest\output\outro-ficheiro.json" -Value '{"nao":"recolher"}' -Encoding ASCII
  $destColeta = Join-Path $raiz 'recolha'
  $r = Invoke-Filho "Set-Location '$dest'; & '$dest\Collect-ClassificationAuditReport.ps1' -Destino '$destColeta'"
  Check ($r.Exit -eq 0) 'Collect: exit 0' $r.Out
  $zipsRel = @(Get-ChildItem -LiteralPath $destColeta -Filter '*.zip')
  Check ($zipsRel.Count -eq 1) 'um ZIP de relatorio gerado'
  $nomesRel = Get-NomesZip $zipsRel[0].FullName
  Check (($nomesRel -join '|') -eq ((@('SHA256.txt', 'auditoria-classificacao.json', 'auditoria-classificacao.md') | Sort-Object) -join '|')) 'o ZIP do relatorio so tem .json, .md e SHA256.txt (sem config, logs, run, locks, outros)' ($nomesRel -join ', ')
  Check (Test-Path -LiteralPath "$($zipsRel[0].FullName).sha256") 'ficheiro .sha256 do relatorio criado'
  # Collect recusa relatorio com ar de credencial
  Set-Content -LiteralPath "$dest\output\auditoria-classificacao.md" -Value 'password = hunter2xyz' -Encoding ASCII
  $r = Invoke-Filho "Set-Location '$dest'; & '$dest\Collect-ClassificationAuditReport.ps1' -Destino '$destColeta-2'"
  Check ($r.Exit -ne 0 -and -not (Test-Path "$destColeta-2")) 'Collect recusa um relatorio com ar de credencial (e nao cria nada)' $r.Out

  # ---------------------------------------------------------------- 6. Remove (script extraido do pacote)
  Write-Host "`n=== 6. Remove ==="
  $r = Invoke-Filho "& '$entrega\Remove-ClassificationAudit.ps1' -BaseDir '$base' -Rev98Dir '$rev98' -DestDir '$dest'"
  Check ($r.Exit -eq 2 -and (Test-Path -LiteralPath $dest)) 'sem -Confirmar: so mostra o que removeria (exit 2) e nada e apagado' $r.Out
  $r = Invoke-Filho "& '$entrega\Remove-ClassificationAudit.ps1' -BaseDir '$base' -Rev98Dir '$rev98' -DestDir '$rev98' -Confirmar"
  Check ($r.Exit -ne 0 -and (Test-Path -LiteralPath $rev98)) 'recusa remover a rev98 (mesmo com -Confirmar)' $r.Out
  $r = Invoke-Filho "& '$entrega\Remove-ClassificationAudit.ps1' -BaseDir '$base' -Rev98Dir '$rev98' -DestDir '$dest' -Confirmar"
  Check ($r.Exit -eq 0 -and -not (Test-Path -LiteralPath $dest)) 'com -Confirmar remove SO a pasta do diagnostico' $r.Out
  Check (-not ($SEGREDOS | Where-Object { $r.Out.Contains($_) })) 'nenhum segredo na saida do Remove'

  # ---------------------------------------------------------------- 7. rev98 / tarefa / config byte a byte
  Write-Host "`n=== 7. rev98, tarefa agendada e config byte a byte inalterados ==="
  Check ((Get-Impressao $rev98) -eq $impAntes) 'rev98: impressao digital final == inicial (caminhos, tamanhos, SHA-256 e datas de TODOS os ficheiros)'
  $cfgBytesDepois = [IO.File]::ReadAllBytes("$rev98\agent.config.json")
  Check ((Compare-Object $cfgBytesAntes $cfgBytesDepois -SyncWindow 0).Count -eq 0 -and $cfgBytesAntes.Length -eq $cfgBytesDepois.Length) 'agent.config.json da rev98: bytes identicos (comparacao byte a byte)'
  Check ((Get-FileHash -LiteralPath "$rev98\agent.config.json" -Algorithm SHA256).Hash -eq $cfgHashAntes) 'agent.config.json da rev98: SHA-256 igual'
  Check ($tarefa -eq $tarefaAntes -and $txtInstall -notmatch $proibidos) 'tarefa agendada: definicao inalterada e os scripts nunca a alteram (so Get-ScheduledTask)'
  Check (Test-Path -LiteralPath "$rev98\run\pipeline.lock") 'lock da rev98 continua la (nao foi tocado)'
}
finally {
  Remove-Item -LiteralPath $raiz -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host ''
Write-Host ("{0} {1} OK, {2} falhas" -f $(if ($script:falhas -eq 0) { 'PASSOU' } else { 'FALHOU' }), $script:ok, $script:falhas)
exit $(if ($script:falhas -eq 0) { 0 } else { 1 })
