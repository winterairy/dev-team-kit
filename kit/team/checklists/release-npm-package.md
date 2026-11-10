# 배포 점검표: npm 패키지

- **게시 내용**: `npm pack --dry-run`으로 포함 파일 확인. `files`·`exports`·`bin` 설정
- **버전**: 변경 내용에 맞는 버전 올림과 변경 기록(CHANGELOG)
- **CI**: 테스트·빌드 워크플로, 필요하면 provenance를 켠 게시 워크플로
- 실행하지 않을 명령 예: `npm publish`, 태그 push
