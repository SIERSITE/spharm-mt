# Production freeze guardrails — piloto SPharm.MT

Política operacional efectiva durante a fase piloto (a partir de 2026-05-14).
Aplicável até decisão explícita de transição para a fase pós-piloto, com
revisão deste documento.

## Princípio

**Sem novos módulos durante o piloto.**

O piloto serve para validar em condições reais o que já está construído.
Funcionalidade nova introduz risco que não consegue ser absorvido enquanto
estamos a estabilizar primeiros clientes.

## O que PODE mudar sem autorização especial

Alterações que mantêm a forma do sistema e melhoram a sua robustez:

- **Bugfixes em código existente** (PR + descrição do bug + teste/passo de
  reprodução)
- **Mensagens de erro, logs e textos UI** (sem alterar lógica)
- **Documentação** (notes/, docs/, comentários inline)
- **Defaults de configuração** que se revelem inseguros (com nota no PR)
- **Adição de campos a logs / outputs já existentes** (e.g. enriquecer
  o summary do export-orders) — não muda a forma da resposta para clientes
- **Index Prisma para optimizar query lenta** (com `EXPLAIN ANALYZE` antes
  e depois no PR)
- **Permissões de SQL login do agent** (granular grants em vez de roles)

## O que NÃO pode mudar sem autorização explícita

Qualquer alteração desta lista exige discussão prévia + aprovação documentada
no PR pelo admin do piloto:

- **Schema da BD control plane ou tenant** — qualquer migration Prisma
- **Schema das tabelas SPharm escritas** (`dbo.Encomendas`,
  `dbo.[Encomendas Detalhe]`, `dbo.SPharmMT_OrderWriteLog`)
- **Conjunto de campos populados no INSERT do SPharm** — ver write
  contract em [agent/src/spharm-orders-writer.ts](../agent/src/spharm-orders-writer.ts)
- **Endpoints públicos** (`/api/ingest/*`, `/api/outbox/*`,
  `/api/admin/*`) — adicionar, remover ou mudar shape de resposta
- **Modelo de auth** — `withIntegrationAuth`, sessão, platform admin
- **Tenant resolution** — middleware, headers, fallback LEGACY_TENANT
- **Orquestração de pipeline** — daily-pipeline command, aggregate-month,
  ordem de fases, lockfile, healthchecks
- **Modelo de outbox** — schema OrderOutbox, lease TTL, ack/nack contract
- **Modo de escrita SPharm** — `ordersWriteMode` semantics, idempotência
- **Identificadores de produto** — `productLookupColumn` (escolha exige
  novo run de `inspect-product-identifiers` + validação operador)
- **Dependências runtime** — adicionar deps em `package.json`,
  actualizar versão major de Node/Prisma/Next
- **Novos workers/queues/websockets/serviços** — proibido durante o
  piloto. Trabalho assíncrono novo desenha-se pós-piloto

## Checklist — antes de qualquer migration Prisma

1. [ ] PR descreve o motivo (bug? requisito? optimização?)
2. [ ] Migration foi gerada com `prisma migrate dev` em ambiente local
3. [ ] Migration foi inspeccionada visualmente (não confiar cega em
       diff de schema)
4. [ ] Foi corrido `npm run tenancy:migrate-all` em staging contra
       tenant não-produtivo
5. [ ] Migration tem rollback documentado no PR (mesmo que seja "drop
       column", explícito)
6. [ ] Não introduz NOT NULL em coluna existente sem default (quebra
       deploys com rows pré-existentes)
7. [ ] Não renomeia/elimina coluna usada em código (grep antes)
8. [ ] Approval do admin do piloto antes do merge

## Checklist — antes de qualquer alteração ao agent

1. [ ] PR descreve impacto (read-only? escrita? config?)
2. [ ] `npx tsc --noEmit` clean em repo e em `agent/`
3. [ ] `npm run agent:package` corre sem erros
4. [ ] Se mexer no caminho de escrita: smoke test com
       `run-test-order-write.bat` em DRY-RUN + COMMIT contra demo-neon
5. [ ] AGENT_REV bumpado em `agent/build.mjs`
6. [ ] CHANGELOG / rev history em `docs/pilot-operator-guide.md`
       actualizado
7. [ ] Rollback documentado: como reverter à rev anterior
       (operador re-extrai ZIP rev N-1 e reinicia Task Scheduler)
8. [ ] ZIP da rev nova testado em pelo menos uma farmácia controlada
       antes de roll-out

## Checklist — antes de qualquer alteração ao SPharm write

Quaisquer mudanças em [agent/src/spharm-orders-writer.ts](../agent/src/spharm-orders-writer.ts)
que envolvam o conjunto de colunas escritas, lookup de produto, ou
contract de idempotência:

1. [ ] Operador SPharm confirma que a alteração é segura no contexto
       do ERP local (não há trigger ou regra de negócio implícita
       que dependa do comportamento antigo)
2. [ ] Write contract em `spharm-orders-writer.ts` actualizado para
       reflectir o novo conjunto de campos tocados / não-tocados
3. [ ] `inspect-orders-schema` re-corre se houver dúvida sobre
       schema-alvo
4. [ ] `inspect-product-identifiers` re-corre se mudar a coluna de
       lookup
5. [ ] DRY-RUN passa com payload representativo
6. [ ] COMMIT com `--outbox-id` controlado passa visualmente em SPharm
7. [ ] Re-run com mesmo `--outbox-id` devolve `source=recovered`
       (idempotência intacta)

## Rollback obrigatório antes de merge

Todo PR que toca em código de produção precisa de uma secção `## Rollback`
no corpo do PR, descrevendo concretamente:

- **Como reverter**: `git revert <sha>` + redeploy? Ou config flag?
  Ou downgrade de rev do ZIP?
- **Janela de exposição**: tempo máximo aceitável que o bug pode estar
  vivo antes do rollback
- **Quem decide**: nome ou role da pessoa que pode iniciar o rollback
- **Side effects do rollback**: encomendas já escritas ficam? Dados
  migrados perdem-se? Migrations Prisma têm `down`?

PRs sem secção Rollback são bloqueados em review.

## Kill switches disponíveis durante o piloto

Para corte rápido sem necessidade de deploy:

| Switch | Como activar | Efeito |
|---|---|---|
| Parar escrita real no SPharm | `agent.config.json` → `ordersWriteMode: "stub"` | Próximo run do auto BAT gera JSON em vez de INSERT. Encomendas em fila ficam no SaaS. |
| Parar daily-pipeline | Desactivar tarefa no Task Scheduler local | Ingestão pausa até reactivar; não há catch-up automático |
| Desligar feature flag | `FEATURE_<NAME>=0` no ambiente SaaS + redeploy | Ver `lib/feature-flags.ts` |
| Desactivar tenant | `npm run tenancy:deactivate -- --tenant <slug>` | Bloqueia logins + ingestão no tenant; agent perde auth |

## Revisão deste documento

Revisão obrigatória ao fim de:
- 30 dias de piloto (avaliar se o freeze pode ser parcialmente levantado)
- Qualquer incident de produção que envolva alteração ao freeze
- Decisão de transitar para fase pós-piloto

Última actualização: 2026-05-14 (rev21 freeze)
