# Instalação do agent rev98 — resiliência da sincronização diária (Silveirense)

Revisão a instalar: a indicada pelo `commit` do `MANIFEST.json` do pacote `spharmmt-agent-base-rev98.zip`
(branch `fix/agent-sync-resiliencia`). **Só agent: sem alterações ao SaaS, sem migrations, sem deploy da aplicação.**
`agent.config.json` rev97 continua válido (as opções novas são opcionais).

Origem da rev97 (referência): pacote `spharmmt-agent-base-rev97` = commit `9990fa0` («chore(agent): rev97 — MANIFEST.json no pacote…»,
branch `feat/pesquisa-impressao-designacao-silveirense`). A rev98 parte do SHA de produção da aplicação (`b7041de`) + esse commit do pacote
(cherry-pick): o código funcional do agent é o da rev97 + a resiliência.

> **Pacotes rev98 anteriores estão obsoletos.** Qualquer ZIP `spharmmt-agent-base-rev98.zip` gerado antes desta versão (SHA-256 diferente,
> `commit` diferente no `MANIFEST.json`) NÃO deve ser instalado: tinha o lock só por PID e a migração copiava a pasta `run` inteira.

## 1. Gerar e verificar o pacote (máquina de build)

```bash
git fetch origin && git checkout --detach <SHA-final> && git status --short          # vazio
PUBLIC_APP_URL=https://app.spharmmt.com npm run agent:package
sha256sum dist-agent/spharmmt-agent-base-rev98.zip
unzip -p dist-agent/spharmmt-agent-base-rev98.zip MANIFEST.json | head -8            # rev=98, commit=<SHA-final>, dirty=false
```

`PUBLIC_APP_URL` tem de ser o mesmo que a VPS tem em `platform.env` (é selado em `agent.config.example.json`).

## 2. Instalar na Silveirense — LADO A LADO (a rev97 fica intacta)

Convenção da instalação atual: `C:\SPharm_MT\spharmmt-agent-base-rev97`. **Não se copia a pasta `run`.** A rev97 não guarda nada da
corrida diária em `run\` — só o `pipeline.lock` e ficheiros de auditoria/onboarding — e a rev98 cria o seu estado sozinha.
Migra-se apenas: `agent.config.json` (obrigatório), `logs` e `output` (opcionais, histórico) e `run\full-sync-state.json` (só com
onboarding realmente pendente). **Nunca**: `pipeline.lock`, auditorias (`iva-audit-*`, `catalog-audit-*`, `movimentos-audit-*`, …) nem
qualquer ficheiro de estado da rev98 (não existem na rev97).

Cada bloco **pára** (`throw`) se algo não estiver como esperado. Fora de uma corrida; PowerShell **como o utilizador que corre a tarefa**.

```powershell
$ErrorActionPreference = 'Stop'
$base   = 'C:\SPharm_MT'
$antigo = Join-Path $base 'spharmmt-agent-base-rev97'
$novo   = Join-Path $base 'spharmmt-agent-base-rev98'
$zip    = 'C:\Temp\spharmmt-agent-base-rev98.zip'
$sha256Esperado = '<SHA-256 do ZIP entregue>'

# 1) Validar origem, ZIP e destino (nada é escrito)
if (-not (Test-Path -LiteralPath $antigo -PathType Container)) { throw "Origem rev97 não encontrada: $antigo" }
if (-not (Test-Path -LiteralPath (Join-Path $antigo 'agent.config.json') -PathType Leaf)) { throw 'A rev97 não tem agent.config.json' }
if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw "ZIP não encontrado: $zip" }
if (Test-Path -LiteralPath $novo) { throw "O destino já existe: $novo. NÃO se sobrescreve — confirma o que lá está e renomeia/remove-o à mão antes de repetir." }
$h = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
if ($h -ne $sha256Esperado.ToUpper()) { throw "SHA-256 do ZIP não confere: $h" }

# 2) A rev97 não pode estar a correr (lock ativo de um node.exe vivo)
$lock97 = Join-Path $antigo 'run\pipeline.lock'
if (Test-Path -LiteralPath $lock97) {
  $l = Get-Content -LiteralPath $lock97 -Raw | ConvertFrom-Json          # só pid/modo/datas — sem segredos
  $p = Get-Process -Id $l.pid -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') { throw "A rev97 está a correr (pid $($l.pid), $($l.kind)$($l.modo)). Espera que termine." }
  Write-Host "Lock órfão da rev97 (pid $($l.pid) já não existe) — NÃO é copiado." 
}

# 3) Extrair para uma pasta NOVA (sem -Force: falha se existir)
Expand-Archive -LiteralPath $zip -DestinationPath $novo

