# Dashboard — Internal Substitution tile (Fase A)

**Data:** 2026-05-11
**Âmbito:** tornar visível no dashboard executivo o valor de
substituição interna same-CNP já detectado (Fase B). Card compacto,
sem gráfico, CTA para `/encomendas`. Sem writes, sem novo fluxo.

---

## 1. Executive summary

Adicionado 4º card à row de optimização da dashboard (`/dashboard`):
**"Encomendas evitáveis · Substituição interna same-CNP"**. Mostra
em estilo premium-compacto:

- Compra evitável total (€)
- Unidades transferíveis
- Número de oportunidades
- Top 3 oportunidades (com CTA para `/encomendas`)
- Empty state quando count=0: *"Sem oportunidades internas
  detectadas"*

Dados servidos pelo mesmo path canónico que `/encomendas`
(`getInternalSubstitutionsData` com thresholds rupture<15,
excess>30, target=15, reserve=14). **Zero duplicação de cálculo.**

**Reutilizando os números medidos hoje** (commit Fase B `c5574d6`):
o card mostraria **2 844 €** evitáveis · **433 un.** transferíveis ·
**103 oportunidades**, com o top-1 a ser Forxiga 10 Mg em 906,83 €
(Principal → Castelo).

156 testes verdes (sem regressão). `tsc --noEmit` limpo.

---

## 2. Alterações

### 2.1 `lib/dashboard.ts`

| Mudança | Efeito |
|---|---|
| Import `getInternalSubstitutionsData` | Reutiliza loader server-only existente |
| Novo type `DashboardInternalSubstitution` | Shape de cada top item |
| Novo bloco `internalSubstitution` em `DashboardData` | `count`, `units`, `avoidedPurchaseValueEur`, `top[]` |
| `Promise.all` estendido | `getInternalSubstitutionsData(...)` chamado em paralelo com loaders existentes — sem aumento de latência sequencial |
| Assembly do bloco | top 3 já vem ordenado por € desc no detector |

Thresholds usados — espelham os de `/encomendas` (Fase B):

```ts
getInternalSubstitutionsData({
  ruptureThresholdDays: 15,  // destino abaixo de cobertura-alvo
  excessThresholdDays: 30,   // source com excesso confortável
  targetCoverageDays: 15,    // alinhado com encomenda
  reserveDaysSource: 14,     // mantém source > 14d
  minTransferableQty: 1,
})
```

### 2.2 `components/dashboard/dashboard-sections.tsx`

Novo `InternalSubstitutionCard` (~115 linhas) com:
- Header: ícone `Repeat2`, título "Encomendas evitáveis", hint
  "Substituição interna same-CNP"
- KPI principal: valor € evitável (cyan, link para `/encomendas`)
- KPI secundário: contagem de oportunidades
- Detalhe colapsível: top 3 com `farmaciaOrigem → farmaciaDestino`,
  qty, cobertura, € evitável por linha
- CTA `SeeAllLink` para `/encomendas` quando count > 3

Estilos consistentes com `TransferenciasCard` e `ExcessosCard` —
mesma estrutura `CardShell` + `CollapsibleDetail`. Cores em
`cyan-*` para distinguir do tom `emerald` (Transferências) e
`amber` (Excessos).

Empty state: KPI mostra "0 €" + "Sem oportunidades internas
detectadas" + lista vazia com mesma mensagem. **Sem mock data,
nunca.**

### 2.3 `app/dashboard/page.tsx`

Grid de cartões compactos passou de `md:grid-cols-3` para
`md:grid-cols-2 xl:grid-cols-4` para acomodar 4º card sem
amontoar:

```tsx
<section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
  <CriticalAlertsCard data={data.criticalAlerts} />
  <TransferenciasCard data={data.optimization} />
  <ExcessosCard data={data.excess} />
  <InternalSubstitutionCard data={data.internalSubstitution} />
</section>
```

Em viewports < md, todos ficam empilhados (já era o
comportamento). Em md-lg ficam em 2 × 2. Em xl+ ficam em 1 × 4.

---

## 3. Dados que aparecem no card (probe Fase B, 2026-05-11)

