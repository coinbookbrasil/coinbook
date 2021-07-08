echo off
cls
set /p nomeVar=Digite um nome:
echo Voce digitou %nomeVar%
REM heroku login
heroku git:remote -a %nomeVar% 
REM git push heroku master
REM heroku logs --tail