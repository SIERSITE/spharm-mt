# Funcionalidades documentadas e excluídas

Regra: só entra no manual o que foi **confirmado no browser** (build integrada, dados sintéticos). O que só foi lido no código ficou de fora.

## Documentadas (15 capítulos)
1. **Entrar, navegar e «Última atualização»** — entrar/sair, mensagens de erro, menu e secções, comportamento por perfil, bloco «Última atualização» por farmácia, menu em telemóvel, alterar password (regras validadas).
2. **Dashboard** — mosaicos clicáveis, tendência, cartões, detalhe por farmácia.
3. **Stock e ficha do artigo** — pesquisa, filtros, cartões, colunas e estados, ficha em painel e em página, extrato de movimentos.
4. **Devoluções**.
5. **Catálogo e criar produto** — cartões, filtros, corrigir designação, criar produto (campos, validações, estado «Pendente», comportamento com CNP existente).
6. **Vendas e Manutenção de Vendas** — gerar, opções, tabela, «Agrupar por» (só com âmbito Grupo), encomenda a partir das vendas, manutenção (criar, lista, efeito em «Incluir manutenção de vendas»).
7. **Margens** — níveis, estados, aviso «alterações por aplicar», comparação CNPEM (designação oficial: Portaria n.º 224/2015, art. 3.º).
8. **Inventário** — vistas, estados, valorização.
9. **Excessos**.
10. **Transferências** (inclui Manutenção de transferências e **Oportunidades**, só com o comportamento validado: listar e criar transferência).
11. **Encomendas e propostas** — lista, nova encomenda, guardar rascunho, finalizar.
12. **Imprimir, PDF, Excel e email** — botões, nomes de ficheiro, janela de email, opções de preços (efeito validado pelo E2E `vendas-opcoes-browser`, 128 verificações).
13. **Filtros comuns** — painel, rótulos, farmácia, fabricante, forma farmacêutica, Ético/NETT (incl. «Divergente»), Genérico, lista de códigos; onde existe cada filtro.
14. **Espaços de trabalho e separadores** — separadores, «Nova análise», efeito do F5.
15. **Perguntas frequentes e glossário**.

«Depende do perfil ou do grupo» só aparece onde se confirmou diferença real: Utilizadores (Administrador); Encomendas, Transferências e Manutenção de Vendas (Operador volta ao Dashboard); Criar produto e edição de designação/fabricante (Administrador e Gestor de grupo); «Criar encomenda» com âmbito Grupo; «Última atualização» (todas as farmácias vs. só a sua); Manutenção do catálogo e «Editar nome do fabricante» (só em alguns grupos).

## Excluídas (de propósito)
- **Integração** e **Admin** (técnicos) e o ecrã técnico de **Email** (SMTP).
- Informação técnica de integração, agent, chaves, endpoints, filas, infraestrutura e bases de dados — incluindo textos técnicos que ainda aparecem no ecrã (aviso «StagingCompraRawLine» em Margens/Inventário, «pipeline de movimentos» no extrato, microtexto de «Sincronizar agora»); as imagens foram recortadas/ocultadas e o texto não os reproduz.
- **Sincronizar agora** (o texto do ecrã é técnico nesta versão).
- **Utilizadores** (gestão de contas): só referida como «só o Administrador».
- Oportunidades — bloco «DCI-equivalente» (não exercitado com dados) e cartão técnico do estado dos dados; valores em euros (ambíguos).
- Limiar de excesso: nenhum número é citado (o ecrã não o mostra e Dashboard, Stock e política do grupo usam valores diferentes).
- Genérico: a nuance «não genérico inclui artigos sem informação» (só lida no código).
- Anular/Eliminar encomendas e transferências (efeitos não confirmados nesta ronda).
