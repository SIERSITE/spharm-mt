# Validação do manual

## Base usada nas capturas e validações
Build de produção local = `feat/atualizacao-por-farmacia-menu` (d72ce1f) + `fix/relatorios-cabecalho-ver-em-ecra` (b63ceac), integradas em `integ/manual-capturas` (287bede, só local). Base comum: `e7db04071af7edbedc001bf75c73ef3e0bc4e808`. Verificação da integração: E2E `relatorios-cabecalho` 62 OK, E2E `ultima-atualizacao` 56 OK, E2E `vendas-opcoes-browser` 128 OK.

## PDF (`python validar_pdf.py SPharmMT-Manual-v1.0.pdf`)
- 32 páginas.
- Índice clicável: 15 entradas, cada uma leva à página do capítulo (conferido com os marcadores).
- Marcadores laterais: 50 (partes, 15 capítulos e secções), sem títulos duplicados.
- Ligações internas: 46, todas com destino válido, das quais 31 são as referências «ver capítulo N» do texto.
- Texto selecionável e pesquisável (31 499 caracteres; PDF etiquetado).
- Sem termos técnicos nem nomes de clientes no texto (verificado por expressão regular).
- Imagens: 25 no corpo; resolução efetiva mínima 106 dpi, mediana 128 dpi. A 100 % em A4, o texto de 12 px da aplicação mede ≈ 6,7 pt (tabelas densas ≈ 6 pt). Todas as páginas conferidas em miniatura; amostra a 100 % (96 dpi): página 16 (tabela de Vendas), legível.

## Instruções validadas no browser (dados sintéticos, base local)
Ver `scripts/e2e/manual-fase1..4.ts` e `manual-capturas-final.ts`. Resumo do que se confirmou: erros de entrada; menu por perfil e acesso direto a 9 rotas por 3 perfis; regras da password; mosaicos do Dashboard (ligações); pesquisa/filtros/cartões do Stock; ficha em painel, «Manter como tarefa» e extrato; Catálogo, editar designação (Administrador e Gestor de grupo sim; Gestor de farmácia e Operador não); Criar produto (validações, estado, pesquisa, CNP existente); Vendas (opções, «Agrupar por», encomenda, manutenção a somar ao mapa: 63 → 105 unidades); Margens (alterações por aplicar, CNPEM); Inventário; Excessos (limiar por omissão no browser); Transferências (criar, manutenção) e Oportunidades (criar); Encomendas (rascunho, finalizar); Devoluções; PDF e Excel descarregados; janela de email; filtros (Genérico 158→60, Forma 30, Ético/NETT 30, Fabricante 30, lista 4→3); separadores, Nova análise e F5.

## Dados de clientes reais
Nenhum nome, NIF, utilizador ou dado de cliente real: todas as imagens vêm de uma base local descartável com farmácias «Farmácia Central/do Mercado/Jardim», utilizador «Utilizador Exemplo», fabricantes «Laboratório Alfa…», distribuidoras «Norte/Sul» e produtos «… EXEMPLO …». Os textos técnicos que o ecrã ainda mostra foram ocultados nas capturas. As imagens foram revistas em folhas de contacto e nas páginas do PDF (25 usadas, de 27 capturadas); o texto do PDF foi varrido automaticamente.

## Limitações assumidas
- A paginação das imagens depende do tamanho da janela de captura (1120 px de largura); a aplicação em janelas maiores tem mais colunas por linha.
- O menu mostrado nas figuras 1.2 e 1.3 não inclui «Integração» nem «Manutenção do catálogo» (ocultados nas capturas: a primeira é técnica e a segunda depende do grupo).
- A identificação institucional da capa («SoftReis · SIER») é texto simples; não foi acrescentado logótipo.
