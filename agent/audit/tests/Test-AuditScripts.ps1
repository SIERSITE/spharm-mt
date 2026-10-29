<#
  Testes dos scripts PowerShell do pacote de DIAGNOSTICO classification-audit, numa pasta temporaria SIMULADA
  (nenhuma instalacao real, nenhuma tarefa agendada real). Cada script corre num powershell.exe filho (-EncodedCommand)
  para apanhar o exit code e a saida. Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File Test-AuditScripts.ps1
  Texto ASCII.
#>
$ErrorActionPreference = 'Stop'
$audit = Split-Path -Parent $PSScriptRoot
$scripts = @{
  Install = Join-Path $audit 'Install-ClassificationAudit.ps1'
  Remove  = Join-Path $audit 'Remove-ClassificationAudit.ps1'
  Run     = Join-Path $audit 'pacote\Run-ClassificationAudit.ps1'
  Collect = Join-Path $audit 'pacote\Collect-ClassificationAuditReport.ps1'
}
$script:ok = 0; $script:falhas = 0
function Check([bool]$cond, [string]$nome, [string]$detalhe = '') {
  if ($cond) { $script:ok++; Write-Host "  [OK]    $nome" }
  else { $script:falhas++; Write-Host "  [FALHA] $nome"; if ($detalhe) { Write-Host "            $detalhe" } }
}

# Executa um script num processo filho. $texto = o comando completo (ex.: "& 'x.ps1' -A 1"). Devolve @{Exit; Out}.
function Invoke-Filho([string]$texto) {
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("`$ErrorActionPreference='Continue'; $texto; exit `$LASTEXITCODE"))
  $out = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $enc 2>&1 | Out-String
  return @{ Exit = $LASTEXITCODE; Out = $out }
}

