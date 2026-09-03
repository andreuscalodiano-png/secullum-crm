@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ===========================================
echo   ATUALIZAR SECULLUM CRM
echo ===========================================
echo.

REM --- Confere se esta na pasta certa ---
if not exist ".git" (
    echo [ERRO] Este arquivo precisa estar dentro da pasta secullum-crm.
    echo Mova o atualizar.bat para C:\Users\...\Desktop\secullum-crm
    echo.
    pause
    exit /b 1
)

REM --- Alerta sobre arquivos grandes soltos na pasta ---
if not exist ".gitignore" (
    echo [ATENCAO] Nao existe .gitignore neste projeto.
    echo Backups e chaves podem acabar sendo enviados por engano.
    echo.
)

REM --- Detecta o que mudou ---
set MUDOU_FRONT=0
set MUDOU_FUNCTIONS=0

git status --porcelain | findstr /C:"src/" >nul && set MUDOU_FRONT=1
git status --porcelain | findstr /C:"functions/" >nul && set MUDOU_FUNCTIONS=1

if !MUDOU_FRONT!==0 if !MUDOU_FUNCTIONS!==0 (
    echo Nenhuma alteracao encontrada. Nada a publicar.
    echo.
    pause
    exit /b 0
)

echo O que mudou:
if !MUDOU_FRONT!==1      echo   [x] Frontend  ^(src/App.js^)  -^> Vercel
if !MUDOU_FUNCTIONS!==1  echo   [x] Functions ^(index.js^)    -^> Firebase
echo.

REM --- Mensagem do commit ---
set "MSG=%~1"
if "!MSG!"=="" (
    set /p MSG="Mensagem do commit: "
)
if "!MSG!"=="" set "MSG=atualizacao"

REM --- Publica as functions primeiro ---
REM Os gatilhos precisam estar no ar antes do frontend usa-los.
if !MUDOU_FUNCTIONS!==1 (
    echo.
    echo -------------------------------------------
    echo  1/2  Publicando Cloud Functions...
    echo -------------------------------------------
    call firebase deploy --only functions
    if errorlevel 1 (
        echo.
        echo [ERRO] O deploy das functions falhou. Nada foi enviado ao GitHub.
        echo Corrija o erro acima e rode de novo.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo  Functions publicadas com sucesso.
)

REM --- Envia o codigo ---
echo.
echo -------------------------------------------
if !MUDOU_FUNCTIONS!==1 (echo  2/2  Enviando para o GitHub...) else (echo  Enviando para o GitHub...)
echo -------------------------------------------
REM Adiciona apenas o que faz parte do projeto.
REM "git add -A" varreria a pasta inteira e pegaria backups e chaves.
if exist "src\App.js"           git add src/App.js
if exist "src\firebase.js"      git add src/firebase.js
if exist "src\index.js"         git add src/index.js
if exist "functions\index.js"   git add functions/index.js
if exist "functions\package.json" git add functions/package.json
if exist "package.json"          git add package.json
if exist "firebase.json"         git add firebase.json
if exist "firestore.rules"       git add firestore.rules
if exist ".gitignore"            git add .gitignore
if exist "atualizar.bat"         git add atualizar.bat

REM Nada preparado significa que nao ha o que enviar
git diff --cached --quiet
if not errorlevel 1 (
    echo Nenhum arquivo do projeto foi alterado. Nada a enviar.
    echo.
    pause
    exit /b 0
)

echo.
echo Arquivos que serao enviados:
git diff --cached --name-only
echo.

git commit -m "!MSG!"
git push

if errorlevel 1 (
    echo.
    echo [ERRO] Falha no envio ao GitHub. Veja a mensagem acima.
    echo.
    pause
    exit /b 1
)

echo.
echo ===========================================
echo   TUDO PUBLICADO
echo ===========================================
if !MUDOU_FRONT!==1 (
    echo.
    echo A Vercel leva cerca de 1 a 2 minutos para publicar o frontend.
    echo Depois disso, recarregue o CRM com Ctrl+F5.
)
echo.
pause
