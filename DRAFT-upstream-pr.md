# DRAFT (not for merge upstream as-is): tolerate decodable out-of-band first frames in zstd session logs

Status: fork draft for an upstream PR proposal. Branch:
`dsh/upstream-pr-log-frame-tolerance` (one commit on top of `dsh-v0.2.2-rc.5`).
Rationale record: Genshu `docs/kernel/K10-会话日志帧纪律与corrupt自愈.md`.

## Claim

The zstd session log format promises an independently decodable first frame
that contains **exactly one** header line. rc.5 enforces that promise on the
**read** path (`assertZstdHeaderFrame` in `session-persistence-jsonl/src/index.ts`,
`assertIndependentHeaderFrame` in `generation.ts`, pinned by `tests/zstd.spec.ts`).
Consequence: a log whose first frame packs the header plus decodable event
records — produced by an out-of-band/older writer — becomes permanently
unreadable (every open rejects as corruption). Corruption is a data-loss class;
a decodable-but-non-canonical frame is not corruption.

Proposal: on read, split the leading JSONL record off the first frame and scan
the remainder normally (rejecting only genuinely undecodable content). Keep the
**write** path strict: the first mutation rewrites the artifact into the
canonical one-header-frame layout via an atomic rename, so the invariant holds
for everything this build writes. Migration verification applies the same split.

## Evidence in this branch

- `splitZstdHeaderFrame` replaces the two strict asserts on all read paths
  (full decode, first-line discovery, generation migration + verification).
- `reframeCanonicalLog` + handle state (`reframe`) rewrite the exact accepted
  artifact before the first append lands; canonical logs are byte-identical
  across opens.
- `tests/out-of-band-frame.spec.ts`: packed single-frame artifact reads and
  reframes on first append; canonical artifact unchanged; header-less frames,
  non-header leading records and unparsable packed records still reject.
- Upstream tests flipped accordingly (`zstd.spec.ts`, `generation.spec.ts`).

## Notes for upstream review

- No API change; behavior change is confined to previously-rejected artifacts.
- Known local red unrelated: `generation.spec.ts` › "accepts a valid append on
  a zstd target created by another migration" assumes byte-deterministic zstd
  frames and fails on this host (native zstd + Node 26); pre-existing upstream
  test sensitivity, not introduced here.
