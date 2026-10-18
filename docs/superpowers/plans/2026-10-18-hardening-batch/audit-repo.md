# Room repo hygiene audit (read-only), 2026-10-18

Repo: /Users/rohan/Documents/progwork/aitinkerhackathon, branch brief-slices at 110f918a. Nothing modified.
Raw knip output in this directory: knip.txt (CI config, clean), knip-strict.txt (cycles), knip-production-src.txt
(production-only pass with src entries via knip-production2.json).

## Headline numbers
- Tracked content 48 MB; 32.6 MB is plugins/room/server (29 MB tree-sitter wasm + 2.6 MB room-mcp.mjs bundle).
- .git is 821 MB: 683 MB .git/room-preview worktrees, ~115 MB objects (54 MB packed, 61 MB loose).
- .room/ 773 MB (767 MB in .room/workers, 72 entries). 17 preview worktrees, 29 registered worktrees.
- npx knip (CI config): clean. Production-only pass: 7 test-only exports, 3 test-only deps, 2 unlisted tsx binaries.
- docs/superpowers + host-snapshots: 167 files, 114 unlinked from any current doc. specs/reviews (56 files, 1 MB)
  linked only from historical plan briefs.

## A. Safe to delete / move now
- .gcloudignore: last touched 2026-09-12; zero gcloud/Cloud Run refs anywhere. delete.
- docs/img/{room-hosted,room-live,room-network-kieran,room-run3-merged,room-v2}.png (~1 MB): unreferenced; only room-v2-redesign.png is used by README. delete or move to docs/archive/img.
- packages/web/screenshot.png: unreferenced, 2026-09-10. delete.
- packages/web/DARK-CONTRAST.md: one-off WCAG audit 2026-09-15, unreferenced. archive or delete.
- .git/room-preview/6c26dd049e09e68bfd42, e0bcfd9227c3354006e7: 4 KB empty shells, not registered worktrees. delete.
- Test-only exports (definition is the only src occurrence): isForeignIdentity (server/src/readonly.ts:183),
  readSessionRuntime/writeSessionRuntime/SessionRuntime (room-mcp/src/session.ts:132-164), activityFromEvent
  (worker-activity.ts:116), prIdentity (prs.ts:31), createWriteIntentReader (hooks-bridge.ts:21),
  classifyThreeWay (web/src/merged.ts:125). delete with their tests or move into test helpers.
- discoverLegacyWorktrees (worker-registry.ts:336): only used in-file at :1275; drop the export.
- docs/handoff-*.md: untracked and gitignored (.gitignore:22); nothing to prune in git.

## B. Mechanical cleanups
- yjs in packages/hub-core deps, y-protocols in packages/roomd and packages/server deps: imported only by tests -> devDependencies.
- tsx unlisted in packages/agent and packages/room-mcp scripts.
- closeRegistryForDir (worker-registry.ts:65): 0 src callers, 36 test files -> test helper.
- Duplicates: validParticipantName/assertValidParticipantName identical in server/src/names.ts:3-9 and shared/src/identity.ts:4-10;
  safeUrl + HttpFailure identical in relay/src/index.ts:41-45 and server/src/http.ts:5,87-90; incarnationFile in relay/src/hub.ts:45
  and server/src/hub.ts:56; roomd/src/local.ts:25 ensureLocalRelay is a one-line wrapper of @room/relay.
- knip.json has only test entries, no src/index.ts! production entries, so CI cannot see production-dead code behind tests.
- .agents/plugins/marketplace.json (Codex) is unversioned; .claude-plugin/marketplace.json carries 0.17.16. Keep both, note the gap.

## C. Docs to archive
- docs/trial-plan.md (2026-09-28 substantive), docs/rehearsal-httpx-plan.md (2026-09-26), docs/submission.md (2026-09-21):
  already listed as historical in docs/archive/README.md but live beside current guides. Move into docs/archive/; AGENTS.md:16,62 reference submission.md.
- docs/superpowers/specs/reviews/ (56 files): linked only from plans/*/common.md, review.md, fix1.md, fix2.md. Move to docs/archive/reviews/.
- docs/superpowers/plans/2026-09-29-port-briefs/ (31) and 2026-09-30-release-briefs/ (12): linked only from specs/2026-09-29-port-0.16.35-40.md. Move to docs/archive/briefs/.
- docs/superpowers/rehearsals/ (50): 24 linked from CHANGELOG/README/roadmap/decisions/upgrading. Keep in place.
- docs/superpowers/specs/*.md (14): 5 linked, 9 not. Keep (AGENTS names it as the spec home).
- docs/host-snapshots/, docs/archive/reports/, docs/archive/submission/: keep.

## D. Needs a decision
1. Committed room-mcp.mjs bundle: 276 commits, 552 MB raw history (54 MB packed). Required by CI asset check and GitHub installs. Keep.
2. grammars/*.wasm (29 MB): all 16 byte-identical to node_modules/tree-sitter-wasms; 15 languages shipped = 15 languages supported. Keep unless install size matters (cpp/kotlin/c_sharp/swift = 16 MB).
3. logo.png 544 KB + favicon-512 144 KB duplicated in packages/web/public and plugins/room/web; viewer.html is 833 KB. Recompress at source.
4. plugins/room/bin/claude-room + channel.ts (9 lines) + ROOM_WAKE=channels: documented in AGENTS.md:113, docs/reference.md:67, room-join SKILL.md:66. Claude Code 2.1.224 shipped 2026-08-07. Remove next minor.
5. 0.16->0.17 migration code: 60+ legacy paths in room-mcp (local-migration.ts, policy-store.ts, worker-registry.ts, session.ts, config.ts, codex-turn.ts), relay/src/local-migrate.ts, scripts/room-inventory.mts. No TODO/FIXME/XXX anywhere in src. Pick a sunset version.
6. packages/agent (roomagent, 659 lines, @openai/codex-sdk): hackathon-era driver; referenced by AGENTS, scripts/say.mts, roadmap.md:45. Retire with say.mts or do the roadmap item.
7. scripts/{measure-room-perf,wake-e2e,load-repro,doc-history,soak,measure-idle-rss}.mts: cited only by dated reports; not in package.json/CI. Keep, optionally group under scripts/bench/.
8. evals/solo/{question,rename,research-subagent}: referenced by no doc, script or test. Delete if plugin eval runs routing only.
9. .room/workers 767 MB (oom-repro-lead 203 MB, memory-hardening-lead 112 MB, midturn-lead 61 MB, coupled-benchmark-lead 56 MB, dad-files-opus 46 MB) and 17 locked preview worktrees 683 MB. Collect through Room, then preview-cache cleanup.
10. Uncommitted edits: docs/host-snapshots/2026-10-16-delivery-audit.md (+21), skills/room-etiquette (+5/-2), skills/room-workers (+10/-3).

## E. Verified live (keep)
build-plugin/build-server/bump-version/eval-mocks/room-inventory/demo.sh/say.mts; room-doctor; all 3 hook scripts; codex-mcp.json;
deploy/*, Dockerfile, .dockerignore, .env.example; examples/demo-repo; root vitest/tsconfig/knip/.gitattributes/CODEOWNERS;
packages/web and hub-core are real packages. 12 knip cycles are informational.
