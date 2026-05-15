@echo off
REM SPharm.MT Admin Wizard -- launcher fallback
REM Se o .exe estiver presente, usa-o. Senao, lanca via PowerShell.

setlocal
cd /d "%~dp0"

if exist "%~dp0SPharmMT-Admin-Wizard.exe" (
  start "" "%~dp0SPharmMT-Admin-Wizard.exe"
  exit /b 0
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo ERRO: nem .exe nem powershell.exe disponivel.
  pause
  exit /b 1
)

start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0SPharmMT-Admin-Wizard.ps1"
exit /b 0
