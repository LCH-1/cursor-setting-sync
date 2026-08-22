# Cursor Setting Sync 확장 — 기획서

- 문서 버전: v2.0 (구현 기준)
- 최초 작성일: 2026-07-13
- v2 갱신일: 2026-07-16
- 대상: 공개 배포용 Cursor 확장, Windows 우선
- 지원 기준: VS Code API 1.99 이상. 정확한 Cursor 버전 문자열 대신 런타임 기능과 DB 스키마 계약으로 판정
- 목적: 두 대 이상의 PC 간에 Cursor 채팅, VS Code 사용자 프로필, Cursor 사용자 구성을 암호화된 공유 폴더로 안전하게 동기화

## v2 구현 범위
- VS Code Settings Sync 범위: settings, keybindings, snippets, user tasks, prompts, MCP, extensions, UI state, profiles.
- Cursor 범위: User Rules, 사용자 `~/.cursor/mcp.json`, `cli-config.json`, commands, skills, rules, 채팅/Composer 이력.
- 전송: OneDrive/Syncthing 등 사용자가 선택한 공유 폴더의 장치별 append-only 이벤트 스트림.
- 보안: scrypt로 감싼 repository master key와 AES-256-GCM payload 암호화. SecretStorage/OAuth 토큰은 제외.
- 충돌: 리소스 parent DAG로 인과관계를 판단하고, 동시 변경 원본을 모두 보존한 뒤 사용자가 해결.
- DB 쓰기: 로컬 스키마 계약과 `node:sqlite` online backup 기능을 통과하고 Cursor가 완전히 종료된 경우에만 detached helper가 수행.
- 버전 호환: 파일 리소스는 양방향. 구버전에서 생성된 DB 리소스는 신버전이 수용하며, 신버전에서 생성된 DB 리소스는 구버전에서 업데이트 전까지 적용을 보류한다.
- 안전한 SQLite 런타임: Cursor 내장 `node:sqlite`. WAL 동시 읽기를 지원하지 않는 WASM SQLite는 사용하지 않음.

> 아래 기존 채팅 저장소 분석은 v2의 `state.vscdb` 채팅 어댑터 근거로 유지한다. 전체 프로토콜·보안·호환성·사용법은 `docs/` 문서를 구현 기준으로 삼는다.

---

## 1. 배경 및 문제 정의

### 1.1 출발점
- Cursor에는 VS Code의 Settings Sync 같은 **공식 동기화 기능이 없다.** 채팅 히스토리 내보내기·백업·기기 간 동기화 기능도 2026년 중반 현재 **미제공**이며, 커뮤니티 요청만 다수 열려 있는 상태다.
- 기존에 OneDrive + 심볼릭 링크로 폴더 전체를 동기화하다 **두 PC를 동시에 켜면 DB가 손상**되는 문제를 겪었다. 이는 도구 문제가 아니라 "실행 중인 SQLite DB를 파일 단위로 양방향 동기화"라는 조합 자체의 구조적 한계다.

### 1.2 근본 원인
- Cursor의 채팅 저장소는 SQLite(`state.vscdb`, WAL 모드)이고, **앱이 시작할 때 DB 내용을 메모리에 캐시한 뒤 외부 파일 변경을 감시하지 않는다.** 따라서 외부에서 파일을 덮어써도 반영되지 않거나, 실행 중 덮어쓰면 손상된다.
- 파일 단위 동기화(OneDrive/Drive/Syncthing 공통)는 "통째로 덮어쓰기"라서 양쪽 변경을 병합하지 못하고 한쪽이 소실된다.

### 1.3 해결 방향
"새로 추가된 대화 데이터만 추출 → 이동 → 상대 DB에 레코드 단위로 병합(logical merge)"한다. 동기화 채널로 오가는 것은 **append-only 파일**뿐이라 파일 충돌이 원천적으로 없다. 병합은 Cursor가 **완전히 종료된 상태**에서만 수행한다.

---

## 2. 목표 / 비목표

