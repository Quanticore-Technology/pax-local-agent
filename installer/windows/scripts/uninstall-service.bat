@echo off
REM Stop and remove the pax-agent Windows Service. Runs from Inno Setup
REM uninstaller. Idempotent — safe to run even if service is already gone.

setlocal

set SERVICE=GoNailsPaxAgent
set INSTALL_DIR=%~dp0..
set NSSM=%INSTALL_DIR%\nssm.exe

if exist "%NSSM%" (
  "%NSSM%" stop %SERVICE% >nul 2>&1
  "%NSSM%" remove %SERVICE% confirm >nul 2>&1
) else (
  REM Fallback to sc.exe if NSSM is already gone.
  sc stop %SERVICE% >nul 2>&1
  sc delete %SERVICE% >nul 2>&1
)

endlocal
exit /b 0
