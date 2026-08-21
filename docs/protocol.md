# Synchronization protocol

## Repository layout

```text
<shared-root>/
├─ repo.json
├─ checkpoints/
│  └─ 0000000000000042-<checkpointHash>.csc
└─ devices/
   └─ <deviceId>/
      ├─ device.json
      ├─ head.json
      ├─ acks.json
      ├─ events/
      │  └─ 0000000000000001-<eventHash>.cse
      └─ blobs/sha256/<prefix>/<objectId>.cso
```

`repo.json` is created once. Every device writes only inside its own device directory. Final event and object names are immutable. `head.json` and `acks.json` are diagnostic hints and are not synchronization authority.

## Automatic execution and manual control

An elected extension host watches the repository and runs bounded reconciliation cycles automatically, with polling as a fallback. Eligible file resources are validated and applied while Cursor is running. Database-backed resources remain queued until every Cursor process exits normally; the shutdown helper then exports the stopped local state, reconciles, backs up each target database, and applies the queued SQL changes offline. Checkpointing, pruning, git-history compaction, and safe-orphan cleanup are automatic maintenance.

The only public command is `Cursor Setting Sync: Manage`. Its menu contains all on-demand setup and reconfiguration, diagnostics, forced synchronization and queued application, conflict resolution, unavailable-chat repair and recovered-chat opening, synchronized-version and database-backup restore, repository archive, device retirement or restoration, and local disconnect actions. These actions enter the same bounded protocol paths; they do not create alternate synchronization formats.

## Event streams and resource DAGs

Each device has an increasing sequence whose event header includes the previous event hash. Receivers wait for missing sequence numbers and reject stream forks.

Every resource change lists its parent version IDs. Unrelated resources merge independently. Multiple non-ancestor tips with different semantic content become a conflict. Equivalent tips are coalesced, and the next edit references all equivalent tips so the DAG converges.

Lamport values provide deterministic ordering but never replace ancestry for conflict detection. Wall-clock timestamps and file modification times are not used to select a winner.

Automatic conflict resolution relies on that convergence rule rather than on coordination: both devices resolve the same fork locally and publish a merge whose parents are both tips, so identical results coalesce into one version with no extra round trip. This only works when the two devices emit byte-identical payloads, because a resource that hashes its raw content — UI state among them — compares those bytes. Every automatic merge is therefore symmetric in the two sides: UI state serializes its result canonically, and a JSONC merge writes its result into the common ancestor's text rather than the local device's, so the two sides produce the same bytes and publish the same hash of those bytes. The tie-break for a UI state value with no structural merge is the tip ordering above (Lamport, then device ID, then event hash), which is derived from replicated data alone and so is the same on both devices.

A three-way merge needs a common ancestor, but a tie-break does not. A fork with **no** common ancestor — two devices that each minted the same resource locally, or a base folded away by a checkpoint — is therefore still resolved automatically for UI state: the winning tip is elected with the same tip ordering and republished verbatim, carrying its own semantic hash and its own metadata, so both devices emit identical content and identical metadata. Metadata equality is load-bearing rather than cosmetic, because the reconciler coalesces two tips on operation and semantic hash alone and UI state's `valueType` decides whether the value is bound as `TEXT` or `BLOB`. A put always outranks a delete in this election, whatever the ordering says, and the ordering only breaks ties within the surviving operation: a losing delete can simply be repeated, while a losing put discards the only copy of the value. Kinds that carry authored content are excluded from the base-free *election* entirely and stay with manual resolution.

Workspace storage combines instead of electing, in two shapes. A `state.vscdb` payload is a set of keyed rows, so a base-free fork keeps every row either device has and settles a key both hold with the tip ordering; without this, two computers meeting for the first time raised one manual conflict for **every** workspace they both had open — 198 of them on the pair this was built against — and the only answer the manual resolver could offer, one whole snapshot or the other, discarded the losing machine's notepads and sessions wholesale. A `notepads.json` payload is a JSON array keyed by the `id` Cursor mints per notepad, so it merges the same way: an id one side never touched takes the other side's version, an edit outranks a concurrent delete, and an id only one side holds is kept. Where both sides hold one id with two different texts, a winner is claimed only when one text strictly contains the other — the same note with material added. Anything else is left as a conflict: a notepad carries no modification time (its `id` encodes creation, not last write), and the tip Lamport clock is not a substitute, because a device joining an existing repository publishes at the highest Lamport in it and would outrank every note it is meeting.

