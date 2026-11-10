# dev-team-kit

Claude Code 서브에이전트로 만든 개발팀 BOT 세트입니다. 책임자 BOT(메인 세션) 1명과 역할 BOT 7명(기획, 아키텍처, 디자인, 개발, QA, 보안, 운영)이 단계별로 협업합니다.

- 어느 프로젝트에나 명령 한 줄로 설치하고, 같은 명령으로 업데이트합니다.
- 프로젝트마다 다른 점은 설정 파일 하나(`.claude/team/profile.md`)에만 둡니다.
- 설치한 파일은 프로젝트에 커밋하므로 로컬 세션과 클라우드 세션이 똑같이 동작합니다. (클라우드 세션은 플러그인과 `~/.claude`를 읽지 않습니다.)
- 관찰 서버([agent-observer](https://github.com/winterairy/agent-observer))로 BOT 활동과 토큰 사용량을 보낼 수 있습니다.

## 설치와 업데이트

프로젝트 루트에서 실행합니다. Node.js 20 이상이 필요합니다.

```bash
npx --yes github:winterairy/dev-team-kit install
```

저장소를 받아 두고 실행해도 됩니다.

```bash
node ../dev-team-kit/bin/cli.mjs install --target .
```

- `--dry-run`: 바뀔 내용만 보여 줍니다.
- `--force`: 직접 수정한 kit 파일도 덮어씁니다.

설치 후:
1. Claude Code에서 `/team-init`을 실행합니다. 저장소를 읽고 `profile.md` 초안을 만든 뒤 승인을 받습니다.
2. 바뀐 `.claude/` 파일을 커밋합니다.

업데이트할 때도 같은 명령을 다시 실행합니다. 설치 기록(`.claude/team/.kit-manifest.json`)을 보고 다음처럼 처리합니다.

| 경우 | 처리 |
|---|---|
| kit가 설치한 뒤 바뀌지 않은 파일 | 새 버전으로 갱신 |
| 직접 수정한 kit 파일 | 건너뜀 (`--force`로 덮어쓰기) |
| kit 밖에서 만든 같은 이름의 파일 | 건너뜀 |
| `profile.md` | 절대 건드리지 않음 |
| `.claude/settings.json` | 기존 내용 유지, kit의 hook만 교체하고 거부 규칙 추가 |
| 새 버전에서 빠진 파일 | 수정하지 않았으면 삭제, 수정했으면 유지 |

## 사용법

```
/task 책 프로젝트 저장·열기 기능 (TASK-01)
/task HANDOFF.md 읽고 이어서 진행
```

`/task`로 시작한 대화에서만 메인 세션이 책임자 BOT이 됩니다. 평소 대화에는 영향을 주지 않습니다. 특정 BOT만 쓰려면 "security 에이전트로 src/main 점검해줘"처럼 부르면 됩니다.

### 진행 단계

```
기획 → 설계 → ★승인1 → 디자인 명세 → (★디자인 승인) → 개발
  → 검증(QA + 보안 + 디자인 리뷰 동시) → 운영 → (보안 재검토) → 문서 반영 → ★승인2 → 완료
```

- 단계는 과업 크기가 아니라 무엇을 건드리는지로 고릅니다. 개발과 QA는 항상 거칩니다. 기준은 `kit/team/process.md`에 있습니다.
- 의존성·보안 패치만 하는 과업은 개발 → QA → 보안 → 승인2로 짧게 갑니다.
- 반려 후 재작업은 단계마다 최대 3회입니다.
- 승인 요청은 휴대폰에서 읽어도 판단할 수 있게 짧게 씁니다.
- 승인 지점과 검증 통과 후 상태 파일과 산출물을 커밋합니다(클라우드 컨테이너가 사라져도 남도록).
- 최종 보고에는 검증한 환경과 "사용자가 직접 확인할 항목"이 들어갑니다.

### BOT

| BOT | 파일 | 쓰기 범위 |
|---|---|---|
| 기획 | `agents/planner.md` | 문서만. 마지막에 구현 범위 문서와 Task 상태 갱신 |
| 아키텍처 | `agents/architect.md` | 문서만 |
| 디자인 | `agents/designer.md` | 디자인 기준 문서, 산출물·보고서 폴더 |
| 개발 | `agents/developer.md` | 코드. 기능 단위 커밋, push 안 함 |
| QA | `agents/qa.md` | 테스트 코드와 설정만 |
| 보안 | `agents/security.md` | 보안 보고서만 (읽기 전용) |
| 운영 | `agents/devops.md` | 빌드·배포·CI 설정. 실제 배포 안 함 |

플랫폼별 점검표(`kit/team/checklists/`)는 profile에 적은 것만 읽습니다.
- 보안: `security-web`, `security-electron`, `security-node-cli`
- 배포: `release-vercel`, `release-electron-builder`, `release-npm-package`, `release-docker`

## 실제로 막는 것

`.claude/settings.json`에 거부 규칙을 넣습니다. 지시문과 달리 Claude가 실행할 수 없습니다.

- 강제 push, 기본 브랜치(main·master)로의 push
- `vercel --prod`, `npm publish` 등 배포·게시
- `gh release create`, `gh pr merge`

거부 규칙은 승인으로 풀리지 않습니다. ★승인2 이후의 병합과 배포는 사용자가 직접 하거나(GitHub 화면 등), 그 프로젝트의 규칙을 직접 고친 뒤 진행합니다. 작업 브랜치로의 push는 막지 않습니다.

## 관찰 서버 연결

설치하면 모든 hook 이벤트에서 `.claude/team/observe/observe.mjs`가 비동기로 실행됩니다. `AGENT_OBSERVER_URL`이 없으면 아무것도 하지 않습니다.

**보내는 것**: 이벤트 이름, 세션·에이전트 ID, 에이전트 종류, 도구 이름, 스킬 이름, 호출한 서브에이전트 종류, 알림 종류, 토큰 합계, 저장소 이름과 브랜치.
**보내지 않는 것**: 프롬프트, 응답 메시지, 도구 입력·출력 내용, 파일 내용.

### 클라우드 세션
클라우드 환경 설정(세션 제목 옆 환경 메뉴 → Edit)에서:
1. 환경 변수: `AGENT_OBSERVER_URL=https://<관찰 서버 주소>`
2. Network secrets: 관찰 서버 호스트에 `Authorization: Bearer <토큰>` 추가. 프록시가 요청에 붙여 주므로 스크립트와 저장소에는 토큰이 남지 않습니다.

### 로컬 세션
셸 환경 변수로 `AGENT_OBSERVER_URL`과 `AGENT_OBSERVER_TOKEN`을 설정합니다.

### 문제 확인
- `AGENT_OBSERVER_DEBUG=1`: 보낼 내용을 stderr로 출력
- `AGENT_OBSERVER_DISABLE=1`: 끄기

## 권장 스킬 (선택)

없으면 각 BOT이 기본 규칙으로 작업합니다. 클라우드 세션에서 쓰려면 프로젝트의 `.claude/skills/`에 커밋되어 있거나 claude.ai에서 켜 둔 스킬이어야 합니다.

| 스킬 | 쓰는 BOT | 용도 |
|---|---|---|
| Web Design Guidelines (`vercel-labs/agent-skills`) | 디자인(리뷰) | UI 코드의 접근성·UX 점검 |
| Playwright CLI (`microsoft/playwright-cli`) | 디자인(리뷰), QA | 브라우저 조작, 스크린샷 |
| Taste Skill (`Leonxlnx/taste-skill`) | 개발(마케팅 페이지) | 랜딩 페이지 구성 |
| Awesome DESIGN.md (`VoltAgent/awesome-design-md`) | 디자인(초안) | 레퍼런스. 설치 불필요 |

## 구조

```
bin/cli.mjs                 설치 명령
kit/                        프로젝트의 .claude/ 아래로 복사되는 파일
  agents/                   역할 BOT 7개
  commands/task.md          /task
  commands/team-init.md     /team-init
  settings.json             병합할 hook과 거부 규칙
  team/process.md           책임자 BOT 진행 규칙
  team/profile.template.md  프로젝트 설정 형식
  team/checklists/          플랫폼별 보안·배포 점검표
  team/templates/           상태 파일, DESIGN.md 템플릿
  team/observe/observe.mjs  관찰 서버로 이벤트를 보내는 hook
test/                       node --test
```

## 개발

```bash
npm test
```

## 알려진 제한

- 여러 저장소를 붙인 클라우드 세션과 Projects의 클라우드 스레드에서는 저장소의 hook이 실행되지 않아 관찰 이벤트가 오지 않습니다.
- `claude -p`처럼 바로 끝나는 실행에서는 마지막 Stop 이벤트가 전송되지 않을 수 있습니다. SessionEnd는 전송됩니다.
- 서브에이전트의 토큰은 부모의 Agent 도구 호출이 끝날 때와 SubagentStop 때 집계합니다. 백그라운드로 띄운 서브에이전트는 SubagentStop 시점 값만 들어옵니다.
