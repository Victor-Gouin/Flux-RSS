@echo off
chcp 65001 >nul
title Flux RSS — Serveur Local
cd /d "%~dp0"

echo ========================================================
echo   Demarrage de Flux RSS sur http://localhost:3000
echo ========================================================
echo.

start "" "http://localhost:3000"

if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" server\index.js
) else (
  node server\index.js
)
pause