Chat is the exception, because it does not need an election. A v2 chat payload is a header, a `composerData` row, message rows keyed by `bubbleId:<composerId>:<id>`, and the hash-verified content-addressed blobs reachable from its conversation state. Two forks combine: messages and continuation blobs are unioned by stable key, while the header and `composerData` are adopted whole from the side with the greater `header.lastUpdatedAt`. References not yet materialized remain explicit missing IDs rather than being mistaken for a complete graph. That election is replicated without being an ordering heuristic — both devices read the same payloads and agree — and tip ordering breaks a tie. A `null` timestamp never outranks a real one. The result is serialized with the same canonicalization the chat adapter uses, and schema/count/core metadata is recomputed from the exact result. Bubble rows are additive even with a common base: Cursor has no per-message delete, a missing row is device-local pruning, and the winning `composerData` controls whether the retained row is visible. An older v1 chat can be enriched with blobs from a healthy source without replacing its exact repository core. A payload that fails `parsePortableChatSnapshot` — the same gate the apply side uses — is left as a conflict rather than resolved by discarding a side.

Each event also contains producer metadata:

```json
{
  "extensionVersion": "0.0.1",
  "cursorVersion": "3.11.19",
  "vscodeVersion": "1.125.0"
}
```

Consumers use this metadata only for safe database application. It does not prevent portable file resources from synchronizing.

## Workspace-storage resources

Each allowlisted workspace payload is represented independently as a `workspace-storage` resource. Its encrypted metadata binds the resource ID to a validated workspace identity and portable relative path. The payload allowlist contains a portable logical representation of `state.vscdb`, plus `notepads.json` and `images/**`.

`workspace.json` is read only to discover the workspace ID and URI; it is never stored as an object or restored. Explicit and URI-resolved mappings canonicalize related local workspace IDs to one resource identity, preventing mapped PCs from publishing duplicate histories.

Workspace resources are scanned only by the shutdown helper after every Cursor process exits. SQLite reads committed WAL content directly, then canonicalizes supported rows and storage classes (`NULL`, `TEXT`, `BLOB`, `INTEGER`, and `REAL`) into JSON. The original database and `*-wal`, `*-shm`, or `*-journal` files are never transported. Incoming versions are queued for offline SQL merge and use the same producer-version gate as other database-backed resources.

Resource-kind names use a bounded wire grammar. A client accepts well-formed future kinds into the authenticated immutable event stream but excludes kinds it does not yet implement from its local projection graph. Original change indexes are preserved, so known changes in the same event continue to synchronize and the deferred kind becomes available after the client is updated.

Previous or renamed database backups, corrupt database copies, browser sessions, retrieval indexes, debugger data, caches, and unknown extension directories are outside the allowlist. Workspace-storage scans do not publish file deletions, and incoming tombstones do not delete local files, because workspace sets may differ across PCs. Database imports are upsert-only without an explicit common base, so absence from a snapshot never deletes a target row.

## Encryption

`repo.json` contains scrypt parameters and a random master key wrapped by the passphrase-derived key. Each PC stores the unlocked master key in Cursor `SecretStorage`.

HKDF derives separate keys for event encryption, object encryption, and keyed object IDs. Payload processing is:

1. Check the plaintext size limit.
2. Compress with gzip.
3. Calculate an HMAC-SHA-256 object ID.
4. Encrypt with AES-256-GCM and a random 96-bit nonce.
5. Authenticate the object header as additional data.
6. Write a partial file and atomically publish the final immutable name.

Event manifests use a separate AES-256-GCM subkey. Repository ID, device ID, sequence, and stream hashes remain visible so clients can discover streams without decrypting every header.

## Limits and partial synchronization

- Event envelope: 8 MiB
- Changes per event: 10,000
- Default plaintext payload: 128 MiB
- Configurable plaintext payload maximum: 512 MiB
- Offline apply batch: 512 MiB
- Parents per change: 256

Readers validate file size, canonical base64, hashes, GCM tags, compressed size, decompressed size, resource identifiers, metadata paths, and payload paths. Workspace-storage paths must also match their metadata, workspace ID, and strict file allowlist. Partial files, conflict copies, malformed envelopes, and unsupported protocol versions are not applied.

The repository watcher reacts only to final `.cse` and `.cso` payload files. Polling is retained because shared-folder providers may coalesce or omit filesystem events, and because a git remote emits no filesystem events at all.

## Git transport

A git repository is a transport under the same append-only model, not a different protocol: every device still writes only inside its own device directory, and final event and object names stay immutable, so concurrent commits never touch the same paths and merges are trivial. Under the machine-local sync lock, a cycle runs pull-before-read and commit-and-push-after-write; a rejected push is recovered by pulling and retrying. After a checkpoint prune, the git history is squashed into one orphan commit and force-pushed, because pre-prune history would otherwise retain every deleted event file forever. A device that pulls a force-pushed rewrite recovers with `git reset --mixed`, which adopts the remote history while keeping the working tree — its own unpushed event and object files stay on disk and are re-committed by its next write.

## Deletion and retention

