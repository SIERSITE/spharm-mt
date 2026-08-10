/* ============================================================================
   DIAGNÓSTICO PONTUAL — NÃO FAZ PARTE DA PLATAFORMA

   Objectivo único: descobrir ONDE vivem a DCI, o Grupo Homogéneo e o ATC
   na base do SPharm desta instalação. A auditoria por metadados esgotou o
   retorno (provou o Fabricante, falhou os outros três). O ERP mostra os
   campos no ecrã, logo lê-os de algum sítio; isto observa de onde.

   O que NÃO é: não é para copiar a query do ERP para o Agent. A query da
   ficha junta dezenas de tabelas, calcula preços e serve a UI. Depois de
   sabermos as tabelas e as chaves, o Agent leva uma query PRÓPRIA, mínima
   e estável, com os campos que o products-upload precisa e mais nada.

   Corre uma vez, por quem tiver sysadmin nesta máquina. A conta read-only
   do Agent não chega e não deve chegar.

   Base:  SPharm_Silveirense
   Passos 1 → 2 → 3 → 4, pela ordem. O passo 4 apaga tudo o que isto criou.
   ============================================================================ */


/* -- PASSO 0 -----------------------------------------------------------------
   COMEÇAR AQUI. Se der resposta, os passos 1 a 4 não chegam a ser precisos.

   Vistas, procedimentos e funções guardam o texto da sua própria definição
   dentro da base. Se o SPharm compõe a ficha do artigo com uma delas, a
   lógica está escrita ali e lê-se — não é preciso observá-la a correr.

   Read-only. Não precisa de sysadmin, nem de abrir o SPharm, nem de
   apanhar o momento certo. Basta uma conta que leia a base.

   Isto NÃO procura tabelas nem chaves. Procura a lógica.

   ESTA É A ÚLTIMA TENTATIVA DE DESCOBERTA ESTRUTURAL. Se não produzir a
   chave de ligação, segue-se o PASSO 1 e mais nada. Não há PASSO 0.1, nem
   nova ferramenta, nem outra auditoria.

   Correr os três blocos e enviar os três resultados como vêm. Não é
   preciso ler nem interpretar SQL: os blocos já extraem o que interessa.
   --------------------------------------------------------------------------*/


-- 0A · Que objectos mencionam os campos procurados.
--      Uma linha por objecto. Se vier vazio, ir directo ao PASSO 1.

SELECT
    o.type_desc                              AS tipo,   -- VIEW / PROCEDURE / FUNCTION
    SCHEMA_NAME(o.schema_id) + '.' + o.name  AS objecto,
    LEN(m.definition)                        AS tamanho
FROM sys.sql_modules AS m
JOIN sys.objects     AS o ON o.object_id = m.object_id
WHERE m.definition LIKE '%GrupoHom%'
   OR m.definition LIKE '%SPRAct%'
   OR m.definition LIKE '%Generico%'
   OR m.definition LIKE '%[^A-Za-z]DCI[^A-Za-z]%'
   OR m.definition LIKE '%[^A-Za-z]ATC[^A-Za-z]%'
   OR m.definition LIKE '%Substancia%'
   OR m.definition LIKE '%GamaFabricante%'
ORDER BY tipo, objecto;
GO


-- 0B · Que tabelas cada um desses objectos lê.
--      Vem do próprio SQL Server, já resolvido. Sem parsing.

SELECT DISTINCT
    SCHEMA_NAME(o.schema_id) + '.' + o.name AS objecto,
    d.referenced_entity_name                AS tabela_lida
FROM sys.sql_modules                 AS m
JOIN sys.objects                     AS o ON o.object_id = m.object_id
JOIN sys.sql_expression_dependencies AS d ON d.referencing_id = m.object_id
WHERE (m.definition LIKE '%GrupoHom%'
    OR m.definition LIKE '%SPRAct%'
    OR m.definition LIKE '%Generico%'
    OR m.definition LIKE '%[^A-Za-z]DCI[^A-Za-z]%'
    OR m.definition LIKE '%[^A-Za-z]ATC[^A-Za-z]%'
    OR m.definition LIKE '%Substancia%'
    OR m.definition LIKE '%GamaFabricante%')
ORDER BY objecto, tabela_lida;
GO


-- 0C · A chave e os JOINs, extraídos automaticamente.
--      Devolve só as linhas de FROM / JOIN / ON dessas definições — é onde
--      vive a relação. O resto da definição (select list, filtros, UI) fica
--      de fora de propósito.

WITH numeros AS (
    SELECT TOP (200000)
           ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i
    FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b
),
candidatos AS (
    SELECT o.object_id,
           SCHEMA_NAME(o.schema_id) + '.' + o.name AS objecto,
           REPLACE(m.definition, CHAR(13), '') + CHAR(10) AS txt
    FROM sys.sql_modules AS m
    JOIN sys.objects     AS o ON o.object_id = m.object_id
    WHERE m.definition LIKE '%GrupoHom%'
       OR m.definition LIKE '%SPRAct%'
       OR m.definition LIKE '%Generico%'
       OR m.definition LIKE '%[^A-Za-z]DCI[^A-Za-z]%'
       OR m.definition LIKE '%[^A-Za-z]ATC[^A-Za-z]%'
       OR m.definition LIKE '%Substancia%'
       OR m.definition LIKE '%GamaFabricante%'
),
linhas AS (
    SELECT c.objecto,
           n.i AS posicao,
           LTRIM(RTRIM(SUBSTRING(
               c.txt, n.i,
               CHARINDEX(CHAR(10), c.txt, n.i) - n.i))) AS linha
    FROM candidatos AS c
    JOIN numeros    AS n ON n.i <= LEN(c.txt)
    WHERE n.i = 1 OR SUBSTRING(c.txt, n.i - 1, 1) = CHAR(10)
)
SELECT objecto, posicao, LEFT(linha, 500) AS linha
FROM linhas
WHERE linha <> ''
  AND (linha LIKE '%JOIN%'
    OR linha LIKE '%FROM %'
    OR linha LIKE '% ON %'
    OR linha LIKE '%GrupoHom%'
    OR linha LIKE '%SPRAct%'
    OR linha LIKE '%GamaFabricante%'
    OR linha LIKE '%[^A-Za-z]DCI[^A-Za-z]%'
    OR linha LIKE '%[^A-Za-z]ATC[^A-Za-z]%')
