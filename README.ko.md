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

Extensions 뷰에서 **Cursor Setting Sync**를 설치한 뒤, 명령 팔레트에서 `Cursor Setting Sync: Setup`을 실행합니다.

## 셋업

### 공통 (모든 방식 공통)

- 어느 방식이든 `Cursor Setting Sync: Setup`을 실행하는 것으로 시작합니다.
- 패스프레이즈는 선택 사항입니다. 입력한다면 12자 이상이어야 하고 모든 PC에서 동일해야 합니다. 공유 저장소에 저장되지 않으며, 복구할 수 없습니다.
- 패스프레이즈를 비워 두면 보안 경고가 뜬 뒤 진행됩니다. 이 경우 암호화 키가 저장소 안(데이터 옆)에 놓여, 공유 폴더나 git 원격을 읽을 수 있는 사람은 누구나 복호화할 수 있습니다. 신뢰할 수 있는 로컬 폴더나 완전히 통제되는 비공개 원격에서만 사용하세요.
- 추가 PC에서는 파일 리소스가 안전할 때 자동으로 적용됩니다. DB·워크스페이스 스토리지 변경이 대기하면 상태바 안내에 따라 `Cursor Setting Sync: Restart to Apply`를 실행합니다.
- Setup 전에 `Sync Now`(또는 다른 명령)를 실행하면 아무 일도 일어나지 않습니다. 상태바에 `unconfigured`가 표시되고 Setup을 안내하는 메시지가 뜹니다. 저장소가 설정되기 전까지는 아무것도 동기화되지 않습니다.

