# Classificação ERP dos produtos (Ético, NETT, Serviço, Genérico) — rev97

Referência técnica: `docs/spharm-erp-canonical-mapping.md` § 13. Esta nota é operacional: ordem de instalação,
compatibilidade e rollback.

## Estado (o que está e o que não está provado)

- Só **Genérico** tem coluna conhecida (`dbo.Stocks.[Generico]`).
- **Ético, NETT e Serviço**: nenhum nome de coluna do ERP está provado. O pipeline completo existe, mas fica
  **inativo até alguém configurar `classificacaoErp`** em `agent.config.json` de cada farmácia, depois de correr
  `classification-audit` e validar os valores com quem conhece o SPharm. Não foi corrido contra nenhum ERP real.
- Os serviços continuam fora do payload de produtos (`Processa_Stocks <> 0`); mapear "Serviço" só classifica os
  artigos que já chegam ao SaaS.

## Ordem de instalação (todos os tenants)

1. **Servidor** (código + migration `20261028120000_produto_classificacao_erp`, aplicada a todos os tenants por
   `tenancy:migrate-all`). A migration é aditiva (7 colunas, `NULL` / `DEFAULT false`); o código novo não precisa
   de agent novo e a UI mostra "—" até haver dados.
2. **Agent rev97** nas farmácias (publicação à parte). Sem `classificacaoErp` só passa a enviar `genericoErp`
   (tri-estado de `Stocks.[Generico]`).
3. Por farmácia: `run-classification-audit.bat` → validar → preencher `classificacaoErp` → `daily-sync-dry-run` /
   `bootstrap-dry-run` (conferir sim/não/desconhecido) → sync real.

Ordem inversa (agent rev97 antes do servidor): o servidor antigo ignora os campos novos (nenhuma validação estrita
do corpo); nada se perde, só não é gravado até o servidor ser atualizado e o agent reenviar (o reenvio é idempotente).
Se o servidor tiver o código mas a migration ainda não estiver aplicada a um tenant, o passo da classificação falha
com mensagem em `classificacaoErp.erro` (visível no ecrã do agent) e **o resto do lote é gravado** — aplicar a
migration e reenviar.

## Compatibilidade

- Agent antigo + servidor novo: sem chaves novas → nada é gravado nem apagado (ausente ≠ `false`).
- `flagGenerico` mantém exatamente a semântica anterior. `genericoErp` é independente.
- Respostas do endpoint só ganham `classificacaoErp` quando o lote traz campos.
- Designação (política da Silveirense) e fabricante não são tocados por este passo.

## Rollback

- **Código** (voltar ao servidor/agent anterior): seguro a qualquer momento. As colunas novas são `NULL`/`DEFAULT`
  e a versão anterior nem as seleciona (as queries de Produto usam listas explícitas ou ignoram colunas extra); os
  agents antigos continuam a funcionar.
- **Migration**: não é preciso revertê-la. Depois de haver dados, `DROP COLUMN` apagaria a classificação guardada
  (Ético/NETT/Serviço/Genérico tri-estado, origem, conflito) — informação que só o ERP volta a dar após novo envio
  com o mapeamento. Preferir deixar as colunas; para "desligar", remover `classificacaoErp` do `agent.config.json`
  (o servidor mantém o último valor conhecido, não o apaga).
- Para limpar valores de uma farmácia que foi mal mapeada: corrigir o mapeamento e reenviar o catálogo
  (`products-upload`); `false` e `null` explícitos corrigem os valores. Campos em `camposManuais` nunca são sobrepostos.

## Verificação

```
npx tsx scripts/tests/test-classificacao-erp-db.ts     # PostgreSQL descartável (TEST_PG_ADMIN_URL)
npx tsx agent/src/classificacao-erp.test.ts
```
