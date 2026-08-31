# Cursor Setting Sync

[English](README.md) · **한국어**

Cursor Setting Sync는 Cursor 설정, 허용 목록으로 지정된 워크스페이스 상태, 지원되는 채팅 데이터를 여러 PC 간에 안전하게 동기화합니다. 전송 경로는 OneDrive·Syncthing 같은 공유 폴더이거나 GitHub 같은 git 원격입니다. 저장소 페이로드는 기기를 떠나기 전에 암호화되며, 별도의 동기화 서버나 계정이 필요 없습니다. Windows, macOS, Linux에서 동작합니다.

## 기능

- 기본 프로필 및 명명된 프로필의 설정
- 키바인딩, 스니펫, 사용자 태스크, 프롬프트, MCP 구성
- 설치된 확장 목록, 버전, 활성화 상태, 프리릴리스, 고정(pinning) 상태
- 프로필 정의
- Cursor User Rules
- `~/.cursor`의 MCP·CLI 구성, commands, skills, rules
- 허용 목록으로 지정된 `%APPDATA%\Cursor\User\workspaceStorage` 상태와 notepads·images의 이식 가능한 쿼리 수준 동기화
- Composer/채팅 기록(다음 대화를 이어가는 데 필요한 content-addressed 데이터 포함), 에이전트 트랜스크립트, 지원되는 `store.db` 세션
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
- 저장소 패스프레이즈(선택 사항, 설정할 경우 12자 이상). 비워 두면 암호화 키가 저장소 안에 저장되므로, 개인 로컬 폴더나 완전히 신뢰하는 비공개 원격에서만 사용하세요.

Cursor 내장 런타임이 필요한 SQLite 기능을 제공하지 않을 때도 파일 기반 동기화는 계속 사용할 수 있습니다. 프로필, 사용자 규칙, 확장 상태, 워크스페이스 스토리지, DB 기반 채팅 동기화는 `node:sqlite`, 온라인 백업 지원, 호환되는 로컬 스키마가 필요합니다.

## 설치

Extensions 뷰에서 **Cursor Setting Sync**를 설치한 뒤, 명령 팔레트의 유일한 항목인 `Cursor Setting Sync: Manage`를 실행하고 **Repository & Devices…** → **Setup or Reconfigure This PC…**를 선택합니다.

## 셋업

### 공통 (모든 방식 공통)

- 어느 방식이든 `Cursor Setting Sync: Manage` → **Repository & Devices…** → **Setup or Reconfigure This PC…**에서 시작합니다.
- 패스프레이즈는 선택 사항입니다. 입력한다면 12자 이상이어야 하고 모든 PC에서 동일해야 합니다. 공유 저장소에 저장되지 않으며, 복구할 수 없습니다.
- 패스프레이즈를 비워 두면 보안 경고가 뜬 뒤 진행됩니다. 이 경우 암호화 키가 저장소 안(데이터 옆)에 놓여, 공유 폴더나 git 원격을 읽을 수 있는 사람은 누구나 복호화할 수 있습니다. 신뢰할 수 있는 로컬 폴더나 완전히 통제되는 비공개 원격에서만 사용하세요.
- 추가 PC에서는 파일 리소스가 안전할 때 자동으로 적용됩니다. DB·워크스페이스 스토리지 변경은 모든 Cursor 창을 정상 종료하면 종료 헬퍼가 자동 적용합니다. 지금 동기화하고 생긴 DB 대기열까지 즉시 적용하려면 **Manage** → **Sync & Apply Now**를 사용합니다. 오프라인 작업이 없으면 Cursor를 종료하지 않습니다. 수신 workspaceStorage는 같은 ID, 유일하게 정확히 일치하는 정규화 URI, 이전에 확정한 매핑일 때만 자동 연결되며, 모호한 워크스페이스는 채팅이나 다른 리소스를 막지 않고 보류됩니다.
- 설정 전에는 상태바를 누르면 **Manage**의 **Repository & Devices…** → **Setup or Reconfigure This PC…** 흐름으로 바로 연결됩니다. 저장소가 설정되기 전까지는 아무것도 동기화되지 않습니다.

