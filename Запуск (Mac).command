#!/bin/bash
# Вакиль — запуск на Mac. Дважды щёлкните этот файл.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Не найден Node.js — программа, на которой работает Вакиль."
  echo "Сейчас откроется сайт: скачайте версию «LTS», установите и запустите этот файл снова."
  open "https://nodejs.org/ru/download"
  read -r -p "Нажмите Enter, чтобы закрыть…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю нужные библиотеки (1–2 минуты)…"
  npm install --no-audit --no-fund || { echo "Не получилось. Проверьте интернет и попробуйте снова."; read -r -p "Enter…"; exit 1; }
fi

PORT=$(node -e "try{console.log(require('./data/config.json').panel.port||8790)}catch{console.log(8790)}")
(sleep 2; open "http://localhost:$PORT") &
echo ""
echo "Вакиль работает. Панель: http://localhost:$PORT"
echo "Не закрывайте это окно — иначе бот перестанет отвечать. Остановить: Ctrl+C."
echo ""
node src/main.mjs
