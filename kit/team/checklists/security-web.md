# 보안 점검표: 웹

- **인젝션**: SQL/NoSQL, 커맨드, 템플릿 인젝션. 쿼리 빌더·ORM 사용 여부와 문자열 결합
- **XSS**: 사용자·외부 데이터를 HTML로 넣는 곳(`dangerouslySetInnerHTML`, `innerHTML`, 마크다운 렌더링)과 정리 방식
- **인증·인가**: 인증 없는 API, 객체 단위 권한 확인 누락(다른 사용자 ID로 조회), 세션·토큰 저장 위치와 만료
- **SSRF·경로 조작**: 사용자가 준 URL·파일 경로를 서버가 그대로 쓰는 곳
- **서버·클라이언트 경계**: 서버 전용 비밀값이 클라이언트 번들로 나가는지 (예: Next.js `NEXT_PUBLIC_` 변수, 클라이언트 컴포넌트에서의 import)
- **설정**: CORS, 보안 헤더(CSP, HSTS, X-Frame-Options), 쿠키 속성(HttpOnly, Secure, SameSite)
- **프레임워크 공지**: 사용하는 프레임워크 버전의 공개 보안 공지 (예: Next.js, React Server Components)
- **업로드**: 파일 형식·크기 제한, 저장 위치, 공개 URL 노출
