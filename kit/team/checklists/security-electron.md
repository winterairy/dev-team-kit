# 보안 점검표: Electron 데스크톱

- **창 설정 유지**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`가 모든 창에서 유지되는지. 바꾸는 변경은 High
- **preload 노출 범위**: `contextBridge`로 노출한 함수가 필요한 기능만 주는지. 임의 경로 읽기·쓰기, 임의 명령 실행, `ipcRenderer` 자체를 노출하면 Critical
- **IPC 입력 검증**: main 프로세스 핸들러가 renderer에서 온 값(경로, ID, 크기)을 검증하는지. 경로는 허용된 폴더 밖으로 나가지 못하게(`..`, 절대 경로, 심볼릭 링크) 막는지
- **신뢰할 수 없는 콘텐츠**: 가져온 문서(DOCX, HTML, EPUB, 이미지 등)와 붙여넣은 HTML을 renderer에 넣기 전에 정리하는지(DOMPurify 등). 스크립트·이벤트 속성·외부 리소스 로드 제거
- **CSP**: renderer의 Content-Security-Policy가 약해지지 않았는지(`unsafe-eval`, 원격 스크립트 허용)
- **탐색·새 창**: `will-navigate` 차단, `setWindowOpenHandler` 거부, `shell.openExternal`에 넘기는 URL 검증
- **파일 저장**: 원자적 쓰기, 실패 시 데이터 보존, 사용자 데이터 폴더 권한
- **자동 업데이트·서명**: 업데이트 서버 URL, 서명 검증 설정 (배포 단계)
