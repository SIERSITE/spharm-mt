# 01 — Manifesto

> O documento mais importante deste livro. Se um dia houver conflito entre este capítulo e qualquer
> outro, este ganha.

---

## 1. O que é o SPharm.MT

**O SPharm.MT é a camada de decisão de um grupo de farmácias.**

O ERP da farmácia — o SPharm, em SQL Server, na LAN de cada farmácia — regista o que aconteceu:
cada venda, cada entrada de stock, cada devolução, cada movimento. Fá-lo bem e é o sistema de
registo legal e operacional. O que o ERP não faz é responder a perguntas que atravessam o tempo, o
produto e, sobretudo, **as farmácias**:

- Este produto está parado aqui há três meses e em ruptura na farmácia ao lado?
- Vale a pena comprar, ou basta transferir?
- Que margem estou realmente a fazer nesta categoria, depois do IVA e dos bónus?
- Que artigos me consomem capital sem rotação?
- O que é isto que vendi 400 vezes e não sei sequer classificar?

O SPharm.MT existe para responder a isso. Lê o ERP de cada farmácia através de um agente local,
consolida num modelo próprio, enriquece o catálogo com informação que o ERP não tem, e devolve
decisões accionáveis: transferir, comprar, esperar, rever.

Uma frase para fixar: **o ERP sabe o que aconteceu; o SPharm.MT diz o que fazer a seguir.**

---

## 2. O que o SPharm.MT NÃO é

Esta secção protege o produto. Cada linha aqui já foi tentação em alguma reunião.

**Não é um ERP e nunca será.** Não faz atendimento, não emite facturas, não gere receituário, não
comunica com o INFARMED em nome da farmácia, não fecha caixa. Substituir o ERP significaria assumir
obrigação legal, certificação e responsabilidade operacional de balcão — um negócio diferente, com
outro risco e outro custo. O ERP é um parceiro permanente, não um alvo.

**Não é o sistema de registo.** Nenhum dado operacional nasce aqui. Vendas, stocks, compras,
devoluções e movimentos são **cópias derivadas** do ERP. Se a nossa base divergir do ERP, o ERP está
certo e nós estamos errados — sempre, sem discussão. É por isso que o módulo de extrato foi
construído para bater 1:1 com o ecrã do ERP: a paridade é a prova de que se pode confiar em tudo o
resto.

**Não é um sistema de escrita no ERP.** Há **uma única** excepção deliberada: as encomendas criadas
no SPharm.MT são exportadas para o ERP através do outbox. É um caminho estreito, explícito,
idempotente, auditado e desligável por feature flag. Qualquer proposta de alargar a escrita ao ERP
começa como *não* e tem de ganhar o direito de ser discutida.

**Não é uma ferramenta de BI genérica.** Não há construtor de dashboards, nem SQL livre, nem
"arrasta a dimensão para a linha". Um BI genérico devolve a pergunta ao utilizador. Nós respondemos
a um conjunto pequeno de perguntas que valem dinheiro, com a resposta já formada. Menos flexível,
muito mais útil.

**Não é um sistema em tempo real.** O ciclo é diário e assume-se. As decisões que suportamos —
comprar, transferir, rever margem — não mudam ao minuto. Prometer tempo real obrigaria a ligação
permanente à LAN da farmácia e transformaria cada corte de rede numa avaria nossa.

**Não é um produto para farmácia isolada.** O valor cresce com o número de farmácias do grupo: sem
segunda farmácia não há transferência, não há comparação, não há excedente aproveitável. Uma
farmácia isolada tira daqui talvez 30 % do valor. Isso não é um defeito a corrigir — é a definição
do mercado.

---

## 3. Quem usa

