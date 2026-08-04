# 03 — Product Philosophy

> Princípios de **produto**: o que o sistema escolhe fazer e não fazer, e o preço de cada escolha.
> Os princípios de **engenharia** estão no capítulo [04](./04-architecture-principles.md).

---

## 1. Porque existe este capítulo

Um princípio de produto só vale se responder a uma pergunta real de desenho e se **custar alguma
coisa**. Um princípio que ninguém pode violar não é princípio, é descrição. Por isso cada um dos que
se seguem traz: o que afirma, porque existe, o que se perde ao segui-lo, e como se reconhece que
está a ser violado.

Estão por ordem de precedência. Quando dois colidirem, o de cima ganha.

---

## P1 — O ERP é o sistema de registo; nós somos o sistema de decisão

**Afirma:** nenhum dado operacional nasce aqui. Divergência face ao ERP é bug nosso.

**Porquê:** a farmácia já confia no ERP. A plataforma tem de conquistar confiança, e essa
conquista faz-se por concordância, não por argumento. Foi por isto que o módulo de extrato foi
levado até bater 1:1 com o ecrã do ERP — documento, contraparte, split de bónus, preço e valor —
mesmo sabendo que quase ninguém o abriria. Um gestor que encontra um número errado num sítio deixa
de acreditar em todos os outros.

**Preço:** duplicamos esforço a reproduzir semântica do ERP que poderíamos simplificar. Ficamos
reféns de mudanças no ERP. Nunca podemos "corrigir" um dado que sabemos estar mal na origem.

**Violação:** qualquer funcionalidade que crie dado operacional novo sem correspondência no ERP; ou
que "limpe" dados na ingestão em vez de os classificar.

---

## P2 — Informação verificável antes de inferência

**Afirma:** um valor confirmado por fonte autoritária vale mais do que um valor deduzido. O sistema
sabe a diferença, guarda-a, e usa-a para decidir quem escreve por cima de quem.

**Porquê:** sem hierarquia de autoridade, o último a escrever ganha — e o último costuma ser o mais
barato de obter, que é o mais fraco. É a origem do modelo de tiers (`REGULATORY > MANUFACTURER >
DISTRIBUTOR > RETAIL > INTERNAL_INFERRED`), do bloqueio de campos autoritários (`fabricante`, `dci`,
`codigoATC` só aceitam fontes regulamentares ou do fabricante) e da proveniência por campo.

**Preço:** cobertura mais baixa. Preferimos um campo vazio a um campo plausível: com 30 % de ATC
verificado, teríamos 80 % se aceitássemos inferência de texto — e não saberíamos quais dos 80 %
acreditar.

**Violação:** preencher um campo autoritário a partir de heurística; escrever sem registar de onde
veio; tratar "o tenant tinha este valor" como evidência (o valor pode ter vindo de outra heurística
há dois anos).

---

## P3 — Nunca degradar, nunca apagar

**Afirma:** informação forte não é substituída por fraca; nada é apagado por um processo
automático. Estados terminais são lógicos (`DEPRECATED`, `INATIVO`), nunca `DELETE`.

**Porquê:** todos os pipelines deste sistema correm sem supervisão. Um bug que apaga é
irrecuperável; um bug que acrescenta é corrigível. Além disso, dados operacionais referenciam
catálogo durante anos — apagar um produto parte histórico que já foi mostrado ao cliente.

**Preço:** tabelas crescem e acumulam entradas mortas. É preciso distinguir "não existe" de
"existe mas está inactivo" em toda a UI.

**Violação:** `DELETE` fora de um script administrativo explícito; sobrepor valor não-nulo por
nulo; "limpar" registos antigos sem política escrita.

---

## P4 — Sugerir, nunca decidir

**Afirma:** o sistema classifica, ordena, propõe e explica. A acção com consequência económica —
encomendar, transferir — exige confirmação humana.

**Porquê:** o motor de propostas trabalha sobre cobertura estimada a partir de médias de venda. Está
certo na maioria dos casos e errado numa minoria que o gestor identifica em segundos (campanha,
sazonalidade, doente crónico específico). Automatizar transformaria erros raros em encomendas reais
e destruiria a confiança que sustenta tudo o resto.

