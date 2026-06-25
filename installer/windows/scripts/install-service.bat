@echo off
REM Register pax-agent as a Windows Service via NSSM.
REM Runs from Inno Setup postinstall step. Must run as Administrator.

setlocal

set SERVICE=GoNailsPaxAgent
set INSTALL_DIR=%~dp0..
set BIN=%INSTALL_DIR%\pax-agent.exe
set NSSM=%INSTALL_DIR%\nssm.exe
set CONFIG_DIR=%PROGRAMDATA%\GoNails\PaxAgent
set LOG_DIR=%PROGRAMDATA%\GoNails\PaxAgent\logs

REM Ensure config + log dirs exist before service start.
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"
if not exist "%LOG_DIR%"    mkdir "%LOG_DIR%"

REM Stop + remove any prior install (clean upgrade).
"%NSSM%" stop %SERVICE% >nul 2>&1
"%NSSM%" remove %SERVICE% confirm >nul 2>&1

REM Register the service. NSSM handles auto-restart on crash + log redirect.
"%NSSM%" install %SERVICE% "%BIN%"
"%NSSM%" set %SERVICE% AppDirectory "%INSTALL_DIR%"
"%NSSM%" set %SERVICE% Description "GoNails — relays cloud POS commands to the local PAX A920 terminal."
"%NSSM%" set %SERVICE% Start SERVICE_AUTO_START
"%NSSM%" set %SERVICE% AppStdout "%LOG_DIR%\stdout.log"
"%NSSM%" set %SERVICE% AppStderr "%LOG_DIR%\stderr.log"
"%NSSM%" set %SERVICE% AppRotateFiles 1
"%NSSM%" set %SERVICE% AppRotateOnline 1
"%NSSM%" set %SERVICE% AppRotateBytes 10485760
"%NSSM%" set %SERVICE% AppEnvironmentExtra "PAX_AGENT_CONFIG=%CONFIG_DIR%\config.json" "PAX_AGENT_LOG_DIR=%LOG_DIR%" "PAX_AGENT_BOOTSTRAP_URL=__BOOTSTRAP_URL__"
"%NSSM%" set %SERVICE% AppExit Default Restart
"%NSSM%" set %SERVICE% AppRestartDelay 5000

REM Start now (auto-start kicks in on next boot regardless).
"%NSSM%" start %SERVICE%

endlocal
exit /b 0
