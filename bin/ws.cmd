@echo off
REM Startet den Prozess fuer die Live-Verbindung in der Entwicklung.
REM Das Fenster bleibt offen, solange der Prozess laeuft.

setlocal
set "PHP=php"
if exist "C:\xampp\php\php.exe" set "PHP=C:\xampp\php\php.exe"

pushd "%~dp0.."
"%PHP%" ws\server.php start
popd
endlocal