**Preço:** o produto nunca poupa 100 % do tempo. Há sempre uma pessoa no ciclo.

**Violação:** qualquer coisa que crie uma encomenda sem confirmação; ou que esconda o motivo de uma
proposta (o "porquê" é parte da proposta, não um extra).

---

## P5 — Transferir antes de comprar

**Afirma:** o excedente da rede é a primeira fonte de abastecimento. A compra é o que sobra.

**Porquê:** é a proposta de valor central. O motor calcula excedente como
`stock − médiaDiária × coberturaAlvo × factor` e só sugere `COMPRAR` quando não há
`TRANSFERÊNCIA` possível.

**Preço:** complexidade real — obriga a manter estado consistente entre farmácias, a resolver
equivalências (DCI, marca própria) e a lidar com o facto de uma transferência ter custo logístico
que o sistema não conhece.

**Violação:** propor compra sem verificar a rede; ignorar equivalências por serem difíceis.

---

## P6 — Cada número tem de ser explicável

**Afirma:** todo o valor mostrado tem de poder ser decomposto até ao movimento que o originou, e
tem de saber dizer de quando é.

**Porquê:** o utilizador vai ter de justificar a decisão a um sócio ou a um contabilista. Um número
que não se consegue justificar não é usado — e um dashboard não usado é pior do que nenhum, porque
consumiu confiança.

**Preço:** obriga a guardar granularidade que "não é precisa" para o agregado, e a mostrar frescura
mesmo quando é má notícia.

**Violação:** indicador sem drill-down; número sem data de referência; agregado que não bate com a
soma das suas partes.

---

## P7 — A farmácia trabalha sem nós

**Afirma:** nenhuma funcionalidade pode tornar a plataforma necessária ao balcão.

**Porquê:** somos a camada de decisão, não a de operação. Uma indisponibilidade nossa tem de ser um
incómodo, nunca uma paragem. Daí o ciclo diário, o agente que tenta outra vez, a ingestão
idempotente e a recuperação automática do dia perdido.

**Preço:** desistimos de tudo o que exigiria ligação permanente ou resposta imediata.

**Violação:** funcionalidade que exija o agente online em contínuo; escrita síncrona no ERP a partir
de uma acção da UI; SLA implícito de tempo real.

---

## P8 — Dados antes de UI, mas UI honesta

**Afirma:** primeiro o dado está certo e é medível; depois mostra-se. E quando o dado é fraco, a UI
diz-lo em vez de o embelezar.

**Porquê:** a ordem inversa produz ecrãs bonitos sobre números errados — o pior resultado possível,
porque não há sinal de erro. É a razão de existirem `SyncRun`, `PipelineRun`, indicadores de
frescura de pipeline e o painel de saúde do enriquecimento.

**Preço:** o produto parece mais lento a evoluir. Há ecrãs deliberadamente vazios enquanto a
pipeline correspondente não é fiável.

**Violação:** mostrar zero quando o que se passa é "não sabemos"; esconder que o dado é de há dois
meses; construir ecrã antes de a pipeline estar validada.

---

## P9 — Simples até doer, e explícito onde é complexo

**Afirma:** preferir a solução mais simples que resolve o problema real; quando a complexidade é
irredutível, torná-la explícita e isolada em vez de a espalhar.

**Porquê:** as duas coisas andam juntas. O classificador de movimentos é complexo — mas é uma função
pura, testável, num ficheiro, com a especificação escrita no topo. O motor de resolução do catálogo
é complexo — mas está isolado e documentado. A complexidade que faz mal é a que está diluída em
vinte sítios sem nome.

**Preço:** por vezes escreve-se mais código para o manter simples de ler.

**Violação:** lógica de decisão dentro de um componente React; regra de negócio duplicada em dois
módulos; "esperteza" que poupa dez linhas e custa uma tarde a entender.

---

## P10 — O catálogo é o activo; o resto é software

