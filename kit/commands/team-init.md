---
description: 저장소를 읽고 dev-team-kit 프로젝트 설정(.claude/team/profile.md) 초안을 만든다
argument-hint: [추가로 알려 줄 내용]
---

dev-team-kit의 프로젝트 설정 파일 `.claude/team/profile.md`를 만든다. 사용자가 덧붙인 내용: $ARGUMENTS

직접 조사한다. 서브에이전트를 부르지 않는다. 코드는 수정하지 않는다.

## 1. 조사

아래를 읽고 사실과 추정을 구분해 둔다.

- README, `docs/` 아래 문서 목록과 제목. 계획 문서(Task 목록, 로드맵), 설계 결정, 디자인 기준(DESIGN.md, 컴포넌트 문서, 테마 토큰 파일), "현재 구현 범위"를 적는 곳을 찾는다.
- 패키지 매니페스트(package.json, pyproject.toml 등)의 스크립트와 의존성. lock 파일 종류를 보고 패키지 관리자를 정한다. **lock 파일이 둘 이상이면** 추정하지 말고 질문 목록에 넣는다.
- 개발 서버 설정(포트, 고정 여부), 테스트 설정(Playwright, Jest, Vitest 등).
- CI 설정(`.github/workflows/` 등)과 배포 단서(vercel.json, electron-builder 설정, Dockerfile, npm 게시 설정).
- `git log -30 --format='%s%n%b'`로 커밋 제목 형식과 언어, `git branch -a`로 브랜치 규칙.
- 기존 `CLAUDE.md`, `AGENTS.md`, `.claude/` 설정. 이미 있는 규칙은 존중하고 profile의 "기타 규칙"에 요약한다.
- README 등에 적힌 실행 환경 제약(예: "클라우드에서는 Electron 실행 불가").

## 2. 초안 작성

`.claude/team/profile.template.md`의 형식으로 `.claude/team/profile.md`를 쓴다.
- 확인한 값은 그대로, 추정한 값에는 `(추정)`, 모르는 값은 `(없음)`.
- 보안 점검표는 플랫폼에 맞게 고른다: `.claude/team/checklists/` 안의 `security-*.md` 이름에서 고른다.
- 배포 방식은 `.claude/team/checklists/release-*.md` 이름 중 하나 또는 `없음`.

## 3. 사용자 확인

아래 형식으로 보여 주고 답을 기다린다. 승인받기 전에는 커밋하지 않는다.

```
[승인 요청] 프로젝트 설정 초안
요약: 플랫폼 · 패키지 관리자 · 테스트 · 배포 방식을 한 줄로
문서 위치: 계획 / 설계 / 디자인 기준 / 구현 범위
확인이 필요한 것: 1) … 2) …   (추정값과 충돌하는 단서)
```

사용자가 고친 내용을 반영해 저장하고, profile 파일만 커밋한다(커밋 형식은 profile 기준).
