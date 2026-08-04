# SPharm.MT Architecture Book

Este é o documento de referência da arquitectura do SPharm.MT. Não descreve o código — descreve
**porque é que o sistema é como é**, que decisões foram tomadas, quais são inegociáveis, e como
avaliar o que vier a seguir.

O código muda. Este livro é escrito para lhe sobreviver.

---

## Para que serve

Três utilizações concretas, por ordem de frequência:

1. **Avaliar uma funcionalidade nova.** Antes de desenhar, lê o [manifesto](./01-manifesto.md) e os
   [princípios de arquitectura](./04-architecture-principles.md). Se a funcionalidade viola um
   princípio, ou o desenho está errado, ou o princípio precisa de mudar — e mudar um princípio é uma
   decisão consciente, não um efeito secundário de uma sprint.
2. **Entrar no projecto.** Um programador novo lê os capítulos 01 a 06 e percebe o sistema sem ler
   uma linha de código. Depois lê o capítulo do módulo em que vai trabalhar.
3. **Perceber uma decisão estranha.** Quase todas as decisões que parecem estranhas no código têm
   uma razão que não está no código. Está aqui.

## Para que NÃO serve

- **Não é documentação de API nem de código.** Não lista funções, não descreve assinaturas, não é
  gerado a partir de nada. Se puder ser gerado automaticamente, não pertence aqui.
- **Não é um manual de operação.** Runbooks, onboarding de farmácias e procedimentos de piloto
  vivem em `docs/` (raiz) — [`pilot-operator-guide.md`](../pilot-operator-guide.md),
  [`onboarding-real-pharmacy.md`](../onboarding-real-pharmacy.md), etc.
- **Não é um registo de investigação.** Análises, spikes e relatórios de progresso vivem em
  `notes/`. São válidos no dia em que foram escritos; este livro é válido até ser alterado.

---

## Índice

| # | Capítulo | Estado | Responde a |
|---|---|---|---|
| — | [README](./README.md) | ✅ escrito | Como usar este livro |
| 01 | [Manifesto](./01-manifesto.md) | ✅ escrito | O que é, o que não é, para quem, porquê |
| 02 | [Platform Overview](./02-platform-overview.md) | ✅ escrito | Componentes, fronteiras, fluxos |
| 03 | [Product Philosophy](./03-product-philosophy.md) | ✅ escrito | Princípios de produto e as suas consequências |
| 04 | [Architecture Principles](./04-architecture-principles.md) | ✅ escrito | Regras permanentes de engenharia |
| 05 | Domain Model | ⏳ por escrever | Entidades, invariantes, linguagem ubíqua |
| 06 | Multi-tenant | ⏳ por escrever | Isolamento, control plane, provisionamento |
| 07 | Catalog | ⏳ por escrever | O catálogo como activo; ver [Catalog Release System](./catalog-release-system.md) |
| 08 | Enrichment | ⏳ por escrever | Fontes, tiers, resolução por campo, curadoria |
| 09 | Dashboard | ⏳ por escrever | Que perguntas responde e porquê essas |
| 10 | Reporting | ⏳ por escrever | Modelo `Report`, exportação, email |
| 11 | Agents | ⏳ por escrever | Agente on-prem, ciclo de vida, versionamento |
| 12 | Data Ingestion | ⏳ por escrever | Bootstrap, sync diário, staging, canonicalização |
| 13 | Infrastructure | ⏳ por escrever | VPS, Postgres, processos, backups |
| 14 | Security | ⏳ por escrever | Autenticação, RBAC, segredos, superfície de ataque |
| 15 | Observability | ⏳ por escrever | `SyncRun`, `PipelineRun`, freshness, alertas |
| 16 | Deployment | ⏳ por escrever | Build, migrations, rollout, rollback |
| 17 | Roadmap | ⏳ por escrever | Direcção a 12–24 meses |

**Documentos de arquitectura fora da numeração:**

- [`catalog-release-system.md`](./catalog-release-system.md) — arquitectura aprovada do sistema de
  releases de catálogo. Será referenciado pelo capítulo 07 quando este existir.

Um capítulo por escrever é uma lacuna conhecida, não uma omissão. Escreve-se quando alguém precisar
dele — de preferência quem estiver a trabalhar nessa área.

---

## Relação com o código

O livro tem **precedência** sobre o código. Quando divergirem, uma das duas coisas é verdade:

