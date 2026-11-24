@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Вакиль

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Не найден Node.js - программа, на которой работает Вакиль.
  echo Сейчас откроется сайт: скачайте версию LTS, установите и запустите этот файл снова.
  start "" https://nodejs.org/ru/download
  pause
  exit /b 1
)

if not exist node_modules (
  echo Первый запуск: устанавливаю нужные библиотеки, 1-2 минуты...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Не получилось. Проверьте интернет и попробуйте снова.
    pause
    exit /b 1
  )
)

start "" http://localhost:8790
echo.
echo Вакиль работает. Панель: http://localhost:8790
echo Не закрывайте это окно - иначе бот перестанет отвечать.
echo.
node src\main.mjs
pause
