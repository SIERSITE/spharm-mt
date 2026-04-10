-- CreateEnum
CREATE TYPE "UtilizadorPerfil" AS ENUM ('ADMINISTRADOR', 'GESTOR_GRUPO', 'GESTOR_FARMACIA');

-- CreateEnum
CREATE TYPE "EntidadeEstado" AS ENUM ('ATIVO', 'INATIVO');

-- CreateEnum
CREATE TYPE "ProdutoEstado" AS ENUM ('NOVO', 'PENDENTE', 'PARCIALMENTE_ENRIQUECIDO', 'ENRIQUECIDO_AUTOMATICAMENTE', 'VALIDADO', 'INATIVO');

-- CreateEnum
CREATE TYPE "ProdutoOrigemDados" AS ENUM ('EXCEL', 'FARMACIA', 'ENRIQUECIMENTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "FornecedorTipo" AS ENUM ('COOPERATIVA', 'LABORATORIO_DIRETO', 'DISTRIBUIDOR', 'OUTRO');

-- CreateEnum
CREATE TYPE "TipoClassificacao" AS ENUM ('NIVEL_1', 'NIVEL_2');

-- CreateEnum
CREATE TYPE "TipoVenda" AS ENUM ('RECEITA', 'SEM_RECEITA', 'VENDA_LIVRE', 'OUTRO');

-- CreateEnum
CREATE TYPE "TipoDevolucao" AS ENUM ('CLIENTE', 'FORNECEDOR', 'OUTRA');

-- CreateEnum
CREATE TYPE "PrioridadeRevisao" AS ENUM ('ALTA', 'MEDIA', 'BAIXA');

-- CreateEnum
CREATE TYPE "EstadoFilaRevisao" AS ENUM ('PENDENTE', 'RESOLVIDO', 'IGNORADO');

-- CreateEnum
CREATE TYPE "TipoRevisao" AS ENUM ('NOVO_PRODUTO', 'ENRIQUECIMENTO_FALHOU', 'CONFLITO', 'CLASSIFICACAO_PENDENTE', 'FABRICANTE_PENDENTE', 'OUTRO');

-- CreateEnum
CREATE TYPE "EstadoListaEncomenda" AS ENUM ('RASCUNHO', 'FINALIZADA', 'EXPORTADA');

-- CreateEnum
CREATE TYPE "TipoLoteIngestao" AS ENUM ('FICHA', 'STOCK', 'VENDAS', 'VENDAS_MENSAIS', 'COMPRAS', 'DEVOLUCOES', 'AJUSTES_STOCK', 'INVENTARIO', 'PRODUTOS_INTERNOS');

-- CreateEnum
CREATE TYPE "EstadoLoteIngestao" AS ENUM ('RECEBIDO', 'EM_PROCESSAMENTO', 'PROCESSADO', 'FALHOU');

-- CreateEnum
CREATE TYPE "ClassificacaoRotacao" AS ENUM ('NORMAL', 'ATENCAO', 'SEM_ROTACAO');

-- CreateEnum
CREATE TYPE "ClassificacaoABC" AS ENUM ('A', 'B', 'C', 'NAO_CLASSIFICADO');

-- CreateEnum
CREATE TYPE "EnriquecimentoEstado" AS ENUM ('PENDENTE', 'EM_PROCESSAMENTO', 'SUCESSO', 'SUCESSO_PARCIAL', 'FALHOU');

-- CreateEnum
CREATE TYPE "TipoAjusteStock" AS ENUM ('POSITIVO', 'NEGATIVO', 'CORRECAO', 'QUEBRA', 'PERDA', 'OUTRO');

-- CreateEnum
CREATE TYPE "EstadoInventario" AS ENUM ('RASCUNHO', 'FECHADO', 'PROCESSADO', 'CANCELADO');

-- CreateTable
CREATE TABLE "Produto" (
    "id" TEXT NOT NULL,
    "cnp" INTEGER NOT NULL,
    "designacao" TEXT NOT NULL,
    "fabricanteId" TEXT,
    "classificacaoNivel1Id" TEXT,
    "classificacaoNivel2Id" TEXT,
    "tipoArtigo" TEXT,
    "codigoATC" TEXT,
    "dci" TEXT,
    "imagemUrl" TEXT,
    "flagGenerico" BOOLEAN NOT NULL DEFAULT false,
    "flagMSRM" BOOLEAN NOT NULL DEFAULT false,
    "flagMNSRM" BOOLEAN NOT NULL DEFAULT false,
    "grupoHomogeneo" TEXT,
    "estado" "ProdutoEstado" NOT NULL DEFAULT 'PENDENTE',
    "origemDados" "ProdutoOrigemDados" NOT NULL DEFAULT 'FARMACIA',
    "validadoManualmente" BOOLEAN NOT NULL DEFAULT false,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Produto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fabricante" (
    "id" TEXT NOT NULL,
    "nomeNormalizado" TEXT NOT NULL,
    "paisOrigem" TEXT,
    "estado" "EntidadeEstado" NOT NULL DEFAULT 'ATIVO',
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fabricante_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FabricanteAlias" (
    "id" TEXT NOT NULL,
    "fabricanteId" TEXT NOT NULL,
    "aliasNome" TEXT NOT NULL,

    CONSTRAINT "FabricanteAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Classificacao" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" "TipoClassificacao" NOT NULL,
    "classificacaoPaiId" TEXT,
    "estado" "EntidadeEstado" NOT NULL DEFAULT 'ATIVO',
    "ordem" INTEGER,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Classificacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fornecedor" (
    "id" TEXT NOT NULL,
    "nomeNormalizado" TEXT NOT NULL,
    "tipo" "FornecedorTipo" NOT NULL DEFAULT 'OUTRO',
    "estado" "EntidadeEstado" NOT NULL DEFAULT 'ATIVO',
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Fornecedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FornecedorAlias" (
    "id" TEXT NOT NULL,
    "fornecedorId" TEXT NOT NULL,
    "aliasNome" TEXT NOT NULL,

    CONSTRAINT "FornecedorAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Farmacia" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "codigoANF" TEXT,
    "morada" TEXT,
    "contacto" TEXT,
    "estado" "EntidadeEstado" NOT NULL DEFAULT 'ATIVO',
    "dataAdesao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Farmacia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Utilizador" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "perfil" "UtilizadorPerfil" NOT NULL,
    "farmaciaId" TEXT,
    "estado" "EntidadeEstado" NOT NULL DEFAULT 'ATIVO',
    "passwordHash" TEXT,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Utilizador_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProdutoFarmacia" (
    "id" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "designacaoLocal" TEXT,
    "pvp" DECIMAL(12,4),
    "pmc" DECIMAL(12,4),
    "puc" DECIMAL(12,4),
    "stockAtual" DECIMAL(14,3),
    "stockRaw" DECIMAL(14,3),
    "stockMinimo" DECIMAL(14,3),
    "stockMaximo" DECIMAL(14,3),
    "fornecedorHabitualId" TEXT,
    "dataUltimaVenda" TIMESTAMP(3),
    "dataUltimaCompra" TIMESTAMP(3),
    "validadeMaisAntiga" TIMESTAMP(3),
    "flagRetirado" BOOLEAN NOT NULL DEFAULT false,
    "modeloGestaoStock" TEXT,
    "familiaOrigem" TEXT,
    "categoriaOrigem" TEXT,
    "subcategoriaOrigem" TEXT,
    "fabricanteOrigem" TEXT,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProdutoFarmacia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProdutoInterno" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "codigoInterno" INTEGER NOT NULL,
    "designacao" TEXT,
    "tipoArtigo" TEXT,
    "pvp" DECIMAL(12,4),
    "puc" DECIMAL(12,4),
    "stockAtual" DECIMAL(14,3),
    "flagRetirado" BOOLEAN NOT NULL DEFAULT false,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,
    "loteIngestaoId" TEXT,

    CONSTRAINT "ProdutoInterno_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venda" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "quantidade" DECIMAL(14,3) NOT NULL,
    "valorTotal" DECIMAL(14,2) NOT NULL,
    "valorUnitario" DECIMAL(12,4),
    "custoUnitario" DECIMAL(12,4),
    "tipoVenda" "TipoVenda",
    "valorComparticipacao" DECIMAL(14,2),
    "valorPagoUtente" DECIMAL(14,2),
    "numeroTransacoes" INTEGER,
    "dataIngestao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loteIngestaoId" TEXT,

    CONSTRAINT "Venda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendaMensal" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "ano" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "quantidade" DECIMAL(14,3) NOT NULL,
    "valorTotal" DECIMAL(14,2) NOT NULL,
    "mesCompleto" BOOLEAN NOT NULL DEFAULT true,
    "origemBootstrap" BOOLEAN NOT NULL DEFAULT false,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,
    "loteIngestaoId" TEXT,

    CONSTRAINT "VendaMensal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Compra" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "fornecedorId" TEXT,
    "data" TIMESTAMP(3) NOT NULL,
    "quantidade" DECIMAL(14,3) NOT NULL,
    "valorTotal" DECIMAL(14,2) NOT NULL,
    "precoUnitario" DECIMAL(12,4),
    "descontoBonificacao" DECIMAL(14,2),
    "numeroDocumento" TEXT,
    "dataIngestao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loteIngestaoId" TEXT,

    CONSTRAINT "Compra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Devolucao" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "quantidade" DECIMAL(14,3) NOT NULL,
    "valor" DECIMAL(14,2) NOT NULL,
    "tipo" "TipoDevolucao" NOT NULL,
    "motivo" TEXT,
    "fornecedorDestinoId" TEXT,
    "dataIngestao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loteIngestaoId" TEXT,

    CONSTRAINT "Devolucao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricoStock" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "dataFotografia" TIMESTAMP(3) NOT NULL,
    "quantidade" DECIMAL(14,3) NOT NULL,
    "valorCusto" DECIMAL(14,2),
    "loteIngestaoId" TEXT,

    CONSTRAINT "HistoricoStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AjusteStock" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "produtoId" TEXT,
    "produtoInternoId" TEXT,
    "data" TIMESTAMP(3) NOT NULL,
    "tipo" "TipoAjusteStock" NOT NULL,
    "quantidade" DECIMAL(14,3) NOT NULL,
    "valor" DECIMAL(14,2),
    "motivo" TEXT,
    "observacoes" TEXT,
    "dataIngestao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loteIngestaoId" TEXT,

    CONSTRAINT "AjusteStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventario" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "nome" TEXT,
    "dataInventario" TIMESTAMP(3) NOT NULL,
    "estado" "EstadoInventario" NOT NULL DEFAULT 'RASCUNHO',
    "observacoes" TEXT,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,
    "loteIngestaoId" TEXT,

    CONSTRAINT "Inventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinhaInventario" (
    "id" TEXT NOT NULL,
    "inventarioId" TEXT NOT NULL,
    "produtoId" TEXT,
    "produtoInternoId" TEXT,
    "stockSistema" DECIMAL(14,3),
    "stockContado" DECIMAL(14,3) NOT NULL,
    "diferenca" DECIMAL(14,3),
    "valorDiferenca" DECIMAL(14,2),
    "observacoes" TEXT,

    CONSTRAINT "LinhaInventario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndicadoresProdutoFarmacia" (
    "id" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "mediaVendasDiarias30d" DECIMAL(14,4),
    "mediaVendasDiarias90d" DECIMAL(14,4),
    "mediaVendasMensais3m" DECIMAL(14,4),
    "mediaVendasMensais12m" DECIMAL(14,4),
    "diasStockRestante" DECIMAL(14,2),
    "diasSemVenda" INTEGER,
    "ultimoPrecoCompra" DECIMAL(12,4),
    "ultimoFornecedorId" TEXT,
    "classificacaoABC" "ClassificacaoABC" NOT NULL DEFAULT 'NAO_CLASSIFICADO',
    "classificacaoRotacao" "ClassificacaoRotacao" NOT NULL DEFAULT 'NORMAL',
    "valorStockParado" DECIMAL(14,2),
    "dataCalculo" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndicadoresProdutoFarmacia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListaEncomenda" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "estado" "EstadoListaEncomenda" NOT NULL DEFAULT 'RASCUNHO',
    "criadoPorId" TEXT NOT NULL,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListaEncomenda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinhaEncomenda" (
    "id" TEXT NOT NULL,
    "listaEncomendaId" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "quantidadeSugerida" DECIMAL(14,3),
    "quantidadeAjustada" DECIMAL(14,3),
    "fornecedorSugeridoId" TEXT,
    "notas" TEXT,

    CONSTRAINT "LinhaEncomenda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilaRevisao" (
    "id" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "tipoRevisao" "TipoRevisao" NOT NULL,
    "prioridade" "PrioridadeRevisao" NOT NULL DEFAULT 'MEDIA',
    "dadosOrigem" JSONB,
    "estado" "EstadoFilaRevisao" NOT NULL DEFAULT 'PENDENTE',
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataResolucao" TIMESTAMP(3),

    CONSTRAINT "FilaRevisao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnriquecimentoFila" (
    "id" TEXT NOT NULL,
    "produtoId" TEXT NOT NULL,
    "prioridade" "PrioridadeRevisao" NOT NULL DEFAULT 'MEDIA',
    "ultimaTentativa" TIMESTAMP(3),
    "numeroTentativas" INTEGER NOT NULL DEFAULT 0,
    "estado" "EnriquecimentoEstado" NOT NULL DEFAULT 'PENDENTE',
    "ultimaFonte" TEXT,
    "mensagemErro" TEXT,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnriquecimentoFila_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoteIngestao" (
    "id" TEXT NOT NULL,
    "farmaciaId" TEXT NOT NULL,
    "tipo" "TipoLoteIngestao" NOT NULL,
    "dataReferencia" TIMESTAMP(3) NOT NULL,
    "dataProcessamento" TIMESTAMP(3),
    "estado" "EstadoLoteIngestao" NOT NULL DEFAULT 'RECEBIDO',
    "totalRegistos" INTEGER,
    "totalAceites" INTEGER,
    "totalRejeitados" INTEGER,
    "mensagemErro" TEXT,
    "nomeFicheiro" TEXT,
    "blobUrl" TEXT,
    "hashConteudo" TEXT,
    "dataCriacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataAtualizacao" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoteIngestao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Produto_cnp_key" ON "Produto"("cnp");

-- CreateIndex
CREATE INDEX "Produto_fabricanteId_idx" ON "Produto"("fabricanteId");

-- CreateIndex
CREATE INDEX "Produto_classificacaoNivel1Id_idx" ON "Produto"("classificacaoNivel1Id");

-- CreateIndex
CREATE INDEX "Produto_classificacaoNivel2Id_idx" ON "Produto"("classificacaoNivel2Id");

-- CreateIndex
CREATE INDEX "Produto_estado_idx" ON "Produto"("estado");

-- CreateIndex
CREATE UNIQUE INDEX "Fabricante_nomeNormalizado_key" ON "Fabricante"("nomeNormalizado");

-- CreateIndex
CREATE INDEX "FabricanteAlias_aliasNome_idx" ON "FabricanteAlias"("aliasNome");

-- CreateIndex
CREATE UNIQUE INDEX "FabricanteAlias_fabricanteId_aliasNome_key" ON "FabricanteAlias"("fabricanteId", "aliasNome");

-- CreateIndex
CREATE INDEX "Classificacao_tipo_idx" ON "Classificacao"("tipo");

-- CreateIndex
CREATE INDEX "Classificacao_classificacaoPaiId_idx" ON "Classificacao"("classificacaoPaiId");

-- CreateIndex
CREATE UNIQUE INDEX "Classificacao_nome_tipo_classificacaoPaiId_key" ON "Classificacao"("nome", "tipo", "classificacaoPaiId");

-- CreateIndex
CREATE UNIQUE INDEX "Fornecedor_nomeNormalizado_key" ON "Fornecedor"("nomeNormalizado");

-- CreateIndex
CREATE INDEX "FornecedorAlias_aliasNome_idx" ON "FornecedorAlias"("aliasNome");

-- CreateIndex
CREATE UNIQUE INDEX "FornecedorAlias_fornecedorId_aliasNome_key" ON "FornecedorAlias"("fornecedorId", "aliasNome");

-- CreateIndex
CREATE INDEX "Farmacia_codigoANF_idx" ON "Farmacia"("codigoANF");

-- CreateIndex
CREATE UNIQUE INDEX "Farmacia_nome_key" ON "Farmacia"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "Utilizador_email_key" ON "Utilizador"("email");

-- CreateIndex
CREATE INDEX "ProdutoFarmacia_farmaciaId_idx" ON "ProdutoFarmacia"("farmaciaId");

-- CreateIndex
CREATE INDEX "ProdutoFarmacia_produtoId_idx" ON "ProdutoFarmacia"("produtoId");

-- CreateIndex
CREATE INDEX "ProdutoFarmacia_fornecedorHabitualId_idx" ON "ProdutoFarmacia"("fornecedorHabitualId");

-- CreateIndex
CREATE INDEX "ProdutoFarmacia_flagRetirado_idx" ON "ProdutoFarmacia"("flagRetirado");

-- CreateIndex
CREATE UNIQUE INDEX "ProdutoFarmacia_produtoId_farmaciaId_key" ON "ProdutoFarmacia"("produtoId", "farmaciaId");

-- CreateIndex
CREATE INDEX "ProdutoInterno_farmaciaId_idx" ON "ProdutoInterno"("farmaciaId");

-- CreateIndex
CREATE INDEX "ProdutoInterno_codigoInterno_idx" ON "ProdutoInterno"("codigoInterno");

-- CreateIndex
CREATE UNIQUE INDEX "ProdutoInterno_farmaciaId_codigoInterno_key" ON "ProdutoInterno"("farmaciaId", "codigoInterno");

-- CreateIndex
CREATE INDEX "Venda_farmaciaId_data_idx" ON "Venda"("farmaciaId", "data");

-- CreateIndex
CREATE INDEX "Venda_produtoId_data_idx" ON "Venda"("produtoId", "data");

-- CreateIndex
CREATE INDEX "Venda_farmaciaId_produtoId_data_idx" ON "Venda"("farmaciaId", "produtoId", "data");

-- CreateIndex
CREATE INDEX "Venda_loteIngestaoId_idx" ON "Venda"("loteIngestaoId");

-- CreateIndex
CREATE INDEX "VendaMensal_ano_mes_idx" ON "VendaMensal"("ano", "mes");

-- CreateIndex
CREATE INDEX "VendaMensal_farmaciaId_ano_mes_idx" ON "VendaMensal"("farmaciaId", "ano", "mes");

-- CreateIndex
CREATE INDEX "VendaMensal_produtoId_ano_mes_idx" ON "VendaMensal"("produtoId", "ano", "mes");

-- CreateIndex
CREATE UNIQUE INDEX "VendaMensal_farmaciaId_produtoId_ano_mes_key" ON "VendaMensal"("farmaciaId", "produtoId", "ano", "mes");

-- CreateIndex
CREATE INDEX "Compra_farmaciaId_data_idx" ON "Compra"("farmaciaId", "data");

-- CreateIndex
CREATE INDEX "Compra_produtoId_data_idx" ON "Compra"("produtoId", "data");

-- CreateIndex
CREATE INDEX "Compra_fornecedorId_idx" ON "Compra"("fornecedorId");

-- CreateIndex
CREATE INDEX "Compra_farmaciaId_produtoId_data_idx" ON "Compra"("farmaciaId", "produtoId", "data");

-- CreateIndex
CREATE INDEX "Compra_loteIngestaoId_idx" ON "Compra"("loteIngestaoId");

-- CreateIndex
CREATE INDEX "Devolucao_farmaciaId_data_idx" ON "Devolucao"("farmaciaId", "data");

-- CreateIndex
CREATE INDEX "Devolucao_produtoId_data_idx" ON "Devolucao"("produtoId", "data");

-- CreateIndex
CREATE INDEX "Devolucao_tipo_idx" ON "Devolucao"("tipo");

-- CreateIndex
CREATE INDEX "Devolucao_fornecedorDestinoId_idx" ON "Devolucao"("fornecedorDestinoId");

-- CreateIndex
CREATE INDEX "Devolucao_loteIngestaoId_idx" ON "Devolucao"("loteIngestaoId");

-- CreateIndex
CREATE INDEX "HistoricoStock_farmaciaId_dataFotografia_idx" ON "HistoricoStock"("farmaciaId", "dataFotografia");

-- CreateIndex
CREATE INDEX "HistoricoStock_produtoId_dataFotografia_idx" ON "HistoricoStock"("produtoId", "dataFotografia");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricoStock_farmaciaId_produtoId_dataFotografia_key" ON "HistoricoStock"("farmaciaId", "produtoId", "dataFotografia");

-- CreateIndex
CREATE INDEX "AjusteStock_farmaciaId_data_idx" ON "AjusteStock"("farmaciaId", "data");

-- CreateIndex
CREATE INDEX "AjusteStock_produtoId_data_idx" ON "AjusteStock"("produtoId", "data");

-- CreateIndex
CREATE INDEX "AjusteStock_produtoInternoId_data_idx" ON "AjusteStock"("produtoInternoId", "data");

-- CreateIndex
CREATE INDEX "AjusteStock_tipo_idx" ON "AjusteStock"("tipo");

-- CreateIndex
CREATE INDEX "AjusteStock_loteIngestaoId_idx" ON "AjusteStock"("loteIngestaoId");

-- CreateIndex
CREATE INDEX "Inventario_farmaciaId_dataInventario_idx" ON "Inventario"("farmaciaId", "dataInventario");

-- CreateIndex
CREATE INDEX "Inventario_estado_idx" ON "Inventario"("estado");

-- CreateIndex
CREATE INDEX "LinhaInventario_inventarioId_idx" ON "LinhaInventario"("inventarioId");

-- CreateIndex
CREATE INDEX "LinhaInventario_produtoId_idx" ON "LinhaInventario"("produtoId");

-- CreateIndex
CREATE INDEX "LinhaInventario_produtoInternoId_idx" ON "LinhaInventario"("produtoInternoId");

-- CreateIndex
CREATE INDEX "IndicadoresProdutoFarmacia_farmaciaId_idx" ON "IndicadoresProdutoFarmacia"("farmaciaId");

-- CreateIndex
CREATE INDEX "IndicadoresProdutoFarmacia_classificacaoRotacao_idx" ON "IndicadoresProdutoFarmacia"("classificacaoRotacao");

-- CreateIndex
CREATE INDEX "IndicadoresProdutoFarmacia_classificacaoABC_idx" ON "IndicadoresProdutoFarmacia"("classificacaoABC");

-- CreateIndex
CREATE INDEX "IndicadoresProdutoFarmacia_diasSemVenda_idx" ON "IndicadoresProdutoFarmacia"("diasSemVenda");

-- CreateIndex
CREATE UNIQUE INDEX "IndicadoresProdutoFarmacia_produtoId_farmaciaId_key" ON "IndicadoresProdutoFarmacia"("produtoId", "farmaciaId");

-- CreateIndex
CREATE INDEX "ListaEncomenda_farmaciaId_idx" ON "ListaEncomenda"("farmaciaId");

-- CreateIndex
CREATE INDEX "ListaEncomenda_criadoPorId_idx" ON "ListaEncomenda"("criadoPorId");

-- CreateIndex
CREATE INDEX "ListaEncomenda_estado_idx" ON "ListaEncomenda"("estado");

-- CreateIndex
CREATE INDEX "LinhaEncomenda_produtoId_idx" ON "LinhaEncomenda"("produtoId");

-- CreateIndex
CREATE INDEX "LinhaEncomenda_fornecedorSugeridoId_idx" ON "LinhaEncomenda"("fornecedorSugeridoId");

-- CreateIndex
CREATE UNIQUE INDEX "LinhaEncomenda_listaEncomendaId_produtoId_key" ON "LinhaEncomenda"("listaEncomendaId", "produtoId");

-- CreateIndex
CREATE INDEX "FilaRevisao_estado_prioridade_idx" ON "FilaRevisao"("estado", "prioridade");

-- CreateIndex
CREATE INDEX "FilaRevisao_produtoId_idx" ON "FilaRevisao"("produtoId");

-- CreateIndex
CREATE INDEX "FilaRevisao_tipoRevisao_idx" ON "FilaRevisao"("tipoRevisao");

-- CreateIndex
CREATE INDEX "EnriquecimentoFila_estado_prioridade_idx" ON "EnriquecimentoFila"("estado", "prioridade");

-- CreateIndex
CREATE UNIQUE INDEX "EnriquecimentoFila_produtoId_key" ON "EnriquecimentoFila"("produtoId");

-- CreateIndex
CREATE INDEX "LoteIngestao_farmaciaId_tipo_dataReferencia_idx" ON "LoteIngestao"("farmaciaId", "tipo", "dataReferencia");

-- CreateIndex
CREATE INDEX "LoteIngestao_estado_idx" ON "LoteIngestao"("estado");

-- AddForeignKey
ALTER TABLE "Produto" ADD CONSTRAINT "Produto_fabricanteId_fkey" FOREIGN KEY ("fabricanteId") REFERENCES "Fabricante"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Produto" ADD CONSTRAINT "Produto_classificacaoNivel1Id_fkey" FOREIGN KEY ("classificacaoNivel1Id") REFERENCES "Classificacao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Produto" ADD CONSTRAINT "Produto_classificacaoNivel2Id_fkey" FOREIGN KEY ("classificacaoNivel2Id") REFERENCES "Classificacao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FabricanteAlias" ADD CONSTRAINT "FabricanteAlias_fabricanteId_fkey" FOREIGN KEY ("fabricanteId") REFERENCES "Fabricante"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Classificacao" ADD CONSTRAINT "Classificacao_classificacaoPaiId_fkey" FOREIGN KEY ("classificacaoPaiId") REFERENCES "Classificacao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FornecedorAlias" ADD CONSTRAINT "FornecedorAlias_fornecedorId_fkey" FOREIGN KEY ("fornecedorId") REFERENCES "Fornecedor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Utilizador" ADD CONSTRAINT "Utilizador_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProdutoFarmacia" ADD CONSTRAINT "ProdutoFarmacia_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProdutoFarmacia" ADD CONSTRAINT "ProdutoFarmacia_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProdutoFarmacia" ADD CONSTRAINT "ProdutoFarmacia_fornecedorHabitualId_fkey" FOREIGN KEY ("fornecedorHabitualId") REFERENCES "Fornecedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProdutoInterno" ADD CONSTRAINT "ProdutoInterno_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProdutoInterno" ADD CONSTRAINT "ProdutoInterno_loteIngestaoId_fkey" FOREIGN KEY ("loteIngestaoId") REFERENCES "LoteIngestao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venda" ADD CONSTRAINT "Venda_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venda" ADD CONSTRAINT "Venda_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venda" ADD CONSTRAINT "Venda_loteIngestaoId_fkey" FOREIGN KEY ("loteIngestaoId") REFERENCES "LoteIngestao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendaMensal" ADD CONSTRAINT "VendaMensal_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendaMensal" ADD CONSTRAINT "VendaMensal_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendaMensal" ADD CONSTRAINT "VendaMensal_loteIngestaoId_fkey" FOREIGN KEY ("loteIngestaoId") REFERENCES "LoteIngestao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_fornecedorId_fkey" FOREIGN KEY ("fornecedorId") REFERENCES "Fornecedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Compra" ADD CONSTRAINT "Compra_loteIngestaoId_fkey" FOREIGN KEY ("loteIngestaoId") REFERENCES "LoteIngestao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Devolucao" ADD CONSTRAINT "Devolucao_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Devolucao" ADD CONSTRAINT "Devolucao_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Devolucao" ADD CONSTRAINT "Devolucao_fornecedorDestinoId_fkey" FOREIGN KEY ("fornecedorDestinoId") REFERENCES "Fornecedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Devolucao" ADD CONSTRAINT "Devolucao_loteIngestaoId_fkey" FOREIGN KEY ("loteIngestaoId") REFERENCES "LoteIngestao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricoStock" ADD CONSTRAINT "HistoricoStock_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricoStock" ADD CONSTRAINT "HistoricoStock_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricoStock" ADD CONSTRAINT "HistoricoStock_loteIngestaoId_fkey" FOREIGN KEY ("loteIngestaoId") REFERENCES "LoteIngestao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AjusteStock" ADD CONSTRAINT "AjusteStock_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AjusteStock" ADD CONSTRAINT "AjusteStock_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AjusteStock" ADD CONSTRAINT "AjusteStock_produtoInternoId_fkey" FOREIGN KEY ("produtoInternoId") REFERENCES "ProdutoInterno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AjusteStock" ADD CONSTRAINT "AjusteStock_loteIngestaoId_fkey" FOREIGN KEY ("loteIngestaoId") REFERENCES "LoteIngestao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventario" ADD CONSTRAINT "Inventario_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventario" ADD CONSTRAINT "Inventario_loteIngestaoId_fkey" FOREIGN KEY ("loteIngestaoId") REFERENCES "LoteIngestao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinhaInventario" ADD CONSTRAINT "LinhaInventario_inventarioId_fkey" FOREIGN KEY ("inventarioId") REFERENCES "Inventario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinhaInventario" ADD CONSTRAINT "LinhaInventario_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinhaInventario" ADD CONSTRAINT "LinhaInventario_produtoInternoId_fkey" FOREIGN KEY ("produtoInternoId") REFERENCES "ProdutoInterno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndicadoresProdutoFarmacia" ADD CONSTRAINT "IndicadoresProdutoFarmacia_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndicadoresProdutoFarmacia" ADD CONSTRAINT "IndicadoresProdutoFarmacia_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndicadoresProdutoFarmacia" ADD CONSTRAINT "IndicadoresProdutoFarmacia_ultimoFornecedorId_fkey" FOREIGN KEY ("ultimoFornecedorId") REFERENCES "Fornecedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListaEncomenda" ADD CONSTRAINT "ListaEncomenda_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListaEncomenda" ADD CONSTRAINT "ListaEncomenda_criadoPorId_fkey" FOREIGN KEY ("criadoPorId") REFERENCES "Utilizador"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinhaEncomenda" ADD CONSTRAINT "LinhaEncomenda_listaEncomendaId_fkey" FOREIGN KEY ("listaEncomendaId") REFERENCES "ListaEncomenda"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinhaEncomenda" ADD CONSTRAINT "LinhaEncomenda_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinhaEncomenda" ADD CONSTRAINT "LinhaEncomenda_fornecedorSugeridoId_fkey" FOREIGN KEY ("fornecedorSugeridoId") REFERENCES "Fornecedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilaRevisao" ADD CONSTRAINT "FilaRevisao_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnriquecimentoFila" ADD CONSTRAINT "EnriquecimentoFila_produtoId_fkey" FOREIGN KEY ("produtoId") REFERENCES "Produto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoteIngestao" ADD CONSTRAINT "LoteIngestao_farmaciaId_fkey" FOREIGN KEY ("farmaciaId") REFERENCES "Farmacia"("id") ON DELETE CASCADE ON UPDATE CASCADE;
