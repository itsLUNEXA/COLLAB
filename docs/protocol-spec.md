# Collaborative AI Coding Platform — Wire Protocol & Architectural Safeguards Specification

**Protocol Version:** `1.0`  
**Standard Envelopes:** JSON / MessagePack over WebSocket (WSS) and JSON-RPC 2.0 (MCP)  
**Security Status:** Strictly Data-Plane (Zero Command Execution permitted)

---

## 1. Universal Wire Envelope

Every message transmitted over the real-time synchronization WebSocket conforms to the `SyncEnvelope` specification:

```typescript
{
  "protocol_version": "1.0",
  "project_id": "UUIDv4",
  "device_id": "UUIDv4",
  "message_type": "CLIENT_EVENT" | "SERVER_BROADCAST" | "EVENT_ACK" | ...,
  "client_op_id": "UUIDv4",
  "sequence_num": 104, // Assigned monotonically by central server; omitted on outbound client events
  "timestamp_utc": "2026-10-19T00:45:00.000Z",
  "payload": { ... }
}
```

---

## 2. Mandatory Architectural Safeguards

### Safeguard 1: Editing Leases & Active File Protection
* **Problem:** Filesystem watchers detect on-disk saves, not unsaved editor buffers or active typing sessions.
* **Mechanism:** Developers or AI agents declare an `EditingLease` (`CLAIM_EDIT_LEASE`) when actively modifying a file.
* **Inbound Policy:** When an incoming remote sync event arrives for a file under an active lease:
  1. The local user's file is **never silently overwritten**.
  2. The incoming change is written to a shadow file: `<path>.collab-remote-<seq>`.
  3. An advisory notification is dispatched: *"Teammate changed <path> while you have an active editing lease."*

### Safeguard 2: Separation of WIP vs. Verified Integration Checkpoints
* **WIP Checkpoint (`WIP_SNAPSHOT`):** Captures the ongoing, live state of all files across laptops. Even if unit tests, contract checks, or type checking fail, the WIP checkpoint is **never discarded**, preserving team progress.
* **Verified Checkpoint (`VERIFIED_INTEGRATION`):** Represents an immutable milestone that has passed the Checkpoint Gate (TypeScript typecheck, OpenAPI contract compatibility, database migration checks). Only verified checkpoints can be published to GitHub.

### Safeguard 3: Immutable Snapshot Identity (Tree Hash)
* A checkpoint is bound to a `SnapshotIdentity`:
  - `manifest`: Array of `{ relative_path, content_hash, size_bytes }` sorted alphabetically by path.
  - `tree_sha256`: SHA-256 computed across the sorted manifest string.
* When publishing to GitHub, the server verifies that the tree hash of the Git commit matches `tree_sha256` exactly.

### Safeguard 4: Machine-Readable Contracts & Uncertainty Labels
* Contract validators (e.g. `OpenApiContractValidator`, `TypeScriptAstValidator`) must explicitly declare supported versions and patterns.
* Any contract inferred through heuristics, dynamic computed properties, or unsupported AST patterns is marked:
  ```json
  {
    "confidence": "INFERRED_UNCERTAIN",
    "uncertain_inferred": true,
    "warnings": ["Dynamic computed pattern encountered; flagged for developer review."]
  }
  ```

### Safeguard 5: Path & Credential Isolation
* Absolute local filesystem paths (e.g., `D:\projects\app` or `/Users/shivam/app`) are **never stored in plaintext on the server**. Workspaces store a SHA-256 `local_path_hash`.
* `.env*`, `.pem`, `.key`, and `id_rsa*` files are hardcoded in `DEFAULT_IGNORE_PATTERNS` and rejected at the watcher boundary.

### Safeguard 6: Zero Remote Code Execution (RCE)
* The synchronization protocol contains **no opcodes** for shell commands, scripts, or terminal instructions. It is strictly limited to filesystem primitives (`FILE_CREATE`, `FILE_UPDATE`, `FILE_DELETE`, `FILE_RENAME`).

### Safeguard 7: Immutable Contract Version History
* Updating a contract increments its `version` integer and records a new immutable entry in `contract_versions` with diffs and breaking change details. Old versions are preserved for historical audit and rollback.

### Safeguard 8: Loop Prevention & Internal Artifact Shielding
* Paths matching `.collab/`, `.collab-internal/`, `.agents/diagnostics/`, `*.collab-remote-*`, and `*.conflict.remote` are suppressed from triggering outbound sync events.
* A 5-second `EchoSuppressionCache` registers `(path, target_hash, op_id)` before applying remote files to disk, ignoring the subsequent local OS watcher event.

---

## 3. Real-Time Synchronization Flow

```
Machine A (Maheen)             Server Sequencer              Machine B (Shivam)
      │                               │                              │
1. Save auth.py                       │                              │
2. Watcher fires (debounce 150ms)     │                              │
3. Enqueue SQLite outbox              │                              │
4. Send CLIENT_EVENT ───────────────► │                              │
                                5. Validate path jail                │
                                6. Assign seq_num=201                │
                                7. Persist to sync_events            │
   ◄──────── Send EVENT_ACK (seq=201) │                              │
                                      │ ──── Broadcast (seq=201) ──► │
                                      │                              8. Check Active Leases
                                      │                              9. Add to EchoSuppressionCache
                                      │                              10. Atomic write auth.py
                                      │                              11. Watcher fires -> DROPPED
```
