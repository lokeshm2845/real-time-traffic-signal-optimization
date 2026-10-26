@echo off
setlocal EnableDelayedExpansion
title AdaptiveSignal Control Console - Demo launcher
cd /d "%~dp0"
set "APP=%~dp0prototype\index.html"
set "URL=file:///%APP:\=/%"
set "CHOICE=%~1"

:menu
if not "%CHOICE%"=="" goto run
cls
echo ==========================================================
echo   Real-Time Traffic Signal Optimization  -  DEMO
echo ==========================================================
echo.
echo   1  Open the control console (live demo)
echo   2  Run the safety / verification tests (9 tests)
echo   3  Run the full benchmark in the terminal (about 1 minute)
echo   0  Exit
echo.
set /p CHOICE=Choose an option:
:run
if "%CHOICE%"=="1" goto console
if "%CHOICE%"=="2" goto tests
if "%CHOICE%"=="3" goto bench
if "%CHOICE%"=="0" goto end
set "CHOICE="
goto menu

:console
set "BROWSER="
for %%P in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe") do (
  if exist %%P if not defined BROWSER set "BROWSER=%%~P"
)
if defined BROWSER ( start "" "!BROWSER!" --new-window --start-maximized "%URL%" ) else ( start "" "%APP%" )
goto after

:tests
where node >nul 2>nul || ( echo Node.js is not installed. Get it from https://nodejs.org & pause & goto end )
node scripts\tests.js
goto after

:bench
where node >nul 2>nul || ( echo Node.js is not installed. Get it from https://nodejs.org & pause & goto end )
node -e "const S=require('./prototype/js/sim.js');S.runBenchmark({seeds:10}).then(r=>{const n={balanced:'Balanced',rush_ew:'Rush hour',asym:'Asymmetric',heavy:'Near saturation',night:'Night',surge:'Time-varying',emergency:'Emergency'};console.log('Average delay in s/veh (mean of 10 seeds)\n');console.log('Scenario'.padEnd(18)+'Fixed 30/30'.padEnd(14)+'Webster'.padEnd(12)+'Adaptive');for(const k in r.results){const c=r.results[k].ctl;console.log(n[k].padEnd(18)+c.fixed.avgDelay.mean.toFixed(1).padEnd(14)+c.webster.avgDelay.mean.toFixed(1).padEnd(12)+c.adaptive.avgDelay.mean.toFixed(1));}const e=r.results.emergency.ctl;console.log('\nAmbulance delay (s): fixed '+e.fixed.ambDelay.mean.toFixed(1)+'  adaptive + pre-emption '+e.adaptive_ep.ambDelay.mean.toFixed(1));});"
goto after

:after
echo.
if not "%~1"=="" goto end
pause
set "CHOICE="
goto menu

:end
endlocal