# 4) Copiar APENAS o que é da farmácia. Copy-Item sem -Force: nunca sobrescreve em silêncio.
Copy-Item -LiteralPath (Join-Path $antigo 'agent.config.json') -Destination (Join-Path $novo 'agent.config.json')
if (Test-Path -LiteralPath (Join-Path $antigo 'logs'))   { Copy-Item -Path (Join-Path $antigo 'logs\*')   -Destination (Join-Path $novo 'logs')   -Recurse }   # opcional
if (Test-Path -LiteralPath (Join-Path $antigo 'output')) { Copy-Item -Path (Join-Path $antigo 'output\*') -Destination (Join-Path $novo 'output') -Recurse }   # opcional

# 5) SÓ se houver um onboarding (full-sync) REALMENTE pendente E o confirmares aqui à mão:
$onboardingPendenteConfirmado = $false
$fss = Join-Path $antigo 'run\full-sync-state.json'
if ($onboardingPendenteConfirmado -and (Test-Path -LiteralPath $fss)) {
  New-Item -ItemType Directory -Path (Join-Path $novo 'run') -Force | Out-Null
  Copy-Item -LiteralPath $fss -Destination (Join-Path $novo 'run\full-sync-state.json')
}

# 6) Conferências (NÃO mostram o conteúdo do agent.config.json)
try { $c = Get-Content -LiteralPath (Join-Path $novo 'agent.config.json') -Raw | ConvertFrom-Json } catch { throw 'agent.config.json copiado não é JSON válido' }
"tenant=$($c.saas.tenantSlug)  farmacia=$($c.saas.farmacia)  endpoint=$($c.saas.endpoint)  ingestKey=" + $(if ($c.saas.ingestKey) { "(definida, $($c.saas.ingestKey.Length) caracteres)" } else { '(EM FALTA)' })
if (Get-ChildItem -LiteralPath $novo -Recurse -Filter 'pipeline.lock*' -ErrorAction SilentlyContinue) { throw 'Há um lock no destino — não devia existir' }
if (Test-Path -LiteralPath (Join-Path $novo 'run')) { Get-ChildItem -LiteralPath (Join-Path $novo 'run') | Select-Object Name }   # vazio, ou só full-sync-state.json se confirmado
Push-Location $novo; .\node.exe agent.cjs health; Pop-Location                    # banner: rev=98 commit=<SHA-final>
(Get-Content -LiteralPath (Join-Path $novo 'MANIFEST.json') -Raw | ConvertFrom-Json) | Select-Object rev, commit, builtAtUtc, dirty
```

A rev97 não é tocada em nenhum passo (só se lê).

## 3. Validar ANTES de mudar a tarefa agendada

```powershell
cd C:\SPharm_MT\spharmmt-agent-base-rev98

# a) dry-run do plano: política HTTP/SQL, estado do lock (só leitura) e dias que seriam processados. NÃO executa nem escreve nada,
#    NÃO cria lock.
.\node.exe agent.cjs daily-pipeline --plan
#   esperado: "Política HTTP: 1 + 4 retentativas (5s, 15s, 30s, 60s) … Retoma do pipeline: 4 tentativas, 15 min …",
#             "Política SQL Server: 2 retentativa(s) …", "Lock (run/pipeline.lock): livre",
#             "Último dia concluído confirmado pelo SaaS: <data>", "[plan] Dias que seriam processados (por ordem): …"

# b) dry-run da leitura do ERP para um dia (sem POST, sem lock):
.\node.exe agent.cjs daily-sync-dry-run --date 2026-10-14

# c) ligação ao SaaS e ao SQL Server (sem lock):
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

Trocar **só o caminho** rev97 → rev98 na ação (mantém o formato que lá estiver) e pôr o limite máximo em **`PT8H`**:

```powershell
$t = Get-ScheduledTask -TaskName $nome
$a = $t.Actions[0]
$a.Execute          = $a.Execute          -replace 'rev97','rev98'
$a.Arguments        = $a.Arguments        -replace 'rev97','rev98'
$a.WorkingDirectory = $a.WorkingDirectory -replace 'rev97','rev98'
$t.Settings.ExecutionTimeLimit = 'PT8H'
Set-ScheduledTask -InputObject $t | Out-Null

# conferir
$t2 = Get-ScheduledTask -TaskName $nome
$t2.Actions | Format-List Execute, Arguments, WorkingDirectory      # só rev98
$t2.Settings | Format-List ExecutionTimeLimit, MultipleInstances, RestartCount, RestartInterval, StartWhenAvailable
Get-ScheduledTaskInfo -TaskName $nome | Format-List LastRunTime, LastTaskResult, NextRunTime
```

### O que é o `PT8H` (e o que não é)

* **É só um teto de segurança**, não a duração normal: uma execução normal demora o mesmo que na rev97 (~3,5 min na Silveirense; a retoma só
  espera quando há falha). O Agendador mata o processo se este teto for ultrapassado — o lock órfão (processo morto) recupera-se de imediato no arranque seguinte e o dia fica
  pendente para o catch-up.
* **Porquê 8 h:** o pior caso teórico de UM dia (SaaS a esgotar todas as retentativas em todos os passos, 4 tentativas do pipeline) é ≈ 3 h 25 min,
  e um dia recuperado à última tentativa seguido de até 6 dias em atraso chega a ≈ 3 h 45 min. `PT4H` ficava apertado; `PT8H` dá folga sem
  deixar uma execução pendurada para sempre.