| Papel | O que quer | Onde vive isso |
|---|---|---|
| **Gestor de grupo** | Ver as farmácias todas ao mesmo tempo; decidir onde está o capital parado; comprar melhor por escala. | Dashboard consolidado, excessos, transferências, margens |
| **Gestor de farmácia** | Não ter rupturas; não acumular stock morto; justificar decisões de compra. | Encomendas, stock, oportunidades, extrato |
| **Operador** | Consultar. Não decide, não configura. | Leitura em toda a aplicação |
| **Administrador do grupo** | Utilizadores, integrações, configuração de email. | Configurações |
| **Administrador da plataforma** (nós) | Criar clientes, provisionar bases, gerar agentes, vigiar pipelines. | `/admin`, Admin Wizard, scripts de tenancy |

E dois "utilizadores" que não são pessoas, mas condicionam tudo:

- **O agente local**, que corre no PC da farmácia e é o único canal entre o ERP e a plataforma.
- **O catálogo**, que é consumido por todos os módulos e não pertence a nenhum.

**Nota deliberada:** o cliente da farmácia não é utilizador. Não há app do doente, não há montra
online, não há reserva. Se um dia houver, é outro produto, com outro nome.

---

## 4. Porque existe

Três factos do negócio que explicam a plataforma inteira.

**1. O stock é capital imobilizado, e as farmácias não o vêem como tal.** Um grupo com quatro
farmácias tem tipicamente dezenas de milhares de euros parados em artigos que outra farmácia do
mesmo grupo está a comprar ao fornecedor nesse mesmo dia. O ERP não mostra isto porque cada
instalação só se vê a si própria. Ver a rede inteira é a primeira razão de existir.

**2. Os dados do ERP são operacionalmente completos e analiticamente pobres.** O ERP sabe que
vendeu o artigo 1234567; não sabe fiavelmente que é um analgésico, de que fabricante, com que DCI,
em que categoria comercial. Sem isso não há análise por categoria, por substância, por fabricante —
que é exactamente o nível a que se negoceia e se decide. Enriquecer o catálogo é a segunda razão.

**3. A decisão está a ser tomada de cabeça.** Comprar por hábito, transferir por telefone, avaliar
margem por sensação. Não porque o gestor seja descuidado, mas porque calcular à mão o que
justificaria a decisão é impossível em vinte mil referências. Substituir intuição por conta feita é
a terceira razão.

---

## 5. Problemas que resolve, por ordem de valor

1. **Stock parado com procura noutra farmácia do grupo** — detecção de excedentes e proposta de
   transferência. É o que paga a plataforma.
2. **Ruptura previsível** — cobertura em dias por artigo e farmácia, com proposta de encomenda.
3. **Comprar o que já se tem** — a proposta de encomenda considera excedentes internos primeiro e
   só depois sugere compra.
4. **Catálogo cego** — classificação canónica, DCI, ATC, fabricante e imagem sobre artigos que no
   ERP são só uma designação.
5. **Margem real desconhecida** — margem por artigo, categoria e farmácia, com IVA e custo reais.
6. **Substituição por equivalente** — quando o artigo pedido não existe mas há equivalente por DCI
   ou por marca própria, propor em vez de comprar.
7. **Sem visão de grupo** — dashboard consolidado que o ERP estrutural­mente não pode dar.

Nenhum destes problemas é resolvido por "mais dados". Todos são resolvidos por **dados
confiáveis + uma regra explícita + uma pessoa a decidir**.

---

## 6. Filosofia operacional

Sete posições que atravessam todas as decisões técnicas do sistema.

### 6.1 O ERP manda

Divergência entre nós e o ERP é sempre bug nosso. Daí a obsessão com paridade: o extrato de
movimentos foi reconstruído até bater 1:1 com o ecrã do ERP, incluindo composição de documento,
contraparte e split de bónus. Não porque alguém precise de ver o extrato aqui — mas porque um
gestor que encontra uma divergência num número deixa de acreditar em todos os outros.

### 6.2 A farmácia tem de conseguir trabalhar sem nós

Se a plataforma estiver em baixo, a farmácia vende à mesma. O agente falha e tenta outra vez; a
ingestão é idempotente; um dia perdido recupera-se no dia seguinte sem intervenção. Nunca
introduzir dependência síncrona da plataforma no balcão.

