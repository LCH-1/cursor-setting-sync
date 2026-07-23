# Cursor Setting Sync

[English](README.md) · **한국어**

Cursor Setting Sync는 Cursor 설정, 허용 목록으로 지정된 워크스페이스 상태, 지원되는 채팅 데이터를 여러 PC 간에 안전하게 동기화합니다. 전송 경로는 OneDrive·Syncthing 같은 공유 폴더이거나 GitHub 같은 git 원격입니다. 저장소 페이로드는 기기를 떠나기 전에 암호화되며, 별도의 동기화 서버나 계정이 필요 없습니다. Windows, macOS, Linux에서 동작합니다.

## 기능

- 기본 프로필 및 명명된 프로필의 설정
- 키바인딩, 스니펫, 사용자 태스크, 프롬프트, MCP 구성
- 설치된 확장 목록, 버전, 활성화 상태, 프리릴리스, 고정(pinning) 상태
- 프로필 정의 및 선택된 사용자 범위 UI 상태
- Cursor User Rules
- `~/.cursor`의 MCP·CLI 구성, commands, skills, rules
- 허용 목록으로 지정된 `%APPDATA%\Cursor\User\workspaceStorage` 상태와 notepads·images의 이식 가능한 쿼리 수준 동기화
- Composer/채팅 기록, 에이전트 트랜스크립트, 지원되는 `store.db` 세션
- 불변 히스토리, 결정론적 충돌 감지, 암호화·중복 제거된 객체, 백업, 진단
- 공유 폴더 또는 git 원격 전송: `cursorSettingSync.gitSync`가 켜져 있고 저장소 폴더가 git 워크트리이면, 매 주기마다 읽기 전에 pull하고 쓰기 후에 commit/push합니다

## 버전 간 동기화

Cursor 버전이 정확히 일치할 필요는 없습니다.

- 파일 기반 리소스는 지원되는 Cursor 버전 간에 양방향으로 동기화됩니다.
- 구버전 Cursor나 확장이 만든 DB 기반 리소스는 신버전에서 적용할 수 있습니다.
- 신버전 Cursor·VS Code 베이스·확장이 만든 DB 기반 리소스는 구버전 PC에서 보류됩니다. 적용하려면 해당 PC를 먼저 업데이트하세요.
- 워크스페이스 DB 행은 버전이 있는 이식 가능한 페이로드로 직렬화되며, Cursor 종료 후에만 SQL로 병합됩니다. 원본 SQLite 파일은 전송되거나 설치되지 않습니다.
- 보류된 원격 버전은 변경되지 않은 구버전 로컬 사본으로 덮어써지지 않습니다. 두 PC가 실제로 같은 리소스를 수정하면, 어느 쪽도 조용히 덮어쓰지 않고 두 버전 모두 충돌로 보존됩니다.
- 알 수 없는 저장소 프로토콜 버전은 클라이언트가 로컬 변경을 발행하기 전에 안전하게 실패합니다.
- 신버전 확장의 안전하지만 알 수 없는 리소스 종류는 불변 로그에 남습니다. 구버전 확장은 이해하는 종류만 계속 적용하고, 업데이트 후에 보류된 종류를 받아 적용합니다.

이 정책은 전방 마이그레이션과 데이터 안전을 우선합니다. 구버전 Cursor로의 역방향 적용은 생성 버전이 더 새롭지 않고 로컬 DB가 필요한 스키마 검사를 통과할 때만 허용됩니다.

## 요구 사항

- Windows 10 이상, macOS, 또는 Linux
- VS Code API 1.99 이상을 지원하는 Cursor
- OneDrive, Syncthing 등 파일 동기화 도구가 제공하는 공유 폴더 — 또는 git 원격(git 전송에는 `git` CLI가 PATH에 있어야 함)
- 12자 이상의 저장소 패스프레이즈

Cursor 내장 런타임이 필요한 SQLite 기능을 제공하지 않을 때도 파일 기반 동기화는 계속 사용할 수 있습니다. 프로필, UI 상태, 확장 상태, 워크스페이스 스토리지, DB 기반 채팅 동기화는 `node:sqlite`, 온라인 백업 지원, 호환되는 로컬 스키마가 필요합니다.

