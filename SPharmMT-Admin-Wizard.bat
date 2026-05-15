@echo off
REM SPharm.MT -- Admin Wizard (executavel grafico)
REM
REM Duplo-click neste ficheiro abre o wizard. Substitui o
REM onboarding-wizard.bat como ponto de entrada oficial.
REM
REM 1) Tenta usar o .exe compilado em dist-admin\ (se ja foi feito build)
REM 2) Fallback: lanca o .ps1 directamente via PowerShell

setlocal
cd /d "%~dp0"

if exist "%~dp0dist-admin\SPharmMT-Admin-Wizard.exe" (
  start "" "%~dp0dist-admin\SPharmMT-Admin-Wizard.exe"
  exit /b 0
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo ERRO: powershell.exe nao disponivel.
  echo Este wizard requer Windows com PowerShell 5.1+ ^(default em Win10/11^).
  pause
  exit /b 1
)

REM UTF-8 para preservar acentos no display
chcp 65001 >nul

start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0admin-wizard\SPharmMT-Admin-Wizard.ps1"
exit /b 0
