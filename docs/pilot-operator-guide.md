# SPharm.MT — Guia do Operador

Versão de bolso. Imprimir e ter à mão.

---

## O que está instalado no teu PC

| Componente | Onde | O que faz |
|---|---|---|
| Agente SPharm.MT | `C:\spharmmt\agent\` | Liga ao SQL Server da farmácia (read-only) e envia dados ao SaaS |
| `agent.config.json` | mesma pasta | Credenciais + endpoints. **Não editar a não ser com instruções** |
| Task Scheduler task | "SPharm.MT — Daily Pipeline" | Corre o agente todos os dias às 03:00 automaticamente |
| Logs | `C:\spharmmt\agent\logs\` | Histórico do que correu, dia a dia |

---

## O que vês todos os dias

Não precisas de fazer nada. O agente corre sozinho às 03:00 e envia
os dados de **ontem** para o SaaS. De manhã podes confirmar abrindo
o navegador em:

```
https://<endereço-do-saas>/relatorios/vendas-mensais
https://<endereço-do-saas>/analise-operacional
```

Devem mostrar o mês corrente com os dados actualizados.

---

## Quando avisar o admin

Avisa **imediatamente** se:

- O PC esteve **desligado** durante mais de 24h
- O SQL Server da farmácia **deixou de arrancar** ou está em manutenção
- A internet do PC esteve em baixo a noite/madrugada (entre 02:30 e 04:00)
- Recebeste alerta visual no Task Scheduler ("Last Run Result" não é 0)

Avisa **no próprio dia** se:

- O relatório mensal aparece vazio (sem produtos)
- Os números do mês têm valores estranhos (negativos, zeros em massa)
- O ecrã `/admin/pipeline` mostra um erro vermelho

Avisa **na semana seguinte** se:

- Os candidatos a ruptura/excesso parecem desfasados da realidade
- Há produtos sempre presentes em "Stock negativo" ou "Sem stockMin/Max"

---

## Comandos de diagnose (se admin pedir)

Tudo na pasta `C:\spharmmt\agent\`. Duplo-click no .bat correspondente.

| Ficheiro | Quando usar |
|---|---|
| `run-health.bat` | "O agente está vivo?" — testa conexão SQL + SaaS |
| `run-test-connection.bat` | Mais detalhe da ligação |
| `run-daily-pipeline-auto.bat` | Forçar o pipeline manualmente (igual ao Task Scheduler) |
| `run-daily-sync-dry-run.bat` | Ver o que **vai** ser enviado sem enviar (pergunta data) |

Resultado é mostrado no ecrã + escrito em `logs\`.

---

## O que NÃO fazer

- ❌ **Não apagar nada** em `C:\spharmmt\agent\`
- ❌ **Não editar** `agent.config.json` (contém credenciais)
- ❌ **Não correr** dois pipelines ao mesmo tempo (já há um lockfile,
  mas evita)
- ❌ **Não desligar o PC à noite**. O agente precisa dele ligado às
  03:00.
- ❌ **Não mover** a pasta de `C:\spharmmt\agent\` para outro sítio
  sem avisar o admin

---

## Quando há actualização do agente

O admin avisa por email/telefone. Tipicamente:

1. Recebes um ZIP novo (`SPharmMT-Agent-YYYY-MM-DD-revN.zip`)
2. Extrair em `C:\Temp\` (qualquer pasta temporária)
3. **Copiar** o teu `agent.config.json` e a pasta `logs\` actuais
4. **Apagar** `C:\spharmmt\agent\` antiga
5. **Mover** a nova pasta extraída para `C:\spharmmt\agent\`
6. **Restaurar** o `agent.config.json` e os `logs\`
7. Right-click → Run na task do Task Scheduler para confirmar

Em alternativa: pedir ao admin para fazer remoto via TeamViewer.

---

## Contactos

- **Admin SPharm.MT:** [preencher nome + telefone + email]
- **Hora preferida para chamadas:** [preencher]
- **Canal alternativo (Slack/Teams):** [preencher]

---

## Histórico de versões do agente

| Data | Versão (rev) | Notas |
|---|---|---|
| 2026-05-14 | rev18 | **Correcção crítica**: removido uso de `CodCNPEM` para lookup de produto (é Código Nacional Para Equivalência Medicamentosa — grupo homogéneo, partilhado por múltiplos produtos). Novo probe `run-inspect-product-identifiers.bat` para identificar a coluna real do CNP em `dbo.Stocks`. Campo `productLookupColumn` agora obrigatório em `ordersInsert`; `CodCNPEM` é rejeitado em 3 camadas (config, schema probe, lookup). Match ambíguo (>1 produto) também bloqueia. Modo `insert` permanece bloqueado até operador validar a coluna correcta. |
| 2026-05-14 | rev17 | **Correcção crítica**: removido uso de `VVM_ID` para idempotência (é Via Verde do Medicamento, escrever ali era semanticamente errado). Idempotência agora vive em tabela auxiliar `dbo.SPharmMT_OrderWriteLog` (criada pelo novo `run-setup-orders-write-log.bat`). Modo `insert` bloqueado até tabela existir. Campo `idempotencyColumn` removido do config. |
| 2026-05-14 | rev16 | Adicionado `run-export-orders-auto.bat` (Task Scheduler: log file + exit code, sem prompts) e `run-export-orders-once.bat` (manual com pause). Summary do `export-orders` enriquecido: `pulled / inserted / idempotent / acked / failed`. Aviso explícito quando `ordersWriteMode=stub`. |
| 2026-05-14 | rev15 | `writeInsert` real implementado (INSERT transaccional em `dbo.Encomendas` + `dbo.[Encomendas Detalhe]`, idempotente via coluna ERP — **substituído em rev17**). Adicionado `run-test-order-write.bat`. Secção `ordersInsert` em `agent.config.json` exigida quando `ordersWriteMode=insert`. |
| 2026-05-14 | rev14 | Adicionado `run-inspect-orders-schema.bat` (probe read-only ao schema das encomendas SPharm; gera `inspection.md`). NÃO activa escrita real. |
| 2026-05-14 | rev13 | Adicionado daily-pipeline + auto-bat para Task Scheduler |
| 2026-05-14 | rev12 | Adicionado processaStocks no payload de vendas |
| 2026-05-14 | rev11 | Adicionado inspect-codigoid para diagnose de orphans |
| 2026-05-13 | rev9-10 | Bootstrap + daily-sync iniciais |

## rev14 — inspecção do schema de encomendas

Sequência obrigatória no PC da farmácia:

1. Extrair `SPharmMT-Agent-2026-05-14-rev14.zip` para `C:\spharmmt\agent\`
2. Copiar `agent.config.example.json` → `agent.config.json` e editar credenciais SQL Server
3. **Duplo-clique em `run-test-connection.bat`** — confirma que o agent fala com o SQL Server + SaaS
4. **Duplo-clique em `run-inspect-orders-schema.bat`** — probe read-only às tabelas de encomendas
5. Enviar `output\orders-schema-<data>\inspection.md` ao admin SPharm.MT

**O que o BAT faz:**
- Lê metadata (colunas, PKs, FKs, índices, datas) de `dbo.Encomendas`, `dbo.Encomendas Detalhe`, `dbo.EncomendasFaltas`, `dbo.Encomendas_Prepara`, `dbo.Fornecedores`, `dbo.Stocks`
- Lê TOP 5 amostras (read-only)
- Auto-descobre variantes locais via `LIKE %encomenda%`
- Gera `inspection.md` com a estrutura completa + uma proposta DRAFT de SQL INSERT transaccional

**O que o BAT NÃO faz:**
- Não escreve nada no SPharm
- Não envia nada para a SaaS
- Não activa o modo `insert` do agent (continua em `stub` por contracto)

A escrita real de encomendas no SPharm só será implementada depois do admin analisar o `inspection.md` recebido.

## rev15 — activação do modo insert (escrita real)

Pré-requisito: `inspection.md` da rev14 validado pelo admin SPharm.

### 1. Permissões SQL Server

O SQL login usado pelo agent precisa de upgrade. Opções:

- **Simples (não recomendado em produção)**: `ALTER ROLE db_datawriter ADD MEMBER [spharm_agent]`. Concede escrita em toda a BD.
- **Granular (recomendado)**: conceder apenas INSERT + SELECT em duas tabelas:
  ```sql
  GRANT SELECT, INSERT ON [dbo].[Encomendas]          TO [spharm_agent];
  GRANT SELECT, INSERT ON [dbo].[Encomendas Detalhe]  TO [spharm_agent];
  GRANT SELECT          ON [dbo].[Stocks]             TO [spharm_agent];  -- já existe
  GRANT VIEW DEFINITION ON SCHEMA::dbo                TO [spharm_agent];  -- para sys.columns probe
  ```

### 2. Identificar coluna do CNP em `dbo.Stocks` (rev18+)

**OBRIGATÓRIO antes do primeiro INSERT.** `CodCNPEM` **NÃO é o CNP** — é Código Nacional Para Equivalência Medicamentosa (grupo homogéneo). Múltiplos produtos diferentes partilham o mesmo `CodCNPEM`. Usar essa coluna para lookup de linha de encomenda **matcha produto errado**.

Duplo-clique em **`run-inspect-product-identifiers.bat`**:

- Lista todas as colunas de `dbo.Stocks` cujo nome contém `cnp`, `codigo`, `cnpem`, `barras` ou `ean`
- Para cada uma, testa 4 CNPs conhecidos (`6433359`, `5771464`, `9754119`, `8070409`)
- Reporta match único / ambíguo / sem match por coluna
- Sugere a coluna provável (match único em todos os CNPs)
- Markdown em `output\product-identifiers-<data>\inspection.md`

Para CNPs alternativos:
```
node.exe agent.cjs inspect-product-identifiers --cnps "1234567,8901234"
```

Operador **valida visualmente** a sugestão e configura em `agent.config.json`:
```jsonc
"ordersInsert": {
  ...,
  "productLookupColumn": "Codigo"   // exemplo — confirmar com inspect
}
```

**Defesas em 3 camadas contra CodCNPEM:**
1. `loadConfig` rejeita `productLookupColumn = "CodCNPEM"` (case-insensitive)
2. `getInsertSchema` rejeita mesmo se passar pelo config (segunda linha)
3. `lookupCodigoIdAndPrices` rejeita match ambíguo (>1 produto) — apanha qualquer outra coluna que seja agrupadora

### 3. Criar tabela auxiliar de idempotência (rev17+)

**OBRIGATÓRIO antes do primeiro INSERT.** O agent recusa correr em `ordersWriteMode=insert` se a tabela `dbo.SPharmMT_OrderWriteLog` não existir.

Duplo-clique em **`run-setup-orders-write-log.bat`**. SQL idempotente:

```sql
IF OBJECT_ID('dbo.SPharmMT_OrderWriteLog', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.SPharmMT_OrderWriteLog (
        outboxId    varchar(32) NOT NULL,
        encomendaId int         NOT NULL,
        createdAt   datetime    NOT NULL DEFAULT GETDATE(),
        payloadHash varchar(64) NULL,
        status      varchar(20) NOT NULL DEFAULT 'created',
        CONSTRAINT PK_SPharmMT_OrderWriteLog PRIMARY KEY CLUSTERED (outboxId)
    );
END
```

A tabela é **exclusivamente nossa** — não pertence ao schema SPharm e não interfere com nenhum fluxo existente (incluindo Via Verde do Medicamento / `VVM_ID`, que **NÃO** é tocada por este caminho).

Se o SQL login não tiver permissão `CREATE TABLE`, o BAT imprime o SQL para o DBA executar manualmente via SSMS. Após criar, voltar a correr o BAT para confirmar.

### 4. Editar `agent.config.json`

Mudar `ordersWriteMode` para `"insert"` e preencher secção `ordersInsert`:

```jsonc
"options": {
  "ordersWriteMode": "insert"
},
"ordersInsert": {
  "userIdForInsert":         25,        // User ID SPharm existente
  "fornecedorIdForOrders":   416,       // Fornecedor default (validar em SPharm UI)
  "armazemId":               1,         // Default observado
  "tipoEncomendaId":         2,         // Default observado
  "encomendaSituacaoInitial": "A",      // 'A' = Aberta (confirmar localmente)
  "productLookupColumn":     "Codigo"   // CONFIRMAR com inspect-product-identifiers. NUNCA "CodCNPEM".
}
```

**Nota:** o campo `idempotencyColumn` foi REMOVIDO em rev17. Se ainda existir no config antigo, o agent emite warning mas ignora — idempotência vive na tabela auxiliar, não em nenhuma coluna do SPharm.

### 5. Smoke test (sem efeito permanente)

`run-test-order-write.bat`:

1. Operador escolhe CNP de um produto existente em `dbo.Stocks`
2. Escolhe quantidade (inteiro)
3. Escolhe modo:
   - **1 = DRY-RUN** (default) → executa INSERT dentro de transacção e faz ROLLBACK. Nada visível em SPharm. Valida que o caminho funciona end-to-end.
   - **2 = COMMIT** → escrita real, pede confirmação "CONFIRMO". Encomenda fica visível em SPharm UI imediatamente.

Se `dbo.SPharmMT_OrderWriteLog` não existir, o teste falha com mensagem clara apontando para `run-setup-orders-write-log.bat`.

### 6. Validação operacional

Depois de um `--commit` bem-sucedido, o operador SPharm valida:

- A encomenda aparece na lista de encomendas pendentes em SPharm UI
- 1 linha presente com o CNP escolhido + quantidade
- Estado inicial = `encomendaSituacaoInitial` da config
- Re-run com mesmo `--outbox-id` devolve `source=idempotent` (mesma encomenda ID; sem duplicação)

### 7. Activação em produção

Depois da validação:

1. `ordersWriteMode=insert` fica em produção (já está no config)
2. Agendar **`run-export-orders-auto.bat`** no Task Scheduler (intervalo recomendado: a cada 5-10 min). Sem prompts, sem janela visível, log em `logs\export-orders-<YYYY-MM-DD>.log`, exit code propagado. Wrapper introduzido em **rev16** — não usar `node.exe agent.cjs export-orders` directamente.

### Rollback automático em erro

Qualquer falha no caminho de INSERT (CNP inexistente, FK violation, deadlock, timeout, permission denied) aciona `tx.rollback()` antes da exception propagar. O outbox SaaS recebe `nack(retryable=true)` ou `nack(retryable=false)` consoante o tipo de erro:

- **retryable=true**: deadlock (1205), timeout (-2), network (ECONNRESET/ECONNREFUSED/ETIMEOUT/ESOCKET). A SaaS recoloca em PENDENTE com backoff.
- **retryable=false**: CNP não encontrado, FK violation (fornecedor/user/armazém inexistente), schema mismatch. A SaaS marca FALHADO para triagem humana.

## rev16 — wrappers operacionais do export-orders

### `run-export-orders-auto.bat` (Task Scheduler)

Sem prompts. Designed para `schtasks` ou Task Scheduler UI.

Comportamento:
1. Calcula `YYYY-MM-DD` via `node.exe` (independente do locale do Windows)
2. Cria `logs/` se não existir
3. Append `=== START ===` no `logs/export-orders-<data>.log`
4. Corre `node.exe agent.cjs export-orders` com stdout+stderr → log
5. Append `=== END (exit=N) ===`
6. Se `EXIT != 0`, ecoa erro para stdout (Task Scheduler regista)
7. `exit /b %EXIT%` — Task Scheduler vê o código real

Configuração típica no Task Scheduler:
- **Trigger**: At startup + every 5 minutes for 1 day, repeat indefinitely
- **Action**: Start a program → `C:\spharmmt\agent\run-export-orders-auto.bat`
- **Conditions**: desmarcar "Start the task only if the computer is on AC power"
- **Settings**: "If the task is already running, then the following rule applies: Do not start a new instance"

### `run-export-orders-once.bat` (manual)

Interactivo. `pause` antes e depois. Output em tempo real. Log gravado mas só com markers de START/END (não duplica o output do agent — operador vê na janela).

Quando usar:
- Primeira validação após configurar `ordersWriteMode=insert`
- Debug de uma encomenda que falhou na corrida automática
- Verificar manualmente o output do summary antes de confiar no Task Scheduler

### Summary impresso no fim de cada corrida

```
═══════════════════════════════════════════════════════════════
Resumo
═══════════════════════════════════════════════════════════════
  mode         : insert
  pulled       : 5
  inserted     : 3     (writes novos no SPharm)
  idempotent   : 1     (outboxId já existia — sem novo INSERT)
  acked        : 4     (SaaS marcou EXPORTADO)
  nacked       : 1     (SaaS marcou FALHADO ou re-queued)
  failed       : 0     (erros sem nack — lease expira e reentrega)
═══════════════════════════════════════════════════════════════
```

Em modo `stub`, aparece também:
```
⚠  ATENÇÃO: ordersWriteMode=stub — NADA foi escrito no SPharm.
   Apenas ficheiros JSON em <outputDir>/orders-export/<YYYY-MM-DD>/.
```

### Limitações conhecidas v1

- **Mapeamento Fornecedor SaaS↔SPharm**: 1 fornecedor por farmácia via config. Encomendas multi-fornecedor exigirão uma tabela de mapping no SaaS (v2).
- **NEncomenda**: calculado `MAX([NEncomenda]) + 1` sob `TABLOCKX HOLDLOCK`. Seguro para single-instance agent + operador concorrente em SPharm UI. NÃO suporta múltiplos agents a escrever simultaneamente para o mesmo SPharm.
- **Sem stored procedure**: INSERT directo. Se o SPharm tiver SP `usp_CriarEncomenda` com regras de negócio, este caminho NÃO as dispara. Validar com admin SPharm no smoke test.
- **`Encomenda ID` deve ser IDENTITY**: o agent verifica em runtime via `sys.columns`. Se não for, falha cedo com mensagem clara — não tenta inventar IDs.
- **Idempotência: tabela auxiliar separada**: `dbo.SPharmMT_OrderWriteLog` tem de existir antes do primeiro INSERT (criada por `run-setup-orders-write-log.bat`). NENHUMA coluna do SPharm é usada para tracking — `VVM_ID` (Via Verde do Medicamento), `Observacoes`, ou qualquer outra coluna operacional ficam intactas.
