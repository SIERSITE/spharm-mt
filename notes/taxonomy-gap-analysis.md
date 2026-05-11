# Taxonomy Gap Analysis — Fechar rule gaps ATC

**Data:** 2026-05-11
**Fase:** análise apenas (sem alterar mapper, taxonomia ou BD)
**Origem:** 48 produtos MEDICAMENTO classificados como "Outros Medicamentos"
apesar de terem `codigoATC` válido. Distribuídos por 9 prefixos ATC sem
regra no `ATC_PREFIX_TO_NIVEL2` actual.

## Resumo executivo

| Prefixo | N | Categoria clínica | Estado actual |
|---|---:|---|---|
| J02 | 12 | Antifúngicos sistémicos | known gap (sem categoria) |
| H02 | 10 | Corticoides sistémicos | **NEW** gap |
| J01 | 10 | Antibióticos sistémicos | known gap (sem categoria) |
| H03 | 5 | Hormonas tiróide | known gap (sem categoria) |
| J05 | 3 | Antivirais sistémicos | known gap (sem categoria) |
| P02 | 3 | Antiparasitários intestinais | **NEW** gap |
| A11 | 2 | Vitaminas (forma farmacêutica) | known gap |
| M05 | 2 | Bifosfonatos / saúde óssea | known gap |
| N01 | 1 | Anestésicos (tópicos) | known gap |
| **Total** | **48** | | |

## Taxonomia MEDICAMENTOS actual (referência)

15 nivel2 disponíveis hoje em `lib/catalog-taxonomy.ts:30`:

1. Analgésicos e Anti-inflamatórios
2. Constipação, Tosse e Gripe
3. Alergias
4. Sistema Digestivo
5. Sistema Nervoso
6. Cardiovascular
7. Diabetes
8. Dermatológicos
9. Oftálmicos
10. Otológicos
11. Ginecológicos
12. Urológicos
13. Respiratório
14. Antisséticos e Desinfetantes
15. Outros Medicamentos (catch-all)

## Análise por prefixo

### J01 — Antibióticos sistémicos (10)

**DCIs:** Amoxicilina (×3), Cefradina (×2), Azitromicina (×2), Flucloxacilina, Cefaclor, Clindamicina
**Formas:** Cápsula (×6), Pó suspensão oral (×2), Comprimido (×1+1)
**Exemplos:**
- 2532794 J01CA04 Amoxicilina · Amoxicilina Labesfal, 500 mg x 16 cáps
- 9577700 J01CA04 Amoxicilina · Cipamox, 1000 mg x 16 comp
- 8352112 J01CA04 Amoxicilina · Clamoxyl, 500 mg x 16 cáps
- 4666889 J01CF05 Flucloxacilina · Floxapen, 500 mg x 24 cáps
- 9540906 J01DB09 Cefradina · Cefradur, 1000 mg x 16 comp

**Nivel2 sugerido:** _categoria nova_ "Anti-infecciosos"
**Reusar existente:** _impossível com precisão_ — "Antisséticos e Desinfetantes" é tópico, não sistémico; mismatch semântico
**Impacto operacional:** alto — antibióticos são MSRM, identificáveis no balcão, importantes para gestão de stock e alertas
**Risco de criar:** baixo — categoria clinicamente reconhecida; pharmacists já pensam assim
**Overlap:** sem overlap com existentes

---

### J02 — Antifúngicos sistémicos (12)

**DCIs:** Fluconazol (×12, todos)
**Formas:** Cápsula (×12)
**Exemplos:**
- 8692806 J02AC01 · Diflucan 50 Mg 7 Cápsula
- 8692822 J02AC01 · Diflucan, 150 mg x 1 cáps
- 8692830 J02AC01 · Diflucan, 150 mg x 2 cáps
- 2846194 J02AC01 · FLUCONAZOL ALTER CAPS 150 MG X 2
- 2846798 J02AC01 · FLUCONAZOL SUPREMASE CAPS 150 MG X 2

**Nivel2 sugerido:** mesma categoria de J01 (anti-infecciosos sistémicos)
**Reusar existente:** "Dermatológicos" tem antifúngicos tópicos (D01) mas Fluconazol oral é diferente — mismatch
**Impacto operacional:** médio — Fluconazol oral é frequente como receita para candidíase; agrupar com antibióticos faz sentido
**Risco de criar:** baixo (se for combinado com J01)
**Overlap:** D01 (Dermatológicos) cobre antifúngicos tópicos — não há colisão

---

### J05 — Antivirais sistémicos (3)