### 2.1 목표 (In Scope)
1. 두 PC 간 Cursor **채팅/컴포저 대화 히스토리** 동기화 (질문·답변·대화 목록).
2. 사용자는 **확장(VSIX) 하나만 설치**. 별도 프로그램 수동 설치·스케줄러 등록 불필요.
3. 병합 시 DB **손상 위험 최소화**(백업·무결성 검증·원자적 트랜잭션).
4. 동기화 채널은 사용자가 이미 쓰는 것(OneDrive / Syncthing / git 폴더) 중 아무거나 재사용.

### 2.2 비목표 (Out of Scope, v1)
- 실시간 동기화. (v1은 "종료 시 내보내기 / 다음 실행 때 반영" 모델)
- Cursor **설정·확장·키바인딩** 동기화. (별도 dotfiles로 처리 — 본 확장 범위 아님)
- 파일 스냅샷/체크포인트/undo 상태(`checkpointId`, `ofsContent`, `inlineDiff`) 동기화. (기기·워크트리 종속 + 대용량, 기본 제외)
- `agentKv` 프로비넌스 블롭(1.7GB) 동기화. (§4.4 참고, 기본 제외)
- 3대 이상 동시 다자 병합의 정교한 충돌 해소. (v1은 대화 단위 last-write-wins)

### 2.3 선택한 UX 모델 = "재시작 유도(Approach #1)"
검토한 세 방식 중 **재시작 유도**를 채택:
- **채택** — 재시작 유도: 확장이 미병합 데이터를 감지하면 "다른 PC 채팅 N건 있음, 적용하려면 재시작" 알림 → 클릭 시 자동 재시작하며 그 틈에 병합. **순수 VSIX 하나로 완결**, 상주 프로세스 없음.
- 대안(미채택) — 상주 헬퍼: 완전 자동(실행 즉시 반영)이나 백그라운드 상주 프로세스 필요. → v2 업그레이드 경로로 남김(§12).
- 대안(미채택) — 런처 래퍼: 바로가기 교체 필요, "확장 하나로 끝" 조건에서 벗어남.

> UX 요약: 미병합 데이터가 없으면 알림이 뜨지 않으므로 평소엔 존재감 없이 동작하고, 상대 PC 작업분이 도착했을 때만 한 번 클릭해 재시작한다.

---

## 3. 실측 기반 데이터 모델 (본 기기에서 직접 확인)

> 아래는 사용자 실제 설치본을 **읽기 전용(`mode=ro`)**으로 조사한 결과다. 커뮤니티 리서치와 교차 검증됨.

