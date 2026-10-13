-- Upload manual dos dados do INFARMED (página /admin/infarmed): guarda quem
-- carregou e o tamanho do ficheiro. Puramente aditiva (duas colunas nulas).
ALTER TABLE "InfarmedImportacao" ADD COLUMN "bytes" INTEGER;
ALTER TABLE "InfarmedImportacao" ADD COLUMN "utilizadorEmail" TEXT;
