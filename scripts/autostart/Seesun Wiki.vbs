' 로그온 때 사내 위키 서버를 창 없이 띄운다 (2026-11-09).
' 실제 일은 D:\workspace\_tools\wiki\scripts\autostart\run-wiki.cmd 가 한다. 끄려면 작업 관리자에서 cmd · seesun-wiki.exe 를 끝내고 이 파일을 지운다.
CreateObject("WScript.Shell").Run """D:\workspace\_tools\wiki\scripts\autostart\run-wiki.cmd""", 0, False
