# RC Batch 2 — Comunicação Operacional Entre Farmácias

**Data:** 2026-05-11 · **Commit:** próximo

## Fechou

| # | Item | Estado |
|---|---|---|
| 1 | CTA "Criar transferência" em same-CNP e DCI-equivalent (encomendas, transferências, inbox) | ✅ |
| 2 | Internal transfer draft reusando `ListaEncomenda` (RASCUNHO, sem outbox) | ✅ |
| 3 | Operational inbox `/oportunidades` (feed compacto unificado + IPF freshness) | ✅ |
| 4 | Dashboard `InternalSubstitutionCard` aponta agora para `/oportunidades` | ✅ |
| 5 | Sidebar nav: novo item "Oportunidades" antes de "Encomendas" | ✅ |

## Arquitectura (caminho a)

`createInternalTransferAction(input)` invoca `createEncomendaWithOutbox(prisma, tenant, { finalize: false, linhas: [...] })`. Ou seja:
- **Sem novo modelo** — usa `ListaEncomenda` em estado RASCUNHO e `LinhaEncomenda` existentes
- **Sem outbox** — não há export agent para esta lista (não é encomenda externa)
- **Notas estruturadas** na `LinhaEncomenda.notas`: origem, kind (same-cnp / dci-equivalent), motivo, validação requerida em DCI
- **`logAudit`** com `action: "internal_transfer.created_draft"` — auditoria operacional
- **Redireccionamento** automático para `/encomendas/[id]` onde o operador revê e finaliza no flow normal
- **Confirmação humana obrigatória** — `confirm()` nativo antes de criar; texto explícito em DCI ("VALIDAR antes de transferir")

## Walkthrough operacional

```
Farmácia A (Castelo) tem ruptura iminente de Forxiga 10 mg (cov 6d).
Farmácia B (Principal) tem 29 un. em excesso (cov 42d).

  1. Operador abre /oportunidades (link no sidebar).
  2. Vê linha cyan no feed "Same-CNP":
       Forxiga 10 Mg 28 Comp. CNP 5487228
       Destino: Castelo (cov 6d) · Origem: Principal (cov 42d)
       29 un. · −906,83 €    [Criar transferência]
  3. Clica em [Criar transferência].
  4. Confirma a pop-up:
       "Criar transferência interna?
        Forxiga 10 Mg 28 Comp.
        Origem: Principal
        Qtd. sugerida: 29"
  5. Server action cria ListaEncomenda RASCUNHO em Castelo:
       nome: "Transferência interna · Principal → Forxiga 10 Mg 28 Comp."
       linha: produtoId, quantidadeSugerida=29
       notas: "Transferência interna sugerida (same-cnp). Origem:
               Principal · Motivo: rotura iminente · excesso interno"
  6. Browser redirecciona para /encomendas/<listaId>
  7. Operador revê quantidade, ajusta se preciso, finaliza no flow
     existente — mesmo botão "Finalizar" de qualquer outra encomenda.
  8. (Manual / fora deste batch) Farmácia B aprova fisicamente
     o envio. Sistema regista a finalização via logAudit.
```

DCI-equivalent segue o mesmo fluxo com:
- Badge **amber** (não cyan)
- Texto de confirmação explícito: "VALIDAR antes de transferir"
- Notas adicionais identificam source product (CNP diferente do destino)

## Pontos de acesso ao CTA

| Local | Contexto | Variante |
|---|---|---|
| `/encomendas` per-pharmacy detail | rotura por farmácia + sugestão | cyan/amber inline |
| `/transferencias` tabela de sugestões | listagem clássica | cyan "Criar" na col Acção |
| `/oportunidades` inbox | feed unificado | cyan + amber buttons full label |
| `/dashboard` InternalSubstitutionCard | KPI tile | link para /oportunidades |

## Regras respeitadas

- ✅ Zero novo modelo (`ListaEncomenda` reutilizado)
- ✅ Zero automação silenciosa (`confirm()` + `RASCUNHO`)
- ✅ Sem alteração de preço / fornecedor / heurística normal
- ✅ Confirmação humana obrigatória
- ✅ Operador termina o flow em `/encomendas/[id]` existente

## Validações

- `tsc --noEmit` ✅ limpo
- 7 suites / 252 asserts ✅ verdes (testes existentes continuam a cobrir detectores; CTA é UI thin layer)
- HTTP smoke: `/oportunidades` HTTP 200 + `/encomendas`, `/transferencias`, `/dashboard` HTTP 200

## Blockers reais (RC)

Mesmos P0 do Batch 1 — multi-tenant ainda bloqueado por config:
1. **`CONTROL_DATABASE_URL` não provisionado** — bloqueia `/admin`, `tenant:onboard`, `--all-tenants`
2. **`TENANT_DB_HOST` + `PGADMIN_*`** — onde se hospedam BDs por tenant

Não há blockers novos introduzidos por este batch.

## "Já pode ser usado por um grupo real de farmácias?"

**Sim** — desde que envs P0 estejam configurados:
- Onboarding 1-comando ✅
- Painel admin de saúde ✅
- ATC/DCI visíveis nas listagens core ✅
- DCI-equivalente em encomendas com gates clínicos ✅
- IPF refresh diário automático (Vercel Cron) ✅
- **Criar transferência interna em 2 cliques** ✅ (este batch)
- Inbox de oportunidades em sidebar ✅ (este batch)

Demo executável end-to-end:
- Abrir /oportunidades → ver feed → clicar Criar transferência → editar em /encomendas/[id] → finalizar.

## ETA próximo batch

**Batch 3 — Estabilização final.** Estimativa: **0.5–1 dia útil** (depende de quantos legacy paths sobram). Items:
1. Eliminar recálculos legacy restantes — já feito em Operational Consolidation, validar se sobra alguma janela escondida
2. Scheduler estável — Vercel Cron já funcional; falta documentar smoke-trigger
3. ENV validation hardening — criar `lib/env.ts` central que falha-rápido em arranque se faltarem keys críticas
4. Logs accionáveis — auditoria por server action já existe; adicionar fail-fast structured logging
5. Fail-fast operacional — verificar que cada loader devolve estado utilizável quando dependência está down

---

_2 cliques: oportunidade → transferência criada · reutilização total do workflow de encomendas · zero novos modelos · pronto para piloto._