방식별 상세는 아래를 참고하고, 제공자별 주의사항은 [저장소 옵션](#저장소-옵션) 표를 확인하세요.

### 방식 A — 공유 폴더 (OneDrive · Dropbox · Google Drive · Syncthing · 로컬)

**첫 번째 PC**

1. `Cursor Setting Sync: Manage`를 실행하고 **Repository & Devices…** → **Setup or Reconfigure This PC…**를 선택합니다.
2. 공유 폴더(또는 로컬 폴더) 안의 빈 폴더를 선택합니다.
3. **Plain shared folder**를 선택합니다.
4. 패스프레이즈를 입력합니다(12자 이상, 또는 비워서 생략).
5. 상태바가 동기화 완료를 보고할 때까지 기다린 뒤, 공유 폴더 제공자의 업로드 완료를 확인합니다.

**추가 PC**

1. 확장을 설치하고 `Cursor Setting Sync: Manage`에서 **Repository & Devices…** → **Setup or Reconfigure This PC…**를 선택합니다.
2. 같은 공유 폴더(각 PC의 로컬 사본)를 선택합니다.
3. **Plain shared folder**를 선택하고 같은 패스프레이즈를 입력합니다.

> Google Drive는 "파일 미러링" 모드 + "오프라인 액세스", OneDrive는 "항상 이 장치에 유지"가 필요합니다. 자세한 내용은 [저장소 옵션](#저장소-옵션)을 참고하세요.

### 방식 B — Git 원격 (GitHub · GitLab · 셀프호스팅)

**사전 준비**: `git` CLI가 PATH에 있어야 하고, 인증은 비대화식(`GIT_TERMINAL_PROMPT=0`)으로 동작하므로 자격증명 헬퍼나 SSH 키를 미리 설정하세요.

**첫 번째 PC (새 저장소 생성)**

1. `Cursor Setting Sync: Manage`를 실행하고 **Repository & Devices…** → **Setup or Reconfigure This PC…**를 선택합니다.
2. 빈 폴더를 선택합니다(위치는 자유).
3. **New git repository with remote**를 선택하고 원격 URL을 입력합니다(비워두면 원격 없는 로컬 git 히스토리).
4. 패스프레이즈를 입력합니다(12자 이상, 또는 비워서 생략). 첫 동기화에서 원격으로 push됩니다.

**추가 PC (기존 저장소 합류)**

1. 확장을 설치하고 `Cursor Setting Sync: Manage`에서 **Repository & Devices…** → **Setup or Reconfigure This PC…**를 선택합니다.
2. 빈 폴더를 선택합니다.
3. **Clone an existing git repository**를 선택하고 같은 원격 URL을 입력합니다.
4. 같은 패스프레이즈를 입력합니다.

## 저장소 옵션

저장소는 암호화된 append-only 파일들이 담긴 폴더입니다. "동기화"의 의미는 그 폴더를 다른 PC로 무엇이 옮겨 주느냐에 따라 달라집니다. **Manage**의 **Repository & Devices…** → **Setup or Reconfigure This PC…**에서 폴더를 지정하고, 폴더가 이동하는 방식에 맞는 전송을 선택하세요.

| 전송 방식 | 설정 방법 | 결과 |
| --- | --- | --- |
| **OneDrive / Dropbox / iCloud Drive** | **Plain shared folder**를 선택하고, 제공자가 동기화하는 위치 안의 빈 폴더를 지정하세요. 폴더는 반드시 디스크에 실제로 유지해야 합니다. OneDrive는 폴더 우클릭 → **"항상 이 장치에 유지"**("공간 확보"는 사용 금지, 이것이 "파일 온디맨드" 기능입니다), Dropbox는 "온라인 전용"을 끄고, iCloud Drive는 기본적으로 파일을 로컬에 유지합니다. | 완전한 다중 PC 동기화. 제공자가 폴더를 업로드하고, 각 PC는 같은 동기 폴더의 자기 로컬 사본을 **Repository & Devices…** → **Setup or Reconfigure This PC…**에서 가리킵니다. |
| **Google Drive** | 데스크톱용 Google Drive에서 **"파일 미러링"** 모드(스트리밍 전용 아님)를 쓰고, 폴더를 우클릭해 **"오프라인 액세스 가능"**으로 설정한 다음 **Plain shared folder**를 선택하세요. | 완전한 다중 PC 동기화. 스트리밍 전용 모드에서는 파일이 가상 placeholder라 파일 감시와 읽기가 불안정하므로 파일 미러링 모드가 필수입니다. |
| **Syncthing / Resilio** | 모든 PC의 공유를 같은 폴더로 맞추고 **Plain shared folder**를 선택하세요. | 클라우드 계정 없이 완전한 다중 PC 동기화. 확장은 `sync-conflict` 사본을 이미 무시합니다. |
| **로컬 폴더(클라우드·git 없음)** | **Plain shared folder**를 선택하고 아무 로컬 경로나 지정하세요. | 단일 PC 버전 백업. **Restore Data…**에서 전체 버전 히스토리와 DB 백업 복원을 모두 사용할 수 있습니다. 폴더를 기기 밖으로 옮기는 주체가 없으므로 다른 PC로 전파되지 않을 뿐입니다. |
| **Git — clone existing** | **Clone an existing git repository**를 선택하고 저장소 URL(GitHub·GitLab·셀프호스팅 원격)을 붙여넣으세요. | 다른 PC들이 이미 push하는 저장소에 합류합니다. 매 주기마다 읽기 전에 pull하고 쓰기 후 commit/push합니다. |
| **Git — new with remote** | **New git repository with remote**를 선택하고 원격 URL을 붙여넣으세요. | 폴더에 git을 초기화하고 원격을 연결하며, 첫 동기화에서 push합니다. GitHub/GitLab/셀프호스팅으로 여러 PC를 새로 시작할 때 쓰세요. |
| **Git — local-only** | **New git repository with remote**를 선택하고 URL을 비워 두세요. | 원격 없는 로컬 git 히스토리 — 로컬 폴더와 같지만 git 커밋이 남습니다. 나중에 원격을 추가해 게시할 수 있습니다. |

Git 전송에는 `git` CLI가 `PATH`에 있어야 합니다. 인증은 시스템 git 자격증명을 비대화식(`GIT_TERMINAL_PROMPT=0`)으로 사용하므로, 자격증명 헬퍼나 SSH 키를 미리 설정하세요. 인증 실패 시 경고로 강등되고 폴더는 로컬에서 계속 동작합니다. 원격 변경은 폴링으로 감지됩니다(git 모드는 파일 변경 이벤트를 받지 않음). 암호화 페이로드는 델타 압축이 안 되어 git 저장소는 담긴 데이터만큼 커집니다. 확장은 git 파일 크기를 자동 검사하며, 이벤트 로그가 500개를 넘으면 동기화와 동일한 전파·안전 조건 아래에서 체크포인트와 프루닝을 주기적으로 시도합니다.

## 다른 PC에서 같은 원본 채팅 이어가기

PC B에서는 대화가 정상적으로 이어지고 있고, 새 승계 Agent가 아니라 PC A에서 그 원본 대화를 그대로 이어 쓰려면 다음 순서로 진행합니다.

1. 두 PC에 같은 최신 확장 버전을 설치합니다. PC B에서 정상 원본 대화를 연 뒤 자동 동기화와 공유 폴더 업로드 또는 git push가 모두 끝날 때까지 기다립니다. 즉시 한 주기를 강제하려면 **Manage**에서 **Sync & Apply Now**를 선택합니다. 먼저 동기화하고 DB 작업이 대기 중일 때만 Cursor를 종료합니다.
2. PC A에서 자동 저장소 갱신을 기다립니다. DB 변경이 대기하면 모든 Cursor 창을 정상 종료하고 종료 헬퍼가 끝난 뒤 다시 실행합니다. 즉시 적용하려면 **Manage** → **Sync & Apply Now**를 선택합니다. Cursor 실행 중에는 채팅 DB 행을 쓰지 않습니다.
3. 같은 워크스페이스를 다시 열고 원본 대화를 선택합니다. 정확히 같은 `composerId`가 유지되며 새 Agent를 만들지 않습니다.

PC A는 완전한 portable v2 continuation graph에서만 채팅 core를 대기열에 넣어 적용하고, 오프라인 헬퍼가 쓰기 직전에 메타데이터와 reachable closure를 다시 검증합니다. Legacy blob-only 이벤트 자체는 blob만 추가할 수 있고 없는 core를 직접 만들지는 않지만, 그 payload의 closure가 완전하면 현재 확장이 검증된 core-applying child로 다시 발행해 기존 저장소에서도 원본 core를 복구할 수 있게 합니다. 실제로 보존된 orphan blob은 유지하고, 현재 core에서 도달할 수 없으며 원본 PC에도 없다고 확인된 missing 선언만 bounded 단계로 정규화합니다. Cursor가 양쪽 사본에 같은 고정 timestamp를 부여했더라도, 더 긴 완전한 사본이 공통 visible sequence의 확실한 strict extension일 때만 자동으로 선택됩니다. 모호하게 갈라진 fork는 자동 덮어쓰기하지 않고 수동 처리를 위해 남깁니다. 새로 발행되거나 변경된 채팅도 bounded 두 개 작업 묶음에 포함된 경우에만 같은 동기화 주기 안에서 continuation enrichment를 받습니다. 다만 오래된 채팅이 매우 많으면 backlog는 점진적으로 처리되므로 한 주기로 모든 legacy 대화가 준비된다고 보장하지 않습니다. 정상 원본이 남은 PC에서 추가 자동 동기화 주기를 허용한 뒤 다른 PC에 적용하세요.

## 하나의 관리 명령

명령 팔레트에는 **Cursor Setting Sync: Manage** 하나만 표시됩니다. 평소에는 명령이 필요 없습니다. 동기화는 폴링과 파일 감시로 자동 실행되고, 안전한 파일 변경은 Cursor 실행 중 적용되며, 대기 중인 DB 변경은 모든 Cursor 창을 정상 종료하면 적용됩니다. 체크포인트·프루닝·orphan 정리도 bounded 안전 조건 뒤에서 자동 실행됩니다.

**Manage**의 최상위 작업은 정확히 6개입니다.

- **Show Diagnostics**: 상태·경고·대기 작업·저장소 사용량을 확인합니다.
- **Sync & Apply Now**: 한 번 동기화하고 안전한 라이브 파일 작업을 적용한 뒤, DB 변경이 대기 중일 때만 Cursor를 종료·적용·재실행합니다. 평소 자동 작업을 앞당기는 단일 작업입니다.
- **Resolve Conflicts**: 안전하게 병합할 수 없는 데이터의 어느 쪽을 유지할지 선택합니다.
- **Recover Chats…**: bounded 원위치 복구와 안전한 transcript 대체 경로인 **Check and Recover Current Chats**, **Open a Preserved Chat**을 담습니다. 전체 복구 감사는 큰 라이브 DB를 스캔할 수 있으므로 의도적으로 사용자가 시작하게 유지합니다. 누락 continuation 데이터를 만들어내지 않으며 정확한 원본이 없으면 기존 채팅을 바꾸지 않습니다.
- **Restore Data…**: 명시적인 롤백인 **Restore a Synchronized Version**, **Restore a Local Database Backup (Emergency)**를 담습니다. 두 복원 경로 모두 의도적으로 사용자가 시작해야 합니다. DB 복원은 Cursor를 종료하고 이후 다른 PC에도 복원 상태가 동기화되며, 복원 전에는 되돌릴 수 있는 pre-restore 백업을 만듭니다.
- **Repository & Devices…**: **Setup or Reconfigure This PC…**, **Map Pending Workspaces…**, **Archive Repository…**, **Retire or Restore Another Device…**, **Disconnect This PC**를 담습니다. 서로 다른 두 경로가 같은 프로젝트라는 사실을 알고 있을 때만 워크스페이스를 수동 매핑하세요. 일반 동기화는 폴더 이름만 보고 추정하지 않습니다. Disconnect는 이 PC의 경로·키·매핑만 지우며 공유 저장소는 바꾸지 않습니다.

상태바를 누르면 설정·진단·동기화·충돌 해결에 맞는 내부 작업으로 바로 연결됩니다. 대기 중인 DB 작업은 정상 종료 시 계속 자동 적용되며, 지금 처리하려면 최상위 **Sync & Apply Now** 하나만 선택하면 됩니다.

## 설정 항목

```jsonc
{
  "cursorSettingSync.enabled": true,
  "cursorSettingSync.pollIntervalSeconds": 30,
  "cursorSettingSync.chatPollIntervalSeconds": 30,
  "cursorSettingSync.autoApplyFiles": true,
  "cursorSettingSync.syncChat": true,
  "cursorSettingSync.syncWorkspaceStorage": true,
  "cursorSettingSync.applyOnShutdown": true,
  "cursorSettingSync.syncLocalWorkspaces": false,
  "cursorSettingSync.ignoredWorkspaces": [],
  "cursorSettingSync.gitSync": true,
  "cursorSettingSync.ignoredSettings": [],
  "cursorSettingSync.useDefaultIgnoredSettings": true,
  "cursorSettingSync.ignoredExtensions": [],
  "cursorSettingSync.ignoredUserFiles": [],
  "cursorSettingSync.ignoredUiStateKeys": [],
  "cursorSettingSync.maxPayloadMiB": 128
}
```

| 설정 | 기본값 | 역할 |
| --- | --- | --- |
| `enabled` | `true` | Setup 이후 자동 동기화를 켜고 끄는 마스터 스위치. |
| `pollIntervalSeconds` | `30` | 공유 저장소를 스캔하는 폴백 폴링 간격(초, 10–3600). git 모드는 원격 변경을 이 폴링으로 감지합니다. |
| `chatPollIntervalSeconds` | `30` | Cursor 채팅 메타데이터 변경을 확인하는 간격(초, 10–3600). |
| `autoApplyFiles` | `true` | Cursor 실행 중 충돌 없는 파일 리소스를 자동 적용할지. **Sync & Apply Now**의 동기화 단계는 이 값과 무관하게 적용합니다. |
| `syncChat` | `true` | 지원되는 Cursor 채팅 저장소(composer 대화·에이전트 트랜스크립트·`store.db`) 동기화 여부. |
| `syncWorkspaceStorage` | `true` | `workspaceStorage` 상태 백업 여부. 모든 Cursor 프로세스가 종료된 뒤에만 캡처됩니다. |
| `applyOnShutdown` | `true` | Cursor를 정상 종료할 때 대기 중인 데이터베이스 작업을 자동 적용할지. 끄면 **Sync & Apply Now**로 명시적으로 적용합니다. 안전한 파일 작업은 계속 실행 중 적용되며, Cursor가 실행 중일 때 데이터베이스를 쓰지는 않습니다. |
| `syncLocalWorkspaces` | `false` | 로컬 폴더 워크스페이스(`file://`)를 workspaceStorage 동기화에 포함할지. **기본은 끔**: 로컬 폴더는 경로로 식별되므로 두 컴퓨터가 같은 프로젝트를 똑같은 경로로 열지 않는 한 반대편에 내려앉을 곳이 없습니다. 일반 동기화에서는 일치하지 않는 데이터를 선택창 없이 보류하며, 서로 다른 두 경로가 같은 프로젝트임을 확실히 아는 경우에만 **Map Pending Workspaces…**를 사용하세요. Remote-SSH 워크스페이스는 항상 동기화됩니다. **기기 범위.** |
| `ignoredWorkspaces` | `[]` | 위 기본 제외에 **더해서** 이 컴퓨터가 백업도 쓰기도 하지 않을 워크스페이스. 워크스페이스 URI로 매칭하며 와일드카드가 됩니다: `vscode-remote://ssh-remote+staging*`. Cursor가 저장한 퍼센트 인코딩 형태도 사람이 쓰는 읽기 쉬운 패턴과 매칭됩니다. **기기 범위(machine scope)**라 다른 설정과 달리 컴퓨터 간에 전파되지 않습니다 — 어떤 프로젝트가 이 기기에 있는지는 그 기기의 사실이기 때문입니다. 채팅에는 영향이 없습니다. |
| `gitSync` | `true` | 저장소 폴더가 git 워크트리일 때 읽기 전 pull·쓰기 후 commit/push를 사용할지. `git` CLI가 필요합니다. |
| `ignoredSettings` | `[]` | `settings.json`에서 동기화 제외할 설정 키 목록. API 키 등 민감한 값을 여기에 추가하세요. 각 항목은 정확한 키(`editor.fontSize`) 또는 와일드카드(`remote.SSH.*`)입니다. |
| `useDefaultIgnoredSettings` | `true` | 아래의 기기 전용 설정 기본 목록도 함께 제외할지. 끄면 해당 키들도 동기화됩니다. |
| `ignoredExtensions` | `[]` | 동기화에서 제외할 확장 ID 목록. 정확한 ID(`ms-python.python`) 또는 와일드카드(`ms-python.*`)이며 대소문자를 구분하지 않습니다. |
| `ignoredUserFiles` | `[]` | `~/.cursor` 아래에서 동기화 제외할 파일을 상대 경로로 지정합니다. `mcp.json`이나 `cli-config.json`을 공유 폴더에서 빼려면 `ignoredSettings`가 아니라 **이 설정**을 사용하세요. 디렉터리 항목(`rules` 또는 `rules/`)은 그 아래 전체를 제외하고, `rules/*.md`·`skills/**/secret.md` 같은 와일드카드도 동작합니다. |
| `ignoredUiStateKeys` | `[]` | **0.0.42부터 효과 없음.** UI 상태는 이제 어떤 키도 동기화하지 않으므로 이 목록이 제외할 대상이 남아 있지 않습니다. [UI 상태는 동기화하지 않습니다](#ui-상태는-동기화하지-않습니다) 참고. |
| `maxPayloadMiB` | `128` | 한 페이로드의 최대 비압축 크기(MiB, 1–512). 이보다 큰 리소스는 이름을 명시한 경고와 함께 건너뛰며, 같은 주기의 나머지 리소스는 정상적으로 동기화됩니다. |

모든 제외 목록은 같은 패턴을 지원합니다. 정확한 항목, 임의의 문자에 대응하는 `*`(경로형인 `ignoredUserFiles`에서는 `/`에서 멈춤), 디렉터리 구분자를 넘는 `**`입니다. `ignoredSettings`와 `ignoredUserFiles`에서는 아무것도 매칭하지 않은 항목이 출력 채널에 경고로 표시되므로 오타가 드러납니다.

레거시 `cursorSync.*` 네임스페이스에 남아 있는 값은 폴백으로 인정됩니다.

### 기본으로 제외되는 기기 전용 설정

아래 키들은 취향이 아니라 그 컴퓨터 자체를 기술합니다. VS Code가 확장 매니페스트가 아닌 워크벤치 코드에 등록하므로 확장 스캔으로는 볼 수 없습니다 — 프록시 URL에는 자격증명이 들어가고, 셸 경로는 다른 PC에 없을 수도 있는 실행 파일을 가리키며, 확대 배율은 모니터에 속한 값입니다. `cursorSettingSync.useDefaultIgnoredSettings: false`로 목록 전체를 끌 수 있습니다.

```
application.shellEnvironmentResolutionTimeout   remote.WSL.*
git.path                                        terminal.external.*
http.proxy*                                     terminal.integrated.automationProfile.*
http.systemCertificates                         terminal.integrated.cwd
http.experimental.systemCertificatesV2          terminal.integrated.defaultProfile.*
java.jdt.ls.java.home                           terminal.integrated.shell.*
python.condaPath                                terminal.integrated.shellArgs.*
python.defaultInterpreterPath                   window.zoomLevel
remote.SSH.*                                    window.zoomPerWindow
```

VS Code 자체 Settings Sync가 기기 간에 전파하는 키는 의도적으로 **목록에 넣지 않았습니다**. `terminal.integrated.profiles.*`, `terminal.integrated.env.*`, `files.simpleDialog.enable`은 평범한 애플리케이션 범위 환경설정이고, `python.venvPath`는 Python 확장 자체가 `machine` 범위로 선언합니다.

설치된 확장이 `machine` 또는 `machine-overridable` 범위로 선언한 설정은 이 목록에 더해 함께 제외됩니다.

이 목록에 있는 키가 이 PC에서 이미 동기화되고 있었다면, 목록이 그 키를 덮기 시작한 시점에 출력 채널이 해당 키 이름을 알려 주고 `Show Diagnostics`의 지속 경고 목록에도 같은 안내가 남습니다 — 업그레이드 후 어떤 키가 조용히 전파를 멈추는 일은 없습니다.

### UI 상태는 동기화하지 않습니다

0.0.42부터 **어떤 UI 상태 키도** 기기 사이를 이동하지 않습니다. 창 레이아웃 — 고정한 패널과 뷰 컨테이너, 숨긴 뷰, 패널별 상태, 알림 표시 카운터 — 은 그 값을 만든 기기에만 남습니다.

이 키들은 각 Cursor 창이 그 화면에서 한 일에 따라 제각기 다시 쓰는 값이라 두 기기 사이에 공유될 의미가 없고, 수렴할 대상도 없습니다. 그런데도 실어 나르다 보니 사람이 편집한 적 없는 충돌이 생겼습니다 — 이 확장을 만든 실제 환경에서 두 번째 컴퓨터가 처음 합류했을 때 뜬 충돌 16개 중 13개가 UI 상태였고, 그 키들의 유일한 잘못은 양쪽 기기에 모두 존재했다는 것뿐이었습니다. 0.0.4부터 0.0.41까지는 문제가 되는 계열을 하나씩 제외해 왔지만(죽은 채팅 패널 GUID, 고정 패널 합집합, reactive-storage 블롭), 현장에서는 늘 다음 키가 나왔습니다.

**Cursor 사용자 규칙**은 같은 데이터베이스 테이블에 저장되지만 별개의 리소스이므로 계속 동기화됩니다. 설정, 키 바인딩, 스니펫, 태스크, 프롬프트, MCP 설정, 확장, 프로필, 채팅, 워크스페이스 스토리지도 마찬가지입니다.

이는 안전 규칙이 아니라 정책입니다. 이전 버전이 이미 발행한 UI 상태 값은 도착 시 건너뛰고 출력 채널에 이름이 남으며, 같은 요청의 나머지 적용을 실패시키지 않습니다. 다른 기기에 이미 있는 값이 삭제되지도 않습니다. 따라서 `cursorSettingSync.ignoredUiStateKeys`는 아무 효과가 없으며 설정에서 지워도 됩니다.

## 보안 및 개인정보

- 페이로드는 저장소 무작위 마스터 키에서 파생된 키로 AES-256-GCM 암호화됩니다.
- 패스프레이즈에서 파생된 키는 마스터 키를 감싸기만 하며, 패스프레이즈는 저장소에 저장되지 않습니다.
- 잠금 해제된 마스터 키는 각 PC의 Cursor `SecretStorage`에 보관됩니다.
- Cursor/확장의 `SecretStorage`와 알려진 DB 기반 OAuth·인증 세션·비밀번호·자격증명·토큰 키는 제외됩니다.
- 동기화되는 설정이나 MCP JSON 안의 인라인 값은 암호화되지만 페이로드의 일부입니다. 환경 변수 참조를 선호하세요. `settings.json` 안의 민감한 키는 `cursorSettingSync.ignoredSettings`에, `mcp.json`·`cli-config.json`처럼 `~/.cursor` 아래의 파일 전체는 `cursorSettingSync.ignoredUserFiles`에 추가합니다.
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
- 강제 종료는 마지막 DB·워크스페이스 스토리지 내보내기를 못 끝낼 수 있습니다. 필요하면 **Manage**에서 **Sync & Apply Now**를 선택하세요. 먼저 동기화하고 대기 중인 오프라인 작업은 정상 종료·재실행 흐름으로 처리합니다.
- 워크스페이스 스토리지는 모든 Cursor 프로세스 종료 후에만 캡처됩니다. **Sync & Apply Now**의 Cursor 실행 중 동기화 단계는 이를 스캔하지 않으며, 오프라인 작업이 대기 중이면 종료 후 헬퍼가 캡처합니다.
- 워크스페이스 DB 가져오기는 프로토콜 v1에서 upsert 전용입니다. 대상에만 있는 행은 보존되며, 들어오지 않은 행이 로컬 상태를 삭제하지 않습니다.
- 에이전트 트랜스크립트만으로는 모든 Cursor 사이드바 항목을 완전히 재현하지 못할 수 있습니다.
- 확정된 이벤트와 툼스톤은 자동 유지보수가 체크포인트로 접어 제거할 때까지 저장소 프로토콜 v1에서 유지됩니다. 이벤트 로그 파일이 500개를 넘으면 실행 중인 extension host는 자동 시도 사이에 최소 6시간을 기다립니다. Cursor를 다시 시작하면 더 일찍 재평가할 수 있지만 전파·age·보류 작업·충돌 안전 조건은 그대로 적용됩니다.
- 기기 전용 제외 집합은 PC마다 따로 계산됩니다. 확장이 `machine` 범위로 선언한 키는 그 확장이 설치된 PC에서만 제외되므로, 확장 설치 순서에 따라 그런 키가 전파될 수 있습니다. 위의 기본 목록은 모든 PC에 동일하게 적용되며 영향을 받지 않습니다.

기술적 상세는 [usage](docs/usage.md), [protocol](docs/protocol.md), [security](docs/security.md), [compatibility](docs/compatibility.md)를 참고하세요.

## 라이선스

[MIT](LICENSE)

## 링크

- [저장소](https://github.com/LCH-1/cursor-setting-sync)
- [이슈 트래커](https://github.com/LCH-1/cursor-setting-sync/issues)
