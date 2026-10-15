# Instalação do agent rev98 — resiliência da sincronização diária (Silveirense)

Revisão a instalar: a indicada pelo `commit` do `MANIFEST.json` do pacote `spharmmt-agent-base-rev98.zip`
(branch `fix/agent-sync-resiliencia`). **Só agent: sem alterações ao SaaS, sem migrations, sem deploy da aplicação.**
`agent.config.json` rev97 continua válido (as opções novas são opcionais).

Origem da rev97 (para referência): pacote `spharmmt-agent-base-rev97` = commit `9990fa0`
(«chore(agent): rev97 — MANIFEST.json no pacote…», branch `feat/pesquisa-impressao-designacao-silveirense`). A rev98 parte do SHA
de produção da aplicação (`b7041de`) + esse commit do pacote (cherry-pick), pelo que o código funcional do agent é o da rev97 + a resiliência.

## 1. Gerar e verificar o pacote (máquina de build)

```bash
git fetch origin && git checkout --detach <SHA-final> && git status --short          # vazio
PUBLIC_APP_URL=https://app.spharmmt.com npm run agent:package
sha256sum dist-agent/spharmmt-agent-base-rev98.zip
unzip -p dist-agent/spharmmt-agent-base-rev98.zip MANIFEST.json | head -8            # rev=98, commit=<SHA-final>, dirty=false
```

`PUBLIC_APP_URL` tem de ser o mesmo que a VPS tem em `platform.env` (é selado em `agent.config.example.json`).

## 2. Instalar na Silveirense (lado a lado — a rev97 fica intacta para rollback)

Convenção da instalação atual: `C:\SPharm_MT\spharmmt-agent-base-rev97`. **Fora de uma corrida** (confirmar que não há `daily-pipeline`
nem `sync-now` ativos — não deve existir `run\pipeline.lock`).

```powershell
$base  = 'C:\SPharm_MT'
$antigo = "$base\spharmmt-agent-base-rev97"
$novo   = "$base\spharmmt-agent-base-rev98"
$zip    = 'C:\Temp\spharmmt-agent-base-rev98.zip'

# 0) o lock não pode estar ativo
Test-Path "$antigo\run\pipeline.lock"      # tem de ser False

# 1) extrair a rev98 para uma pasta NOVA
Expand-Archive $zip $novo -Force

# 2) copiar o que é da farmácia (config real, estado e logs) — nunca vem no ZIP
Copy-Item "$antigo\agent.config.json" "$novo\agent.config.json"
if (Test-Path "$antigo\run")  { Copy-Item "$antigo\run"  "$novo\run"  -Recurse }
if (Test-Path "$antigo\logs") { Copy-Item "$antigo\logs" "$novo\logs" -Recurse }
if (Test-Path "$antigo\output") { Copy-Item "$antigo\output" "$novo\output" -Recurse }

# 3) confirmar a revisão e a origem
cd $novo; .\node.exe agent.cjs health                      # o banner mostra rev=98
Get-Content .\MANIFEST.json | Select-String '"rev"|"commit"|"builtAtUtc"|"dirty"'
```

(Se `run\pipeline.lock` existir de uma corrida morta, apaga-o antes de copiar `run`.)

## 3. Validar ANTES de mudar a tarefa agendada

```powershell
cd C:\SPharm_MT\spharmmt-agent-base-rev98

# a) dry-run do plano: política de retentativas + dias que seriam processados. NÃO executa nem escreve nada.
.\node.exe agent.cjs daily-pipeline --plan
#   esperado: "Política HTTP: 1 + 4 retentativas (5s, 15s, 30s, 60s) … Retoma do pipeline: 4 tentativas, 15 min …",
#             "Último dia concluído confirmado pelo SaaS: <data>", "[plan] Dias que seriam processados (por ordem): …"

# b) dry-run da leitura do ERP para um dia (sem POST):
.\node.exe agent.cjs daily-sync-dry-run --date 2026-10-14

# c) ligação ao SaaS e à base:
.\node.exe agent.cjs test-connection
```

## 4. Atualizar a tarefa agendada «SPharm.MT — Daily Pipeline»

Primeiro **guardar a definição atual** (é o rollback exato) e ver o que lá está:

```powershell
$nome = 'SPharm.MT — Daily Pipeline'
Export-ScheduledTask -TaskName $nome | Out-File 'C:\SPharm_MT\tarefa-daily-pipeline.rev97.xml' -Encoding utf8
$t = Get-ScheduledTask -TaskName $nome
$t.Actions  | Format-List Execute, Arguments, WorkingDirectory
$t.Settings | Format-List ExecutionTimeLimit, MultipleInstances, RestartCount, RestartInterval, StartWhenAvailable
```

