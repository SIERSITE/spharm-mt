# INFOMED — Investigação técnica (Maio 2026)

Notas técnicas sobre o portal `extranet.infarmed.pt/INFOMED-fo/`. Não é
documentação de produto — é ground-truth do que o site faz, capturado
durante a investigação para servir o pipeline regulatório SPharm.MT.

## Resumo executivo

| Acção | Estado | Notas |
|-------|--------|-------|
| GET detail page por `med_guid` | ✅ funciona via HTTP directo (curl/fetch) | Step A está implementado e validado em `lib/regulatory-sources/infarmed-detail-page.ts` |
| GET `index.xhtml` via curl | ❌ 503 anti-bot | Bloqueia clientes não-browser explicitamente |
| GET `index.xhtml` via Playwright | ✅ 200 | Browser real passa o anti-bot |
| GET `pesquisa-avancada.xhtml` via curl | ❌ 503 | Idem |
| GET `listagem.xhtml?<param>` directo | ❌ 404 | Endpoint não existe |
| Autocomplete AJAX via Playwright | ✅ 200 | POST `/INFOMED-fo/index.xhtml` retorna XML com sugestões — apenas TEXT, não med_guid |
| Submit search via click `#mainForm:ajax` | ❌ não navega | URL fica em `index.xhtml` — fluxo precisa de seleccionar sugestão antes |
| Click em sugestão do dropdown | ⚠️ não testado fim-a-fim | PrimeFaces dropdown tem timing/visibility issues em headless |

## Stack técnico do INFOMED

- **JSF 2.x** com **PrimeFaces 7.0** (estilos `.ui-autocomplete`, `.ui-datatable`, etc.)
- **`javax.faces.ViewState`** server-side em hidden inputs
- **AJAX** via `<f:ajax>` / `p:ajax` que faz POST ao `index.xhtml` com
  parâmetros `javax.faces.partial.ajax=true`
- **Anti-bot** filtra User-Agents não-browser nas pages de pesquisa.
  A page de detalhe (`detalhes-medicamento.xhtml?med_guid=...`) NÃO é filtrada
  — assim que tens o med_guid, é HTTP simples.

## Estrutura do form principal

Inputs descobertos em `index.xhtml`:

```
mainForm                                    (form)
mainForm:acMinLength_input                  (text, placeholder "DCI/Nome do Medicamento")
mainForm:acMinLength_hinput                 (hidden — armazena o valor SELECCIONADO do autocomplete)
mainForm:chkAutorizadoComercializado_input  (checkbox "apenas autorizados+comercializados")
javax.faces.ViewState                       (hidden, ID j_id1:javax.faces.ViewState:0)

#mainForm:ajax                              (button submit "lupa")
```

Variantes para tablet/mobile (`tablet-mainForm:...` e `mobile-mainForm:...`)
existem mas estão visualmente escondidas no desktop.

## Pesquisa avançada (form alternativo)

Existe um segundo form `pesquisa-avancada-form` com botão
`#pesquisa-avancada-form:btnPesquisar`. Este form pode ter mais campos
(DCI, ATC, dosagem, forma) — não inspeccionado em detalhe. Vale a pena
avaliar se este botão é mais simples de submeter (sem autocomplete).

## Fluxo de pesquisa (UI)

1. Utilizador digita texto no input `acMinLength_input`
2. JS PrimeFaces dispara AJAX (POST a `index.xhtml`) → recebe XML
   `<partial-response>` com `<update id="mainForm:acMinLength">` contendo
   `<table class="ui-autocomplete-items">` com `<tr data-item-value="..."
   data-item-label="...">`
3. Dropdown é renderizado em painel atached ao DOM
4. Utilizador clica numa sugestão → JS PrimeFaces popula
   `acMinLength_hinput` com o valor seleccionado
5. Utilizador clica `#mainForm:ajax` → form submete via POST → resposta
   é provavelmente HTML completo da listagem.xhtml (ou re-render do
   index com painel de resultados)

## O que precisa ser capturado

Para ter HTTP-only replay, precisamos do POST em (5):
- URL exacto (provavelmente `index.xhtml;jsessionid=...`)
- Cookies (sessão JSF)
- Form data: ViewState + acMinLength_input + acMinLength_hinput + checkbox
- Possível parâmetro AJAX-specific (`javax.faces.source`, `javax.faces.partial.execute`, `javax.faces.partial.render`)
- Response: HTML/XML com med_guids dos resultados

## Resposta do autocomplete (capturada)

```xml
<?xml version='1.0' encoding='UTF-8'?>
<partial-response id="j_id1">
  <changes>
    <update id="mainForm:acMinLength">
      <![CDATA[
        <table class="ui-autocomplete-items ui-autocomplete-table ui-widget-content ui-widget ui-corner-all ui-helper-reset">
          <tbody>
            <tr class="ui-autocomplete-item ui-autocomplete-row ..." data-item-value="Decapeptyl" data-item-label="Decapeptyl">
              <td><span class="ui-autocomplete-item">Decapeptyl</span></td>
            </tr>
            <tr class="ui-autocomplete-item ..." data-item-value="Decapeptyl 0,1 mg" data-item-label="Decapeptyl 0,1 mg">
              ...
            </tr>
            ...
          </tbody>
        </table>
      ]]>
    </update>
    ...
  </changes>
</partial-response>
```