* **`MultipleInstances = IgnoreNew` continua adequado:** se a execução anterior ainda estiver viva (retoma a esperar), a nova ocorrência do
  Agendador é ignorada em vez de se acumular — e, mesmo sem isso, o lock com heartbeat recusa uma 2.ª execução.
* **`RestartOnFailure` (3× / 15 min)** pode ficar: é proteção adicional; a recuperação principal é do agent.
* **Computador suspenso a meio:** o lock identifica o processo (PID + instante de criação + executável + arranque do Windows). Ao acordar, um heartbeat atrasado NÃO deixa outra execução reclamar o lock
  enquanto o processo proprietário estiver vivo: a 2.ª execução é recusada («processo proprietário vivo com heartbeat atrasado», `run\pipeline-lock-diagnostico.json`) e a 1.ª retoma o heartbeat.
  Só um processo que morreu, um PID reutilizado ou um reinício do Windows libertam o lock automaticamente. Num processo bloqueado: terminá-lo no Gestor de Tarefas ou `--force` conscientemente.
* **Durante uma execução longa** o log do dia (`logs\pipeline-<dia>.log`) é escrito linha a linha e o `run\pipeline.lock` renova o
  `heartbeatEm` a cada 10 s (visível com `Get-Content run\pipeline.lock`).
* **Se a recuperação ficar definitivamente pendente** há alerta: `PipelineRun` ERROR/PARTIAL no SaaS (`/admin/pipeline`), evento no Registo de
  Eventos do Windows (Application, `SPharmMT-Agent`, ID 901) e, com `healthcheckUrl`, `POST /fail` no Healthchecks.io — uma vez por farmácia+dia+causa.

## 5. Validar a tarefa de ponta a ponta (opcional, recomendado)

Só numa janela sem corrida a decorrer e com a tarefa já apontada à rev98:

```powershell
Start-ScheduledTask -TaskName $nome
Get-Content C:\SPharm_MT\spharmmt-agent-base-rev98\logs\pipeline-$((Get-Date).AddDays(-1).ToString('yyyy-MM-dd')).log -Wait
```

No fim o log termina com `RESULTADO <dia>: concluído à primeira` (ou o desfecho aplicável) e `RESUMO DA EXECUÇÃO`; no SaaS o `PipelineRun`
fica `OK` com `details.resiliencia`. Se o dia já estava concluído o plano diz «Nada a fazer» (idempotente).

## 6. Como confirmar que a resiliência está ativa

* `daily-pipeline --plan` mostra as políticas HTTP e SQL e o estado do lock (secção 3a).
* Falha transitória HTTP: linhas `[http] … tentativa k/5 falhou … AMBÍGUA|o servidor não chegou a processar … nova tentativa em Ns`.
* Falha transitória do SQL Server: `⚠ SQL Server: falha transitória (…) na tentativa k/3 … nova ligação em Ns`; permanente (credenciais, tabela/coluna): falha logo, sem esperas.
* Falha persistente: `Pipeline <dia> — tentativa 2/4` após ~15 min; estado em `run\pipeline-pendentes.json`; alerta em `run\pipeline-alertas.json`.

## 7. Rollback para a rev97

A rev97 nunca foi alterada (instalação lado a lado). Para voltar atrás:

```powershell
$nome = 'SPharm.MT — Daily Pipeline'
# a) restaurar a definição EXATA guardada no passo 4
Unregister-ScheduledTask -TaskName $nome -Confirm:$false
Register-ScheduledTask -TaskName $nome -Xml (Get-Content 'C:\SPharm_MT\tarefa-daily-pipeline.rev97.xml' -Raw)
Get-ScheduledTask -TaskName $nome | Select-Object -ExpandProperty Actions | Format-List Execute, Arguments, WorkingDirectory
```

Antes de repor, confirmar que a rev98 não está a correr (`Get-Content …\spharmmt-agent-base-rev98\run\pipeline.lock` — se existir e o `pid`
for um `node.exe` vivo, aguardar). O estado local criado pela rev98 (`run\pipeline-*.json`, `pipelinerun-pendentes\`) é ignorado pela rev97;
**não há migrações** nem alterações de dados a reverter. Registos em `run\pipelinerun-pendentes\` por enviar: correr a rev98 uma vez, ou apagá-los se o
dia correspondente já estiver `OK` no SaaS.

## 8. O que NÃO muda

Fórmulas, endpoints, dados enviados, janelas (ontem em Europe/Lisbon), gates de agregação, designação autoritativa, fabricante, exit codes do
`daily-pipeline` (0/1/2). `agent.config.json` não é tocado. Mudam, por desenho: o lock (heartbeat, único para `daily-pipeline`, `full-sync`,
`sync-now` e os comandos `*-upload`/`daily-sync`) e o facto de `sync-now`/uploads avulsos serem recusados enquanto outra execução tem o lock.
