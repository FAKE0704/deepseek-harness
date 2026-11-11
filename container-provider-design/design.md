# Container Execution Providers for DeepSeek Harness — Design Document

> **Status**: draft v0.1 (rapid generation, AI-assisted — see [Authorship note](#authorship-note))
> **Author**: FAKE0704
> **Discussion**: [deepseek-ai/deepseek-harness#9120](https://github.com/deepseek-ai/deepseek-harness/discussions/9120)
> **Target**: DSH 0.2.2-rc.1 (upstream `master` at time of writing; all citations fetched 2026-11-11)

## Authorship note

This document was produced rapidly with AI assistance (DeepSeek Harness) under the direction of FAKE0704. Every claim about upstream source code is cited as `path:line` against `deepseek-ai/deepseek-harness@master` and was machine-verified at drafting time. The design decisions, their tradeoffs, and any errors of judgment are the author's; errors of fact should be reported in the linked discussion and will be corrected. Where this document and discussion #9120 differ on matters of source fact, this document is authoritative.

## TL;DR

A **staged container-execution provider family** for DSH, modeled on the in-repo `dsh-ssh` family and following the seam-replacement architecture that `packages/sandbox/sandbox/src/index.ts` prescribes for containers.

- **Stage A** (weeks): stock, unmodified `dsh-ssh` family pointed at an sshd-in-container, where the container is created/pinned/torn down by a small local lifecycle plugin. Ships real isolation value immediately; zero changes to upstream code.
- **Stage B**: a native Docker family whose transport is `docker exec` stdio — same helper, same wire protocol, no sshd, no SSH config management, and true `--network none` support.
- **Policy is upstream's to own**: `danger-full-access` is refused inside the container by default — deliberately *stricter* than today's ssh-world behavior, which executes that mode unconfined in the target world (§6.1). The opt-in restores upstream semantics; per-call `SandboxExecutionPolicy` semantics — including the `approveEscalation` ladder — are enforced by the helper *inside* the container, unchanged.
- **Designed for adoption**: package layout, naming, and test conventions mirror the `dsh-ssh` family so upstream can graduate any part of this in-repo with minimal rework.

## 1. Goals and non-goals

**Goals**

1. Kernel-boundary isolation for a DSH execution world, delivered as a **full seam replacement** (the slot `packages/sandbox/sandbox/src/index.ts:2-4` reserves for containers), not a `ctx.sandbox` backend registration.
2. Per-call policy semantics preserved *unchanged*: `SandboxExecutionPolicy` travels with every call; the `approveEscalation` ladder stays host-side; enforcement happens on the executing host.
3. Staged delivery: Stage A (stock `dsh-ssh` + lifecycle plugin, zero upstream changes) → Stage B (native `docker exec` transport).
4. Adoption-ready structure: conventions aligned with the `dsh-ssh` family so graduation in-repo is a move, not a rewrite.
5. Image-pinned supply chain: image digest + helper artifact digest both pinned and surfaced.

**Non-goals**

1. No changes to any seam interface, the policy vocabulary, or the escalation ladder.
2. No network/process-visibility policy axis (§8) — container `Config` only.
3. No `shell-docker` package: the shell family composes over `subprocess`/`sandbox` seams and relocates for free (§3.3).
4. No cloud backends (Modal/Daytona) in this design; the transport seam stays agnostic so they can follow (§5.4).
5. No hostile-execution-host defense: digest pinning verifies artifacts, not host intent — the ssh family states this limit explicitly and we inherit it (`packages/ssh/ssh/README.md` trust-model note; `sandbox-ssh/README.md:67-68` trusted-infrastructure boundary).

## 2. Background: the seam-replacement architecture

DSH's sandbox service is explicitly documented as a **same-world** confinement seam. From `packages/sandbox/sandbox/src/index.ts:1-4` (verified verbatim):

> Service Definition for the same-world process-confinement capability seam: wrap exact subprocess argv under a host-path file policy. **Containers, microVMs, and remote execution replace the surrounding capability seam instead**; this service shares the host kernel and filesystem.

Three facts follow from the current tree (all verified against `master`, DSH `0.2.2-rc.1`):

1. **The precedent exists.** The `@deepseek-ai/dsh-ssh` family (`packages/ssh/{ssh,fs-ssh,subprocess-ssh,sandbox-ssh,ssh-helper-runtime}`) already replaces the fs, subprocess, and sandbox seams for a remote world; the family README states it "implements the existing filesystem, subprocess and sandbox APIs; it introduces no SSH-specific model tools" (`docs/subsystems/ssh.md:5`) and that containers and remote executors "replace whole capabilities instead of registering here" (`packages/sandbox/README.md:12`).
2. **The container slot is empty.** As of this writing, no package under `packages/` is a Docker/container/microVM family. Upstream even records the open question in `packages/sandbox/sandbox-local/README.md:148-150`: *"An environment-coherent capability group example, such as bash plus fs against one container"* — undecided. This family is exactly that group.
3. **The ecosystem pressure is real.** Hermes Agent ([NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent)) ships first-party terminal backends (`local, docker, modal, daytona, vercel_sandbox, ssh` — `tools/terminal_tool_backends.py:51`) with built-in environment modules under `tools/environments/`. DSH's model is deeper: it replaces the whole fs/shell/subprocess seam rather than selecting a backend for a single tool — which is the best argument for supporting containers officially, and the reason this design is written to be adoption-ready rather than ecosystem-terminal.

## 3. Architecture overview

### 3.1 Family layout

Working names follow the ssh family's convention — one unsuffixed transport package owning connection + protocol + helper, one package per replaced seam, one private build carrier (`packages/ssh/README.md:23-29`):

| Package (working name) | Provides | Mirrors | Config? |
|---|---|---|---|
| `dsh-docker` | `ctx.docker` — connection, helper identity, transport lifecycle | `dsh-ssh` | **yes — the only configured package** |
| `dsh-fs-docker` | `ctx.fs` (`extends FileSystem`) | `fs-ssh` | no (`inject: ['docker', 'sandboxPolicy']`) |
| `dsh-subprocess-docker` | `ctx.subprocess` (`extends SubprocessRuntime`) | `subprocess-ssh` | no (`inject: ['docker']`) |
| `dsh-sandbox-docker` | `ctx.sandbox` (`extends SandboxProvider`) | `sandbox-ssh` | no (`inject: ['docker']`) |
| `dsh-docker-helper-runtime` | private SEA (single-executable-application) build carrier (no service) | `ssh-helper-runtime` | private:true |
| `dsh-docker-policy-ceiling` | §6 default: caps the `sandbox-policy` row | — (new, no ssh analog) | one boolean |

Final naming is upstream's call at graduation; the *shape* is the point: a transport family is fully described by which seam bases its packages subclass.

### 3.2 Helper inside the container — composition, not reimplementation

The helper runs **inside the container** and mounts the local provider stack — `SandboxedFileSystem` (`dsh-fs-sandbox`), `LocalSubprocessRuntime`, `LocalSandboxProvider`, plus `SandboxPolicyService` and `SessionProjectionRegistry` — in a private cordis Context — exactly the ssh helper's pattern (`packages/ssh/ssh/src/helper.ts:28-36`). The wire layer is a thin, strict-validated dispatcher exposing each seam method 1:1 as a namespaced method (`fs.*`, `process.*`, `terminal.*`, `sandbox`, `executable`), over a **custom framed protocol**: 4-byte big-endian length prefix + JSON body, frame types `request|result|error|cancel`, typed error codes preserved end-to-end (`packages/ssh/ssh/src/protocol.ts:36-41,50-55,134-204`) — not a generic RPC standard; Stage B reuses it verbatim (§5.1). The container adds the outer kernel/filesystem boundary; per-call policy semantics are enforced by the in-container sandbox exactly as on any DSH host:

- Policy is resolved host-side per call (`ctx.sandboxPolicy.resolve()`), never provider-held (`packages/sandbox/sandbox-policy/src/index.ts:197-205`).
- The enforcing host canonicalizes roots itself — "a local host must not canonicalize a remote path" (`sandbox-policy/src/index.ts:36-57`); `additionalWritableRoots` are "checked on the remote host" (`packages/sandbox/sandbox/src/index.ts:48`).
- All five fs mutators send the resolved per-call policy over the wire (`packages/ssh/fs-ssh/README.md:32`).

### 3.3 What is *not* replaced: shell and terminals

- **`ctx.shell` stays.** The ssh family provides exactly `ctx.ssh`, `ctx.fs`, `ctx.subprocess`, `ctx.sandbox` — no shell package (`packages/ssh/README.md:23-29`). The same bash executors run unchanged: `SandboxBashExecutor extends LocalBashExecutor` with `inject = ['subprocess','sandbox','sandboxPolicy']` (`packages/shell/bash-sandbox/src/index.ts:45-46`), confining `['bash','-c',command]` via `ctx.sandbox.confine` and spawning through `ctx.subprocess` (`bash-sandbox/src/index.ts:187-189`). When the container family occupies those rows, every shell tool relocates into the container with zero shell-specific code. Shell-facts discovery rides the subprocess seam (`terminalEnvironment()`; `packages/ssh/subprocess-ssh/tests/shell-discovery.spec.ts:8-36`).
- **`ctx.terminals` stays.** It is a concrete registry, not a provider slot (`packages/terminal/terminal/src/index.ts:104-118`); `terminal-bash` sessions wrap a `SubprocessTerminalHandle` (`terminal-bash/src/session.ts:279`), which the container subprocess provider supplies via `spawnTerminal`. The whole-life sandbox fence applies; confined modes require a same-world `ctx.sandbox` provider — which the family provides (`terminal-bash/README.md:49,70`).

### 3.4 Wiring

Cordis bundle-patch rows by id, last-write-wins; one implementation per service slot (`packages/bundle/base/cordis.patch.yml:1-13`; `packages/subprocess/subprocess/src/index.ts:89-93`). A container profile replaces the base rows `subprocess`, `sandbox`, `fs-sandbox` by id, adds the `dsh-docker` connection row, and optionally the ceiling row. The canonical row order mirrors the release verifier's composition: projections → policy → connection → providers (`scripts/verify-ssh-helper-artifact.ts:84-95`). No shipped preset includes a replacement family — activation is by custom profile (`packages/ssh/ssh/README.md:28`).

## 4. Stage A — lifecycle-managed container + stock `dsh-ssh`

### 4.1 Concept

Zero upstream changes: the stock `dsh-ssh` family connects to an sshd running in a container, and a small **lifecycle plugin** (the only new code) owns the container end-to-end. The lifecycle plugin does not touch any seam; it materializes the connection's prerequisites.

### 4.2 Lifecycle plugin responsibilities

1. **Image pin**: resolve the configured image tag to a manifest digest at first use, record it, and `docker create` by digest forever after; drift on reuse is refused (§7).
2. **Create** the container: sshd entrypoint, workspace **bind-mounted at an identical host/container path** (path-spelling contracts, §9), port published on **127.0.0.1 only** (bridge network required in Stage A — §8), user mapping configurable (Hermes's `docker_run_as_host_user` is the UX precedent, `cli-config.yaml.example:498`).
3. **Extract the ephemeral host key** via Docker control and write it, `[host]:<port>`-spelled, into a plugin-owned `known_hosts` file.
4. **Write a managed `Include` block** into a plugin-owned ssh-config file referenced from `~/.ssh/config` — alias, `HostName 127.0.0.1`, fixed `Port`, `UserKnownHostsFile`, `StrictHostKeyChecking yes`. This is forced by the schema: `host` is an OpenSSH alias with **no `port`/`user`/`knownHostsFile` fields anywhere** (`packages/ssh/ssh/src/index.ts:33-69`), and the alias regex admits no `:` (`host:port` impossible).
5. **Inject the helper**: `docker cp` the helper artifact (Stage A default: the `executable` SEA kind — `ssh-helper-runtime` already builds node24-linux-x64/arm64 targets, covering both container architectures with no Node in the image; `ssh-helper-runtime/README.md:30-47`), compute its SHA-256, and write `helperHash` into the emitted connection row.
6. **Emit the `dsh-ssh` row** with `host` = the managed alias, `launch: {kind:'executable'}`, `helper`, `helperHash`, `workspace` = the identical bind-mount path; sensible wire defaults (`requestTimeoutMs` 30 s, `maxFrameBytes` 64 MiB, `maxPending` 128, `leaseMs` 30 s) come from the schema (`ssh/src/index.ts:60-69`).
7. **Dispose**: `docker rm -f`, remove the ssh-config block and `known_hosts` entries. The helper's own lease/heartbeat self-termination (`ssh/src/index.ts:321-326`; `helper.ts:85-88`) plus its `/tmp/dsh-ssh-*` cleanup covers the in-container side.

### 4.3 Trust model

`BatchMode=yes`, `StrictHostKeyChecking=yes`, no agent forwarding, no interactive fallback are **hardcoded** (`ssh/src/index.ts:299-303`). Stage A therefore anchors trust in **local Docker API control, not network TOFU**: the plugin that created the container is the same process that wrote the only host key the connection will accept, and the helper digest verified at handshake (`hello.hash`, `helper.ts:115`; compare `index.ts:316`) is the digest of the artifact that same plugin injected. Nothing first-use about it.

### 4.4 Constraints

- Client platform guard is linux/darwin (`ssh/src/index.ts:90`) — Docker Desktop hosts are fine; the container is linux, covered by both SEA targets.
- Stream forwarding uses the ssh control master and **streamlocal** (`ssh -O forward -L localUnix:remoteUnix`, `index.ts:163-171`); passing streamlocal through containerized sshd is expected to work but is a **validate-in-prototype** item (§13).
- Stage A cannot use `--network none`: sshd must be reachable. True network-off arrives with Stage B.

### 4.5 Operational edges this design owns

1. **Orphan recovery.** The lifecycle plugin labels its containers (`dsh.container`, profile id). On startup it finds a leftover container and **recreates** — containers are stateless executors: session storage, policy, and transcripts live host-side, so recreation loses only running processes, exactly like a crashed remote host. The helper's own lease expiry has already cleaned its side (`helper.ts:85-88`).
2. **Concurrency.** Default: one container per profile, concurrent sessions sharing it — as concurrent sessions share one ssh host; per-session state is keyed off `policy.sessionId` (§3.2). A per-session-container mode exists as config for stricter isolation, at image-start latency cost.
3. **Resource limits.** `cpu`/`memory`/`pids` are family `Config` passed to `docker create` — conservative defaults, not policy vocabulary (§8).
4. **macOS caveat.** Docker Desktop file sharing must cover the workspace path or the identical-path bind-mount fails; the plugin detects this and fails with an actionable message, since §9's path-coincidence premise depends on it.

These carry over to Stage B, where the connection service owns the same responsibilities (§5.2).

## 5. Stage B — native Docker family

### 5.1 Transport

`docker exec -i <container> <helper-entry>` stdio carries the same framed protocol (§3.2), with its own protocol literal (the ssh family versions its wire with `SSH_PROTOCOL_VERSION = 3`, `protocol.ts:10`; the docker family starts at 1) and the same handshake: `hello` → digest + protocol + launch-kind checks gating plugin readiness (`ssh/src/index.ts:310-318`).

### 5.2 What evaporates

No sshd, no `~/.ssh/config` management, no `known_hosts`, no control master, no port publishing. Trust reduces to **Docker API access + the pinned image digest**. The lifecycle plugin's responsibilities fold into the `dsh-docker` connection service.

### 5.3 Streams

Per-stream TLS-PSK socket servers inside the container are kept as-is (256-bit capability tokens minted per endpoint and delivered only over the admin channel; pinned cipher/identity; `helper-processes.ts:423-444`; `stream-security.ts:6-25`). The host side replaces the ssh forward with a per-stream `docker exec` relay (a tiny socket-dialer exec'd in the container); alternatives (daemon-attached proxies) are noted for the prototype to choose between.

### 5.4 What stays backend-agnostic

The transport seam is deliberately narrow (exec stdio + stream sockets). Cloud executors (Modal/Daytona) would be new transports over the same helper — out of scope here, noted for upstream's roadmap (§13).

## 6. Safety policy: `danger-full-access` (Q1)

### 6.1 What upstream does today (verified)

1. Consumers **bypass the seam entirely** for `danger-full-access`: tools spawn the original argv and never call `ctx.sandbox` (`docs/subsystems/sandbox.md:23`).
2. In a replaced-seam world that argv executes **unconfined in the target world** — for ssh, on the remote host; the connection adds no policy flag (`sandbox-ssh/README.md:30`).
3. `helper.ts:159` ("Unconfined argv does not need a sandbox wrapper") is a misuse guard on the `confine` RPC, unreachable by well-formed consumers.

Today's semantics are therefore **(c) unconfined in-world** — neither (a) refusal nor (b) route-back-to-host. Option (b) is not implementable within current seams: the subprocess spawn spec carries no policy (`packages/subprocess/subprocess/src/types.ts:77-107`), so a provider cannot see that a spawn is unconfined, let alone reroute it — and exactly one subprocess implementation may occupy the slot (§3.4). Option (a) is implementable and is what this family ships by default.

### 6.2 This family's stance

- **Default — refuse, via a policy ceiling.** The optional `dsh-docker-policy-ceiling` row replaces the `sandbox-policy` row with a subclass whose `resolve()` delegates to the base resolver, then throws `SandboxUnsupportedPolicyError` with an actionable message when the resolved mode is `danger-full-access` and the opt-in is off. UX softener (best-effort, clearly marked): a waterfall listener on `approval/request` that auto-rejects escalations to `danger-full-access` before the prompt — the escalation reason is templated (`escalate sandbox to ${mode}: …`, `escalation.ts:189-196`), so the pre-filter matches on the template, but the **resolve-time ceiling is the enforcement**; the pre-filter is cosmetic. The ceiling row is transport-independent — it replaces the `sandbox-policy` row, so it composes with Stage A (stock `dsh-ssh`) exactly as with Stage B.
- **Opt-in — unconfined in-world (upstream semantics).** One config boolean removes the ceiling; `danger-full-access` argv then runs unwrapped inside the container. The container boundary itself is untouched by this mode — that is precisely what "not confined" means upstream.
- **Literal route-back-to-host — needs upstream.** Listed as open question §13.5: it requires either a policy-carrying spawn spec or a sanctioned two-world composition; the seams today permit neither.
- **Both paths tested against the same ladder.** The matrix runs every policy mode × escalation outcome × (default | opt-in), asserting the host-side `approveEscalation`/`ctx.approval` flow (`escalation.ts:172-206`; `packages/interaction/user-approval/src/index.ts:242-332`) behaves identically apart from the ceiling.

**Why refuse rather than match upstream on day one**: a container profile is typically adopted *because* the user wants a hard boundary; silent unconfined execution — even inside the container — is the one mode where the model runs without any wrapper at all. Refusal costs one config line for users who want upstream-exact semantics and keeps the default honest. If upstream rules "containers follow ssh semantics exactly," the ceiling plugin is deleted and this section shrinks to a citation.

## 7. Image pinning and supply chain

1. **Image**: pinned by manifest digest at create; tag→digest resolution recorded; drift on reuse refused. Surfaced in connection status.
2. **Helper artifact**: `helperHash` pinned in config and verified against the helper's self-computed `hello.hash` at handshake (`helper.ts:115`; `index.ts:316`); Stage A's hash is computed by the same plugin that injected the artifact.
3. **SEA archive**: `manifest.json` carries source commit, embedded Node version, protocol literal, and per-file digests+permissions (`ssh-helper-runtime/README.md:30-47`).
4. **Runtime deps**: exact-pinned (the ssh family pins `zod: "4.4.3"`; same policy).
5. **Stated limits**: digest pinning is not hostile-host defense; the trusted-infrastructure boundary is documented, not pretended away (`sandbox-ssh/README.md:67-68`).

## 8. Network visibility (Q4) — Config-only

The policy vocabulary deliberately excludes network/process visibility (the mode schema carries only `mode`/`workspaceRoot`/`additionalWritableRoots`/`sessionId`, `sandbox/src/index.ts:40-60`), so network posture is family `Config`, not policy:

- Stage A: bridge network + loopback-published sshd port (forced, §4.4).
- Stage B: `networkMode` config, **default `none`** (the transport is the Docker socket; the container needs no network at all), `bridge`/custom as opt-in.

No cross-provider network policy extension is proposed now; if upstream later wants one, this Config becomes the migration surface.

## 9. Mixed-world composition (Q3)

Mechanically sound: service rows are independent, so a profile can keep `fs` host-local (`fs-local` + `fs-sandbox`) while replacing `subprocess`/`sandbox` with container providers. With the workspace bind-mounted at an identical path (§4.2.2), both worlds agree on path spelling, satisfying the execution-world-spelling rule (`sandbox-policy/src/index.ts:36-57`) in either world. LSP stays host-side — the original motivation.

Caveats, stated honestly:

1. Host-assuming consumers exist: "replacing providers alone does not make [host-assuming web views] remote-aware" (`docs/subsystems/ssh.md:27`). The *inverse* composition (host fs + container exec) is new even for ssh; upstream blessing is open question §13.3.
2. In mixed composition, fs mutators are fenced host-side by the host `fs-sandbox` against host paths, while `confine()` comes from the container provider — consistent under path coincidence, but **prototype-validate** before recommending (§13).
3. The §6 ceiling is host-side and world-agnostic; mixed composition does not change ladder behavior.

## 10. Version corridor (Q5)

Upstream publishes family peers as caret ranges — in-repo peers are `workspace:*`, which resolve to caret on publish (verified against the npm registry); only true runtime deps such as `zod: "4.4.3"` are exact — so an out-of-repo family should:

1. Declare peers as caret ranges aligned to the **newest tested** DSH release (not wider).
2. Publish a README table of tested DSH versions, updated per release.
3. Track released upgrade guides; the protocol literal + handshake checks make incompatible wire changes fail loudly at connection, not mid-session.
4. Propose that upstream document this corridor convention for third-party families (open question §13.4).

## 11. Stage A → Stage B migration path

**What holds** (the seam contracts and everything above them):

- All three providers' external surface (same seam bases, same service names, same per-call policy flow).
- The helper: same private-Context composition, same wire methods, same lease/heartbeat/cleanup semantics.
- Host-side policy resolution, escalation ladder, approval flow; model-facing denial/escalation markers verbatim.
- Profile row ids for `subprocess`/`sandbox`/`fs-sandbox`.

**What changes**:

| Dimension | Stage A | Stage B |
|---|---|---|
| Connection row | `dsh-ssh` (+ separate lifecycle plugin) | `dsh-docker` (lifecycle folded in) |
| Transport | ssh exec channel + control-master streamlocal forwards | `docker exec` stdio + per-stream exec relays |
| Trust machinery | alias + plugin-written `known_hosts` + managed ssh-config block | Docker API access + image digest |
| Network | bridge, loopback port | `none` by default |
| Helper artifact | injected by lifecycle plugin, hash emitted to config | baked into pinned image (same handshake check) |
| Extra plugin | lifecycle plugin (new code); ceiling row applies here too (§6) | policy-ceiling row (§6) |

Migration is a row swap plus config; sessions see no semantic difference except the network default.

## 12. Adoption-friendly structure and test strategy

Conventions copied from the ssh family so graduation is a move, not a rewrite:

1. One configured transport package; zero-config providers (`static inject` only) — the config catalog shows exactly one configurable package per family (`packages/preset/agent-preset/skills/cordis-composition-reference/references/packages.md:448-449`; generated config block at `docs/config-catalog.md:3488-3533`).
2. Replace seams by subclassing the shared abstract Service bases; unsupported methods left to base defaults (fs `watch()` precedent, `fs-ssh/README.md:70`).
3. Family lockstep versioning; providers peer `workspace:*`-style on the transport; helper carrier `private: true` with the closed embed set.
4. Bilingual READMEs (`README.md` + `README.zh.md`) + locale dirs for service descriptions — the family convention.
5. **Tests, two tiers + adversarial**: per-package vitest with mock-transport unit tests (`ctx.provide('docker', { request })` pattern); real-helper integration via a shared fixture; opt-in live e2e behind env vars; dedicated adversarial specs for stream-capability replay, socket rebind, and protocol boundaries — the ssh family's live e2e even dials a stream socket with an all-zero PSK and asserts `{connected: true, secure: false}` (`packages/ssh/ssh/tests/live.e2e.ts:66-95`); we adopt the same attack-as-test discipline.

## 13. Open questions for upstream

1. **Q1 ruling**: (c) in-world unconfined (today's ssh semantics) vs (a) refusal-by-default (this design's ceiling) vs (b) route-back-to-host with upstream seam support. If upstream picks ssh-exact semantics, the ceiling plugin is deleted.
2. **Q2**: would `dsh-ssh`'s Config grow ephemeral-host fields (`port`/`user`/`knownHostsFile`/`trustedHostKey`), removing Stage A's managed ssh-config block entirely? Or is the managed block the preferred long-term shape?
3. **Q3**: is host-fs + container-exec mixed composition contractually blessed, and are there same-world invariants beyond the documented host-assuming consumers?
4. **Q5**: will upstream document the third-party version corridor (§10) as a convention?
5. **Route-back-to-host** (§6.1 option (b)): requires a policy-carrying spawn spec or two-world composition — is that wanted at all?
6. **Streamlocal forwarding** through containerized sshd in Stage A: expected to work; prototype validates.
7. **Graduation criteria**: what would upstream want to see (adoption, test coverage, benchmarks) before adopting a container family in-repo?

## Appendix A — Seam compliance matrix

| # | Obligation (from the seam contracts) | Where satisfied |
|---|---|---|
| 1 | Consume per-call policy via `ctx.sandboxPolicy.resolve()`; never provider-held mode | §3.2 |
| 2 | `workspaceRoot`/`additionalWritableRoots` in execution-world spelling; enforcing host validates each call | §3.2; identical bind-mount path §4.2 |
| 3 | Use `workspaceWritableRoots`/`writableRoots` derivations for allow-lists | helper mounts `dsh-sandbox-local` unchanged §3.2 |
| 4 | Never enforce policy for `danger-full-access` (consumers bypass the seam) | §6.1; ceiling is host-side §6.2 |
| 5 | Key per-session state off `policy.sessionId` | inherited from local providers §3.2 |
| 6 | `SandboxProvider.confine(argv, policy, signal?) → ConfinedArgv`; fail closed; no silent passthrough | `dsh-sandbox-docker` §3.1 |
| 7 | `FileSystem`: all 16 abstract methods; five mutators take trailing `sandboxPolicy`; `watch()` rejection legal; `processPathFromHostPath` undefined; honest `sandboxMode` getter; `FsError` codes only; no ambiguous-mutation retry | `dsh-fs-docker` §3.1 |
| 8 | `SubprocessRuntime`: `resolveExecutable`/`terminalEnvironment`/`spawn` (sync handle)/`spawnTerminal`; no policy param; env scrub shared; no ambiguous replay | `dsh-subprocess-docker` §3.1 |
| 9 | Shell: delegate, never replace | §3.3 |
| 10 | Terminal: register/ride a `TerminalBackend`, never subclass the registry | §3.3 |
| 11 | One connection service owns transport/identity; providers config-free | §3.1, §12.1 |
| 12 | Cordis rows by id, last-write-wins; one implementation per slot | §3.4 |
| 13 | Escalation stays host-side; container enforces the granted mode on the one escalated retry | §6.2 |
| 14 | Model-facing dialect preserved: `[sandbox: file access denied under <mode> mode]` + escalation hint + `FS_SANDBOX_DENIED` | inherited verbatim §11 |
| 15 | Honest limits: no network/process-visibility vocabulary; partial stays partial; trusted-infrastructure boundary documented | §8, §7.5 |

## Appendix B — Stage A → B contract deltas

See §11 table. The wire protocol, helper behavior, and all seam contracts are identical; only the transport, trust machinery, and lifecycle ownership move.
