# Continuação da normalização de fabricantes — tenant `garantia`

## Estado e regra de segurança

Não executes `--apply`. O dry-run anterior provou apenas a consistência técnica do primeiro plano; não provou que todas as relações empresariais estavam cobertas.

Usa `plano-normalizacao-garantia-achatado-checkpoint.json` como novo ponto de partida. O ficheiro está limitado ao tenant `garantia`, não contém cadeias winner→loser→winner, não repete `source_id` e mantém separadas entidades do mesmo grupo quando têm personalidade jurídica distinta.

## Resultado consolidado atual

- 555 grupos finais.
- 736 fabricantes de origem a inativar.
- 10.056 produtos únicos a reatribuir diretamente ao destino definitivo.
- Estimativa: 2.365 fabricantes ativos antes e 1.629 depois.
- 53 grupos do plano inicial foram absorvidos noutros grupos para eliminar movimentos em cadeia.
- 28 destinos exigem também atualização da própria denominação canónica.

## Alteração obrigatória no executor

O executor atual só move produtos/aliases e inativa origens. Antes de novo dry-run, acrescenta suporte explícito a `canonical_name_after`:

1. validar que o `canonical_id` existe e está ativo;
2. validar conflitos de unicidade da nova denominação normalizada;
3. criar alias com `canonical_name_before` quando o nome mudar;
4. atualizar a denominação do destino dentro da mesma transação;
5. mover cada produto uma única vez, diretamente para o destino final;
6. inativar as origens apenas depois dos movimentos;
7. abortar toda a transação perante qualquer conflito;
8. manter a trava rígida `--tenant=garantia` e dry-run por omissão.

## Casos empresariais adicionados e já documentados

Entre outros: ToLife→Towa Pharmaceutical; Laboratoire Bioderma Portugal→NAOS Portugal; Angelini Farmacêutica→Angelini Pharma Portugal; Bayer Portugal S.A.→Bayer Portugal Lda.; Nestlé Portugal S.A.→Nestlé Portugal Unipessoal Lda.; IFC Innovation/variantes→IFC Skincare Portugal; Pierre Fabre Dermo-Cosmétique e respetivas marcas; e as variantes legais de Artsana, Generis, Farmodiética, Bluepharma Genéricos, Sandoz Portugal, Medinfar, Azevedos, Edol, Basi, Tecnifar, Zambon, Mylan Portugal, Teva Portugal e Ratiopharm Portugal.

As fontes e justificações estão em cada grupo `supplemental_research` do JSON.

## Separações que nunca podem ser ultrapassadas

Respeita integralmente `do_not_merge`. Em especial:

- Alfasigma S.p.A. ≠ Alfasigma Portugal;
- Pierre Fabre Medicament Portugal ≠ Pierre Fabre Dermo-Cosmétique Portugal;
- Pentafarma ≠ Tecnimede;
- Bluepharma Genéricos ≠ Bluepharma Indústria;
- Generis Phar ≠ Generis Farmacêutica;
- Farmoz ≠ Biofarmoz ≠ Farmoz Genéricos;
- Mylan ≠ Viatris Healthcare/Upjohn;
- Ratiopharm ≠ Teva Pharma;
- Johnson & Johnson ≠ Kenvue;
- Janssen-Cilag ≠ Janssen Farmacêutica Portugal sem prova de identidade jurídica.

## Correções às denominações do primeiro plano

- `TAKEDA - FARMACEUTICOS PORTUGAL` → `TAKEDA - FARMACEUTICOS PORTUGAL LDA`.
- `HALEON PORTUGAL` → `HALEON PORTUGAL LDA`.

Estas correções já estão refletidas no JSON achatado.

## Casos ainda excluídos por prudência

Não os unas automaticamente apenas por semelhança textual: B. Braun Medical S.A./Lda./SAS; Boehringer Ingelheim (Portugal, International, Animal Health e Vetmedica); Roche (farmacêutica, diagnostics, diabetes care e registration); Janssen-Cilag International/Janssen-Cilag Farmacêutica/Janssen Farmacêutica Portugal; Merck Sharp & Dohme sem sufixo/B.V.; entidades L'Oréal/Cosmética Activa/La Roche-Posay; e quaisquer nomes genéricos que possam representar uma casa-mãe estrangeira.

## Próximo passo pedido

1. Adaptar o executor ao formato achatado e ao rename canónico.
2. Criar testes offline para conflito de nome, alias do nome antigo, rollback total, ausência de cadeias, ausência de sources repetidos e bloqueio de `do_not_merge`.
3. Gerar novo dry-run na VPS, ainda sem `--apply`.
4. Comparar contagens esperadas com o JSON e produzir relatório de divergências.
5. Parar e pedir aprovação humana; não aplicar alterações.