| Campo | Valor |
|---|---:|
| `count` | **103** oportunidades |
| `units` | **433** unidades transferíveis |
| `avoidedPurchaseValueEur` | **2 844,27 €** |
| `top[0]` | Forxiga 10 Mg · Principal→Castelo · 29 un. · 906,83 € · cov 33d→6d |
| `top[1]` | Mounjaro 2.5 Mg · Principal→Castelo · 2 un. · 317,82 € · cov 103d→10d |
| `top[2]` | Edistride 10 Mg · Principal→Castelo · 3 un. · 95,67 € · cov 42d→12d |

> **Forxiga sozinho representa 32% do total de € evitáveis.**

---

## 4. Server/client boundary

- `lib/dashboard.ts` continua marcado `import "server-only"`.
- `getInternalSubstitutionsData` é server-only (já era).
- `DashboardData` (type) é importado em
  `components/dashboard/dashboard-sections.tsx` mas só o
  **type** atravessa — zero código de runtime do server vai para
  o bundle do client. ✓
- Nenhum acesso a Prisma no client. ✓
- Empty state e tons de cor são responsabilidade pura de UI; dados
  vêm pronto-a-mostrar do server. ✓

---

## 5. Tests / typecheck

| Suite | Resultado |
|---|---|
| `test-operational-metrics.ts` (86) | ✅ |
| `test-internal-substitution.ts` (22) | ✅ |
| `test-encomendas-substitution.ts` (15) | ✅ |
| `test-ipf-freshness.ts` (33) | ✅ |
| **Total** | **156 verdes** |
| `tsc --noEmit` | ✅ limpo |

Nenhum teste novo desta fase porque a lógica é 100% reutilizada
de componentes já testados (`findInternalSubstitutions`,
`getInternalSubstitutionsData`, dual-read de
`lib/transferencias-data.ts`). O contrato cobre:

- Thresholds encomenda vs default (`test-encomendas-substitution.ts`)
- Comportamento da fórmula avgDaily/coverage
  (`test-operational-metrics.ts`)
- Política de ordenação por € desc
  (`test-internal-substitution.ts`)

Para validação visual do card: smoke manual abrindo `/dashboard`
em dev. Sem suite de UI nesta passagem.

---

## 6. Regras respeitadas

| Regra | Estado |
|---|---|
| Sem writes | ✅ |
| Sem novo fluxo de transferência | ✅ — só CTA para `/encomendas` |
| Sem alterar dashboard geral além deste card | ✅ — só o grid passou de 3 cols para 2/4 |
| Sem mock data | ✅ — empty state textual, sem placeholders |
| Reutiliza `getInternalSubstitutionsData` | ✅ — zero duplicação de cálculo |
| Sem Prisma em client | ✅ — só type `DashboardData` atravessa |
| Preservar server/client boundaries | ✅ — `lib/dashboard.ts` mantém `import "server-only"` |
| Empty state legível | ✅ — "Sem oportunidades internas detectadas" |

---

## 7. Decisão pendente

Recommendation técnica (não decisão): após este checkpoint, há 2
caminhos naturais:

**A. DCI-equivalente.** Estender o detector para considerar
substitutos genéricos com mesmo `dci + dosagem + formaFarmaceutica`.
Maior universo de oportunidades, requer validação clínica.
Esforço: ~1,5-2 dias.

**B. Scheduler real.** Activar Vercel Cron / daemon externo para
correr `scripts/jobs/refresh-ipf.ts` diariamente, com alerta
operacional baseado em `scripts/ipf-health.ts`. Esforço:
~0,5-1 dia. Requer decisão sobre infra hosting.

Não inicio nenhuma sem aprovação.

---

## 8. Comandos de validação

```bash
# Typecheck
npx tsc --noEmit

# Testes (156 verdes)
npx tsx scripts/tests/test-operational-metrics.ts
npx tsx scripts/tests/test-internal-substitution.ts
npx tsx scripts/tests/test-encomendas-substitution.ts
npx tsx scripts/tests/test-ipf-freshness.ts

# Probe dos mesmos dados que o card vai mostrar
npx tsx scripts/probe-encomendas-substitution.ts --top=3

# Render manual: abrir /dashboard em dev e validar o 4º card.
```

---

_Card compacto · zero gráfico · CTA único para `/encomendas` ·
mesma fonte canónica do badge em `/encomendas` (Fase B) · empty
state legível · sem mock._