- o código está errado → abre-se trabalho para o corrigir;
- o livro está desactualizado → actualiza-se **no mesmo PR** que muda o comportamento.

O que o livro **não** faz é acompanhar refactorizações internas. Mudar o nome de uma função,
extrair um módulo ou melhorar uma query não toca aqui. O livro muda quando muda uma **decisão** —
uma fronteira, uma responsabilidade, uma garantia, um princípio.

Regra prática: se conseguires descrever a alteração sem nomear ficheiros, provavelmente é uma
decisão e pertence ao livro. Se só a conseguires descrever nomeando ficheiros, não pertence.

## Relação com ADRs

Este livro descreve o **estado presente** da arquitectura, no presente do indicativo. Um ADR
descreve **uma decisão num momento**, com o contexto e as alternativas que existiam nesse momento,
e nunca é reescrito — é superado por outro ADR.

```
   ADR                              Architecture Book
   ───                              ─────────────────
   "Em 2026-08 decidimos X          "O sistema faz X."
    porque Y, apesar de Z."
   imutável, datado, com contexto    vivo, sempre no presente
   responde: porque decidimos        responde: o que é verdade hoje
```

Quando existirem, os ADRs vivem em `docs/architecture/adr/NNNN-titulo.md` com estado
`Proposto | Aceite | Superado por NNNN`. Uma decisão estrutural gera **os dois**: um ADR novo e uma
edição no capítulo afectado.

Hoje ainda não há ADRs formais. As decisões estruturais tomadas até agora estão registadas em
[`catalog-release-system.md`](./catalog-release-system.md) §1 e nos documentos de `notes/`. Converter
retroactivamente o histórico em ADRs não vale o esforço; começar a fazê-lo a partir da próxima
decisão vale.

---

## Quem escreve e quem actualiza

**Quem toma a decisão escreve.** Não há um dono da documentação separado de quem faz o sistema —
essa separação é a razão pela qual a documentação de arquitectura morre em quase todos os projectos.

| Situação | Acção obrigatória |
|---|---|
| Nova fronteira entre componentes | Capítulo 02 + ADR |
| Nova entidade de domínio ou invariante | Capítulo 05 |
| Alteração a um princípio | Capítulo 03 ou 04 + ADR (nunca em silêncio) |
| Nova dependência externa | Capítulo 02 (fronteiras) + capítulo 13 |
| Alteração ao modelo de isolamento ou de segurança | Capítulos 06 e 14 + ADR |
| Dívida técnica descoberta | Secção "Dívida" do capítulo afectado — **registar mesmo sem corrigir** |
| Refactorização interna | Nada |

A última linha é a mais importante e a mais ignorada: **registar dívida sem a corrigir é
trabalho legítimo e valioso.** Dívida conhecida e escrita é um risco gerido. Dívida conhecida e não
escrita é uma armadilha para quem vier a seguir.

---

## Como se lê um capítulo

Todos os capítulos respondem, pela mesma ordem:

1. **Porque existe** — o que se perderia se este componente não existisse.
2. **Que problema resolve** — em termos do negócio, não da tecnologia.
3. **Que decisões foram tomadas** — as escolhas reais, incluindo as que se rejeitaram.
4. **Porquê** — o raciocínio, com os factos que o suportavam na altura.
5. **Consequências** — o que ficou mais fácil e o que ficou mais difícil. Todas as decisões custam.
6. **Como deve evoluir** — a direcção pretendida e o que a desbloqueia.
7. **O que nunca deve ser feito** — os limites que, se forem atravessados, partem o sistema.

A secção 7 é a que dá valor ao livro. Um documento que só diz o que fazer é um tutorial; um que
diz o que **não** fazer é arquitectura.

---

## Convenções

- **Português europeu**, como o resto do repositório. Termos técnicos em inglês quando é o nome
  próprio da coisa (`outbox`, `tier`, `release`, `middleware`).
- **Factos com número** — "283 337 linhas", não "muitas linhas". Um facto sem número é uma opinião.
  Números medidos levam a data da medição.
- **Diagramas em ASCII**, dentro de blocos de código. Sobrevivem a `git diff`, a `grep` e a qualquer
  ferramenta de renderização.
- **Ligações relativas** para ficheiros do repositório, para que funcionem no GitHub e no editor.
- **Tom directo.** Sem "poderá eventualmente considerar-se". Ou é decisão, ou é questão em aberto e
  está identificada como tal.