# Impressao digital de uma pasta: caminho + tamanho + SHA-256 + data de escrita de CADA ficheiro (e pastas vazias).
function Get-Impressao([string]$dir) {
  $raiz = (Resolve-Path -LiteralPath $dir).Path.TrimEnd('\')
  $itens = Get-ChildItem -LiteralPath $dir -Recurse -Force | Sort-Object FullName | ForEach-Object {
    if ($_.PSIsContainer) { 'D|' + $_.FullName.Substring($raiz.Length) }
    else { 'F|{0}|{1}|{2}|{3}' -f $_.FullName.Substring($raiz.Length), $_.Length, (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash, $_.LastWriteTimeUtc.Ticks }
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($itens -join "`n"))
  return [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))
}

$SEGREDOS = @('SENTINEL_PWD_5d8e!x', 'sentinel_user_91c2', 'SENTINEL_INGEST_KEY_aa11bb22cc33dd44', 'sentinel-host-7f3a.example.invalid', 'sentinel-tenant-x9')
$raiz = Join-Path ([IO.Path]::GetTempPath()) ('audit-ps-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $raiz | Out-Null
$nodeReal = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
try {
  # ---------------------------------------------------------------- sandbox
  $base = Join-Path $raiz 'SPharm_MT'
  $rev98 = Join-Path $base 'spharmmt-agent-base-rev98'
  $dest = Join-Path $base 'spharmmt-classification-audit'
  New-Item -ItemType Directory -Path "$rev98\run", "$rev98\logs", "$rev98\output" -Force | Out-Null
  $cfg = @{ saas = @{ endpoint = 'https://saas.sentinel.invalid'; tenantSlug = 'sentinel-tenant-x9'; ingestKey = 'SENTINEL_INGEST_KEY_aa11bb22cc33dd44' }
            sqlServer = @{ host = 'sentinel-host-7f3a.example.invalid'; port = 1433; database = 'SPharm'; user = 'sentinel_user_91c2'; password = 'SENTINEL_PWD_5d8e!x' } } | ConvertTo-Json -Depth 5
  Set-Content -LiteralPath "$rev98\agent.config.json" -Value $cfg -Encoding UTF8
  Set-Content -LiteralPath "$rev98\MANIFEST.json" -Value '{ "name": "spharmmt-agent-base", "rev": "98", "commit": "beb5fa7c008cb33238b3e644ec1165caf99fb648", "dirty": false }' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\node.exe" -Value 'fake-node-rev98' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\agent.cjs" -Value 'console.log("rev98")' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\run\pipeline.lock" -Value '{"versao":2,"runId":"abc","pid":999999,"modo":"daily-pipeline"}' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\run\pipeline-pendentes.json" -Value '{"dias":["2026-10-28"]}' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\logs\pipeline-2026-10-28.log" -Value 'LOG REAL com SENTINEL_PWD_5d8e!x' -Encoding ASCII
  Set-Content -LiteralPath "$rev98\output\iva-audit-x.json" -Value '{"decoy":true}' -Encoding ASCII
  $antesRev98 = Get-Impressao $rev98

  # pacote minimo (mesma estrutura do real: raiz plana + MANIFEST com sha256 por ficheiro)
  $pk = Join-Path $raiz 'pk'
  New-Item -ItemType Directory -Path $pk | Out-Null
  foreach ($f in @('Run-ClassificationAudit.ps1', 'Collect-ClassificationAuditReport.ps1', 'run-classification-audit.bat', 'LEIAME.txt')) { Copy-Item -LiteralPath (Join-Path $audit "pacote\$f") -Destination $pk }
  Set-Content -LiteralPath "$pk\node.exe" -Value 'fake-node-pkg' -Encoding ASCII
  Set-Content -LiteralPath "$pk\agent.cjs" -Value 'console.log("pkg")' -Encoding ASCII
  $files = [ordered]@{}
  foreach ($f in (Get-ChildItem -LiteralPath $pk -File | Sort-Object Name)) { $files[$f.Name] = @{ sha256 = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower(); bytes = $f.Length } }
  $man = [ordered]@{ name = 'spharmmt-agent-classification-audit'; pacote = 'classification-audit'; versao = 'diag-2026-10-29'; diagnostico = $true; instalavel = $false; baseRev = '98'
                     baseCommit = 'beb5fa7c008cb33238b3e644ec1165caf99fb648'; commit = '0123456789abcdef0123456789abcdef01234567'; files = $files }
  ($man | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath "$pk\MANIFEST.json" -Encoding ASCII
  $zip = Join-Path $raiz 'spharmmt-agent-classification-audit.zip'
  Compress-Archive -Path "$pk\*" -DestinationPath $zip
  $zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash

  $tarefaOk = "{ param(`$n) [pscustomobject]@{ State = 'Ready'; Actions = @([pscustomobject]@{ Execute = '$rev98\node.exe'; Arguments = 'agent.cjs daily-pipeline'; WorkingDirectory = '$rev98' }) } }"
  $tarefaCorrer = $tarefaOk.Replace("'Ready'", "'Running'")
  $tarefaOutra = $tarefaOk.Replace($rev98, (Join-Path $base 'spharmmt-agent-base-rev97'))
  $tarefaAusente = "{ param(`$n) throw 'nao existe' }"
  function Instalar([string]$tarefa, [string]$hash = $zipHash, [string]$zipPath = $zip, [string]$destino = $dest, [string]$r98 = $rev98) {
    return Invoke-Filho "& '$($scripts.Install)' -ZipPath '$zipPath' -Sha256Esperado '$hash' -BaseDir '$base' -Rev98Dir '$r98' -DestDir '$destino' -GetTask $tarefa"
  }

  # ================================================================ 0. estaticos
  Write-Host "`n=== 0. Estaticos ==="
  foreach ($k in $scripts.Keys) {
    $bytes = [IO.File]::ReadAllBytes($scripts[$k])
    Check (-not ($bytes | Where-Object { $_ -gt 127 })) "${k}: so ASCII (PowerShell 5.1 sem BOM)"
    $err = $null; [void][Management.Automation.Language.Parser]::ParseFile($scripts[$k], [ref]$null, [ref]$err)
    Check ($err.Count -eq 0) "${k}: sintaxe valida" ($err -join '; ')
  }
  $txtInstall = Get-Content -LiteralPath $scripts.Install -Raw
  Check ($txtInstall -notmatch '(?i)(Set|Register|Unregister|Start|Stop|Disable|Enable)-ScheduledTask|Stop-Process|schtasks') 'Install: nao tem nenhum cmdlet que altere/pare tarefas ou processos'
  Check ($txtInstall -match '\[char\]0x2014' -and $txtInstall -match 'Get-ScheduledTask') 'Install: tarefa por omissao «SPharm.MT <travessao> Daily Pipeline» (so Get-ScheduledTask)'
  $linhasCfg = @($txtInstall -split "`n" | Where-Object { $_ -match 'Get-Content' -and $_ -match 'agent\.config' })
  Check ($linhasCfg.Count -ge 1 -and @($linhasCfg | Where-Object { $_ -notmatch '\$null = ' }).Count -eq 0 -and $txtInstall -notmatch '(?i)(Write-Host|Info)[^\r\n]*Get-Content') 'Install: nunca mostra o conteudo do agent.config.json (so o valida em silencio, para $null)'

  # ================================================================ 1. sucesso
  Write-Host "`n=== 1. Instalacao lado a lado (sucesso) ==="
  $r = Instalar $tarefaOk
  Check ($r.Exit -eq 0) 'exit 0' $r.Out
  Check (Test-Path -LiteralPath $dest -PathType Container) 'pasta de diagnostico criada, independente da rev98'
  $nomesDest = (Get-ChildItem -LiteralPath $dest -Force | Select-Object -ExpandProperty Name | Sort-Object) -join ','
  $esperadoDest = ((@((Get-ChildItem -LiteralPath $pk).Name) + 'agent.config.json') | Sort-Object) -join ','
  Check ($nomesDest -eq $esperadoDest) 'destino = ficheiros do pacote + agent.config.json (so isso)' $nomesDest
  Check ((Get-FileHash -LiteralPath "$dest\agent.config.json").Hash -eq (Get-FileHash -LiteralPath "$rev98\agent.config.json").Hash) 'agent.config.json copiado identico'
  Check (-not (Test-Path -LiteralPath "$dest\run") -and -not (Test-Path -LiteralPath "$dest\logs") -and -not (Test-Path -LiteralPath "$dest\output")) 'NAO copiou run, logs nem output'
  Check (-not (Get-ChildItem -LiteralPath $dest -Recurse -Force | Where-Object { $_.Name -like 'pipeline.lock*' -or $_.Name -like 'pipeline-pendentes*' -or $_.Name -like 'iva-audit*' })) 'NAO copiou locks, estado nem auditorias anteriores'
  Check ((Get-ChildItem -LiteralPath $dest -Recurse -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw } | Out-String) -notmatch 'LOG REAL') 'nenhum conteudo de log real no destino'
  Check ((Get-Impressao $rev98) -eq $antesRev98) 'rev98 INTACTA: impressao digital (caminhos, tamanhos, SHA-256, datas) igual antes/depois'
  Check (-not ($SEGREDOS | Where-Object { $r.Out.Contains($_) })) 'nenhum segredo na saida do script'
  Check ($r.Out -match 'conteudo NAO mostrado') 'diz que o conteudo do config nao e mostrado'
  Check ($r.Out -match 'estado=Ready' -and $r.Out -notmatch 'A CORRER') 'tarefa lida (Ready) e nao alterada'

  # ================================================================ 2. pre-condicoes
  Write-Host "`n=== 2. Pre-condicoes: qualquer falha pára (exit != 0) e nao escreve nada ==="
  Remove-Item -LiteralPath $dest -Recurse -Force   # repoe o estado para os cenarios de falha
  $r = Instalar $tarefaCorrer
  Check ($r.Exit -ne 0 -and $r.Out -match 'A CORRER') 'tarefa a correr -> falha' $r.Out
  Check (-not (Test-Path -LiteralPath $dest)) '…e nada foi criado'
  $r = Instalar $tarefaOutra
  Check ($r.Exit -ne 0 -and $r.Out -match 'NAO aponta para a rev98') 'tarefa a apontar para outra pasta (rev97) -> falha' $r.Out
  $r = Instalar $tarefaAusente
  Check ($r.Exit -ne 0 -and $r.Out -match 'nao encontrada') 'tarefa inexistente -> falha'
  $r = Instalar $tarefaOk ('0' * 64)
  Check ($r.Exit -ne 0 -and $r.Out -match 'SHA-256 do ZIP nao confere') 'hash do ZIP errado -> falha' $r.Out
  Check (-not (Test-Path -LiteralPath $dest)) '…e nada foi criado'
  $r = Instalar $tarefaOk $zipHash (Join-Path $raiz 'nao-existe.zip')
  Check ($r.Exit -ne 0 -and $r.Out -match 'ZIP nao encontrado') 'ZIP inexistente -> falha'
  $r = Instalar $tarefaOk $zipHash $zip $rev98
  Check ($r.Exit -ne 0 -and $r.Out -match 'INDEPENDENTE') 'destino = rev98 -> falha'
  $r = Instalar $tarefaOk $zipHash $zip (Join-Path $rev98 'diag')
  Check ($r.Exit -ne 0 -and $r.Out -match 'INDEPENDENTE' -and -not (Test-Path -LiteralPath "$rev98\diag")) 'destino dentro da rev98 -> falha'
  $r = Instalar $tarefaOk $zipHash $zip $base
  Check ($r.Exit -ne 0 -and $r.Out -match 'INDEPENDENTE') 'destino que contem a rev98 -> falha'
  New-Item -ItemType Directory -Path $dest | Out-Null; Set-Content -LiteralPath "$dest\meu.txt" -Value 'nao tocar' -Encoding ASCII
  $r = Instalar $tarefaOk
  Check ($r.Exit -ne 0 -and $r.Out -match 'ja existe' -and (Get-Content -LiteralPath "$dest\meu.txt" -Raw) -match 'nao tocar') 'destino ja existente -> falha sem sobrescrever'
  Remove-Item -LiteralPath $dest -Recurse -Force
  $r = Instalar $tarefaOk $zipHash $zip $dest (Join-Path $base 'nao-existe-rev98')
  Check ($r.Exit -ne 0 -and $r.Out -match 'nao encontrada') 'rev98 inexistente -> falha'
  Rename-Item -LiteralPath "$rev98\agent.config.json" -NewName 'agent.config.json.off'
  $r = Instalar $tarefaOk
  Check ($r.Exit -ne 0 -and $r.Out -match 'nao tem agent.config.json') 'rev98 sem agent.config.json -> falha'
  Rename-Item -LiteralPath "$rev98\agent.config.json.off" -NewName 'agent.config.json'
  Set-Content -LiteralPath "$rev98\MANIFEST.json" -Value '{ "rev": "97" }' -Encoding ASCII
  $r = Instalar $tarefaOk
  Check ($r.Exit -ne 0 -and $r.Out -match 'nao e a rev98') 'pasta que nao e a rev98 (MANIFEST rev=97) -> falha'
  Set-Content -LiteralPath "$rev98\MANIFEST.json" -Value '{ "name": "spharmmt-agent-base", "rev": "98", "commit": "beb5fa7c008cb33238b3e644ec1165caf99fb648", "dirty": false }' -Encoding ASCII
  Check (-not ($SEGREDOS | Where-Object { $r.Out.Contains($_) })) 'nenhum segredo nas mensagens de erro'

  # processo node.exe a correr a partir da rev98 (node real, copia temporaria na rev98 simulada)
  if ($nodeReal) {
    # o script procura processos 'node' cujo caminho esta na rev98: usa-se uma copia do node real como node.exe da rev98 simulada
    Copy-Item -LiteralPath $nodeReal -Destination "$rev98\node.exe" -Force
    $p = Start-Process -FilePath "$rev98\node.exe" -ArgumentList '-e', 'setTimeout(()=>{},30000)' -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 800
    $r = Instalar $tarefaOk
    Check ($r.Exit -ne 0 -and $r.Out -match 'a correr a partir da rev98') 'node.exe vivo na pasta da rev98 -> falha' $r.Out
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Set-Content -LiteralPath "$rev98\node.exe" -Value 'fake-node-rev98' -Encoding ASCII
  }
  # lock vivo: pid de um processo 'node' real
  if ($nodeReal) {
    $p = Start-Process -FilePath $nodeReal -ArgumentList '-e', 'setTimeout(()=>{},30000)' -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 800
    Set-Content -LiteralPath "$rev98\run\pipeline.lock" -Value ('{"versao":2,"runId":"abc","pid":' + $p.Id + ',"modo":"daily-pipeline"}') -Encoding ASCII
    $r = Instalar $tarefaOk
    Check ($r.Exit -ne 0 -and $r.Out -match 'lock com pid') 'lock da rev98 com processo node vivo -> falha' $r.Out
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Set-Content -LiteralPath "$rev98\run\pipeline.lock" -Value '{"versao":2,"runId":"abc","pid":999999,"modo":"daily-pipeline"}' -Encoding ASCII
  }
  # repor as datas do que mexemos para a comparacao final (conteudo igual, datas podem ter mudado: recalcula-se a base)
  $antesRev98 = Get-Impressao $rev98

  # ZIP adulterado: manifesto diz um hash, ficheiro tem outro
  $pk2 = Join-Path $raiz 'pk2'; Copy-Item -LiteralPath $pk -Destination $pk2 -Recurse
  Set-Content -LiteralPath "$pk2\agent.cjs" -Value 'ADULTERADO' -Encoding ASCII
  $zip2 = Join-Path $raiz 'adulterado.zip'; Compress-Archive -Path "$pk2\*" -DestinationPath $zip2
  $r = Instalar $tarefaOk (Get-FileHash -LiteralPath $zip2 -Algorithm SHA256).Hash $zip2
  Check ($r.Exit -ne 0 -and $r.Out -match 'SHA-256 do ficheiro nao confere com o MANIFEST') 'ficheiro adulterado face ao MANIFEST -> falha' $r.Out
  Check (-not (Test-Path -LiteralPath $dest)) '…e a pasta incompleta foi removida (so a que o script criou)'
  # ZIP com agent.config.json lá dentro
  $pk3 = Join-Path $raiz 'pk3'; Copy-Item -LiteralPath $pk -Destination $pk3 -Recurse
  Set-Content -LiteralPath "$pk3\agent.config.json" -Value '{"x":1}' -Encoding ASCII
  $zip3 = Join-Path $raiz 'comconfig.zip'; Compress-Archive -Path "$pk3\*" -DestinationPath $zip3
  $r = Instalar $tarefaOk (Get-FileHash -LiteralPath $zip3 -Algorithm SHA256).Hash $zip3
  Check ($r.Exit -ne 0 -and $r.Out -match "agent.config.json', que nao devia existir|traz 'agent.config.json'") 'ZIP que traz agent.config.json -> falha' $r.Out
  Check ((Get-Impressao $rev98) -eq $antesRev98) 'rev98 intacta apos TODOS os cenarios de falha'

  # ================================================================ 3. Run
  Write-Host "`n=== 3. Run-ClassificationAudit.ps1 ==="
  $r = Instalar $tarefaOk
  Check ($r.Exit -eq 0) 'reinstalacao limpa' $r.Out
  $semCfg = Join-Path $raiz 'run-sem-cfg'; Copy-Item -LiteralPath $pk -Destination $semCfg -Recurse
  $r = Invoke-Filho "& '$semCfg\Run-ClassificationAudit.ps1'"
  Check ($r.Exit -eq 1 -and $r.Out -match 'agent.config.json nao encontrado') 'sem agent.config.json: exit 1 com mensagem clara'
  Check (-not (Test-Path -LiteralPath "$semCfg\output")) '…e nao criou nada'
  if ($nodeReal) {
    # node real + agent.cjs falso que regista os argumentos recebidos
    Remove-Item -LiteralPath "$dest\node.exe" -Force
    cmd /c mklink /H "$dest\node.exe" "$nodeReal" | Out-Null
    if (-not (Test-Path -LiteralPath "$dest\node.exe")) { Copy-Item -LiteralPath $nodeReal -Destination "$dest\node.exe" }
    Set-Content -LiteralPath "$dest\agent.cjs" -Value "require('fs').writeFileSync('output/args.txt', JSON.stringify(process.argv.slice(2))); process.exit(0)" -Encoding ASCII
    # o MANIFEST ja nao bate (ficheiros trocados de proposito neste teste): o Run so le diagnostico/instalavel
    $r = Invoke-Filho "& '$dest\Run-ClassificationAudit.ps1' -Cnps 1234567,7654321 -CnpsFicheiro cnps.txt"
    Check ($r.Exit -eq 0) 'executa e devolve o exit code do node' $r.Out
    $args1 = Get-Content -LiteralPath "$dest\output\args.txt" -Raw | ConvertFrom-Json
    Check (($args1 -join ' ') -eq 'classification-audit --out .\output\auditoria-classificacao.json --cnps 1234567,7654321 --cnps-ficheiro cnps.txt') 'comando = classification-audit --out .\output\auditoria-classificacao.json [--cnps ..] [--cnps-ficheiro ..]' ($args1 -join ' ')
    Set-Content -LiteralPath "$dest\agent.cjs" -Value "process.exit(7)" -Encoding ASCII
    $r = Invoke-Filho "& '$dest\Run-ClassificationAudit.ps1'"
    Check ($r.Exit -eq 7) 'propaga o exit code do node (7)'
    Remove-Item -LiteralPath "$dest\node.exe" -Force
  }
  # Run recusa pastas que nao sao o pacote de diagnostico
  $naoPacote = Join-Path $raiz 'nao-pacote'; New-Item -ItemType Directory -Path $naoPacote | Out-Null
  Copy-Item -LiteralPath "$audit\pacote\Run-ClassificationAudit.ps1" -Destination $naoPacote
  Set-Content -LiteralPath "$naoPacote\MANIFEST.json" -Value '{"rev":"98"}' -Encoding ASCII
  $r = Invoke-Filho "& '$naoPacote\Run-ClassificationAudit.ps1'"
  Check ($r.Exit -eq 1 -and $r.Out -match 'nao e um pacote de diagnostico') 'pasta com MANIFEST de agent (nao diagnostico): recusa'

  # ================================================================ 4. Collect
  Write-Host "`n=== 4. Collect-ClassificationAuditReport.ps1 ==="
  New-Item -ItemType Directory -Path "$dest\output", "$dest\logs", "$dest\run" -Force | Out-Null
  Set-Content -LiteralPath "$dest\output\auditoria-classificacao.json" -Value '{"cabecalho":{"pacote":{"diagnostico":true}},"perfis":[]}' -Encoding UTF8
  Set-Content -LiteralPath "$dest\output\auditoria-classificacao.md" -Value '# classification-audit' -Encoding UTF8
  Set-Content -LiteralPath "$dest\output\outro.txt" -Value 'nao recolher' -Encoding ASCII
  Set-Content -LiteralPath "$dest\logs\x.log" -Value 'LOG com SENTINEL_PWD_5d8e!x' -Encoding ASCII
  Set-Content -LiteralPath "$dest\run\pipeline.lock" -Value '{"pid":1}' -Encoding ASCII
  $r = Invoke-Filho "& '$dest\Collect-ClassificationAuditReport.ps1'"
  Check ($r.Exit -eq 0) 'exit 0' $r.Out
  $zr = Get-ChildItem -LiteralPath "$dest\entrega" -Filter 'auditoria-classificacao-*.zip'
  Check ($zr.Count -eq 1 -and (Test-Path -LiteralPath "$($zr.FullName).sha256")) 'ZIP do relatorio + .sha256'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $z = [IO.Compression.ZipFile]::OpenRead($zr.FullName); $nomes = ($z.Entries | ForEach-Object { $_.FullName } | Sort-Object) -join ','; $z.Dispose()
  Check ($nomes -eq 'auditoria-classificacao.json,auditoria-classificacao.md,SHA256.txt') 'contem SO auditoria-classificacao.json/.md + SHA256.txt' $nomes
  Check ($nomes -notmatch 'config|log|lock|run|outro') 'sem config, logs, locks, run nem outros ficheiros de output'
  Check ((Get-Content -LiteralPath "$($zr.FullName).sha256" -Raw) -match (Get-FileHash -LiteralPath $zr.FullName -Algorithm SHA256).Hash.ToLower()) 'o .sha256 e o do ZIP'
  Check (-not ($SEGREDOS | Where-Object { $r.Out.Contains($_) })) 'nenhum segredo na saida'
  Set-Content -LiteralPath "$dest\output\auditoria-classificacao.json" -Value '{"sqlServer":{"password": "abc123"}}' -Encoding UTF8
  $antes = @(Get-ChildItem -LiteralPath "$dest\entrega").Count
  $r = Invoke-Filho "& '$dest\Collect-ClassificationAuditReport.ps1' -Destino '$dest\entrega2'"
  Check ($r.Exit -ne 0 -and $r.Out -match 'ar de credencial' -and -not (Test-Path -LiteralPath "$dest\entrega2")) 'relatorio com ar de credencial: NAO e recolhido'
  Remove-Item -Path "$dest\output\auditoria-classificacao.*" -Force
  $r = Invoke-Filho "& '$dest\Collect-ClassificationAuditReport.ps1' -Destino '$dest\entrega3'"
  Check ($r.Exit -ne 0 -and $r.Out -match 'nao ha relatorio') 'sem relatorio: falha clara'

  # ================================================================ 5. Remove
  Write-Host "`n=== 5. Remove-ClassificationAudit.ps1 (so a pasta certa) ==="
  function Remover([string]$alvo, [string]$extra = '') { return Invoke-Filho "& '$($scripts.Remove)' -BaseDir '$base' -DestDir '$alvo' -Rev98Dir '$rev98' $extra" }
  $antesRev98 = Get-Impressao $rev98
  $r = Remover $dest
  Check ($r.Exit -eq 2 -and (Test-Path -LiteralPath $dest) -and $r.Out -match 'Nada foi removido') 'sem -Confirmar: mostra e nao remove (exit 2)' $r.Out
  $r = Remover $rev98 '-Confirmar'
  Check ($r.Exit -eq 1 -and (Test-Path -LiteralPath $rev98) -and $r.Out -match 'spharmmt-classification-audit') 'apontar para a rev98: RECUSADO (nome)' $r.Out
  # nome certo mas dentro da rev98
  $falsa = Join-Path $rev98 'spharmmt-classification-audit-x'
  New-Item -ItemType Directory -Path $falsa | Out-Null
  Set-Content -LiteralPath "$falsa\MANIFEST.json" -Value '{"pacote":"classification-audit","diagnostico":true,"instalavel":false}' -Encoding ASCII
  $r = Remover $falsa '-Confirmar'
  Check ($r.Exit -eq 1 -and (Test-Path -LiteralPath $falsa) -and $r.Out -match 'rev98') 'pasta com nome certo mas DENTRO da rev98: RECUSADO' $r.Out
  Remove-Item -LiteralPath $falsa -Recurse -Force
  $antesRev98 = Get-Impressao $rev98
  $r = Remover $base '-Confirmar'
  Check ($r.Exit -eq 1 -and (Test-Path -LiteralPath $rev98)) 'apontar para a pasta-mae (contem a rev98): RECUSADO' $r.Out
  $outra = Join-Path $base 'spharmmt-classification-audit-sem-manifesto'; New-Item -ItemType Directory -Path $outra | Out-Null
  $r = Remover $outra '-Confirmar'
  Check ($r.Exit -eq 1 -and (Test-Path -LiteralPath $outra) -and $r.Out -match 'MANIFEST') 'pasta sem MANIFEST: RECUSADO'
  Remove-Item -LiteralPath $outra -Recurse -Force
  $errada = Join-Path $base 'outra-coisa'; New-Item -ItemType Directory -Path $errada | Out-Null
  Copy-Item -LiteralPath "$dest\MANIFEST.json" -Destination $errada
  $r = Remover $errada '-Confirmar'
  Check ($r.Exit -eq 1 -and (Test-Path -LiteralPath $errada)) 'nome que nao comeca por spharmmt-classification-audit: RECUSADO'
  Remove-Item -LiteralPath $errada -Recurse -Force
  $alvoJ = Join-Path $raiz 'alvo-da-juncao'; New-Item -ItemType Directory -Path $alvoJ | Out-Null
  Copy-Item -LiteralPath "$dest\MANIFEST.json" -Destination $alvoJ
  Set-Content -LiteralPath "$alvoJ\importante.txt" -Value 'nao apagar' -Encoding ASCII
  $juncao = Join-Path $base 'spharmmt-classification-audit-juncao'
  cmd /c mklink /J "$juncao" "$alvoJ" | Out-Null
  $r = Remover $juncao '-Confirmar'
  Check ($r.Exit -eq 1 -and (Test-Path -LiteralPath "$alvoJ\importante.txt") -and $r.Out -match 'juncao') 'ponto de juncao: RECUSADO (o alvo fica intacto)' $r.Out
  cmd /c rmdir "$juncao" | Out-Null
  $r = Remover 'C:\' '-Confirmar'
  Check ($r.Exit -eq 1) 'raiz de disco: RECUSADO'
  $r = Remover $dest '-Confirmar'
  Check ($r.Exit -eq 0 -and -not (Test-Path -LiteralPath $dest)) 'pasta certa + -Confirmar: removida' $r.Out
  Check ((Get-Impressao $rev98) -eq $antesRev98) 'rev98 INTACTA (impressao digital igual) apos a remocao e todas as recusas'
  Check (-not ($SEGREDOS | Where-Object { $r.Out.Contains($_) })) 'nenhum segredo na saida'
  $r = Remover $dest '-Confirmar'
  Check ($r.Exit -eq 1 -and $r.Out -match 'nao existe') 'remover o que ja nao existe: falha clara, sem apagar nada'
}
finally {
  # Limpeza: so a pasta temporaria deste teste (e junções primeiro, sem seguir o alvo).
  Get-ChildItem -LiteralPath $raiz -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | ForEach-Object { cmd /c rmdir "$($_.FullName)" 2>$null | Out-Null }
  if ($raiz -and $raiz.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $raiz) -like 'audit-ps-test-*') {
    Remove-Item -LiteralPath $raiz -Recurse -Force -ErrorAction SilentlyContinue
  }
}
Write-Host ''
Write-Host ("{0} ok, {1} falhas" -f $script:ok, $script:falhas)
exit $(if ($script:falhas -eq 0) { 0 } else { 1 })
