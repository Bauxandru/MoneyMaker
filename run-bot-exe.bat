@echo off
REM ════════════════════════════════════════════════════════════════════
REM  Restart-loop launcher for arb-bot.exe
REM
REM  Resolves the exe path automatically — looks in:
REM     1. dist\arb-bot.exe   (dev layout: built by npm run build:exe)
REM     2. arb-bot.exe        (deploy layout: exe sits next to this .bat)
REM  First match wins.
REM
REM  Reads settings from `settings.txt` if present next to this file
REM  (or next to the .exe). Env vars set before calling this .bat still
REM  take precedence over the file.
REM
REM  All bot stdout + stderr redirected to a timestamped log in data/.
REM  Tail live output with (in another PowerShell):
REM     Get-Content -Wait -Tail 50 data\arb_<stamp>.log
REM
REM  Ctrl+C in THIS window to stop the bot (closes the loop).
REM ════════════════════════════════════════════════════════════════════

cd /d "%~dp0"
if not exist data mkdir data

REM Resolve exe path: prefer dist\arb-bot.exe, fall back to arb-bot.exe in cwd
set BOT_EXE=
if exist "dist\arb-bot.exe" set BOT_EXE=dist\arb-bot.exe
if "%BOT_EXE%"=="" if exist "arb-bot.exe" set BOT_EXE=arb-bot.exe

if "%BOT_EXE%"=="" (
  echo [ERROR] arb-bot.exe not found — looked in dist\ and current directory.
  echo Place the exe at one of: %~dp0dist\arb-bot.exe  or  %~dp0arb-bot.exe
  pause
  exit /b 2
)

REM Timestamp format: YYYYMMDD_HHMMSS (Windows has no built-in ISO format)
for /f "tokens=2 delims==" %%i in ('wmic os get localdatetime /value ^| findstr LocalDateTime') do set DT=%%i
set STAMP=%DT:~0,8%_%DT:~8,6%

set LOG=data\arb_%STAMP%.log
echo [%date% %time%] Launching %BOT_EXE%
echo [%date% %time%] Log: %LOG%
echo Tail with:  Get-Content -Wait -Tail 50 "%LOG%"
echo.

:loop
echo [%date% %time%] Starting %BOT_EXE%... >> "%LOG%"
"%BOT_EXE%" >> "%LOG%" 2>&1
echo [%date% %time%] Bot exited (code %ERRORLEVEL%). Restarting in 5 seconds... >> "%LOG%"
timeout /t 5 /nobreak >nul
goto loop