**DCIs:** Aciclovir (×3)
**Formas:** Comprimido (×3)
**Exemplos:**
- 4607784 J05AB01 · ACICLOVIR GENERIS 800 MG X 25 COMP
- 5006820 J05AB01 · Aciclovir Generis 800 Mg Comprimidos 35 Comp.
- 8583906 J05AB01 · Zovirax, 200 mg x 25 comp

**Nivel2 sugerido:** mesma categoria de J01/J02 (anti-infecciosos sistémicos)
**Reusar existente:** "Dermatológicos" cobre Aciclovir tópico — não cobre comprimidos
**Impacto operacional:** baixo (poucos produtos)
**Risco de criar:** baixo (se combinado)
**Overlap:** D06 tem antivirais tópicos — sem colisão

---

### H02 — Corticoides sistémicos (10) — **NEW**

**DCIs:** Metilprednisolona (×4), Prednisolona (×4), Deflazacorte (×2)
**Formas:** Comprimido (×9), Suspensão injetável (×1)
**Exemplos:**
- 8114314 H02AB04 Metilprednisolona · Depo-Medrol, 40 mg/mL x 3 susp inj amp
- 5790381 H02AB04 Metilprednisolona · Medrol, 16 mg x 50 comp
- 8315226 H02AB04 Metilprednisolona · Medrol, 4 mg x 20 comp
- 5790282 H02AB04 Metilprednisolona · Medrol, 4 mg x 50 comp
- 9507343 H02AB06 Prednisolona · Lepicortinolo, 20 mg x 20 comp

**Nivel2 sugerido:** _categoria nova_ "Hormonais e Corticoides" (combinado com H03)
**Reusar existente:** "Dermatológicos" tem corticoides tópicos (D07) mas H02 é sistémico, indicações totalmente diferentes (autoimune, asma severa, oncologia)
**Impacto operacional:** alto — corticoides sistémicos requerem cuidado especial; agrupados ajudam pharmacist a identificar
**Risco de criar:** médio — múltiplas indicações clínicas podem tornar a categoria "lata"
**Overlap:** D07 (Dermatológicos) é tópico, sem colisão

---

### H03 — Hormonas tiróide / antitiroideus (5)

**DCIs:** Levotiroxina sódica (×4), Iodeto de potássio (×1)
**Formas:** Comprimido (×5)
**Exemplos:**
- 3735685 H03AA01 Levotiroxina sódica · Eutirox, 25 mcg x 20 comp
- 3736089 H03AA01 Levotiroxina sódica · Eutirox, 25 mcg x 60 comp
- 3742780 H03AA01 Levotiroxina sódica · Eutirox, 50 mcg x 60 comp
- 3743689 H03AA01 Levotiroxina sódica · Eutirox, 75 mcg x 60 comp
- 5483359 H03CA Iodeto de potássio · Yodafar, 0,2 mg x 50 comp

**Nivel2 sugerido:** mesma "Hormonais e Corticoides" de H02
**Reusar existente:** "Diabetes" (A10) é metabolismo mas não cobre hormonas tiróide
**Impacto operacional:** médio — Levotiroxina é alta rotatividade, muitos pacientes crónicos
**Risco de criar:** baixo (se combinado com H02 — total 15 produtos)
**Overlap:** sem colisão

---

### P02 — Antiparasitários intestinais (3) — **NEW**

**DCIs:** Mebendazol (×2), Albendazol (×1)
**Formas:** Comprimido (×3)
**Exemplos:**
- 9359703 P02CA01 Mebendazol · Pantelmin, 100 mg x 6 comp
- 9434423 P02CA01 Mebendazol · Toloxim, 100 mg x 18 comp
- 8644815 P02CA03 Albendazol · Zentel, 400 mg x 1 comp

**Nivel2 sugerido:** **REUTILIZAR "Sistema Digestivo"** — vermífugos actuam no tracto digestivo; em farmácia portuguesa são tipicamente expostos no balcão como auto-medicação digestiva
**Reusar existente:** sim — "Sistema Digestivo" é a melhor opção pragmática
**Impacto operacional:** baixo (3 produtos)
**Risco de criar:** alto se for categoria própria (poucos produtos)
**Overlap:** P02 é claramente "do tracto digestivo"

---

### A11 — Vitaminas em forma farmacêutica (2)

**DCIs:** Alfacalcidol (×2, vitamina D activa)
**Formas:** Cápsula (×2)
**Exemplos:**
- 3256385 A11CC03 Alfacalcidol · Etalpha 0.5 µg 30 Cápsula
- 8532499 A11CC03 Alfacalcidol · Etalpha, 0,25 mcg x 30 cáps