### 3.1 저장 위치
| 항목 | 경로 | 크기(실측) | 역할 |
|---|---|---|---|
| 전역 DB | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` | **2.8 GB**, WAL | **채팅 본문·인덱스 전부 여기** |
| 워크스페이스 DB | `%APPDATA%\Cursor\User\workspaceStorage\<hash>\state.vscdb` | 393개, 합 524MB | 사이드바 목록/레이아웃 등 워크스페이스 상태 |
| (신형) 대화 저장소 | `~/.cursor/chats/*/*/store.db` | **본 기기 없음** | 2026 신형 포맷(§11.2) — 아직 미사용 |
| (신형) 에이전트 트랜스크립트 | `~/.cursor/projects/*/agent-transcripts/` | 디렉터리 9개, **파일 0** | v3.11 검색용 — 아직 비어 있음 |

**중요:** 본 기기에서는 **전역 `state.vscdb` 하나가 채팅의 단일 소스**다. 워크스페이스 DB의 `cursorDiskKV`·`composerHeaders`는 비어 있었다.

### 3.2 전역 DB 스키마 (3개 핵심 테이블)
```
ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)      -- 앱 전역 설정/UI, 1,126행
cursorDiskKV(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)   -- 대화 콘텐츠 본체
composerHeaders(composerId PK, workspaceId, createdAt,
    lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value)  -- 대화 인덱스(권위), 368행
lost_and_found(...)   -- ★ 과거 .recover(손상 복구) 흔적. 방어적 설계 필수 근거.
```
- `cursorDiskKV`/`ItemTable`은 스키마에 `ON CONFLICT REPLACE`가 이미 걸려 있어 **동일 key INSERT = 자동 교체**. 병합에 유리.

### 3.3 cursorDiskKV key prefix 분포 (실측)
| prefix | 행 수 | 용량 | 동기화 대상? |
|---|---:|---:|---|
| `agentKv:blob:<sha256>` | 121,616 | **1.73 GB** | ✗ 기본 제외 (프로비넌스/재구성 아카이브) |
| `bubbleId:<cid>:<bubbleId>` | 61,649 | 503 MB | ✔ **대화 본문(메시지)** |
| `checkpointId:<cid>:<id>` | 1,753 | 61 MB | ✗ 파일상태 스냅샷(undo용) |
| `composerData:<cid>` | 1,760 | 59 MB | ✔ **대화 메타(_v=14)** |
| `ofsContent:<cid>:file://…` | 1,417 | 22 MB | ✗ 파일 콘텐츠 스냅샷(바이너리) |

### 3.4 대화 → 메시지 연결
- `composerData:<cid>` (JSON): `fullConversationHeadersOnly`가 **순서 있는 bubble 헤더 목록**(예: 28개)을 보유. `conversationMap`은 신 포맷에서 비어 있음.
- 실제 메시지 본문 = `bubbleId:<cid>:<bubbleId>` 행들(대화당 수십~수백 행).
- 즉 **한 대화 = `composerData:<cid>` 1행 + `bubbleId:<cid>:*` N행 + `composerHeaders` 1행**. 이 세 묶음이 동기화의 원자 단위.

### 3.5 사이드바 노출 연결 (★ "동기화했는데 안 보임" 방지의 핵심)
- 전역 `composerHeaders.workspaceId` = **워크스페이스 폴더 해시**와 일치(실측: 해시 `bb936c48…` 워크스페이스에 59개 대화 매핑).
- 워크스페이스 DB `ItemTable['composer.composerData']`(작음, ~470B)이 해당 워크스페이스 사이드바의 대화 목록/포인터로 보임.
- **함의:** 대화가 상대 PC 사이드바에 뜨려면 (a) 전역 3묶음 병합 + (b) `composerHeaders` 행의 `workspaceId`가 상대 PC의 워크스페이스 해시와 일치해야 함. 워크스페이스 해시는 **프로젝트 절대경로에서 파생**되므로, 두 PC에서 같은 경로(예: `C:\Users\ckdgh\Desktop\claude`)로 열면 자동 일치. 경로가 다르면 워크스페이스 매칭/재작성 로직 필요(§10.3, 리스크 R4).

### 3.6 암호화 = 이식 가능 (핵심 발견)
- `composerData`에 `blobEncryptionKey`, `speculativeSummarizationEncryptionKey`가 **대화별로 인라인 저장**됨.
- 로컬 `bubbleId` 본문은 평문 JSON으로 읽힘(커뮤니티 도구들이 타 기기에서 그대로 렌더 성공 → **기기 종속·머신 바인딩 아님**).
- 결론: **복호화 키가 데이터와 함께 이동**하므로 대화 데이터는 PC 간 이식 가능. (단 `serverBubbleId`로만 참조되는 클라우드 백업 블롭은 오프라인에서 복구 불가할 수 있음 — 리스크 R5.)

### 3.7 변경 감지 워터마크
- `composerHeaders.lastUpdatedAt`(epoch millis)가 **대화별 최종수정 시각**을 제공 → 동기화 워터마크로 직접 사용.
- 이는 일반적 KV 테이블(타임스탬프 없음)보다 유리한 조건. **대화 단위로 "마지막 동기화 이후 바뀐 composerId"를 헤더 테이블에서 뽑고, 그 cid에 속한 `bubbleId:<cid>:*`를 전량 재추출**하면 됨(행별 해시 비교 불필요).
- 실측: 최근 7일 = 28개 대화 변경.

---

## 4. 시스템 아키텍처

### 4.1 구성요소
```
┌─────────────────────────── PC A ───────────────────────────┐
│  Cursor (실행 중)                                            │
│   └─ [확장] Sync Extension                                    │
│        ├─ Exporter: 주기적으로 전역 DB를 mode=ro로 읽어       │
│        │            변경분(대화 묶음)을 outbox에 export       │
│        ├─ Watcher:  inbox(상대가 보낸 파일) 감시 → 미병합 감지 │
│        └─ Notifier: 미병합 있으면 "재시작" 알림               │
│                                                              │
│   outbox/ inbox/  ──(append-only 파일)──┐                    │
└─────────────────────────────────────────┼───────────────────┘
                                           │  Syncthing / OneDrive / git
┌─────────────────────────────────────────┼───────────────────┐
│  PC B                                    ▼                    │
│   공유폴더 <-> 동기화                                         │
│   [확장]이 감지 → 사용자 클릭 → workbench.action.quit         │
│        └─ 종료 직전 Detached Helper(별도 Node 프로세스) 실행  │
│              ├─ Cursor 완전 종료 대기(락 프로브)              │
│              ├─ 백업 → 무결성검사 → INSERT OR REPLACE 병합    │
│              ├─ wal_checkpoint → 재검사                       │
│              └─ process.execPath로 Cursor 재실행              │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 왜 병합만 "외부 헬퍼"인가 (플랫폼 제약, 리서치 확증)
- 전역 `state.vscdb`는 Cursor **메인 프로세스**가 열고 메모리 캐시를 소유한다. `workbench.action.reloadWindow`는 렌더러만 리로드하고 메인 프로세스는 살아 있어, 이때 외부에서 DB를 써도 메인 프로세스가 다음 flush/종료 시 덮어쓴다. → **창 리로드로는 병합 불가.**
- 확장은 `workbench.action.quit`로 **앱 전체를 종료**시킬 수 있으나(모든 창+메인 프로세스 종료), **재실행 API는 존재하지 않는다**(관련 요청 "not planned"). → 앱이 죽은 뒤 다시 켜는 주체가 필요 → **detached 헬퍼**가 담당.
- Windows에서 `spawn(cmd, {detached:true, stdio:'ignore', windowsHide:true}) + unref()`한 자식은 부모(확장 호스트) 종료 후에도 생존. 확증됨.
- 헬퍼 재실행 대상 = 확장 호스트의 `process.execPath`(= `Cursor.exe`).

### 4.3 왜 "export"는 확장 내부에서 가능한가
- 읽기는 `mode=ro`로 실행 중에도 일관된 스냅샷 확보 가능(WAL: 리더는 트랜잭션 시작 시점의 일관 뷰를 봄). 짧은 읽기 트랜잭션만 지키면 안전.
- 따라서 **export/감시/알림/오케스트레이션은 확장이, 실제 DB 쓰기(병합)만 헬퍼가** 담당.

### 4.4 agentKv를 기본 제외하는 근거
- content-addressed(`agentKv:blob:<sha256>`)라 병합은 충돌 없음(`INSERT OR IGNORE`)이나, **bubble JSON이 이 해시들을 참조하지 않음**(실측: 한 bubble에서 64-hex 해시 0개). 즉 대화 렌더에 필수 아님(프롬프트 재구성/프로비넌스 아카이브로 추정).
- 1.73GB로 전송·병합 비용이 압도적. → **기본 제외**, 필요 시 옵션으로 "전량 신규 블롭 동기화"만 추가(§12).

---

## 5. 상세 동작 흐름

### 5.1 Export (송신, 확장 내부 — Cursor 실행 중)
1. 트리거: `onStartupFinished` + 주기 타이머(예: 5~10분) + `deactivate` 훅(가능한 만큼).
2. 싱글턴 확보: globalStorage/temp에 락파일(atomic `wx` + PID + stale 검출). **창=확장호스트가 여러 개**이므로 한 창만 export 수행.
3. 전역 DB를 `mode=ro`, `PRAGMA query_only=ON`으로 open.
4. **짧은** 읽기 트랜잭션: `SELECT composerId, lastUpdatedAt, workspaceId, value FROM composerHeaders WHERE lastUpdatedAt > :watermark AND isSubagent = 0`.
5. 각 변경 cid에 대해 `composerData:<cid>` + `bubbleId:<cid>:*` 조회(각 조회는 밀리초 단위로 짧게, 커서를 오래 열지 않음).
6. cid별로 **하나의 스냅샷 파일**로 직렬화(gzip JSON): `{ schemaVersion, cid, header, composerData, bubbles[], sourceDeviceId, exportedAt, contentHash }`.
7. `outbox/<cid>/<contentHash>.json.gz`로 원자적 write(temp→rename). **append-only**(같은 내용 재전송 안 함). 워터마크 갱신.

> 체크포인트 스타베이션 방지: export 전체를 하나의 긴 `BEGIN`으로 감싸지 않는다. 리더를 오래 붙들면 실행 중 Cursor의 WAL이 무한 증식할 수 있음(문서화된 위험). 몇 행만 뽑으므로 정상 구현 시 수 ms.

### 5.2 Transport (동기화 채널)
- outbox/inbox를 공유폴더에 매핑. Syncthing/OneDrive/git 무엇이든 가능.
- 파일은 **한 번 쓰면 불변**(내용 해시가 파일명) → 두 PC가 동시에 켜져도 파일 충돌 없음. 지우기 전엔 서로 덮어쓸 일이 없음.
- 권장: Syncthing(용량 제한 없음, `.stignore`로 잡파일 제외, 충돌 시 `.sync-conflict` 사본). OneDrive도 append-only엔 안전.

### 5.3 감지 & 재시작 유도 (수신, 확장 내부)
1. Watcher가 inbox 신규 파일 감지 + 로컬 DB의 해당 cid `lastUpdatedAt`와 비교 → **미병합 목록** 산출.
2. 미병합 있으면 상태바 배지 + 알림: "다른 PC의 대화 N건이 도착했습니다. 적용하려면 Cursor를 재시작하세요. [지금 재시작]".
3. 사용자가 클릭 → (a) 병합 요청 파일을 헬퍼 인자로 준비, (b) detached 헬퍼 spawn(락파일 경로·DB경로·`process.execPath`·워크스페이스 매핑 전달), (c) `workbench.action.files.saveAll` 후 `workbench.action.quit`.
4. 미병합이 없으면 **알림 없음**(평소 무존재감).

### 5.4 Merge (헬퍼, Cursor 완전 종료 후)
1. **완전 종료 확인 = 락 프로브**(프로세스명 체크만으로 부족): 전역 DB를 read-write로 열고 `PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;` 시도. `SQLITE_BUSY`면 아직 실행 중 → 백오프 재시도. (Windows/Electron은 종료 후에도 잠깐 파일 락 유지 가능.)
2. `PRAGMA quick_check`(또는 `integrity_check`) → `ok` 아니면 **중단**(병합 안 함).
3. **타임스탬프 백업** 생성(clean checkpoint 후 파일 복사 또는 `VACUUM INTO`). 롤백 지점 확보.
4. **스키마 검증**: 기대 테이블/컬럼(`composerHeaders`, `cursorDiskKV`, `ItemTable`) 존재 + `schemaVersion`/`_v` 호환 확인. 드리프트면 중단(리스크 R1 방어).
5. **단일 트랜잭션**으로:
   - inbox 스냅샷들에 대해 `INSERT OR REPLACE INTO cursorDiskKV(key,value)` (`composerData:<cid>`, `bubbleId:<cid>:*`).
   - `INSERT OR REPLACE INTO composerHeaders(...)` (워크스페이스 매핑 §10.3 적용).
   - 필요 시 워크스페이스 DB `ItemTable['composer.composerData']` 목록에 cid 추가(사이드바 노출용, §3.5).
   - 충돌 정책(§10) 적용.
6. `PRAGMA wal_checkpoint(TRUNCATE)`로 WAL 접고 축소. `journal_mode=WAL`·`synchronous=NORMAL` 유지(변경 금지). **`-wal`/`-shm` 절대 수동 삭제 금지**(분리 시 커밋 손실/손상).
7. `PRAGMA integrity_check` 재실행 → 실패 시 백업 복원.
8. 처리한 inbox 파일을 `applied/`로 이동(재적용 방지). 워터마크/상태 기록.
9. `spawn(process.execPath, [워크스페이스 경로들], {detached:true})`로 **Cursor 재실행** 후 헬퍼 종료.

### 5.5 "꺼져 있는 동안 도착" 빈틈 처리 (Approach #1 특성)
- B가 꺼진 사이 도착한 데이터는 병합해줄 프로세스가 없음 → **다음 실행 시 확장이 감지 → 재시작 유도**로 해소(즉시 반영은 아니고 1회 재시작 필요). 이는 채택한 #1의 알려진 트레이드오프이며, 즉시성 필요 시 v2 상주 헬퍼로 승급(§12).

---

## 6. 기술 스택 / 구현 결정

| 영역 | 결정 | 근거 |
|---|---|---|
| 확장 런타임 | VS Code Extension API (Cursor는 포크, 호환) | `onStartupFinished`, 상태바, 명령, `workbench.action.quit` 사용 |
| 병합 실행 위치 | **독립 detached 헬퍼(순수 Node)** | 앱 종료 후 DB 써야 함 / Electron ABI 회피 |
| SQLite 접근 | 기능 감지된 Cursor 내장 `node:sqlite` + online backup API | 정확한 Node 버전에 결합하지 않고 동일한 SQLite locking/WAL 동작을 사용 |
| 읽기(확장) | `mode=ro` + `query_only=ON`, 짧은 트랜잭션 | 실행 중 일관 스냅샷, 체크포인트 스타베이션 회피 |
| 변경 감지 | `composerHeaders.lastUpdatedAt` 워터마크(+ 보조로 contentHash) | 대화 단위 델타 추출, 행별 해시 불필요 |
| 전송 포맷 | cid별 gzip JSON 스냅샷, append-only | 파일 충돌 제거 |
| 싱글턴 | 락파일(atomic create + PID + stale 검출) | 창마다 확장호스트 존재 |
| 배포 | Open VSX(Cursor) 및 GitHub Release VSIX | Cursor 사용자가 설치 가능한 공개 배포 |
| 확장 ID | `lch.cursor-setting-sync` | 기존 `cursor-notepads`와 동일한 게시자 프로필 사용 |

---

## 7. 안전성 설계 요약 (손상 방지 체크리스트)
- [x] 읽기는 항상 `mode=ro`, 쓰기는 앱 완전 종료 후에만.
- [x] 병합 전 `BEGIN IMMEDIATE` 락 프로브로 실행 여부 확정(프로세스명 신뢰 금지).
- [x] 병합 전/후 `integrity_check`(또는 quick_check). 실패 시 중단/복원.
- [x] 병합 직전 타임스탬프 백업. 실패 시 자동 복원.
- [x] 전체 병합을 **단일 트랜잭션**(원자성).
- [x] 스키마/버전 검증 후에만 쓰기(드리프트 시 중단).
- [x] `-wal`/`-shm` 수동 삭제 금지, `journal_mode`/`synchronous` 변경 금지.
- [x] 병합 후 `wal_checkpoint(TRUNCATE)`.
- [x] 병합량 상한(대화 수/용량) 초과 시 경고·분할.
- [x] `lost_and_found` 존재 여부와 무관하게 위 검증을 항상 수행.

---

## 8. 데이터 스코프 옵션 (사용자 설정)
| 프로파일 | 포함 | 용량 특성 | 용도 |
|---|---|---|---|
| **Lite(기본)** | `composerData` + `bubbleId` + `composerHeaders` | 대화당 소~중 | 순수 대화 히스토리만 |
| Standard | Lite + `checkpointId`/`ofsContent`(같은 경로일 때만) | +파일 스냅샷 | undo/restore까지 이관 |
| Full | Standard + 신규 `agentKv` 블롭 | +대용량 | 완전 재현(프로비넌스 포함) |

> v1은 **Lite만** 구현, Standard/Full은 후속.

---

## 9. 개발 로드맵 (마일스톤)

**M0 — 스키마 고정 & 리드온리 PoC**
- 실측 스키마를 코드에 상수화, 버전 감지기 작성.
- `mode=ro`로 변경 대화 추출 → gzip 스냅샷 생성까지(쓰기 없음). 안전.

**M1 — 병합 헬퍼(오프라인)**
- 별도 Node 헬퍼: 락 프로브 → 백업 → 무결성 → 단일 트랜잭션 병합 → 체크포인트 → 재검사.
- **수동 실행**으로 검증(테스트 DB 사본에 먼저). Cursor 재실행 로직.

**M2 — 확장 골격**
- `onStartupFinished`, 상태바, 락파일 싱글턴, outbox export 주기화.
- inbox watcher + 미병합 감지 + 재시작 알림 + `quit`/헬퍼 spawn 연동.

**M3 — 사이드바 노출 보정**
- `composerHeaders.workspaceId` ↔ 워크스페이스 해시 매핑, 워크스페이스 DB 목록 갱신 검증(§3.5). "동기화했는데 안 보임" 제거.

**M4 — 견고화**
- 충돌 정책, 스키마 드리프트 가드, 병합량 상한, 로깅/진단, 실패 복원 자동화.

**M5 — 배포 패키징**
- `lch` publisher의 Open VSX(Cursor) 패키지와 GitHub Release VSIX, 다중 PC 실사용 검증.

각 마일스톤은 **테스트 DB 사본**에서 먼저 검증 후 실 DB 적용.

---

## 10. 충돌 처리 정책 (v1)
1. **기본 단위 = 대화(composerId).** 병합은 대화 통째 교체(`INSERT OR REPLACE`).
2. **서로 다른 대화**는 cid가 UUID로 달라 자연히 무충돌(양쪽 신규 대화는 그냥 합쳐짐).
3. **같은 대화를 양쪽에서 이어간 경우** = `lastUpdatedAt`가 더 최신인 쪽이 승리(대화 단위 last-write-wins). 진 쪽 버전은 백업에 남음.
4. 운영 습관 권고: "한 대화는 한 PC에서만 이어간다" — 이 습관만으로 3번 상황 거의 소멸.
5. (미해결) 워크스페이스 경로 상이 시 매핑 규칙 — §10.3.

### 10.3 워크스페이스 매칭
- 같은 경로로 열면 워크스페이스 해시 자동 일치 → 별도 처리 불필요(사용자 두 PC 모두 `ckdgh` 계정, 같은 경로 사용 가능성 높음).
- 경로 상이 시: (a) `composerHeaders.workspaceId`를 타깃 워크스페이스 해시로 재작성, 또는 (b) "미분류/글로벌" 워크스페이스로 귀속. v1은 (a) 옵트인.

---

## 11. 리스크 및 완화

| ID | 리스크 | 영향 | 완화 |
|---|---|---|---|
| **R1** | **Cursor 스키마 잦은 변경**(2024 chat tabs→2025 composer→2.0 agent→store.db). 커뮤니티 도구들이 반복적으로 깨짐 | 병합 실패/손상 | 스키마 버전 감지·검증, 드리프트 시 **쓰기 중단**, 상수화된 스키마 계약, 업데이트 후 재검증 |
| **R2** | 병합 중 앱 실행/락 잔존 | DB 손상 | 락 프로브(`BEGIN IMMEDIATE`)+백오프, 프로세스명만 신뢰 금지 |
| **R3** | 배포 채널별 버전 불일치 | 구버전 클라이언트가 신형 DB payload 적용 | 동일 `lch.cursor-setting-sync` ID 유지, producer 버전 기록, 신버전→구버전 DB 적용 보류 |
| **R4** | 워크스페이스 해시 불일치(경로 상이) | 동기화됐으나 사이드바 미노출 | 경로 일치 유도 or workspaceId 재작성(§10.3) |
| **R5** | `serverBubbleId` 클라우드 백업 블롭 | 오프라인 병합 시 일부 콘텐츠 누락 가능 | 로컬 평문 우선, 누락분은 "클라우드 재동기화 필요"로 표시(추정, 확인 필요) |
| **R6** | 신형 `store.db`/agent-transcripts로 이행 | state.vscdb-only 동기화가 신규 대화 누락 | 현재 본 기기 미사용. 존재 감지기 넣고, 채택 시 커버리지 확장(§11.2) |
| **R7** | `lost_and_found` = 과거 손상 이력 | 잔존 불일치 | §7 무결성 검증 필수화 |
| **R8** | 대용량 WAL 증식(리더 오래 점유) | 실행 중 Cursor 성능 저하 | 짧은 읽기 트랜잭션, `query_only` |

### 11.2 신형 저장소(store.db) 대비
- 리서치상 `~/.cursor/chats/*/store.db`(meta+blobs) + `~/.cursor/projects/*/agent-transcripts/`가 state.vscdb와 **병존**(세션ID 서로소). **본 기기엔 아직 없음/비어 있음.**
- 대비: 확장 시작 시 이들 경로 존재/증가를 감지. 실제로 채워지기 시작하면 동기화 범위를 이 계층까지 확장(store.db는 별도 SQLite라 유사 병합 로직 재사용 가능).

---

## 12. 향후 확장 (Post-v1)
- **v2 상주 헬퍼**: 병합 후 종료하지 않고 inbox를 감시, "꺼져 있을 때 도착 → 즉시 병합" → **다음 실행 시 바로 반영**(사용자가 원한 완전 자동). 시작 프로그램 등록 필요.
- Standard/Full 스코프(파일 스냅샷·agentKv).
- store.db/agent-transcripts 계층 커버(R6).
- 3대 이상 다기기, 대화 단위보다 세밀한 병합(메시지 단위 merge).
- 크로스 플랫폼(macOS/Linux) 경로·실행파일 처리.

---

## 13. 미해결 질문 (개발 착수 전 실검증 항목)
1. **사이드바 노출 정확 조건**: 전역 3묶음만 병합해도 사이드바에 뜨는가, 아니면 워크스페이스 DB `composer.composerData` 목록 갱신이 필수인가? → 테스트 DB 사본에 대화 1건 주입 후 확인.
2. `blobEncryptionKey`가 로컬 블롭 복호화에 실제 쓰이는지 vs 순수 서버 참조인지 → 로컬 bubble 중 비평문 존재 여부 정밀 스캔.
3. `workbench.action.quit`가 dirty 에디터/실행 중 에이전트 있을 때 모달 없이 종료되는지(hot exit) → 실앱 테스트.
4. 헬퍼가 재실행할 `process.execPath`가 사용자의 정상 실행 경로(바로가기/Squirrel 업데이터 경유)를 재현하는지.
5. `node-sqlite3-wasm`의 2.8GB WAL 병합 쓰기 성능/정확성 벤치 → 부족 시 프리빌드 `better-sqlite3`로.
6. Cursor 완전 종료 후 트레이/백그라운드 프로세스가 DB 락을 잡는지(락 재시도 강도 결정).

---

## 부록 A. 조사 방법 및 재현
- 조사 스크립트(읽기 전용): `scratchpad/inspect_db.py`, `inspect_deep.py`, `inspect_merge.py`, `inspect_wsindex.py`.
- 원칙: 모든 로컬 접근은 `file:...?mode=ro`. 실행 중 DB에 쓰기·`immutable=1` 사용 금지.
- 근거자료: `scratchpad/findings_local.md`(실측) + 웹 리서치(커뮤니티 도구 cursaves/cursor-history/cursor-view, SQLite 공식 WAL/recovery 문서, VS Code 확장 API 이슈).

## 부록 B. 참고 (외부)
- SQLite WAL / recovery: sqlite.org/wal.html, sqlite.org/recovery.html
- 커뮤니티 동기화 선행사례: cursaves(dev.to), S2thend/cursor-history, saharmor/cursor-view
- 확장 API: microsoft/vscode #115820(quit), #253867(restart not planned), node child_process(detached)
- 신형 저장소 분석: vibe-replay.com/blog/cursor-local-storage
