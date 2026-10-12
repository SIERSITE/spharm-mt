# Encomendas · modo Grupo — «Confirmar e finalizar» que bloqueia (correcção)

Branch `fix/encomendas-grupo-consolidada-bloqueio`, a partir de `886acd6` (produção). Sem migrations,
sem alterações ao agent, à pesquisa, à impressão nem à designação da Silveirense.

## 1. Causa raiz (provada em browser, contra o build de `886acd6`)

`/encomendas/nova`, modo Grupo, vivia de DUAS Server Actions encadeadas dentro de `useTransition`:

1. `gerarPlanoGrupoAction` (persiste encomendas + transferências), dentro de
   `startGerarPlano(async () => …)`;
2. `buildDocumentosFinalizacaoAction` (só lê, prepara os documentos), chamada por
   `mostrarResultadoFinalizacao`, que abria **outra** `startTransition(async …)` e punha
   `setCarregandoResultado(true)` — com o `false` só no caminho feliz, sem `try/catch/finally`.

Não existe nenhum caminho em que «Encomenda única» e «Separada» divirjam antes de
`buildDocumentosFinalizacaoAction`: a escolha só é lida depois do plano ter sucesso
(`incluirConsolidado`). Por isso o ensaio anterior (caminho feliz, tudo a responder) passava nos dois.
O defeito está na **falta de qualquer tratamento de falha/demora das duas acções**, que o
ensaio nunca exerceu. Reproduzido com `scripts/e2e/_diagnostico-defeito.ts` no build antigo
(modo «Encomenda única do Grupo», 8 s depois do clique):

| falha injectada | o que o utilizador via | base de dados |
|---|---|---|
| plano **nunca responde** | modal aberto, «A finalizar…», Cancelar e radios **desactivados**, sem mensagem — **o sintoma observado em produção** | nada criado |
| plano **rejeitado** (rede) | ecrã sem modal, sem mensagem e **sem controlos clicáveis** | nada criado |
| documentos **rejeitados** (rede/500) | idem: ecrã sem resultado, sem mensagem, nada clicável; o overlay «A preparar os documentos…» fica por cima | **tudo persistido** (3 encomendas, 2 transferências, 3 outbox) |

Mecanismos concretos:

* uma rejeição dentro de `startTransition(async …)` não é apanhada: salta `setCarregandoResultado(false)`
  e a excepção sobe para o React (o ecrã perde os controlos, sem mensagem);
* o erro de `gerarPlanoGrupoAction` era escrito no `flash` da página, que fica **atrás** do modal
  (`fixed inset-0 z-50`): o utilizador nunca o via;
* um pedido que não responde deixava `gerandoPlano` verdadeiro para sempre — não havia aviso nem saída;
* o retry (clicar de novo) gerava chaves de idempotência novas ⇒ risco de duplicar encomendas e
  transferências (o ramo de farmácia com um só fornecedor e as transferências não tinham chave).

**Qual das quatro hipóteses da produção?** Com os dados locais, o clique feliz conclui
(0,5 s) e persiste exactamente uma vez em ambos os modos; por isso a produção só pode ter caído num dos
caminhos acima. O sintoma descrito (modal bloqueado, controlos desactivados, sem erro, servidor
saudável, nada nos logs) coincide com **o pedido do plano a não devolver resposta ao browser**
(`plano nunca responde`). Se o servidor chegou a persistir, depende de onde o pedido ficou preso
— o que esta correcção torna **seguro nos dois casos** (ver §5/§6). Não é possível, sem os logs
de produção, saber se persistiu; a nova observabilidade (§4) responde à próxima ocorrência.

## 2. Ficheiros

* `lib/encomendas/finalizacao-grupo-estado.ts` (novo) — estados e regras puras.
* `components/encomendas/order-create-client.tsx` — máquina de estados, painel de erro de documentos,
  avisos de demora, modal com erro, recuperação após refresh.
* `app/encomendas/nova/actions.ts` — logs estruturados; chave de idempotência da encomenda única;
  `correlacaoId` (opcional) nos dois inputs.