Trocar **só o caminho** rev97 → rev98 na ação (mantém o formato que lá estiver) e permitir execuções longas (a retoma espera ~15 min entre
tentativas; o `RestartOnFailure` fica como proteção adicional, não como mecanismo principal):

```powershell
$t = Get-ScheduledTask -TaskName $nome
$a = $t.Actions[0]
$a.Execute          = $a.Execute          -replace 'rev97','rev98'
$a.Arguments        = $a.Arguments        -replace 'rev97','rev98'
$a.WorkingDirectory = $a.WorkingDirectory -replace 'rev97','rev98'
$t.Settings.ExecutionTimeLimit = 'PT4H'
Set-ScheduledTask -InputObject $t | Out-Null

# conferir
$t2 = Get-ScheduledTask -TaskName $nome
$t2.Actions | Format-List Execute, Arguments, WorkingDirectory      # só rev98
$t2.Settings | Format-List ExecutionTimeLimit, MultipleInstances, RestartCount, RestartInterval, StartWhenAvailable
Get-ScheduledTaskInfo -TaskName $nome | Format-List LastRunTime, LastTaskResult, NextRunTime
```

A tarefa continua a chamar `run-daily-pipeline-auto.bat` (que termina com `endlocal & exit /b %EXIT%`). `MultipleInstances = IgnoreNew` mantém-se.

## 5. Validar a tarefa de ponta a ponta (opcional, recomendado)

Só numa janela sem corrida a decorrer e com a tarefa já apontada à rev98:

```powershell
Start-ScheduledTask -TaskName $nome
# acompanhar:
Get-Content C:\SPharm_MT\spharmmt-agent-base-rev98\logs\pipeline-$((Get-Date).AddDays(-1).ToString('yyyy-MM-dd')).log -Wait
```

No fim o log termina com `RESULTADO <dia>: concluído à primeira` (ou o desfecho aplicável) e `RESUMO DA EXECUÇÃO`; no SaaS o `PipelineRun`
fica `OK` com `details.resiliencia`. Se o dia já estava concluído o plano diz «Nada a fazer» (idempotente).

## 6. Como confirmar que a resiliência está ativa

* `daily-pipeline --plan` mostra a política (secção 3a).
* Em qualquer falha transitória o log tem linhas `[http] … tentativa k/5 falhou … AMBÍGUA|o servidor não chegou a processar … nova tentativa em Ns`.
* Falha persistente: `Pipeline <dia> — tentativa 2/4` após ~15 min; estado em `run\pipeline-pendentes.json`; alerta em `run\pipeline-alertas.json`.
* Simulação segura (sem tocar no SaaS real): `.\node.exe agent.cjs daily-pipeline --plan` com `SPHARMMT_ENDPOINT` apontado a um endereço sem serviço
  mostra o diagnóstico «o SaaS não conseguiu informar o último dia concluído» e o fallback para a pista local.

## 7. Rollback para a rev97

A rev97 nunca foi alterada (instalação lado a lado). Para voltar atrás:

```powershell
$nome = 'SPharm.MT — Daily Pipeline'
# a) restaurar a definição EXATA guardada no passo 4
Unregister-ScheduledTask -TaskName $nome -Confirm:$false
Register-ScheduledTask -TaskName $nome -Xml (Get-Content 'C:\SPharm_MT\tarefa-daily-pipeline.rev97.xml' -Raw)
# (ou, sem o XML, repor só o caminho:)  $a.Execute = $a.Execute -replace 'rev98','rev97'  … (como no passo 4)
Get-ScheduledTask -TaskName $nome | Select -Expand Actions | Format-List Execute, Arguments, WorkingDirectory
```

O estado local criado pela rev98 (`run\pipeline-pendentes.json`, `pipeline-alertas.json`, `pipelinerun-pendentes\`) é ignorado pela rev97 e pode ficar
ou ser apagado; **não há migrações** nem alterações de dados a reverter. Se houver registos em `run\pipelinerun-pendentes\` por enviar, correr uma vez
a rev98 (`--plan` já os reenvia no arranque de uma corrida normal) ou apagá-los se o dia correspondente já estiver `OK` no SaaS.

## 8. O que NÃO muda

Fórmulas, endpoints, dados enviados, janelas (ontem em Europe/Lisbon), gates de agregação, designação autoritativa, fabricante, `sync-now`, lock, exit
codes do `daily-pipeline` (0/1/2). `agent.config.json` não é tocado.