## 설치

Extensions 뷰에서 **Cursor Setting Sync**를 설치한 뒤, 명령 팔레트에서 `Cursor Setting Sync: Setup`을 실행합니다.

## 셋업

### 공통 (모든 방식 공통)

- 어느 방식이든 `Cursor Setting Sync: Setup`을 실행하는 것으로 시작합니다.
- 패스프레이즈는 12자 이상이며 모든 PC에서 동일해야 합니다. 공유 저장소에 저장되지 않고, 복구할 수 없습니다.
- 추가 PC에서는 파일 리소스가 안전할 때 자동으로 적용됩니다. DB·워크스페이스 스토리지 변경이 대기하면 상태바 안내에 따라 `Cursor Setting Sync: Restart to Apply`를 실행합니다.
- Setup 전에 `Sync Now`(또는 다른 명령)를 실행하면 아무 일도 일어나지 않습니다. 상태바에 `unconfigured`가 표시되고 Setup을 안내하는 메시지가 뜹니다. 저장소가 설정되기 전까지는 아무것도 동기화되지 않습니다.

방식별 상세는 아래를 참고하고, 제공자별 주의사항은 [저장소 옵션](#저장소-옵션) 표를 확인하세요.

### 방식 A — 공유 폴더 (OneDrive · Dropbox · Google Drive · Syncthing · 로컬)

**첫 번째 PC**

1. `Cursor Setting Sync: Setup`을 실행합니다.
2. 공유 폴더(또는 로컬 폴더) 안의 빈 폴더를 선택합니다.
3. **Plain shared folder**를 선택합니다.
4. 12자 이상의 패스프레이즈를 입력합니다.
5. 상태바가 동기화 완료를 보고할 때까지 기다린 뒤, 공유 폴더 제공자의 업로드 완료를 확인합니다.

**추가 PC**

1. 확장을 설치하고 `Cursor Setting Sync: Setup`을 실행합니다.
2. 같은 공유 폴더(각 PC의 로컬 사본)를 선택합니다.
3. **Plain shared folder**를 선택하고 같은 패스프레이즈를 입력합니다.

> Google Drive는 mirror 모드 + 오프라인 사용, OneDrive는 "항상 오프라인 사용"이 필요합니다. 자세한 내용은 [저장소 옵션](#저장소-옵션)을 참고하세요.

### 방식 B — Git 원격 (GitHub · GitLab · 셀프호스팅)

**사전 준비**: `git` CLI가 PATH에 있어야 하고, 인증은 비대화식(`GIT_TERMINAL_PROMPT=0`)으로 동작하므로 자격증명 헬퍼나 SSH 키를 미리 설정하세요.

**첫 번째 PC (새 저장소 생성)**

1. `Cursor Setting Sync: Setup`을 실행합니다.
2. 빈 폴더를 선택합니다(위치는 자유).
3. **New git repository with remote**를 선택하고 원격 URL을 입력합니다(비워두면 원격 없는 로컬 git 히스토리).
4. 12자 이상의 패스프레이즈를 입력합니다. 첫 동기화에서 원격으로 push됩니다.

**추가 PC (기존 저장소 합류)**

1. 확장을 설치하고 `Cursor Setting Sync: Setup`을 실행합니다.
2. 빈 폴더를 선택합니다.
3. **Clone an existing git repository**를 선택하고 같은 원격 URL을 입력합니다.
4. 같은 패스프레이즈를 입력합니다.

## 저장소 옵션

저장소는 암호화된 append-only 파일들이 담긴 폴더입니다. "동기화"의 의미는 그 폴더를 다른 PC로 무엇이 옮겨 주느냐에 따라 달라집니다. `Setup`에서 폴더를 지정하고, 폴더가 이동하는 방식에 맞는 전송을 선택하세요.

| 케이스 | 설정 | 결과 |
| --- | --- | --- |
| **OneDrive / Dropbox / iCloud** | **Plain shared folder** 선택, 동기 폴더 지정, "항상 오프라인 사용" 유지 | 완전한 다중 PC 동기화 |
| **Google Drive** | **mirror 모드 + 오프라인 사용** 필수(stream 모드는 파일이 가상이라 안 됨), **Plain shared folder** 선택 | 완전한 다중 PC 동기화 |
| **Syncthing / Resilio** | 모든 PC의 공유를 같은 폴더로, **Plain shared folder** 선택 | 클라우드 계정 없이 동기화 |
| **로컬 폴더** | **Plain shared folder** 선택, 아무 로컬 경로 지정 | 단일 PC 버전관리 + 복구(다른 PC로 전파 없음) |
| **Git — clone existing** | **Clone an existing git repository** 선택, 저장소 URL 붙여넣기 | 다른 PC들이 이미 push하는 저장소에 합류 |
| **Git — new with remote** | **New git repository with remote** 선택, 원격 URL 붙여넣기 | git 초기화 + 원격 연결, 첫 동기화에서 push. GitHub/GitLab/셀프호스팅 |
| **Git — local-only** | **New git repository with remote** 선택, URL 비워둠 | 원격 없는 로컬 git 히스토리(나중에 원격 추가 가능) |

**보충 설명**

- **OneDrive / Dropbox / iCloud**: 제공자가 동기화하는 폴더 안의 빈 폴더를 고르고, 그 폴더를 **항상 기기에 유지**로 두세요(OneDrive는 이 폴더의 "여유 공간 확보"/Files On-Demand를 끄기). 실제 파일이 디스크에 존재해야 합니다. 각 PC는 자기 로컬에 있는 같은 동기 폴더를 `Setup`에서 가리킵니다.
- **Google Drive**: 데스크톱 앱을 **mirror 모드**(stream 전용 아님)로 쓰고 폴더를 **오프라인 사용 가능**으로 표시하세요. stream 모드에서는 파일이 가상 placeholder라 파일 감시와 읽기가 불안정합니다.
- **Syncthing / Resilio**: 클라우드 계정 없이 동기화됩니다. 확장은 `sync-conflict` 사본을 이미 무시합니다.
- **로컬 폴더**: 단일 PC 버전 백업입니다. 전체 버전 히스토리, `Restore Version History`, `Restore Backup`이 모두 동작합니다. 폴더를 기기 밖으로 옮기는 주체가 없으므로 다른 PC로만 전파되지 않을 뿐입니다.
- **Git**: `git` CLI가 `PATH`에 있어야 합니다. 인증은 시스템 git 자격증명을 비대화식(`GIT_TERMINAL_PROMPT=0`)으로 사용하므로, 자격증명 헬퍼나 SSH 키를 미리 설정하세요. 인증 실패 시 경고로 강등되고 폴더는 로컬에서 계속 동작합니다. 원격 변경은 폴링으로 감지됩니다(git 모드는 파일 변경 이벤트를 받지 않음). 암호화 페이로드는 델타 압축이 안 되어 git 저장소는 담긴 데이터만큼 커집니다 — GitHub는 100MB 초과 파일을 거부하고 수 GB 이하 저장소를 선호하므로, `Show Repository Usage`를 확인하고 저장소가 커지면 `Checkpoint & Prune History`로 git 히스토리를 스쿼시하세요.

## 명령어

**초기 설정 · 일상 동기화**

- **Setup** — 최초 설정. 저장소 폴더와 전송 방식(plain / clone / new git)을 고르고 암호화 패스프레이즈를 입력합니다(12자 이상, 모든 PC 동일, 폴더에 저장 안 됨).
- **Sync Now** — 즉시 한 번 동기화. 평소에는 자동으로 동기화됩니다(30초 폴링 + 파일 감시). 로컬 변경을 발행하고 원격 변경을 받아옵니다.
- **Restart to Apply** — Cursor를 종료 후 재시작해 대기 중인 DB 변경을 적용합니다. 파일은 실행 중에도 적용되지만 `state.vscdb`(채팅, UI 상태, 워크스페이스 DB)는 Cursor 종료 후에만 SQL로 안전하게 씁니다.

**충돌 · 복구**

- **Resolve Conflicts** — 두 PC에서 편집해 자동 병합되지 않은 충돌을 수동으로 해결합니다. diff를 보여주고 한쪽(또는 현재 로컬 내용)을 선택합니다.
- **Restore Version History** — 리소스를 과거 버전으로 되돌립니다(git revert와 유사). 리소스 선택 → 버전 목록을 diff 미리보기와 함께 탐색 → 선택한 버전을 새 버전으로 발행. 히스토리는 보존됩니다.
- **Restore Backup** — DB를 이전 백업 시점으로 복원합니다. 모든 DB 쓰기 전에 SQLite 백업을 뜨며, 그중 하나를 골라 복원합니다. 잘못된 복원을 되돌릴 "pre-restore" 백업도 목록에 표시됩니다.

**저장소 관리**

- **Checkpoint & Prune History** — 현재 상태를 체크포인트로 접고, 모든 PC가 그것을 받은 뒤 접힌 히스토리를 삭제해 저장소가 무한히 커지는 것을 막습니다. git 모드에서는 git 히스토리도 스쿼시합니다. 실행 전 모든 PC를 업데이트하세요 — 이후 구버전은 명확한 에러로 중단됩니다.
- **Compact Safe Orphans** — 가벼운 청소. 어떤 이벤트도 참조하지 않는 객체 파일과 오래된 임시 파일만 삭제합니다. 이벤트 히스토리는 건드리지 않습니다.
- **Archive Repository** — 저장소 폴더 전체를 별도 위치에 백업 아카이브로 복사합니다.
- **Forget Device** — 더 이상 쓰지 않는 기기를 목록에서 제거합니다(로컬 상태만). 오프라인 기기가 프루닝을 막을 때 사용합니다.

**진단**

- **Show Diagnostics** — 현재 동기화 상태, 에러, 경고 로그를 봅니다. 문제가 있어 보이면 여기부터 확인하세요.
- **Show Repository Usage** — 저장소가 차지하는 용량을 보고합니다. git 모드에서는 100MB GitHub 제한을 초과하는 파일도 경고합니다.

## 설정 항목

```jsonc
{
  "cursorSettingSync.enabled": true,
  "cursorSettingSync.pollIntervalSeconds": 30,
  "cursorSettingSync.chatPollIntervalSeconds": 30,
  "cursorSettingSync.autoApplyFiles": true,
  "cursorSettingSync.syncChat": true,
  "cursorSettingSync.syncWorkspaceStorage": true,
  "cursorSettingSync.gitSync": true,
  "cursorSettingSync.ignoredSettings": [],
  "cursorSettingSync.ignoredExtensions": [],
  "cursorSettingSync.maxPayloadMiB": 128
}
```

| 설정 | 기본값 | 역할 |
| --- | --- | --- |
| `enabled` | `true` | Setup 이후 자동 동기화를 켜고 끄는 마스터 스위치. |
| `pollIntervalSeconds` | `30` | 공유 저장소를 스캔하는 폴백 폴링 간격(초, 10–3600). git 모드는 원격 변경을 이 폴링으로 감지합니다. |
| `chatPollIntervalSeconds` | `30` | Cursor 채팅 메타데이터 변경을 확인하는 간격(초, 10–3600). |
| `autoApplyFiles` | `true` | Cursor 실행 중 충돌 없는 파일 리소스를 자동 적용할지. 수동 `Sync Now`는 이 값과 무관하게 적용합니다. |
| `syncChat` | `true` | 지원되는 Cursor 채팅 저장소(composer 대화·에이전트 트랜스크립트·`store.db`) 동기화 여부. |
| `syncWorkspaceStorage` | `true` | `workspaceStorage` 상태 백업 여부. 모든 Cursor 프로세스가 종료된 뒤에만 캡처됩니다. |
| `gitSync` | `true` | 저장소 폴더가 git 워크트리일 때 읽기 전 pull·쓰기 후 commit/push를 사용할지. `git` CLI가 필요합니다. |
| `ignoredSettings` | `[]` | 동기화에서 제외할 설정 키 목록. API 키 등 민감한 값을 여기에 추가하세요. |
| `ignoredExtensions` | `[]` | 동기화에서 제외할 확장 ID 목록. |
| `maxPayloadMiB` | `128` | 한 페이로드의 최대 비압축 크기(MiB, 1–512). 이보다 큰 리소스는 발행되지 않습니다. |

레거시 `cursorSync.*` 네임스페이스에 남아 있는 값은 폴백으로 인정됩니다.

## 보안 및 개인정보

- 페이로드는 저장소 무작위 마스터 키에서 파생된 키로 AES-256-GCM 암호화됩니다.
- 패스프레이즈에서 파생된 키는 마스터 키를 감싸기만 하며, 패스프레이즈는 저장소에 저장되지 않습니다.
- 잠금 해제된 마스터 키는 각 PC의 Cursor `SecretStorage`에 보관됩니다.
- Cursor/확장의 `SecretStorage`와 알려진 DB 기반 OAuth·인증 세션·비밀번호·자격증명·토큰 키는 제외됩니다.
- 동기화되는 설정이나 MCP JSON 안의 인라인 값은 암호화되지만 페이로드의 일부입니다. 환경 변수 참조를 선호하고, 민감한 설정 키는 `cursorSettingSync.ignoredSettings`에 추가하세요.
- 워크스페이스 스토리지 페이로드는 `state.vscdb`의 논리적 행, `notepads.json`, `images/` 아래 파일로 제한되며, 모든 페이로드는 저장소에서 암호화된 상태로 유지됩니다.
- `workspace.json`은 암호화된 워크스페이스 식별자/URI 메타데이터를 얻기 위해서만 읽습니다. 페이로드로 저장·복원되지 않으며, 매핑된 워크스페이스 ID는 하나의 정규 리소스 식별자를 공유합니다.
- 워크스페이스 스토리지 삭제는 전파되지 않습니다. PC마다 워크스페이스 집합이 다를 수 있기 때문입니다.
- SQLite DB 파일, WAL/SHM/journal 사이드카, 백업 사본, 브라우저 세션, 검색 인덱스, 디버거 데이터, 기타 워크스페이스 캐시는 공유 저장소에 들어가지 않습니다.
- 라이브 Cursor DB는 복사·이름변경·격리·교체되지 않습니다. 모든 변경은 SQLite 트랜잭션 안의 준비된 SQL이며, 커밋 전에 무결성 검사를 거칩니다.
- 복구 백업은 로컬에 남으며, SQL 복원의 읽기 소스로만 쓰입니다. 평문 로컬 백업은 최신 30개·30일·2GiB로 제한됩니다.
- 텔레메트리를 수집하지 않으며, 프로젝트가 운영하는 서버와 통신하지 않습니다.

공유 폴더 상태는 로컬 파일 쓰기만 확인해 줍니다. 중요한 변경 후에는 PC를 끄기 전에 항상 OneDrive나 Syncthing의 업로드 완료를 기다리세요.

## 알려진 제한

- Cursor/GitHub/Microsoft 로그인과 MCP OAuth 인증은 PC마다 별도로 완료해야 합니다.
- 강제 종료는 마지막 DB·워크스페이스 스토리지 내보내기를 못 끝낼 수 있습니다. 중요한 작업 후에는 `Cursor Setting Sync: Sync Now`를 실행하고 Cursor를 정상 종료하세요.
- 워크스페이스 스토리지는 모든 Cursor 프로세스 종료 후에만 캡처됩니다. `Cursor Setting Sync: Sync Now`는 Cursor 실행 중에는 그것을 스캔하지 않습니다.
- 워크스페이스 DB 가져오기는 프로토콜 v1에서 upsert 전용입니다. 대상에만 있는 행은 보존되며, 들어오지 않은 행이 로컬 상태를 삭제하지 않습니다.
- 에이전트 트랜스크립트만으로는 모든 Cursor 사이드바 항목을 완전히 재현하지 못할 수 있습니다.
- 확정된 이벤트와 툼스톤은 저장소 프로토콜 v1에서 유지됩니다.

기술적 상세는 [usage](docs/usage.md), [protocol](docs/protocol.md), [security](docs/security.md), [compatibility](docs/compatibility.md)를 참고하세요.

## 라이선스

[MIT](LICENSE)

## 링크

- [저장소](https://github.com/LCH-1/cursor-setting-sync)
- [이슈 트래커](https://github.com/LCH-1/cursor-setting-sync/issues)
