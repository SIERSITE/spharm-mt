# Agent rev99 — classificação Ético / NETT (instalação lado a lado, validação e rollback)

A rev99 é a rev98 **mais** a leitura de `dbo.Stocks.Etico_NETT` e do lookup `dbo.Etico_NETT` da própria farmácia. Lock único, heartbeat,
identidade do processo, guarda de escrita, retoma SQL/HTTP, catch-up e `agent.config.json` são os da rev98 (nada foi alterado).

> **A rev98 continua a ser o agent em produção até o servidor estar instalado e validado.** Nada neste documento altera a tarefa
> agendada; a troca é um passo explícito e reversível (secção 4).

## 0. Pré-condições (por esta ordem)

1. O **servidor** SPharm.MT desta entrega já está instalado e validado (a migration `produto_farmacia_etico_nett` aplicada). Um servidor
   anterior ignora os campos novos sem erro, mas **não os grava** — não vale a pena trocar o agent antes.
2. A rev98 está a funcionar (tarefa `SPharm.MT — Daily Pipeline` em `Ready`, nenhum `daily-pipeline` a correr).
3. O ZIP tem o SHA-256 indicado na entrega (`Get-FileHash -Algorithm SHA256 .\spharmmt-agent-base-rev99.zip`). Se não bater: **parar**.

## 1. Instalar lado a lado (não toca na rev98)

```powershell
# Pasta NOVA; a rev98 fica exatamente como está.
Expand-Archive .\spharmmt-agent-base-rev99.zip C:\SPharm_MT\spharmmt-agent-base-rev99
# Copiar SÓ a configuração (o pacote não traz config, logs, run nem locks):
Copy-Item C:\SPharm_MT\spharmmt-agent-base-rev98\agent.config.json C:\SPharm_MT\spharmmt-agent-base-rev99\agent.config.json
```

Conferir `MANIFEST.json` (`"rev": "99"`, `commit` = o da entrega, `dirty: false`) e os hashes dos ficheiros.

## 2. Validar ANTES de trocar a tarefa (tudo só leitura / dry-run)

Na pasta da rev99, com a tarefa da rev98 **parada de correr** (estado `Ready`):

1. `run-test-connection.bat` — SQL e SaaS OK.
2. `run-daily-pipeline-plan.bat` — dry-run do plano (política de retentativas e dias em falta; **nada é executado**).
3. `run-daily-sync-dry-run.bat` (pede uma data) — **sem POST**. No log têm de aparecer, e só estas, as linhas de classificação:
   * `Ético/NETT: lookup com N linha(s); reconhecidas 2, ignoradas …, ambíguas 0.` (ou o aviso de lookup indisponível);
   * `Ético/NETT enviados: X Ético, Y NETT; Z de outra categoria conhecida; W sem categoria reconhecível (aviso); V sem código.`
   * **nunca** o conteúdo do lookup, descrições, servidor ou credenciais.
4. Conferir que `reconhecidas` = 2 (Ético e NETT). Se for 0 ou houver `ambíguas > 0`, **parar** e enviar o log ao suporte: o lookup desta
   farmácia tem descrições inesperadas (nada será classificado até se resolver).
5. Conferir que o número de artigos lidos é igual ao de um dry-run da rev98 para o mesmo dia (o universo **não** muda).

## 3. Piloto (uma farmácia) e dados

1. Trocar a tarefa **só na farmácia piloto** (secção 4) e deixar correr um ciclo diário.
2. No SPharm.MT (ficha de um artigo conhecido): «Classificação Ético/NETT» mostra a farmácia piloto com código e descrição ERP.
3. Filtro «Ético / NETT» num mapa: as contagens batem com as do ERP (`SELECT … FROM dbo.Stocks s JOIN dbo.Etico_NETT …`, só leitura).
4. Só depois das restantes farmácias, uma a uma.

## 4. Trocar a tarefa agendada (passo explícito)

Alterar **apenas** o caminho/`WorkingDirectory` da ação para `…\spharmmt-agent-base-rev99` (mesmo nome de tarefa, mesmas definições,
`ExecutionTimeLimit PT8H`). Registar o caminho anterior antes de alterar.

## 5. Rollback para a rev98

1. Repor na tarefa o caminho `…\spharmmt-agent-base-rev98` (o registado no passo anterior). A pasta da rev98 nunca foi alterada.
2. Não há nada a desfazer no SaaS: um agent rev98 **não apaga** classificações gravadas pela rev99 (campos ausentes ⇒ não toca).
3. A pasta rev99 pode ficar (inerte) ou ser removida; não partilha lock nem estado com a rev98.

## 6. O que a rev99 envia (por artigo, campos opcionais)

| Situação no ERP desta farmácia | Payload | Efeito no SaaS |
| --- | --- | --- |
| descrição «Éticos» / «NETT» (normalizada) | `eticoNett: "ETICO"\|"NETT"` + código + descrição | grava na farmácia |
| Serviço, Sacos, Outros (lista fechada) | `eticoNett: null`, `eticoNettOutraCategoria: true` + código + descrição | retira só a classificação **automática** (fica SEM) |
| código órfão, descrição vazia/desconhecida/ambígua, lookup em falta | `eticoNett: null` | aviso; **não** altera |
| artigo sem código, ou instalação sem `Stocks.Etico_NETT` | (omitidos) | não toca |

Classificação marcada como manual no SaaS nunca é substituída nem retirada.