**IMPORTANTE**: as sugestões são `data-item-value="<texto>"` e
`data-item-label="<texto>"` — NÃO contêm med_guid. O lookup `texto → med_guid`
só acontece na submissão final.

## Caminho confirmado: HTTP-only ✅

Validado por `scripts/probe-infomed-http-replay.ts` (Maio 2026, sessão 2):
**TODOS os 5 steps funcionam com `fetch()` puro, zero Playwright em produção.**

Output do probe para term="Decapeptyl":
```
[1] GET index.xhtml                  → 200, 43146 bytes, JSESSIONID + ViewState extraídos
[2] POST submit lupa                  → 200, 150 bytes, <redirect/> XML detectado
[3] GET pesquisa-avancada.xhtml       → 200, 1.2MB, 4 linhas dt-medicamentos parsed
                                          [ri=0] Decapeptyl       Triptorrelina  3.75 mg/2 ml
                                          [ri=1] Decapeptyl 0,1   Triptorrelina  0.1 mg/ml
                                          [ri=2] Decapeptyl LP    Triptorrelina  22.5 mg/2 ml
                                          [ri=3] Decapeptyl LP 11 Triptorrelina  11.25 mg/2 ml
[4] POST click row 0 (linkNome)       → 200, redirect XML para detalhes-medicamento.xhtml
[5] GET detalhes-medicamento.xhtml    → 200, 94KB, detail page "Decapeptyl" renderizada
                                          (sessão guarda a med_guid escolhida)
```

**Playwright é necessário apenas para investigação inicial.** Em produção,
o worker faz tudo com fetch + cheerio, exactamente como o
`infarmed-detail-page.ts` actual.

## Captura completa do fluxo (Maio 2026 — sessão 2)

`scripts/investigate-infomed-search-flow.ts` (não-produção) captou todas as
requests durante uma sequência completa de pesquisa por "Decapeptyl". Output
JSON em `notes/infomed-search-flow-capture.json`, HTML final em
`notes/infomed-search-flow-capture.final-html.html`.

### POST capturado — submit lupa principal

URL: `https://extranet.infarmed.pt/INFOMED-fo/index.xhtml;jsessionid=<X>`

Headers: standard browser + `Cookie: JSESSIONID=<X>`

Form-encoded body (10 params):

```
javax.faces.partial.ajax=true
javax.faces.source=mainForm:ajax
javax.faces.partial.execute=@all
javax.faces.partial.render=mainForm:messages+mainForm:nomesMessage
mainForm:ajax=mainForm:ajax
mainForm=mainForm
mainForm:acMinLength_input=Decapeptyl
mainForm:acMinLength_hinput=Decapeptyl
mainForm:chkAutorizadoComercializado_input=on
javax.faces.ViewState=<value-from-initial-GET>
```

Response: XML `<partial-response>` com `<redirect url="pesquisa-avancada.xhtml"/>`.

### GET pesquisa-avancada.xhtml — listagem com resultados

URL: `https://extranet.infarmed.pt/INFOMED-fo/pesquisa-avancada.xhtml`

Returns 1.3 MB HTML com `<table>#mainForm:dt-medicamentos`. Cada `<tr data-ri="N">`
tem cells por ordem:

1. `<td class="ui-helper-hidden">` — MED_ID interno (sequencial: 2380, 30143, 48612...)
2. **Nome do Medicamento** — em `<a id="mainForm:dt-medicamentos:N:linkNome">`
3. **Substância Ativa/DCI** — directo no `<td>`
4. **Forma Farmacêutica** — directo no `<td>`
5. **Dosagem** — directo no `<td>`
6. **Titular AIM** — directo no `<td>`
7. Comercialização (icone só)
8. Estado AIM Sort (1 = autorizado)
9. Documentos (links RCM/FI)

**IMPORTANTE**: o listagem **NÃO contém med_guid directamente**. Apenas
MED_ID interno (não documentado, não estável para deep-link).

### Resolução row → med_guid

O click no `<a id="mainForm:dt-medicamentos:N:linkNome">` dispara AJAX:

```js
PrimeFaces.ab({s:"mainForm:dt-medicamentos:N:linkNome", f:"mainForm", p:"..."})
```

Server retorna `<partial-response><redirect url="detalhes-medicamento.xhtml?med_guid=<X>"/></partial-response>`.

**Extra round-trip por linha clicada.** Mas geralmente queremos só 1
linha por busca (o melhor match por designacao+dosagem), portanto custo
controlado.

## Protocolo HTTP-only (replay sem Playwright)

Sequência de requests para resolver `designacao → med_guid`:

```
1. GET https://extranet.infarmed.pt/INFOMED-fo/index.xhtml
   ── Headers necessários:
   ──   User-Agent: <browser-like>
   ──   Accept: text/html,application/xhtml+xml,...
   ── Extrair:
   ──   - JSESSIONID do Set-Cookie response header
   ──   - javax.faces.ViewState do HTML (input hidden)

2. POST https://extranet.infarmed.pt/INFOMED-fo/index.xhtml
   ── Headers:
   ──   Cookie: JSESSIONID=<from-step-1>
   ──   Content-Type: application/x-www-form-urlencoded;charset=UTF-8
   ──   Faces-Request: partial/ajax       (alguns servers exigem, defensive)
   ──   X-Requested-With: XMLHttpRequest  (idem)
   ── Body (form-urlencoded):
   ──   javax.faces.partial.ajax=true
   ──   javax.faces.source=mainForm:ajax
   ──   javax.faces.partial.execute=@all
   ──   javax.faces.partial.render=mainForm:messages+mainForm:nomesMessage
   ──   mainForm:ajax=mainForm:ajax
   ──   mainForm=mainForm
   ──   mainForm:acMinLength_input=<search term>
   ──   mainForm:acMinLength_hinput=<search term>
   ──   mainForm:chkAutorizadoComercializado_input=on
   ──   javax.faces.ViewState=<from-step-1>
   ── Response:
   ──   text/xml com <partial-response><redirect url="pesquisa-avancada.xhtml"/>

3. GET https://extranet.infarmed.pt/INFOMED-fo/pesquisa-avancada.xhtml
   ── Headers:
   ──   Cookie: JSESSIONID=<same>
   ── Response:
   ──   HTML 1.3 MB com listagem completa.
   ──   Parsear `#mainForm:dt-medicamentos tr[data-ri]` → array de candidatos:
   ──     { rowIndex, medId, nome, dci, forma, dosagem, titular }

4. (Opcional, se precisarmos do med_guid) — para cada candidato escolhido:
   POST https://extranet.infarmed.pt/INFOMED-fo/pesquisa-avancada.xhtml
   ── Body:
   ──   javax.faces.partial.ajax=true
   ──   javax.faces.source=mainForm:dt-medicamentos:<rowIndex>:linkNome
   ──   javax.faces.partial.execute=mainForm:dt-medicamentos:<rowIndex>:linkNome
   ──   mainForm=mainForm
   ──   mainForm:dt-medicamentos:<rowIndex>:linkNome=mainForm:dt-medicamentos:<rowIndex>:linkNome
   ──   javax.faces.ViewState=<extracted from step 3 HTML>
   ── Response:
   ──   <partial-response><redirect url="detalhes-medicamento.xhtml?med_guid=<X>"/>

5. (Já temos) GET detalhes-medicamento.xhtml?med_guid=<X>
   → fetcher actual em lib/regulatory-sources/infarmed-detail-page.ts
```

### Estimativa de throughput

Por designacao:
- Step 1 (GET index): ~500ms (com session cache pode reusar)
- Step 2 (POST submit): ~500ms
- Step 3 (GET pesquisa-avancada): ~1s (1.3 MB)
- Step 4 (POST row click): ~300ms — 1 vez por candidato
- Step 5 (GET detail): ~300ms

Total per CNP: ~2-3s. 1 hora ≈ 1500 CNPs.
Para 6191 CNPs do cohort outros-medicamentos: ~4 horas.
Realista para crawls overnight.

### Alternativa — atalho via listagem

A listagem já contém DCI + Forma + Dosagem + Titular AIM directamente.
Se NÃO precisarmos de ATC nem CNPs específicos das embalagens, podemos
parar no Step 3 e gravar parcialmente em RegulatoryRecord (ainda sem ATC).

ATC e embalagens com CNPs continuam a vir do detail page. Para o objectivo
de mapear CNP→med_guid (preciso para o RegulatoryRecord ser indexável por
CNP), o detail page é necessário.

## Caminhos rejeitados (para histórico)

- ❌ Direct GET URL com CNP/nome: 404
- ❌ Google Search como indexer (rate limit free 100/dia, cobertura parcial,
  silent failures — não escala para milhares/noite)

## Caminhos paralelos (não bloqueantes)

- INFARMED Cedência institucional (formal, demora semanas)
- Datasets INFARMED Open Data públicos (têm ATC/DCI mas formato XLSX manual)
- 3rd-party DBs (medikamio, mymedfarma, cliquefarma, indice.eu) — podem
  cobrir um subset por scraping mais simples, valeria como complemento mas
  não como primária

## Convenções para futura implementação

- O endpoint INFOMED tem JSF state — qualquer replay precisa de:
  - `Cookie: JSESSIONID=...` da sessão atribuída no GET inicial
  - `javax.faces.ViewState` extraído do HTML inicial
  - User-Agent declarado tipo browser
- Rate limit conservador: ≥2s entre searches
- Detail page (`detalhes-medicamento.xhtml?med_guid=...`) NÃO precisa de
  sessão — é GET simples e funciona sem cookies. Já em produção.
