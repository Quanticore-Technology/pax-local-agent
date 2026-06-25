@echo off
REM Tiny launcher: opens the agent's local config UI in the default browser.
REM Bound to a Start Menu shortcut + a Desktop shortcut by the installer.
REM The actual agent runs as a Windows Service (GoNailsPaxAgent), not from
REM this script.

setlocal
set URL=http://127.0.0.1:9876/

REM Wait up to 5 s for the service web server to come up (helps right after
REM install when the user double-clicks the shortcut immediately).
for /L %%i in (1,1,5) do (
  powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri '%URL%health' -UseBasicParsing -TimeoutSec 1) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 (
    start "" "%URL%"
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)

REM Service didn't respond — show a hint with how to recover.
mshta "javascript:alert('PAX Agent service is not responding on %URL%.\n\nOpen Services (services.msc), find ''GoNailsPaxAgent'', and start it.\n\nOr check logs: %%PROGRAMDATA%%\\GoNails\\PaxAgent\\logs\\');close();"
endlocal
exit /b 1
