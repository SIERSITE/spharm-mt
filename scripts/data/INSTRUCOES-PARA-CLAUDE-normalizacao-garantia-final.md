# Implementação final da normalização de fabricantes — tenant `garantia`

## Resultado da investigação

A investigação empresarial está concluída. Usa `plano-normalizacao-garantia-achatado-checkpoint.json` como plano definitivo para implementação e novo dry-run.

Regra aplicada: unificar apenas variantes inequívocas da mesma entidade, mudança de denominação, fusão/incorporação documentada ou denominação histórica com sucessora identificada. Entidades juridicamente distintas permanecem separadas, mesmo pertencendo ao mesmo grupo. Correspondências incertas foram resolvidas por **não unir**.

## Totais do plano final

- 557 grupos de normalização.
- 756 fabricantes de origem a inativar.
- 11.338 produtos únicos a reatribuir diretamente ao destino definitivo.
- 2.365 fabricantes ativos antes; estimativa de 1.609 depois.
- 36 destinos exigem atualização da denominação canónica.
- Nenhum `source_id` repetido, nenhuma cadeia winner→loser→winner e nenhum self-merge.

## Decisões empresariais finais acrescentadas

| Destino atual | Origens | Produtos | Conclusão |
|---|---:|---:|---|
| BOEHRINGER INGELHEIM PORTUGAL LDA | 4 | 53 | Consolida a designação genérica e variantes portuguesas; International GmbH, Vetmedica e Animal Health ficam separadas. |
| BOEHRINGER INGELHEIM ANIMAL HEALTH PORTUGAL UNIPESSOAL LDA | 5 | 39 | Consolida Merial Portuguesa – Saúde Animal e variantes/truncagens. |
| JANSSEN-CILAG FARMACEUTICA LDA | 2 | 20 | Consolida variantes da entidade NIF 500189412; Janssen Farmacêutica Portugal (NIF 501404198) fica separada. |
| JANSSEN FARMACEUTICA PORTUGAL LDA | 0 | 0 | Apenas completa a denominação legal; sem merge. |
| ROCHE SISTEMAS DE DIAGNOSTICOS LDA | 2 | 6 | Consolida variantes portuguesas desta entidade. |
| ROCHE REGISTRATION GMBH | 1 | 5 | Consolida a entrada sem forma jurídica. |
| ROCHE FARMACEUTICA QUIMICA LDA | 0 | 0 | Apenas completa a denominação legal; sem merge. |
| MERCK SHARP & DOHME LDA | 0 | 0 | Apenas completa a denominação legal; MSD B.V. fica separada. |
| L OREAL PORTUGAL UNIPESSOAL LDA | 13 | 1.162 | Consolida a anterior L'Oréal Portugal Lda, a antiga Cosmética Activa Portugal e as designações da divisão/marcas Vichy, La Roche-Posay e CeraVe. |

As fontes, justificações e IDs exatos estão em cada grupo `supplemental_research_final` do JSON.

## Entidades que devem continuar separadas

Respeita integralmente `do_not_merge`, incluindo:

- B. Braun Medical Lda, B. Braun Medical S.A., B. Braun Medical SAS, B. Braun Melsungen AG e B. Braun Hospicare Ltd;
- Boehringer Ingelheim Portugal, International GmbH, Vetmedica GmbH e Animal Health Portugal;
- Janssen-Cilag Farmacêutica, Janssen Farmacêutica Portugal e Janssen-Cilag International;
- Roche Farmacêutica Química, Roche Sistemas de Diagnósticos, Roche Diagnostics Ltd, Roche Diabetes Care GmbH e Roche Registration GmbH;
- Merck Sharp & Dohme Lda e Merck Sharp & Dohme B.V.;
- Alfasigma S.p.A. e Alfasigma Portugal;
- as restantes famílias protegidas já declaradas no plano.

## Alteração obrigatória no executor

O executor atual só move produtos/aliases e inativa origens. Antes de correr o novo dry-run, acrescenta suporte explícito a `canonical_name_after`:

1. validar que o `canonical_id` existe e está ativo;
2. validar conflitos de unicidade da nova denominação normalizada;
3. criar alias com `canonical_name_before` quando o nome mudar;
4. atualizar a denominação do destino dentro da mesma transação;
5. mover cada produto uma única vez, diretamente para o destino final;
6. inativar as origens apenas depois dos movimentos;
7. abortar toda a transação perante qualquer conflito;
8. manter a trava rígida `--tenant=garantia` e dry-run por omissão;
9. impedir qualquer par abrangido por `do_not_merge`.

## Sequência autorizada agora

1. Adaptar o executor ao plano final.
2. Criar/atualizar testes offline para rename, alias, unicidade, rollback, ausência de cadeias, sources repetidos e `do_not_merge`.
3. Correr novo dry-run na VPS sem `--apply`.
4. Comparar o relatório real com os totais acima e explicar qualquer divergência.
5. Parar para aprovação humana.

**Não executar `--apply`.** A investigação está concluída, mas a escrita na base continua a depender da validação do novo dry-run e de aprovação explícita.
