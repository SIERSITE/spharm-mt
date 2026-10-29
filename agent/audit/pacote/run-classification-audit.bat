@echo off
rem PACOTE DE DIAGNOSTICO (base rev98) - read-only - nao instalavel. So executa SELECT.
rem Equivale a: node.exe agent.cjs classification-audit --out output\auditoria-classificacao.json %*
cd /d "%~dp0"
if not exist agent.config.json goto semconfig
if not exist output mkdir output
node.exe agent.cjs classification-audit --out output\auditoria-classificacao.json %*
exit /b %ERRORLEVEL%
:semconfig
echo [ERRO] agent.config.json nao encontrado nesta pasta. Corre primeiro o Install-ClassificationAudit.ps1.
exit /b 1
