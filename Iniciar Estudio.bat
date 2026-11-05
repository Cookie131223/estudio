@echo off
chcp 65001 >nul
title Estudio de Agentes
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org e rode de novo.
  pause
  exit /b 1
)

if not exist "node_modules\three\build\three.module.js" (
  echo Primeira vez: instalando o three.js, o escritorio 3D...
  call npm install --omit=dev --no-audit --no-fund
)

node server.js
echo.
echo O Estudio foi fechado. Se apareceu algum erro acima, tire um print e mande para o Claude.
pause
