# Correção da hidratação do estado do workspace (React #418)

Branch: `fix/workspace-hidratacao-estado` (a partir de a69cbc5). Contém só a alteração a `lib/workspace/use-workspace-state.ts`.

## Problema
No refresh de uma rota com separadores/workspace (observado em Margens) o build de produção regista `React error #418`
(hidratação). É um bug PRÉ-EXISTENTE no base: o 1.º render lia o rascunho guardado no cliente, divergindo do HTML do servidor.

## O que a correção faz
O 1.º render usa os valores por omissão (iguais no servidor e no cliente) e o rascunho é restaurado em `useLayoutEffect`.

## Risco
`use-workspace-state` é partilhado por TODOS os mapas com workspace. Mudar o momento em que o rascunho é restaurado pode
causar um flash do estado por omissão, perda/duplicação de restauro, ou cruzar estado entre instâncias/tenants/sessões.

## E2E de refresh necessários ANTES de produção (por escrever)
Para cada um de Vendas, Margens, Inventário, Excessos e Transferências, no build de PRODUÇÃO:
- refresh com critérios preenchidos: critérios restaurados, sem erro de hidratação (#418) na consola;
- duas instâncias da mesma rota (dois separadores de análise): cada uma mantém o seu estado, sem contaminação;
- troca de tenant: o rascunho de um tenant não aparece no outro;
- logout (e novo login): rascunho não sobrevive/cruza utilizadores;
- fecho do separador: reabrir começa limpo;
- zero `pageerror` e zero avisos de hidratação durante todo o fluxo.