방식별 상세는 아래를 참고하고, 제공자별 주의사항은 [저장소 옵션](#저장소-옵션) 표를 확인하세요.

### 방식 A — 공유 폴더 (OneDrive · Dropbox · Google Drive · Syncthing · 로컬)

**첫 번째 PC**

1. `Cursor Setting Sync: Setup`을 실행합니다.
2. 공유 폴더(또는 로컬 폴더) 안의 빈 폴더를 선택합니다.
3. **Plain shared folder**를 선택합니다.
4. 패스프레이즈를 입력합니다(12자 이상, 또는 비워서 생략).
5. 상태바가 동기화 완료를 보고할 때까지 기다린 뒤, 공유 폴더 제공자의 업로드 완료를 확인합니다.

**추가 PC**

1. 확장을 설치하고 `Cursor Setting Sync: Setup`을 실행합니다.
2. 같은 공유 폴더(각 PC의 로컬 사본)를 선택합니다.
3. **Plain shared folder**를 선택하고 같은 패스프레이즈를 입력합니다.

> Google Drive는 "파일 미러링" 모드 + "오프라인 액세스", OneDrive는 "항상 이 장치에 유지"가 필요합니다. 자세한 내용은 [저장소 옵션](#저장소-옵션)을 참고하세요.

### 방식 B — Git 원격 (GitHub · GitLab · 셀프호스팅)

**사전 준비**: `git` CLI가 PATH에 있어야 하고, 인증은 비대화식(`GIT_TERMINAL_PROMPT=0`)으로 동작하므로 자격증명 헬퍼나 SSH 키를 미리 설정하세요.

**첫 번째 PC (새 저장소 생성)**

1. `Cursor Setting Sync: Setup`을 실행합니다.
2. 빈 폴더를 선택합니다(위치는 자유).
3. **New git repository with remote**를 선택하고 원격 URL을 입력합니다(비워두면 원격 없는 로컬 git 히스토리).
4. 패스프레이즈를 입력합니다(12자 이상, 또는 비워서 생략). 첫 동기화에서 원격으로 push됩니다.

**추가 PC (기존 저장소 합류)**

1. 확장을 설치하고 `Cursor Setting Sync: Setup`을 실행합니다.
2. 빈 폴더를 선택합니다.
3. **Clone an existing git repository**를 선택하고 같은 원격 URL을 입력합니다.
4. 같은 패스프레이즈를 입력합니다.

## 저장소 옵션

저장소는 암호화된 append-only 파일들이 담긴 폴더입니다. "동기화"의 의미는 그 폴더를 다른 PC로 무엇이 옮겨 주느냐에 따라 달라집니다. `Setup`에서 폴더를 지정하고, 폴더가 이동하는 방식에 맞는 전송을 선택하세요.

| 전송 방식 | 설정 방법 | 결과 |
| --- | --- | --- |
| **OneDrive / Dropbox / iCloud Drive** | **Plain shared folder**를 선택하고, 제공자가 동기화하는 위치 안의 빈 폴더를 지정하세요. 폴더는 반드시 디스크에 실제로 유지해야 합니다. OneDrive는 폴더 우클릭 → **"항상 이 장치에 유지"**("공간 확보"는 사용 금지, 이것이 "파일 온디맨드" 기능입니다), Dropbox는 "온라인 전용"을 끄고, iCloud Drive는 기본적으로 파일을 로컬에 유지합니다. | 완전한 다중 PC 동기화. 제공자가 폴더를 업로드하고, 각 PC는 같은 동기 폴더의 자기 로컬 사본을 `Setup`에서 가리킵니다. |
| **Google Drive** | 데스크톱용 Google Drive에서 **"파일 미러링"** 모드(스트리밍 전용 아님)를 쓰고, 폴더를 우클릭해 **"오프라인 액세스 가능"**으로 설정한 다음 **Plain shared folder**를 선택하세요. | 완전한 다중 PC 동기화. 스트리밍 전용 모드에서는 파일이 가상 placeholder라 파일 감시와 읽기가 불안정하므로 파일 미러링 모드가 필수입니다. |
| **Syncthing / Resilio** | 모든 PC의 공유를 같은 폴더로 맞추고 **Plain shared folder**를 선택하세요. | 클라우드 계정 없이 완전한 다중 PC 동기화. 확장은 `sync-conflict` 사본을 이미 무시합니다. |
| **로컬 폴더(클라우드·git 없음)** | **Plain shared folder**를 선택하고 아무 로컬 경로나 지정하세요. | 단일 PC 버전 백업. 전체 버전 히스토리, `Restore Version History`, `Restore Backup`이 모두 동작합니다. 폴더를 기기 밖으로 옮기는 주체가 없으므로 다른 PC로 전파되지 않을 뿐입니다. |
| **Git — clone existing** | **Clone an existing git repository**를 선택하고 저장소 URL(GitHub·GitLab·셀프호스팅 원격)을 붙여넣으세요. | 다른 PC들이 이미 push하는 저장소에 합류합니다. 매 주기마다 읽기 전에 pull하고 쓰기 후 commit/push합니다. |
| **Git — new with remote** | **New git repository with remote**를 선택하고 원격 URL을 붙여넣으세요. | 폴더에 git을 초기화하고 원격을 연결하며, 첫 동기화에서 push합니다. GitHub/GitLab/셀프호스팅으로 여러 PC를 새로 시작할 때 쓰세요. |
| **Git — local-only** | **New git repository with remote**를 선택하고 URL을 비워 두세요. | 원격 없는 로컬 git 히스토리 — 로컬 폴더와 같지만 git 커밋이 남습니다. 나중에 원격을 추가해 게시할 수 있습니다. |

Git 전송에는 `git` CLI가 `PATH`에 있어야 합니다. 인증은 시스템 git 자격증명을 비대화식(`GIT_TERMINAL_PROMPT=0`)으로 사용하므로, 자격증명 헬퍼나 SSH 키를 미리 설정하세요. 인증 실패 시 경고로 강등되고 폴더는 로컬에서 계속 동작합니다. 원격 변경은 폴링으로 감지됩니다(git 모드는 파일 변경 이벤트를 받지 않음). 암호화 페이로드는 델타 압축이 안 되어 git 저장소는 담긴 데이터만큼 커집니다 — GitHub는 100MB 초과 파일을 거부하고 수 GB 이하 저장소를 선호하므로, `Show Repository Usage`를 확인하고 저장소가 커지면 `Checkpoint & Prune History`로 git 히스토리를 스쿼시하세요.

## 명령어

**초기 설정 · 일상 동기화**

- **Setup** — 최초 설정. 저장소 폴더와 전송 방식(plain / clone / new git)을 고르고 암호화 패스프레이즈를 입력합니다(12자 이상, 모든 PC 동일, 폴더에 저장 안 됨).
- **Sync Now** — 즉시 한 번 동기화. 평소에는 자동으로 동기화됩니다(30초 폴링 + 파일 감시). 로컬 변경을 발행하고 원격 변경을 받아옵니다.
- **Restart to Apply** — 대기 중인 DB 변경을 적용합니다. 이 명령이 대기열을 오프라인 헬퍼에 넘기고, Cursor를 종료시키고, 모든 프로세스가 끝나기를 기다린 뒤 행을 쓰고 다시 실행합니다. 사용자가 직접 Cursor를 껐다 켜는 것으로는 **적용되지 않습니다** — 종료 헬퍼는 이 기기의 변경을 내보내기만 하므로 대기열은 그대로 남습니다. 파일은 실행 중에도 적용되지만 `state.vscdb`(채팅, 사용자 규칙, 워크스페이스 DB)는 Cursor 종료 후에만 SQL로 안전하게 씁니다.

**충돌 · 복구**

- **Resolve Conflicts** — 두 PC에서 편집해 자동 병합되지 않은 충돌을 수동으로 해결합니다. 모든 충돌이 한 화면에 이름과 양쪽 값과 함께 나열됩니다 — `Setting: editor.fontSize · This PC: 14 vs Other PC: 16` — 어느 PC가 언제 썼는지도 함께 표시됩니다. *전부 최신 것으로*, *전부 이 PC 것으로*, *전부 상대 PC 것으로* 중 하나로 목록 전체를 한 번에 처리하거나, 개별 항목을 골라 diff를 열고 따로 결정할 수 있습니다. diff는 직접 확인을 요청한 항목에 대해서만 열립니다. 나중으로 미뤄도 잃는 것은 없습니다. 양쪽 버전이 저장소에 그대로 남고, **Restore Version History**로 진 쪽을 되살릴 수 있습니다. UI 상태와 채팅은 여기에 거의 나타나지 않습니다. UI 상태는 아예 동기화되지 않고, 채팅 분기는 양쪽 메시지의 합집합으로 병합되며, 워크스페이스 DB와 `notepads.json`은 행 단위·노트 단위로 합쳐지므로 어느 PC의 노트도 충돌 해결을 위해 버려지지 않습니다. 사용자가 직접 작성했고 합칠 수 없는 리소스(설정, `.cursor` 규칙과 사용자 파일, 확장)와, 같은 노트를 양쪽에서 서로 다르게 고친 경우만 확인을 요청합니다. 충돌이 열려 있는 동안 해당 리소스는 상대 PC가 이쪽 버전을 볼 수 있도록 최대 1시간에 한 번만 다시 게시하며, 충돌을 해결하면 즉시 정상 동기화로 돌아갑니다.
- **Restore Version History** — 리소스를 과거 버전으로 되돌립니다(git revert와 유사). 먼저 데이터 종류를 고르며, 일반 채팅을 되살릴 때는 **Agent transcripts**가 아니라 **Cursor conversations**를 선택하세요. 채팅이 많으면 워크스페이스/프로젝트로 한 번 더 좁히고, 실제 과거 복원 버전이 있는 항목만 읽기 쉬운 이름·메시지 수·날짜와 함께 표시합니다. diff 미리보기에서 버전을 확인한 뒤 새 버전으로 발행하며, 기존 히스토리는 보존됩니다.
- **Repair Unavailable Chats** — 보이는 메시지 행 손상뿐 아니라, 복원된 대화는 보이지만 다음 프롬프트가 거절되는 continuation 데이터 누락도 자동으로 찾습니다. 동기화된 완전한 사본이 있으면 채팅이나 버전을 직접 고르지 않고 복구합니다. 구버전으로 옮긴 채팅에 continuation 데이터가 아직 없다면 그 채팅을 정상적으로 이어갈 수 있는 PC를 먼저 업데이트해 **Sync Now**를 실행한 뒤, 대상 PC에서도 **Sync Now**와 이 명령을 실행하세요. 기존 메시지와 현재 제목·헤더·composerData는 유지하며, DB 쓰기는 Cursor 종료 후 백업과 최종 race 검사를 거쳐 수행합니다.
- **Restore Backup** — DB를 이전 백업 시점으로 복원합니다. 모든 DB 쓰기 전에 SQLite 백업을 뜨며, 그중 하나를 골라 복원합니다. 잘못된 복원을 되돌릴 "pre-restore" 백업도 목록에 표시됩니다.

**저장소 관리**

- **Checkpoint & Prune History** — 현재 상태를 체크포인트로 접고, 모든 PC가 그것을 받은 뒤 접힌 히스토리를 삭제해 저장소가 무한히 커지는 것을 막습니다. git 모드에서는 git 히스토리도 스쿼시합니다. 실행 전 모든 PC를 업데이트하세요 — 이후 구버전은 명확한 에러로 중단됩니다.
- **Compact Safe Orphans** — 가벼운 청소. 어떤 이벤트도 참조하지 않는 객체 파일과 오래된 임시 파일만 삭제합니다. 이벤트 히스토리는 건드리지 않습니다.
- **Archive Repository** — 저장소 폴더 전체를 별도 위치에 백업 아카이브로 복사합니다.
- **Forget Device** — 더 이상 쓰지 않는 기기를 목록에서 제거합니다(로컬 상태만). 오프라인 기기가 프루닝을 막을 때 사용합니다.
- **Disconnect** — 이 PC에서 동기화를 중단합니다. 저장된 저장소 경로·암호화 키·워크스페이스 매핑을 지우며, 공유 폴더와 히스토리는 그대로 둡니다. 저장소를 바꾸거나, 동기화를 멈추거나, "The configured folder now contains a different repository." 오류에서 벗어날 때 사용합니다.

**진단**

- **Show Diagnostics** — 현재 동기화 상태, 실제로 적용 중인 설정 값, 기기 전용 제외 목록, 대기 중인 각 변경과 그 이유, 충돌 중인 리소스, 그리고 지속 중인 경고와 경과 시간을 봅니다. 문제가 있어 보이면 여기부터 확인하세요.
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
| `autoApplyFiles` | `true` | Cursor 실행 중 충돌 없는 파일 리소스를 자동 적용할지. 수동 `Sync Now`는 이 값과 무관하게 적용합니다. |
| `syncChat` | `true` | 지원되는 Cursor 채팅 저장소(composer 대화·에이전트 트랜스크립트·`store.db`) 동기화 여부. |
| `syncWorkspaceStorage` | `true` | `workspaceStorage` 상태 백업 여부. 모든 Cursor 프로세스가 종료된 뒤에만 캡처됩니다. |
| `syncLocalWorkspaces` | `false` | 로컬 폴더 워크스페이스(`file://`)를 workspaceStorage 동기화에 포함할지. **기본은 끔**: 로컬 폴더는 경로로 식별되므로 두 컴퓨터가 같은 프로젝트를 똑같은 경로로 열지 않는 한 반대편에 내려앉을 곳이 없고, 실제로 벌어지는 일은 무관한 워크스페이스 수백 개를 나열하며 존재하지 않는 대상을 고르라는 프롬프트뿐입니다. 모든 컴퓨터에서 같은 프로젝트가 같은 경로에 있다면 켜세요. Remote-SSH 워크스페이스는 항상 동기화됩니다. **기기 범위.** |
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
- 강제 종료는 마지막 DB·워크스페이스 스토리지 내보내기를 못 끝낼 수 있습니다. 중요한 작업 후에는 `Cursor Setting Sync: Sync Now`를 실행하고 Cursor를 정상 종료하세요.
- 워크스페이스 스토리지는 모든 Cursor 프로세스 종료 후에만 캡처됩니다. `Cursor Setting Sync: Sync Now`는 Cursor 실행 중에는 그것을 스캔하지 않습니다.
- 워크스페이스 DB 가져오기는 프로토콜 v1에서 upsert 전용입니다. 대상에만 있는 행은 보존되며, 들어오지 않은 행이 로컬 상태를 삭제하지 않습니다.
- 에이전트 트랜스크립트만으로는 모든 Cursor 사이드바 항목을 완전히 재현하지 못할 수 있습니다.
- 확정된 이벤트와 툼스톤은 저장소 프로토콜 v1에서 유지됩니다. `Checkpoint & Prune History`가 그것을 접어서 삭제하며, 이벤트 로그 파일이 500개를 넘으면 폴링이 같은 접기를 자동으로 실행합니다(최대 6시간에 한 번, 수동 실행과 동일한 안전 조건 아래에서).
- 기기 전용 제외 집합은 PC마다 따로 계산됩니다. 확장이 `machine` 범위로 선언한 키는 그 확장이 설치된 PC에서만 제외되므로, 확장 설치 순서에 따라 그런 키가 전파될 수 있습니다. 위의 기본 목록은 모든 PC에 동일하게 적용되며 영향을 받지 않습니다.

기술적 상세는 [usage](docs/usage.md), [protocol](docs/protocol.md), [security](docs/security.md), [compatibility](docs/compatibility.md)를 참고하세요.

## 라이선스

[MIT](LICENSE)

## 링크

- [저장소](https://github.com/LCH-1/cursor-setting-sync)
- [이슈 트래커](https://github.com/LCH-1/cursor-setting-sync/issues)
