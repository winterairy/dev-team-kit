# 배포 점검표: Vercel

- **빌드**: profile의 빌드 명령이 로컬에서 통과하는지. Node 버전과 패키지 관리자가 Vercel 설정(`engines`, `packageManager`, lock 파일)과 맞는지
- **환경 변수**: 필요한 변수 목록을 문서화하고 Production·Preview·Development 중 어디에 둘지 적는다. 값은 적지 않는다. 클라이언트에 노출되는 변수(`NEXT_PUBLIC_` 등)에 비밀값이 없는지
- **설정 파일**: `vercel.json`이 필요한 경우만 만든다(리다이렉트, 헤더, 함수 지역·시간 제한, cron)
- **미리보기 배포**: 작업 브랜치 push가 Preview 배포를 만든다는 점을 문서화한다. Preview의 접근 제한(Deployment Protection) 필요 여부
- **CI**: 타입 검사·린트·테스트를 GitHub Actions 등으로 PR마다 돌리는 워크플로 (Vercel 빌드와 별도)
- **되돌리기**: 이전 배포로 되돌리는 방법(Instant Rollback)을 운영 문서에 적는다
- 실행하지 않을 명령 예: `vercel --prod`, `vercel env add`
