-- PROVISÓRIA — NÃO INSTALAR EM PRODUÇÃO até a auditoria real do ERP
-- (agent `classification-audit`) fixar o modelo. Ver notes/classificacao-erp-produtos.md.
--
-- Genérico tri-estado vindo do ERP (dbo.Stocks.[Generico], única coluna de
-- classificação com existência comprovada). Puramente ADITIVA: uma coluna
-- anulável, sem DEFAULT, nenhuma linha existente é reescrita nem perde dados.
--
--  · true = genérico; false = não genérico; NULL = desconhecido / nunca enviado
--    (estado de TODAS as fichas existentes).
--  · "flagGenerico" (boolean NOT NULL DEFAULT false) NÃO é alterado: não
--    consegue distinguir "não genérico" de "desconhecido".
--  · Ético / NETT / Serviço NÃO têm coluna: o modelo (booleanos independentes,
--    categoria única, ...) não está provado e só se fixa depois da auditoria.
--  · Protegível por "camposManuais" (chave genericoErp).
--  · Rollback: ignorada por qualquer versão anterior do código; pode ficar na
--    base sem efeito (DROP COLUMN só apaga o tri-estado, que o reenvio repõe).

-- AlterTable
ALTER TABLE "Produto" ADD COLUMN "genericoErp" BOOLEAN;
