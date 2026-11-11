@echo off
rem 사내 위키 서버를 늘 띄워 둔다. 시작프로그램의 「Seesun Wiki.vbs」가 로그온 때 숨은 창으로 부른다.
rem 서버가 꺼지면 30초 뒤 다시 띄운다. 다른 창(herdr 「사내 위키」 탭의 npm start)이 4500 포트를 쓰고 있으면
rem 띄우기가 바로 실패하고, 그 창이 꺼질 때까지 30초마다 다시 해 본다.
rem cargo run 이 아니라 만들어 둔 실행 파일을 부른다. 로그온 때마다 빌드하지 않게. 코드를 고친 뒤에는 npm run build.
rem 2026-11-09 만듦.
cd /d D:\workspace\_tools\wiki
if not exist logs mkdir logs
:loop
echo [%date% %time%] start >> logs\server.log
"server\target\release\seesun-wiki.exe" >> logs\server.log 2>&1
ping -n 31 127.0.0.1 >nul
goto loop
