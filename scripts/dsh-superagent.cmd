@echo off
rem Windows wrapper for the native dsh-superagent service runner (scripts/dsh-superagent.ps1).
rem Run from the checkout root: scripts\dsh-superagent.cmd start|stop|restart|status [options]
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-superagent.ps1" %*
exit /b %errorlevel%
