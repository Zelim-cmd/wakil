@echo off
chcp 65001 >nul
rem Автозапуск Вакиля при входе в Windows. Запустите этот файл один раз.
rem Чтобы выключить: удалите файл Wakil.bat из папки автозагрузки (Win+R, shell:startup).
cd /d "%~dp0.."
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
(
  echo @echo off
  echo cd /d "%CD%"
  echo start "Wakil" /min cmd /c "node src\main.mjs >> data\autostart.log 2>&1"
) > "%STARTUP%\Wakil.bat"
echo Готово: Вакиль будет запускаться сам при входе в Windows.
echo Файл автозапуска: %STARTUP%\Wakil.bat
pause