**Nivel2 sugerido:** **manter "Outros Medicamentos"**
**Reusar existente:** SUPLEMENTOS ALIMENTARES tem "Vitaminas e Minerais" — mas é _nivel1 diferente_; atravessar nivel1 não está permitido (Etalpha é MSRM, claramente medicamento)
**Impacto operacional:** mínimo (2 produtos)
**Risco de criar:** alto (categoria com 2 produtos = ruído no dashboard)
**Overlap:** N/A
**Decisão:** **não fechar gap** — 2 produtos não justifica categoria

---

### M05 — Bifosfonatos / saúde óssea (2)

**DCIs:** Ácido alendrónico + Colecalciferol (×2)
**Formas:** Comprimido (×2)
**Exemplos:**
- 5062500 M05BB03 · Adrovance, 70 mg + 5600 UI x 4 comp
- 5566781 M05BB03 · Fosavance, 70 mg + 2800 UI x 4 comp

**Nivel2 sugerido:** **manter "Outros Medicamentos"**
**Reusar existente:** "Analgésicos e Anti-inflamatórios" cobre músculo-esquelético inflamatório, não osteoporose — mismatch
**Impacto operacional:** mínimo (2 produtos)
**Risco de criar:** alto (categoria com 2 produtos)
**Decisão:** **não fechar gap** — esperar mais matches antes de criar "Saúde Óssea"; "Articulações e Ossos" em SUPLEMENTOS não pode ser atravessado por bifosfonato MSRM

---

### N01 — Anestésicos tópicos (1)

**DCIs:** Lidocaína + Prilocaína (×1)
**Formas:** Creme (×1)
**Exemplos:**
- 2443588 N01BB20 · EMLA, 2,5/2,5 g % p/p x 5 creme bisn

**Nivel2 sugerido:** **REUTILIZAR "Dermatológicos"** — EMLA é literalmente um creme tópico anestésico, aplicação cutânea
**Reusar existente:** sim, "Dermatológicos" engloba aplicações tópicas
**Impacto operacional:** mínimo (1 produto hoje, possivelmente mais formatos de EMLA)
**Risco de criar:** alto (1 produto)
**Overlap:** zero — N01 nesta forma é tópico, encaixa
**Decisão:** **reutilizar "Dermatológicos"** — pragmático
**Caveat:** N01 noutras formas (intravenosa, hospitalar) iria para "Outros Medicamentos"; o mapper deve usar `formaFarmaceutica` como sinal secundário, OU restringir a regra ao código N01BB (anestésicos tópicos)

## Princípios da proposta

1. **Evitar categorias com <5 produtos** — ruído visual no dashboard, custo de manutenção desproporcional
2. **Agrupar por classe clínica funcional**, não por código ATC puro — "Anti-infecciosos" cobre J01+J02+J05 porque o pharmacist pensa assim
3. **Reutilizar quando o significado pragmático bate** — N01 tópico → Dermatológicos; P02 vermífugos → Sistema Digestivo
4. **Manter "Outros Medicamentos" como bucket honesto** para classes com volume insuficiente — A11, M05 ficam lá até crescerem
5. **Cobertura > pureza** — preferimos -90% rule gaps com 2 categorias novas do que -100% com 5 categorias novas

## Proposta concreta (recomendada)

**Adicionar 2 nivel2 novos em MEDICAMENTOS:**

1. **"Anti-infecciosos"** — agrega J01 (antibióticos), J02 (antifúngicos sistémicos), J05 (antivirais sistémicos)
2. **"Hormonais e Corticoides"** — agrega H02 (corticoides sistémicos), H03 (hormonas tiróide)

**Reusar categorias existentes para:**

3. P02 (vermífugos, 3) → **"Sistema Digestivo"**
4. N01BB (anestésicos tópicos, 1) → **"Dermatológicos"** (restringir regra ao N01BB)

**Manter em "Outros Medicamentos":**

5. A11 (vitaminas medicamentosas, 2)
6. M05 (bifosfonatos, 2)

### Resultado projectado da proposta

