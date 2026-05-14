@echo off
REM SPharm.MT — Onboarding Wizard launcher
REM Duplo-click ou correr da linha de comandos:
REM   onboarding-wizard.bat
REM
REM Encaminha para scripts\onboarding-wizard.ps1. PowerShell 5+ (incluído
REM em qualquer Windows 10+). Sem dependências externas além do npm
REM (já necessário para o repo).

setlocal
cd /d "%~dp0"

REM UTF-8 para preservar acentos no menu/prompts
chcp 65001 >nul

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo ERRO: powershell.exe nao encontrado. Este wizard requer Windows com PowerShell.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\onboarding-wizard.ps1"
set EXIT=%ERRORLEVEL%
endlocal & exit /b %EXIT%