Deletion is a payload-free tombstone event. Chat, transcript, store, and workspace-storage tombstones prevent resurrection but do not automatically delete local Cursor records or files in protocol v1. Workspace-storage adapters do not originate deletion events. Bounded Cursor user-file, profile-file, settings, extension, and UI-state scanners are also additive-only: their fixed-memory pages do not claim that an unvisited or concurrently changing path/key was deleted. They still understand authenticated historical tombstones on apply; they simply do not originate new ones without a stable whole-generation proof.

Finalized events and tombstones are retained until they are folded into a checkpoint and pruned (see below). Automatic safe-orphan compaction requires a warning-free reconcile and removes only old partial files owned by the current device and objects that neither an event nor the absorbed checkpoint references.

## Checkpoints

Automatic checkpoint maintenance folds the entire reconciled state into one encrypted checkpoint file so that the event files it covers can later be deleted. It becomes eligible once the event log passes 500 files. A running extension host waits at least six hours between attempts; restarting Cursor may re-evaluate sooner, but reconciliation, actionable-pending-database, conflict, acknowledgement, and age gates still apply.

### Format

Checkpoints live in `<shared-root>/checkpoints/<lamport16>-<checkpointHash>.csc` and are AES-256-GCM encrypted with a dedicated subkey (`checkpoint-encryption`). The visible header (`protocolVersion`, `envelopeVersion`, `repositoryId`, `deviceId`, `lamport`) is authenticated as additional data, and the file name embeds the SHA-256 of the stored envelope. A checkpoint file is limited to 64 MiB; creation fails with a distinct error instead of writing a truncated checkpoint.

The encrypted manifest records:

- `lamport` — creating a checkpoint consumes one Lamport tick (`state.lamport + 1`), so the checkpoint orders after every event it folds.
- `predecessorHash` — the hash of the newest checkpoint the creator had absorbed (`null` for the first), forming the ancestry chain the prune gates walk.
- `streams` — the creator's accepted stream cursors at creation, including its own head.
- `resources` — exactly one folded entry per resource, including delete tombstones, each preserving the original folded-tip version ID so parent links and pending references stay valid.

Checkpoints never carry device retirement; retirement stays strictly local to each device.

### Absorption

Every repository open and every state refresh runs load-state → discover/absorb the newest checkpoint → recover the own stream, in that order. Absorption persists a verbatim local copy of the winning `.csc` before mutating state, adopts only other devices' cursors (the own cursor is owned exclusively by own-stream recovery), and fail-stops when a previously absorbed checkpoint disappears (checkpoint rollback). Newest-winner selection uses the decrypted Lamport value, never the filename alone, and a well-named shared checkpoint that fails its hash or decryption check is a hard error.

### Version-2 event headers

Once a device has absorbed a checkpoint, it writes event headers with `protocolVersion: 2`. Builds that predate checkpoints accept only version 1 and fail loudly on the first v2 event instead of silently reconstructing a partial history, and after a prune a marker event guarantees that at least one v2 event exists even for fresh installs. `repo.json` is never rewritten because its authenticated header binds the protocol version to the key unwrap. **Upgrade every device to a checkpoint-aware build before automatic checkpoint maintenance first absorbs a checkpoint.**

### Prune gates

Event files are deleted only under the machine-local sync lock — which does not serialize devices, so all cross-device safety comes from these gates — and only after:

1. **G1 — absorption identity.** Every visible non-retired device's `acks.json` must acknowledge the target checkpoint itself or a checkpoint whose `predecessorHash` ancestry contains it. A plain newer-than comparison is insufficient because a concurrent same-generation checkpoint can compare newer without covering the target's cursors. Missing acks, old acks, or an acknowledged hash the pruner cannot load abort the prune and report which device lags.
2. **G2 — age.** The checkpoint must be older than 24 hours. This protects devices that have not yet appeared in the shared folder.

Only events at or below the checkpoint's per-device cursors are deleted, then superseded checkpoint files are removed. Object compaction runs only when a subsequent reconcile reports zero warnings and never deletes another device's blobs.

### Trust and failure model

- Checkpoints are AEAD-authenticated; only master-key holders can create them.
- `acks.json` is unauthenticated and gates only when pruning happens, never correctness: a forged ack can at worst prune early, degrading a lagging device to checkpoint absorption. State still converges; only granular history is lost.
- Conflicts whose merge base predates the checkpoint degrade from three-way merge to the base-free rules above, and the conflict preview degrades to a two-way diff. For UI state, chat and workspace storage that is still automatic — chat and workspace databases lose only the ability to honour a deletion, degrading to a union. For every other content-bearing kind it means manual resolution.
- Granular history before a checkpoint is unrecoverable by design, and folded delete tombstones are retained forever (a documented growth trade-off).
