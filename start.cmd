@echo off
rem Double-click to open the Fable 5.2 challenge page in your browser.
title Fable 5.2 challenge page
if not exist "%~dp0serve.ps1" goto notextracted
if not exist "%~dp0kf_engine.wasm" goto notextracted
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
echo.
echo The page server has stopped. If it did not open, send a screenshot of this window.
pause
exit /b

:notextracted
echo.
echo  Please EXTRACT the zip first (right-click the zip, "Extract All"),
echo  then open the extracted folder and double-click start.cmd there.
echo  Qing xian JIE YA zhe ge ya suo bao, zai dao jie ya chu lai de wen jian jia li shuang ji start.cmd.
echo.
pause
