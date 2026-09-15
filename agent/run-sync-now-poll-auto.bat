@echo off
REM SPharm.MT agent — sync-now POLL AUTO (Task Scheduler)
REM
REM Ficheiro de EXEMPLO — segue o mesmo estilo de run-export-orders-auto.bat.
REM Nao gerado por agent/build.mjs (ainda): copia isto para a pasta da
REM instalacao (ao lado de agent.cjs / agent.config.json) quando este bloco
REM for adoptado. Ver agent/docs/sync-now.md para o desenho completo
REM (endpoint, frequencia, autenticacao, lock, retry, comando schtasks).
REM
REM Sem prompts, sem janela visivel — feito para o Task Scheduler.
REM Cada execucao: ate 3 ciclos de long-poll a GET pending (waitSeconds=18,
REM o servidor mantem o pedido em espera) -> se algo aparecer, produtos+stock
REM DE HOJE -> ack/fail ao SaaS. NUNCA vendas. Ver agent/docs/sync-now.md
REM secção 2 para o desenho completo e o /MO 1 recomendado no schtasks.
REM Log em logs\sync-now-<YYYY-MM-DD>.log (append, um ficheiro por dia).
REM Exit code do node propagado: 0 = nada pendente ou sucesso, 1 = erro
REM antes de reclamar o pedido, 2 = pedido reclamado mas falhou/expirou.

setlocal

cd /d "%~dp0"
if not exist agent.config.json (
  echo ERRO: agent.config.json nao encontrado em %~dp0.
  exit /b 1
)
if not exist node.exe (
  echo ERRO: node.exe nao encontrado em %~dp0.
  exit /b 1
)
if not exist logs mkdir logs

REM Data YYYY-MM-DD via node (sem dependencia de locale)
for /f "tokens=*" %%I in ('node.exe -e "process.stdout.write(new Date().toISOString().slice(0,10))"') do set "TODAY=%%I"
set "LOGFILE=logs\sync-now-%TODAY%.log"

echo. >> "%LOGFILE%"
echo === [%DATE% %TIME%] sync-now-poll-auto START === >> "%LOGFILE%"
node.exe agent.cjs sync-now >> "%LOGFILE%" 2>&1
set EXIT=%ERRORLEVEL%
echo === [%DATE% %TIME%] sync-now-poll-auto END (exit=%EXIT%) === >> "%LOGFILE%"

if not "%EXIT%"=="0" (
  echo ERROR: sync-now retornou %EXIT% — ver %LOGFILE%
)
endlocal & exit /b %EXIT%
