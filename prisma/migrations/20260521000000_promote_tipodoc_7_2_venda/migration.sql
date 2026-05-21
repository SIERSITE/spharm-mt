-- Promote TipoDocumento 7 e 2 de UNKNOWN → VENDA.
--
-- Contexto: a migration 20260514100000 semeou 7 e 2 como UNKNOWN
-- ("default cautelar", caracterização pendente). Entretanto ambos foram
-- VALIDADOS como VENDA (docs/spharm-erp-canonical-mapping.md §§600-601:
-- TipoDoc 7 validado 2024-01-01 c/ comparticipação SNS; TipoDoc 2 validado
-- 2024-04-01). O 7 é o documento de venda dominante do Softreis — mantê-lo
-- UNKNOWN faz com que ~98% das vendas fiquem por classificar e a agregação
-- VendaMensal produza 0 → dashboard a zeros em cada tenant novo.
--
-- Forward-only, idempotente e GUARDADO: só promove quando ainda está no
-- default do sistema (classifiedBy='system' AND classe='UNKNOWN'). Nunca
-- sobrescreve uma decisão manual do operador (classifiedBy='cli'/email) nem
-- uma classe já diferente. Não toca em 27 (tenant-specific; classificar via
-- scripts/classify-tipodoc.ts após confirmação do ERP).
--
-- NOTA: isto corrige a TABELA de classificação. Para propagar às linhas já
-- ingeridas em IngestVendaLinhaRaw é preciso correr, por tenant:
--   npx tsx scripts/reclassify-ingest-vendas.ts --tenant <slug>

UPDATE "TipoDocumentoClassificacao"
SET "classe"       = 'VENDA',
    "descricao"    = 'Venda comercial (Softreis TipoDoc 7) — validado canonical 2024-01-01',
    "classifiedBy" = 'migration:20260521000000',
    "updatedAt"    = CURRENT_TIMESTAMP
WHERE "tipoDocumento" = 7
  AND "classe" = 'UNKNOWN'
  AND "classifiedBy" = 'system';

UPDATE "TipoDocumentoClassificacao"
SET "classe"       = 'VENDA',
    "descricao"    = 'Venda (Softreis TipoDoc 2) — validado canonical 2024-04-01',
    "classifiedBy" = 'migration:20260521000000',
    "updatedAt"    = CURRENT_TIMESTAMP
WHERE "tipoDocumento" = 2
  AND "classe" = 'UNKNOWN'
  AND "classifiedBy" = 'system';

-- Caso um tenant ainda não tenha as linhas 7/2 (provisionado antes do seed),
-- garante que existem já com a classe correcta. Idempotente.
INSERT INTO "TipoDocumentoClassificacao"
  ("tipoDocumento", "classe", "descricao", "classifiedBy", "classifiedAt", "updatedAt")
VALUES
  (7, 'VENDA', 'Venda comercial (Softreis TipoDoc 7) — validado canonical 2024-01-01', 'migration:20260521000000', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (2, 'VENDA', 'Venda (Softreis TipoDoc 2) — validado canonical 2024-04-01', 'migration:20260521000000', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("tipoDocumento") DO NOTHING;
