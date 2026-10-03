# Production 0.17 cutover, 2026-10-03

Rohan explicitly approved the cutover after the rc14 live and real-auth staging rehearsals. The deployed runtime is identical to tested rc14: 3,453 tests passed, plus typecheck, knip, web/plugin builds and the second independent review with no must-fix findings. Only operational documentation changed afterward.

## Snapshot and offline inventory

Production machine `48e10e6c9de518` was removed from public routing and stopped before snapshotting volume `vol_491xoz0935ggnwor`. Snapshot **`vs_BxVDz5Qnb5MfQJ0ykMGqe6`** reached `created` at **2026-10-03 07:27:19 UTC**, with five-day retention (17,505,717 reported snapshot bytes, 1 GiB volume). The app had only the GitHub client-ID secret; no Postgres store required a matching dump.

Rollback must restore this snapshot to a new volume and use the pre-upgrade image `registry.fly.io/room-rohanz:deployment-01M3NJ4Y5WWVJB6V7GS7P385M9` (digest `sha256:b9ade4342a5b76702b9a41ad1461d6dfc64253a5b1699820525e7db3937061c5`). Do not put 0.16 on the migrated production volume. See [the runbook](../../../deploy/DEPLOYING.md).

The snapshot was restored to private inspection volume `vol_vwnk78531888oe9v` on unrouted machine `080060df232058`. The Room server was disabled. The bundled offline inventory ran against a disposable database copy with a 32 MiB budget: **40 documents, 20 served, 12 never-served, 8 unregistered, zero oversized native tables**. One never-served encoded key exceeded the per-document budget (33,741,393 bytes counted at early exit, 346 updates); no served document did. Inventory exit 2 was expected for these preserved legacy keys. Its cross-filesystem hard-link warning was safe here because this was an isolated snapshot copy with no server running.

The inspection machine and volume were destroyed and absence verified before deployment. The earlier dry-run machine and volume were also absent.

## Deployment and migration

Production now runs the exact staging-verified image `registry.fly.io/room-rohanz-staging:rc14-rehearsal`, digest `sha256:9eb09ae764caa34bdbefb2a1c3d9659c3949f87bae2eb8e600470444b4b66a1a`, at 512 MiB with production authentication and proxy trust enabled. The normal public services and autostart were restored by deployment. Health reports `{"ok":true,"schema":2,"hub":1}`; GitHub device authentication is enabled. The served JavaScript asset hash matches the tested build: `3c61656733fef841378c0ce4f2b6b1f5d9a0647344fbb48e4d7749e48a0c5ff8`.

All eight repositories migrated through real GitHub-authenticated 0.17 joins from empty clones with intent-only sharing. Every document reported schema 2; every registry entry ended at `mode=repo`, `step=written`, with **zero skipped source documents**.

| Repository | Join seconds | Scopes | Claims | Pending mail | Unresolved | Archived sources | Skipped records |
|---|---:|---:|---:|---:|---:|---:|---:|
| room-playground | 5.69 | 0 | 0 | 0 | 0 | 1 | 0 |
| room | 5.84 | 0 | 0 | 0 | 0 | 1 | 0 |
| room-playground-2 | 5.65 | 0 | 0 | 7 | 0 | 1 | 65 |
| werkzeug-rehearsal | 7.00 | 0 | 0 | 4 | 6 | 8 | 116 |
| click-rehearsal | 5.71 | 0 | 0 | 0 | 0 | 2 | 17 |
| httpx-rehearsal | 5.71 | 0 | 0 | 0 | 0 | 4 | 53 |
| flask-rehearsal | 5.79 | 0 | 0 | 0 | 2 | 3 | 74 |
| codex-rehearsal | 5.77 | 6 | 0 | 0 | 0 | 1 | 14 |

The verification script initially treated every skipped record as a failure. Review confirmed all eight skipped-record counts exactly match the [fresh-snapshot rehearsal](2026-10-03-rc13-migration.md); these include records deliberately excluded by migration retention rules. Totals also match: 11 pending messages, six scopes, zero claims and eight unresolved entries. No message bodies were inspected. Archived source names remain available under the upgrade guide's retention policy; unresolved owners reclaim their state by rejoining from their original clones.

The temporary production login was logged out, confirmed invalid through `/auth/me` (401), and its local credential/device files removed. Final production health passed. The post-cutover identity and live-session visibility check remains in the roadmap and requires fresh host sessions after plugin installation.