**Afirma:** entre investir em funcionalidade e investir em qualidade de catálogo, ganha o catálogo.

**Porquê:** o software é replicável em meses; um catálogo português classificado, verificado e com
proveniência não é. É o único activo que se valoriza com o tempo e o único que cria vantagem
duradoura. Todas as decisões estruturais do catálogo derivam de o tratar assim.

**Preço:** funcionalidades visíveis esperam por trabalho invisível.

**Violação:** aceitar dados de catálogo fracos para acelerar um ecrã; deixar o catálogo depender de
um cliente; duplicar enriquecimento por conveniência.

---

## P11 — Idempotência e determinismo são requisitos de produto

**Afirma:** repetir uma operação não pode mudar o resultado. Reconstruir um artefacto a partir das
mesmas entradas tem de dar exactamente o mesmo artefacto.

**Porquê:** não é purismo técnico — é o que permite ao operador **repetir sem medo**. Um agente que
falha a meio, um cron que dispara duas vezes, um import interrompido: em todos os casos a resposta é
"corre outra vez", e isso só é aceitável se a repetição for inofensiva. É também o que torna um bug
reproduzível em vez de anedótico.

**Preço:** obriga a chaves naturais, watermarks, ordenação explícita e serialização canónica em
sítios onde "funcionava à mesma".

**Violação:** ingestão que duplica ao reenviar; build cujo resultado depende da hora; script
destrutivo sem `--dry-run` por omissão.

---

## P12 — O erro é visível ou não existe

**Afirma:** nenhuma falha é engolida. Melhor recusar com mensagem accionável do que continuar com
um valor por omissão.

**Porquê:** os processos correm sem ninguém a ver. Uma falha silenciosa transforma-se em dados
errados que só se descobrem semanas depois, quando já contaminaram decisões.

**Preço:** mais paragens visíveis; mais mensagens de erro para escrever bem.

**Violação:** `catch {}` sem log; fallback silencioso para outra base ou outro valor; job que devolve
sucesso quando não fez nada.

**Este é o princípio hoje mais violado** — ver [dívida técnica](./04-architecture-principles.md#8-dívida-técnica-registada).

---

## 2. Princípios que o briefing sugeriu e que não adoptei como estão

**"Automação antes de intervenção manual"** — verdadeiro para *processos* (ingestão, agregação,
enriquecimento) e falso para *decisões* (P4). Enunciado sem essa distinção, este princípio
justificaria encomendas automáticas. Adoptado na forma: **automatizar o trabalho, nunca o
julgamento**.

**"Qualidade antes de quantidade"** — subsumido por P2 e P10, que dizem a mesma coisa de forma
accionável. Isolado, é intenção sem consequência.

**"Operacional antes de estético"** — mantido dentro de P8, mas corrigido: não é licença para UI
pobre. Num produto que se abre todos os dias, clareza visual **é** função operacional. O que P8
proíbe é o estético a **esconder** o estado dos dados, não o estético.

---

## 3. Como usar isto para avaliar uma funcionalidade

Cinco perguntas, por ordem. A primeira resposta "não" pára o desenho.

1. **Viola algum princípio?** Se sim, ou o desenho muda, ou é preciso um ADR a alterar o princípio.
2. **De que qualidade de dados depende?** Se depende de campo com cobertura < 50 %, a
   funcionalidade é investir em cobertura, não em ecrã.
3. **Quem decide no fim?** Se a resposta for "o sistema", reler P4.
4. **Como se sabe que está a funcionar em produção?** Se não houver resposta, falta observabilidade
   e a funcionalidade não está pronta.
5. **O que acontece se correr duas vezes?** Se a resposta não for "nada", falta idempotência.

---

## 4. O que nunca deve ser feito

1. Mostrar um número que não se consegue explicar nem datar.
2. Executar uma decisão económica sem confirmação humana.
3. Preencher informação forte com inferência para "melhorar a cobertura".
4. Apagar dados por processo automático.
5. Criar dependência da plataforma para a operação de balcão.
6. Tratar o catálogo como tabela de apoio de um cliente.
