# Validação do manual (v1.0, revisão 2)

## Base das capturas
Branch candidata **`release/textos-tecnicos-restritos`** (e873cff): `d72ce1f` (atualização por farmácia + menu móvel) → `8bc6e04` (correções dos relatórios) → `123b693` (informação técnica só para técnicos) → `e873cff` (textos em linguagem corrente). Base comum: `e7db04071af7edbedc001bf75c73ef3e0bc4e808`. Build de produção local, PostgreSQL descartável, dados sintéticos.

## PDF (`python -X utf8 validar_pdf.py SPharmMT-Manual-v1.0.pdf`)
- 41 páginas: 27 verticais e 14 horizontais (A4 horizontal só para ecrãs largos).
- Índice clicável: 15 entradas, cada uma leva à página do capítulo.
- 50 marcadores laterais (partes, 15 capítulos, secções), sem títulos duplicados.
- 46 ligações internas válidas (31 são «ver capítulo N» no texto).
- Texto selecionável e pesquisável (PDF etiquetado).
- Sem termos técnicos nem nomes de clientes no texto (expressão regular).
- Imagens: 26 no corpo, resolução efetiva mínima **211 dpi**. Texto de interface de 12 px CSS: **≥ 8,1 pt** no papel (imagens de ecrã largo); nas 4 imagens estreitas (entrada e menus) o texto é de 14 px e mede ≥ 7,9 pt.
- Páginas conferidas em miniatura (todas) e a 100 % (amostra: páginas com figuras largas), legíveis.

## Instruções validadas no browser
`scripts/e2e/manual-fase1..4.ts` e `manual-capturas-v2.ts`. Confirmado, entre outros: erros de entrada; menu e acesso direto por perfil; regras da password; Dashboard; Stock (pesquisa, filtros, cartões), ficha e extrato; Catálogo, editar designação (Administrador e Gestor de grupo), Criar produto; Vendas («Agrupar por» só com âmbito Grupo; manutenção a somar ao mapa, 63 → 105 unidades; encomenda a partir das vendas), Margens, Inventário, Excessos, Transferências e Oportunidades (criar), Encomendas (rascunho, finalizar), Devoluções; PDF e Excel descarregados; janela de email; filtros (Genérico 158→60, Forma 30, Ético/NETT 30, Fabricante 30, lista 4→3); separadores, «Nova análise» e F5.

## Dados de clientes reais
Nenhum nome, NIF, utilizador ou dado de cliente real: base local descartável com «Farmácia Central/do Mercado/Jardim», «Utilizador Exemplo», «Laboratório Alfa…», «Distribuidora Norte/Sul» e «… EXEMPLO …». Já não é preciso ocultar texto técnico nas imagens: foi removido da aplicação (branch `release/textos-tecnicos-restritos`).

## Limitações assumidas
- O menu das figuras não inclui «Manutenção do catálogo» (depende do grupo) — o item não aparece na zona recortada.
- A capa usa a identificação em texto «SoftReis | SIER Group»: não existem no repositório logótipos oficiais da SoftReis/SIER (só o ícone do produto), por isso não foi usado nenhum.
- «Sincronizar agora» não está documentado (o resultado depende de resposta da farmácia, não verificável numa base de teste).
