# Control sockets live in a short runtime dir, not in the anchor

Every other piece of devtrees runtime state stays in `<git-common-dir>/devtrees/` (ADR-0001): the allocation registry, the derived configs, the per-instance logs, the shared instance's persisted name→port map. **Control sockets do not.** They live under a short, per-user runtime dir keyed by a hash of the anchor:

```
<runtime-base>/devtrees-<uid>/<anchor-hash-12>/<instance-id>.sock
```

`<runtime-base>` is `$DEVTREES_RUNTIME_DIR`, else `$XDG_RUNTIME_DIR`, else `/tmp`.

The reason is a hard kernel limit, not a preference. A unix-domain socket path has to fit in `sockaddr_un.sun_path` — 104 bytes on macOS, 108 on Linux — and `<git-common-dir>/devtrees/run/<worktree-id>.sock` blows that budget on any deep checkout. Measured on the repo that reported it (issue #156): 163 bytes, `up` failing 3/3 runs with no service ever starting, while the identical stack at a 44-byte path came up in ~1s. `bind(2)` fails, process-compose exits without printing anything about the socket, and devtrees only sees "the socket never appeared" — which got misdiagnosed twice (issues #154, #157) before anyone measured the path.

Uniqueness survives the move because both dimensions the anchor path provided are preserved explicitly: the anchor hash is one namespace per repo (so two repos never share a `shared.sock`), and the filename is the worktree id, which already carries its own path hash (issue #82). The `<uid>` level keeps two users apart when the base is a shared `/tmp`, and devtrees refuses to use it if it is not a directory it owns with no group/other write bit — binding a control socket into a directory a hostile local user controls is the one outcome worth failing on rather than working around.

## Considered Options

- **Keep sockets in the anchor and shorten the *filename*** (hash instead of the worktree id): rejected — the anchor path is the long part; a shorter stem buys a handful of bytes and costs discovery its readable identity (the run dir's filenames are how `ls` and `prune` name instances).
- **Pass a relative socket path and `chdir` into the run dir before binding**: the classic `sun_path` workaround, and it would keep the socket physically inside the git dir. Rejected — devtrees does not only spawn process-compose, it also *connects* to the socket in-process (`probeSocket`), and `process.chdir` is global and racy against the concurrent probes `ls` and `prune` perform. Every client invocation would have to carry the cwd too.
- **Symlink a short path in `/tmp` to the real run dir inside the git dir**: also works around the limit while leaving the files where ADR-0001 put them, and survives a tmp reaper deleting the *link* (the socket inode is elsewhere). Rejected as too clever for what it buys: the alias has to exist for the path to be valid at all, so `instancePaths` — a pure function every read path calls — would have to perform filesystem side effects, or every caller would have to remember to materialise the link first. The relocation keeps `instancePaths` pure and puts directory creation exactly where `mkdir` already happened.
- **Relocate only when the path does not fit**, keeping the anchor path otherwise: rejected — two locations means every discovery, teardown and probe path has to agree on which one is in play for a given instance, and the rarely-taken branch is the one that would rot.
- **Raise the socket-wait deadline**: rejected on evidence. Running `process-compose up -f <the same generated config> --unix-socket <163-byte path>` by hand produced no socket after 6s and no diagnostic; the same config with a short path bound immediately. There is no timing component to wait out.

## Consequences

- **Sockets no longer survive a reboot.** That is an improvement: a socket file in the git dir outlived the process that bound it (issue #80's stale-socket handling exists for exactly that), whereas `/tmp` and `XDG_RUNTIME_DIR` are cleared. The liveness probe still runs — the socket file is never trusted on its own.
- **`git worktree remove` never removed the socket anyway** (it lived in the git common dir, not in the worktree), so `prune` remains the reconciliation path and is unchanged in kind. It enumerates the new run dir, and `runPrune` now tears an orphan down through the socket path *discovery actually found* rather than a recomputed one.
- **A tmp reaper could delete a live instance's socket**, leaving a running process-compose no one can address. `prune`'s registry-keyed reconciliation (issue #142) still reclaims the allocation entry, but the supervisor would have to be killed by hand. Accepted: default macOS/Linux cleanup thresholds (3 days untouched) are far longer than a stack's usual life, and the alternative is the bug this ADR fixes.
- **Instances started before this change are read, never written.** Discovery also lists the pre-#156 `<anchor>/devtrees/run` dir so such an instance stays visible to `ls` and reclaimable by `prune` instead of becoming an invisible orphan across the upgrade. Nothing is written there again. A stack that is still up across the upgrade is best stopped with `devtrees down` *before* upgrading; if it isn't, a new `up` binds the new path and the old instance surfaces as a `STALE_PORT_BLOCK` collision naming the orphan's PID.
- **`SOCKET_PATH_TOO_LONG` is a new error code** in the ADR-0005 envelope (additive, so not a `schema_version` bump). It fires before any spawn, and its `details` carry the path, its byte length, the platform limit, and `DEVTREES_RUNTIME_DIR` as the remedy. The relocation makes it nearly unreachable in practice — that is the point: a limit that can still be hit has to announce itself rather than reappear as a mystery timeout.
- **`DEVTREES_RUNTIME_DIR` is devtrees' second environment variable** (after `DEVTREES_ASSUME_TTY`) and its only configuration escape hatch for state location. It is also what the test suite uses to sandbox its sockets.
- **Length is measured in bytes, not characters**, since `sun_path` is a byte buffer; a non-ASCII directory name costs more than its length suggests.
