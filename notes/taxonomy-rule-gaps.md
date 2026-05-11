# Taxonomy Rule Gaps — INFOMED reprocess validation

Catálogo de prefixos ATC que actualmente caem em "Outros Medicamentos" por
desenho ou por falta de regra. Compilado a partir do reprocess live do
catálogo (2026-05-09) após o crawl INFOMED produzir 1153 mappings com
ATC populado.

Origem do diagnóstico: 48 produtos sincronizados continuam classificados
como "Outros Medicamentos" apesar de terem ATC válido. Distribuídos por
prefixo ATC abaixo.

## Estado actual (2026-05-09)

| Prefixo ATC | N produtos | Categoria clínica | Estado |
|---|---:|---|---|
| J02 | 12 | Antifúngicos sistémicos | known gap (by design) |
| **H02** | **10** | **Corticoides sistémicos** | **NEW gap descoberto** |
| J01 | 10 | Antibióticos sistémicos | known gap (by design) |
| H03 | 5 | Hormonas tiróide / antitiroideus | known gap (by design) |
| **P02** | **3** | **Antiparasitários intestinais** | **NEW gap descoberto** |
| J05 | 3 | Antivirais sistémicos | known gap (by design) |
| A11 | 2 | Vitaminas | known gap (by design) |
| M05 | 2 | Bifosfonatos / doenças ósseas | known gap (by design) |
| N01 | 1 | Anestésicos | known gap (by design) |

Total rule gaps activos: 48 produtos.

## Why "by design"?

Estes prefixos não têm nivel2 dedicado em `lib/catalog-taxonomy.ts` para
MEDICAMENTOS porque a taxonomia comercial actual (focada em retalho de
farmácia) não distingue:

- Anti-infecciosos sistémicos (J01/J02/J05 — antibióticos, antifúngicos,
  antivirais orais/IV) — não há "Antibióticos" como categoria comercial.
- Hormonas sistémicas (H02 corticoides + H03 tiróide) — sem
  "Hormonais" dedicado.
- Bifosfonatos (M05) — não há "Saúde Óssea" em MEDICAMENTOS.
- Anestésicos (N01) — uso hospitalar, não retalho.
- Antiparasitários intestinais (P02 — vermífugos) — agrupados com J pelos
  prescritores, mas separados na ATC.
- Vitaminas em forma farmacêutica (A11) — vão para SUPLEMENTOS na maioria
  dos casos; quando codificados como MEDICAMENTO, ficam em Outros.

## Iteração futura — opções

1. **Adicionar nivel2 dedicado** para grupos clinicamente relevantes:
   "Antibióticos", "Antifúngicos / Antivirais", "Hormonais (Tiróide /
   Corticoides)", "Saúde Óssea". Implica migration `Classificacao` +
   actualizar `lib/catalog-taxonomy.ts` + mapping em
   `ATC_PREFIX_TO_NIVEL2`.
2. **Mapear para nivel2 existente menos preciso** (ex: H02 →
   "Dermatológicos" porque corticoides têm forte uso cutâneo) — perde
   precisão clínica mas reduz "Outros Medicamentos".
3. **Manter como está** — usar "Outros Medicamentos" como bucket honesto
   para classes sem categoria comercial. Filtros UI podem mostrar ATC
   como facet secundário.

A escolha depende do produto/UX que está a ser construído. Sem decisão
do owner do produto, manter como está.
