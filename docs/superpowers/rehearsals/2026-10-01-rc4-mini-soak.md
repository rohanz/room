# Local mini-soak: Room 0.17.0-rc4, 2026-10-01

Follow-up to the [rc3 staging soak](2026-10-01-soak.md), whose CPU, memory and health criteria failed.
Harness: [`scripts/soak.mts`](../../../scripts/soak.mts) with eight participants, 45 minutes, no restart, against a local
container built the production way. Samples every 5 minutes from `/proc/1` in the container (the server is PID 1).

## Setup

- **Image.** `docker build .` at `e3c2a39`: esbuild-compiled server under plain `node`, no tsx or esbuild in the
  runtime image. `--memory 512m --cpus 1` (the staging VM's memory; one core), `NODE_ENV=staging`,
  `GITHUB_CLIENT_ID=fake`, a fresh volume per run. Docker Desktop 29.6.1 on macOS (a Linux VM with glibc).
- **A/B.** Two containers ran at once from one image: **A** with the image's `MALLOC_ARENA_MAX=2`, **B** with the
  variable removed (`env -u MALLOC_ARENA_MAX node …`). Each had its own soak harness.
- **Soak 1** is an earlier run of the same harness against `d80b961` (the first rc4 cut: ledger index, no startup
  value scan, compiled image, `MALLOC_ARENA_MAX=2`), before the two fixes the CPU profile found (below).
- CPU % is the server's user+system time over each 5-minute interval, as a share of one core.

## Results

| min | A RSS MB | A CPU % | A /health ms | B RSS MB | B CPU % | soak 1 RSS MB | soak 1 CPU % |
|---|---|---|---|---|---|---|---|
| 0 | 73.0 | - | 37 | 75.1 | - | 74.8 | - |
| 5 | 88.7 | 0.87 | 55 | 92.8 | 0.94 | 112.6 | 1.46 |
| 10 | 100.1 | 1.17 | 181 | 109.7 | 1.19 | 104.4 | 2.27 |
| 15 | 107.4 | 1.23 | 93 | 151.0 | 1.34 | 128.5 | 2.72 |
| 20 | 113.2 | 1.21 | 195 | 174.1 | 1.44 | 145.1 | 2.96 |
| 25 | 108.8 | 1.42 | 190 | 154.8 | 1.62 | 110.9 | 3.44 |
| 30 | 117.5 | 1.36 | 152 | 186.3 | 1.43 | 158.3 | 3.93 |
| 35 | 120.3 | 1.29 | 111 | 182.4 | 1.53 | 151.4 | 4.67 |
| 40 | 122.5 | 1.15 | 58 | 200.7 | 1.22 | 133.6 | 4.89 |
| 45 | 118.8 | 1.21 | 51 | 210.6 | 1.36 | 139.9 | 4.93 |

- **CPU is flat** in A and B: 0.9–1.4% of a core from minute 5 to 45 while the bus grew to about 850 entries. Soak 1
  still climbed (1.5% to 4.9%), like rc3 on staging (1.9% to 10% over three hours).
- **Memory.** With `MALLOC_ARENA_MAX=2`, RSS levels off at 107–123 MB from minute 15 (HWM 163 MB). Without it, RSS
  keeps climbing, from 151 to 211 MB (HWM 234 MB), under the same load from the same image. The variable stays.
- **Health.** /health answered every probe (274 per run, none over 8 s); its sampled latency includes the host
  running both harnesses (16 participant processes) beside the containers.
- **Correctness, both runs:** 0 lost and 0 duplicate deliveries (A 515, B 446 addressed messages accepted; 0 owed
  at the stop); 26/26 and 39/39 same-id resends answered as duplicates; no seq or epoch problems; no name drift;
  every leave-and-rejoin kept its name.

## What the CPU profile found

Soak 1's climbing CPU, on a build that already had the incremental ledger index, led to a 20-minute
`node --cpu-prof` run of the compiled server under the same load. Comparing the first and last 5 minutes,
the growth was inclusive time in `Y.encodeStateAsUpdate` (133 to 345 ms per 5 minutes) and GC (162 to 376 ms):
full-document encodes whose cost grows with the room. Two callers:

1. **Persistence** (`packages/server/src/hub.ts`): an update arriving while a write was in flight was not kept, so
   the next write stored a full snapshot. Under steady load that was most writes. Queued updates are now appended as
   one `Y.mergeUpdates`, with a snapshot only by the existing byte rule or after 128 appended records.
2. **Identity guard** (`packages/server/src/readonly.ts`): after every flagged packet it rebuilt its shadow document
   from the whole room, including in observe mode (the default), where the packet is applied to the room anyway.
   It now rebuilds only in enforce mode or after a malformed packet.

## Idle memory (startup scan)

`scripts/measure-idle-rss.mts --mb 60` (60 MB of raw updates, 76 MB on disk, eight documents; RSS after startup
plus 60 s idle, macOS): rc3 source 143.5 / 143.3 MB; the first rc4 cut, with its metadata-only startup inventory,
80.0 / 79.8 MB; rc4 without any startup scan, 63.3 / 61.6 MB. rc2's baseline was 97–98 MB. The 512 MB container
idled at 73–75 MB with an empty volume (rc3's staging process idled at 100 MB, plus 64 MB for the tsx wrapper and esbuild).