### 6.3 Sugerir, nunca decidir sozinho

O motor de propostas classifica cada artigo em TRANSFERÊNCIA, COMPRAR, AGUARDAR ou ADEQUADO — e
pára aí. A encomenda só existe quando uma pessoa a confirma. Automação total do reabastecimento é
tecnicamente fácil e comercialmente suicida: o primeiro erro caro destrói a confiança acumulada em
meses.

### 6.4 Transferir antes de comprar

É uma regra de negócio, não uma optimização. O excedente de uma farmácia é a primeira fonte de
abastecimento das outras. A compra é o que sobra depois de esgotada a rede.

### 6.5 Informação verificável antes de inferência

Um valor com origem regulamentar vale mais do que um valor deduzido de um padrão no texto — e o
sistema sabe a diferença, guarda-a e usa-a para decidir. É a razão de existir o modelo de *tiers*
(REGULATORY > MANUFACTURER > DISTRIBUTOR > RETAIL > INTERNAL_INFERRED). Um sistema que não sabe de
onde vem cada valor acaba, inevitavelmente, a substituir bom por mau.

### 6.6 Cada número tem de ser explicável

Um número que o gestor não consegue justificar perante o sócio é um número que não usa. Por isso há
drill-down do agregado ao movimento, proveniência por campo no catálogo, e a recusa em mostrar
indicadores cuja frescura não conseguimos garantir.

### 6.7 O catálogo é o activo, não o software

O software é substituível; um catálogo português enriquecido, classificado e verificado, construído
ao longo de anos, não é. É a única coisa aqui que se valoriza com o tempo e que um concorrente não
consegue copiar em três meses. Todas as decisões de arquitectura do catálogo — Store dedicado,
releases imutáveis, proveniência por campo — decorrem de o tratar como activo, e não como uma
tabela de apoio.

---

## 7. Visão de longo prazo

**Horizonte 1 — o grupo (é onde estamos).** Uma plataforma que um grupo de farmácias abre todos os
dias para decidir compras e transferências. Sucesso mede-se em rotação de stock e rupturas
evitadas, não em utilizadores activos.

**Horizonte 2 — a plataforma multi-cliente.** N grupos independentes, isolados por base de dados,
provisionados em minutos, todos a nascer do mesmo Catalog Release. O catálogo deixa de ser
propriedade de qualquer cliente e passa a ser infra-estrutura partilhada. É para aqui que aponta o
[Catalog Release System](./catalog-release-system.md).

**Horizonte 3 — o efeito de rede do conhecimento.** Quantas mais farmácias, melhor o catálogo:
mais CNPs vistos, mais correcções, mais sinal. Esse conhecimento volta a todos os clientes através
do release seguinte — **sem que nenhum dado operacional atravesse a fronteira entre clientes**.
Esta é a única forma de efeito de rede aceitável neste negócio, e a fronteira é inviolável.

O que a visão **não** inclui, e é decisão e não omissão: marketplace, compra directa a
fornecedores, app para o doente, integração com outros ERPs antes de o SPharm estar esgotado como
mercado.

---

## 8. O que nunca deve ser feito

1. **Escrever no ERP fora do caminho do outbox.** Uma única escrita não auditada e não idempotente
   basta para corromper o sistema de registo de um cliente.
2. **Tratar a nossa base como fonte de verdade operacional.** Se um relatório contradiz o ERP, o
   relatório está errado.
3. **Deixar dados de um cliente influenciarem outro.** O conhecimento de catálogo é partilhável; o
   dado operacional nunca, sob nenhuma forma, nem agregado.
4. **Automatizar a decisão de compra sem confirmação humana.**
5. **Prometer tempo real.**
6. **Deixar o catálogo depender de um tenant.** É a razão pela qual o Catalog Release System existe.
7. **Adicionar uma funcionalidade que exija ligação permanente à LAN da farmácia.**
8. **Sobrepor informação forte com informação fraca** — em qualquer módulo, não só no catálogo.
