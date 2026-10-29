# Validacao entre tenants da classificacao do produto (Etico_NETT / Generico)

Objetivo: confirmar, com o MESMO diagnostico (pacote v2, `classification-audit`, base rev98, so leitura), que a
estrutura que a Silveirense mostrou (FK `Stocks.Etico_NETT -> dbo.Etico_NETT.Codigo`, 5 linhas, `Stocks.Generico bit`)
e igual noutras farmacias (Garantia e, se acessivel, SIER) ANTES de fixar o modelo (Entrega B). Nada aqui altera
codigo, ERP, rev98 ou tarefa agendada.

## 1. Em cada farmacia (uma de cada vez; cada ERP = uma farmacia)

1. Seguir o `LEIAME-INSTALACAO.txt` da entrega (validar tarefa/rev98 -> instalar lado a lado -> executar UMA auditoria ->
   recolher -> remover).
2. (Opcional, recomendado) exportar do MT os CNPs dessa farmacia com `scripts/diagnostics/cnps-mt-readonly.sql`
   (ver `notes/cnps-mt-exportacao.md`), copiar o ficheiro para a pasta do diagnostico e executar:

        cd C:\SPharm_MT\spharmmt-classification-audit
        .\Run-ClassificationAudit.ps1 -CnpsMtFicheiro .\cnps-mt.txt

   Sem o ficheiro, os universos "existente no MT" e a cobertura ficam "nao calculado" e o resto do relatorio e igual.
3. Recolher: `.\Collect-ClassificationAuditReport.ps1` -> `entrega\auditoria-classificacao-<UTC>.zip`
   (so `auditoria-classificacao.json/.md` + hashes).

O relatorio so identifica a farmacia pelo NOME DA BASE (`cabecalho.baseDados`); nao contem credenciais, anfitriao,
slug do tenant, nome do ficheiro MT, nomes de produtos, precos nem clientes.

## 2. A "impressao" do ambiente (cabecalho do relatorio)

`cabecalho.impressao` (e a linha "Impressao do ambiente" do Markdown) e um conjunto de hashes SHA-256 em grupos de 8
hex, comparavel entre farmacias sem expor nada:

| campo | o que e |
|---|---|
| `lookup` | hash do lookup `dbo.Etico_NETT` normalizado (linhas `codigo=descricao normalizada`, ordenadas) ou `sem-lookup` |
| `colunasStocks` | hash da lista (minusculas, ordenada) de nomes de colunas de `dbo.Stocks` |
| `combinada` / `curta` | hash dos dois anteriores / primeiros 12 hex em grupos de 4 (comparar a vista) |

Se `combinada` for igual entre duas farmacias, o lookup (codigos, descricoes normalizadas) e as colunas de `Stocks` sao
identicos. Se diferir, o campo que difere diz o que ver primeiro (lookup ou colunas).

## 3. Comparar relatorios (offline, sem ligar a nada)

Reunir os `.json` recolhidos numa pasta local e correr, em qualquer PowerShell 5.1:

    .\Compare-AuditReports.ps1 -Reports C:\r\silveirense.json, C:\r\garantia.json, C:\r\sier.json -Out C:\r\comparacao.txt

(`Compare-AuditReports.ps1` esta em `agent/audit/` e e entregue ao lado do pacote; nao vai no ZIP do diagnostico.)
Le so os `.json`, escreve so no stdout e no `-Out`, nunca sobrescreve um relatorio e aceita relatorios v1 (campos em
falta = `n/d`). Imprime, com `<-- DIFERENTE` onde divergem:

1. cabecalho e impressao (SQL Server, impressao combinada, do lookup, das colunas);
2. lookup `Etico_NETT`: por codigo, descricao crua -> normalizada -> categoria proposta; alertas do mapeamento
   (descricao que nao mapeia, duas linhas na mesma categoria, codigo diferente da Silveirense 1..5, orfaos, NULL);
3. colunas de `dbo.Stocks` que faltam numa farmacia e colunas com tipo/anulabilidade diferentes;
4. `Generico`: tipo, anulavel, default e nº de NULL em `Stocks`, `Stocks_Histo`, `Stocks_HistoF`;
5. contagens por categoria (universo total, sincronizavel daily/bootstrap, Servicos incluidos/excluidos);
6. `Processa_Stocks` (= 0, <> 0, NULL, catalogo ativo);
7. universo MT, cobertura e divergencias MT x ERP de `Generico` (explicadas por `manual` ou nao);
8. resumo com o nº de diferencas estruturais.

Contagens diferentes entre farmacias sao esperadas; o que decide e a ESTRUTURA (1 a 4).

## 4. Criterio para avancar

Avancar com um modelo unico por descricao normalizada so se, nas farmacias comparadas:
- as impressoes do lookup coincidem, ou as diferencas sao so de descricao com a mesma categoria proposta;
- nao ha `UNKNOWN`/orfaos relevantes nem codigos que nao existam na Silveirense sem explicacao;
- `Stocks.Generico` tem o mesmo tipo e anulabilidade (ou a diferenca esta documentada);
- as divergencias MT x ERP de `Generico` sao 0 ou todas explicadas por `manual`.
Qualquer outra coisa: parar e decidir com quem conhece o ERP dessa farmacia.

## 5. Limitacoes

- Nunca correu num SQL Server real (so contra um ERP sintetico); a 1.ª execucao real e a da Silveirense.
- O historico (`Stocks_Histo`/`Stocks_HistoF`) usa `LAG` (SQL Server 2012+); em versoes anteriores a consulta falha e
  fica um aviso no relatorio (o resto corre).
- Se `Stocks.Codigo` for texto com zeros a esquerda, o cruzamento com os CNP do MT (sem zeros a esquerda) pode falhar.