ORDER BY objecto, posicao;
GO

/* Enviar 0A, 0B e 0C tal como saírem.

   Zero linhas NÃO quer dizer que a lógica não exista: quer dizer que não
   está guardada como vista, procedimento ou função. Nesse caso, PASSO 1 —
   sem paragens intermédias. */


/* -- PASSO 1 -----------------------------------------------------------------
   Só se o PASSO 0 vier vazio ou inconclusivo.

   Criar e arrancar a captura. Filtrada pela base, para não apanhar tráfego
   de outras aplicações no mesmo servidor.
   --------------------------------------------------------------------------*/

IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = 'SPharmMT_FichaProduto')
    DROP EVENT SESSION [SPharmMT_FichaProduto] ON SERVER;
GO

CREATE EVENT SESSION [SPharmMT_FichaProduto] ON SERVER
ADD EVENT sqlserver.sql_batch_completed (
    ACTION (sqlserver.sql_text, sqlserver.client_app_name)
    WHERE (sqlserver.database_name = N'SPharm_Silveirense')),
ADD EVENT sqlserver.rpc_completed (
    ACTION (sqlserver.sql_text, sqlserver.client_app_name)
    WHERE (sqlserver.database_name = N'SPharm_Silveirense'))
ADD TARGET package0.event_file (
    SET filename = N'C:\Temp\SPharmMT_FichaProduto.xel', max_file_size = 50)
WITH (MAX_DISPATCH_LATENCY = 5 SECONDS, STARTUP_STATE = OFF);
GO

ALTER EVENT SESSION [SPharmMT_FichaProduto] ON SERVER STATE = START;
GO


/* -- PASSO 2 -----------------------------------------------------------------
   Ir ao SPharm e abrir a ficha de UM produto que mostre DCI e/ou Grupo
   Homogéneo. Um medicamento genérico, para os campos virem preenchidos.
   Fechar a ficha. Voltar aqui.
   --------------------------------------------------------------------------*/

ALTER EVENT SESSION [SPharmMT_FichaProduto] ON SERVER STATE = STOP;
GO


/* -- PASSO 3 -----------------------------------------------------------------
   Ler o capturado. Só as queries que tocam nos campos procurados.
   --------------------------------------------------------------------------*/

WITH eventos AS (
    SELECT
        CAST(event_data AS xml).value('(event/action[@name="client_app_name"]/value)[1]', 'nvarchar(256)') AS aplicacao,
        CAST(event_data AS xml).value('(event/action[@name="sql_text"]/value)[1]',        'nvarchar(max)')  AS query
    FROM sys.fn_xe_file_target_read_file('C:\Temp\SPharmMT_FichaProduto*.xel', NULL, NULL, NULL)
),
distintas AS (
    SELECT MIN(aplicacao) AS aplicacao, query, COUNT(*) AS vezes
    FROM eventos
    WHERE query IS NOT NULL AND LEN(query) > 0
    GROUP BY query
)
SELECT
    CASE WHEN query LIKE '%GrupoHom%'  OR query LIKE '%SPRAct%'
           OR query LIKE '%DCI%'       OR query LIKE '%Generico%'
           OR query LIKE '%GamaFabricante%' OR query LIKE '%Laborat%'
           OR query LIKE '%ATC%'
         THEN 1 ELSE 2 END AS relevancia,   -- 1 = interessa, 2 = resto
    aplicacao, vezes, query
FROM distintas
WHERE query LIKE '%Stocks%'
   OR query LIKE '%GrupoHom%' OR query LIKE '%SPRAct%'
   OR query LIKE '%DCI%'      OR query LIKE '%ATC%'
ORDER BY relevancia, vezes DESC;
GO

/* Guardar o resultado (Results to File, ou copiar) e enviar.
   Se vier vazio: ou a ficha não foi aberta entre o PASSO 1 e o PASSO 2, ou
   o SPharm não obtém estes campos do SQL Server — e isso também é resposta,
   fecha esta via em vez de a deixar em aberto. */


/* -- PASSO 4 -----------------------------------------------------------------
   Apagar tudo. Não deixar sessões de diagnóstico a escrever no disco do
   servidor da farmácia. Correr SEMPRE, mesmo que o passo 3 falhe.
   --------------------------------------------------------------------------*/

IF EXISTS (SELECT 1 FROM sys.dm_xe_sessions WHERE name = 'SPharmMT_FichaProduto')
    ALTER EVENT SESSION [SPharmMT_FichaProduto] ON SERVER STATE = STOP;
IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = 'SPharmMT_FichaProduto')
    DROP EVENT SESSION [SPharmMT_FichaProduto] ON SERVER;
GO

/* Apagar também os ficheiros C:\Temp\SPharmMT_FichaProduto*.xel. */