| Gap | Antes | Depois | Δ |
|---|---:|---:|---:|
| J01 → Anti-infecciosos | 10 | 0 | −10 |
| J02 → Anti-infecciosos | 12 | 0 | −12 |
| J05 → Anti-infecciosos | 3 | 0 | −3 |
| H02 → Hormonais e Corticoides | 10 | 0 | −10 |
| H03 → Hormonais e Corticoides | 5 | 0 | −5 |
| P02 → Sistema Digestivo | 3 | 0 | −3 |
| N01BB → Dermatológicos | 1 | 0 | −1 |
| A11 (mantém) | 2 | 2 | 0 |
| M05 (mantém) | 2 | 2 | 0 |
| **Total rule gaps** | **48** | **4** | **−44 (91.7%)** |

**Crescimento da taxonomia:** 15 → 17 nivel2 em MEDICAMENTOS (+13%). Dashboard mantém-se compacto.

**Distribuição "Outros Medicamentos":** 5805 → projectado **5761** apenas via fechar destes gaps (sem novos mappings).

## Opções alternativas (consideradas e rejeitadas)

### Opção A — Minimalista (1 categoria nova)
Só "Anti-infecciosos" (J01+J02+J05 = 25). H02/H03 ficam em Outros.
**Pró:** taxonomia ultra-conservadora
**Contra:** H02 (10 produtos) é grupo significativo e clínico, deixar em Outros é perda de sinal

### Opção C — Pragmática puro reuse (0 categorias novas)
P02 → Sistema Digestivo, N01 → Dermatológicos, restantes ficam em Outros.
**Pró:** taxonomia inalterada
**Contra:** 44 dos 48 gaps (91%) permanecem; J01/J02/J05/H02/H03 não têm reuse pragmático plausível

### Opção D — Maximalista (5 categorias novas)
"Antibióticos", "Antifúngicos", "Antivirais", "Corticoides", "Hormonas Tiróide" separados.
**Pró:** máxima precisão clínica
**Contra:** ruptura dos princípios (5 categorias com <12 produtos cada), dashboard cresce 33% (15→20)

## Risco de execução (se decidirmos avançar)

1. **Coerência semântica** — "Hormonais e Corticoides" mistura H02 e H03 que clinicamente são bastante diferentes. Aceitável dado o volume baixo, mas requer documentação explícita do bucket
2. **Crescimento futuro** — se o crawl trouxer 100 corticoides ou 50 hormonas, a categoria fica "lata". Plano: monitorizar quando atingir 100+ produtos e considerar split
3. **Categoria de N01BB** — restringir ao prefixo de 4 chars (`N01BB`), não 3 chars (`N01`), porque N01 noutros formatos é hospitalar/sistémico. Implica regra em `ATC_PREFIX_TO_NIVEL2` com lookup hierárquico (já existe pattern via `ATC_LETTER_TO_NIVEL2` para letra; podemos estender)
4. **Migration impact** — adicionar nivel2 em `Classificacao` table; sem migrations destrutivas; novos rows são puramente aditivos
5. **Validação manual** — produtos `validadoManualmente=true` não são afectados; produtos sem `codigoATC` não são afectados

## Migration path (NÃO executar agora)

Se a proposta for aprovada:

1. **`lib/catalog-taxonomy.ts:31-47`** — adicionar `"Anti-infecciosos"`, `"Hormonais e Corticoides"` ao array `nivel2` de MEDICAMENTOS
2. **`lib/catalog-taxonomy-map.ts:107`** (`ATC_PREFIX_TO_NIVEL2`) — adicionar:
   ```ts
   J01: "Anti-infecciosos",
   J02: "Anti-infecciosos",
   J05: "Anti-infecciosos",
   H02: "Hormonais e Corticoides",
   H03: "Hormonais e Corticoides",
   P02: "Sistema Digestivo",
   ```
3. **Regra hierárquica N01BB** — exception list para `N01BB → Dermatológicos`; restante N01 mantém-se em fallback (Outros via `atc_letter` N)
4. **Seed `Classificacao`** — inserir os 2 novos nivel2 com `tipo=NIVEL_2`, `estado=ATIVO`, `classificacaoPai=MEDICAMENTOS`
5. **Reprocess dry-run** sobre os 44 produtos elegíveis para validar mapping
6. **Reprocess live** se dry-run estiver limpo

Quantidade estimada do trabalho: 1 PR pequeno, ~60 linhas de código + 1 migration de seed, ~30min de execução.

## Decisão pendente

A proposta acima é **recomendada** mas **não executável sem ordem explícita**. Esta análise foi gerada read-only; nenhum ficheiro de runtime foi alterado. A decisão sobre avançar (e qual variante) fica para o owner do produto/catálogo.

---

_Gerado read-only. Sem writes, sem reprocess, sem migrations._