* `lib/encomendas/finalizar-multi-fornecedor-regras.ts` — `deriveGrupoSimplesIdempotencyKey`.
* Testes: `scripts/tests/test-finalizacao-grupo-estado.ts`, `scripts/e2e/encomendas-grupo-finalizacao-browser.ts`,
  `scripts/e2e/_grupo-comum.ts`, `scripts/e2e/_diagnostico-defeito.ts`.

## 3. A máquina de estados

Duas fases independentes (nada de `useTransition` aninhado):

```
FINALIZAÇÃO   inativo ──confirmar──▶ persistindo ──ok──▶ inativo (modal fecha; inicia DOCUMENTOS)
                                         ├─ erro devolvido / excepção / rejeição ─▶ erro (no MODAL; «Tentar novamente»)
                                         └─ sem resposta 45 s ─▶ aviso no modal («não carregue de novo; veja em Encomendas»)

DOCUMENTOS    a-preparar ──ok──▶ resultado (painel com os documentos)
                 ├─ erro / excepção / rejeição ─▶ painel «Finalização concluída — documentos por preparar»
                 │                                 [Tentar preparar documentos novamente] [Concluir]
                 └─ sem resposta 45 s ─▶ aviso no overlay + «Sair deste passo» (cai no painel de erro)
```

* Cada fase tem uma trava síncrona (`grupoEmVooRef`/`docsEmVooRef`) contra duplo clique e liberta o
  «ocupado» em `finally`.
* As chaves de idempotência (`encomendaBatchKey`, `transferenciaBatchKey`) geram-se UMA vez por
  tentativa e **reutilizam-se nos «Tentar novamente»**; largam-se ao cancelar e depois de persistir.
* Depois de persistir, o modal fecha e **nunca mais se repete a finalização**: só os documentos
  se podem repetir, e fazem-no só com os ids guardados (leitura).

## 4. Observabilidade

Uma linha JSON por evento, com chave de correlação (`correlacaoId`, validada `[A-Za-z0-9-]{1,64}`),
durações e contagens — nunca produtos, notas, nomes ou designações:
`group-finalization-start`, `group-finalization-persisted` (+ `group-finalization-failed`),
`group-documents-start`, `group-documents-success`, `group-documents-failed`.

## 5. Finalização persistida mas documentos falham

O modal já fechou; aparece o painel «Finalização concluída — documentos por preparar» com o número
de encomendas/transferências gravadas, o erro, **Tentar preparar documentos novamente** (só
`buildDocumentosFinalizacaoAction` com os ids, que não cria nada) e **Concluir** (sai para
`/encomendas`). Provado: o retry chama só a acção de documentos (plano 1×, documentos 2×) e as
contagens não mudam.

## 6. Idempotência e recuperação

* Encomenda única (um fornecedor) por farmácia: passou a levar `clientIdempotencyKey` derivada do
  lote; o ramo multi-fornecedor já a tinha; as transferências já suportavam `transferenciaBatchKey`
  mas o cliente nunca a enviava — agora envia. Resposta perdida (o servidor persistiu, o browser
  não soube) + «Tentar novamente» ⇒ **zero duplicados** (provado).
* Refresh depois de persistir e antes dos documentos: os ids ficam em `sessionStorage` (só ids e
  flags, 24 h) e o painel de recuperação reabre-se; não volta a finalizar. Se o pedido guardado
  já não existir (outra aba, expirou), simplesmente não aparece.

## 7. Limitações

* Se o plano nunca responde, o botão fica desactivado (de propósito: carregar de novo seria uma
  segunda operação) até se recarregar/ir a Encomendas; o aviso a 45 s diz exactamente isso. Depois do
  refresh o utilizador volta a gerar a proposta e o retry **dessa nova proposta** é uma operação nova
  (as chaves do pedido perdido não sobrevivem a um refresh). Verificar em `/encomendas` o que ficou
  gravado — os logs `group-finalization-*` com a correlação dizem se o servidor persistiu.
* `test-ficha-manual` e `test-encomenda-grupo-decisao-linha` falham igual em `886acd6` (a primeira por
  a designação da Silveirense já ignorar `camposManuais`; fora deste âmbito).
* Sem `pdf-parse`, alguns testes antigos do repositório não correm nesta máquina (pré-existente).
