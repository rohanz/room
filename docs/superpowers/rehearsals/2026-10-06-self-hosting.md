# Room 0.17.7: self-hosted teams and operator-approved repositories

## Behavior

Local rooms remain the default. Team joins and creation need an explicit or configured server URL; Room no longer supplies a public hosting destination. Previously saved URLs remain valid. Legacy destination-free aliases start locally so the plugin stays usable; explicit team requests ask for a URL without a network request. Login and creation recovery preserve that URL.

Operators can enable `ROOM_MANAGED_REPOS=true` and set `ROOM_ADMINS`. Only those identities may open or close repository rooms, and normal repository admission still applies to them. Collaborators continue to join approved GitHub repos through GitHub push access. Existing registered rooms remain approved. Non-GitHub admission and bearer browser links keep their existing semantics. There is no new teammate list, replica routing or automatic machine provisioning.

The Fly configuration selects managed repositories with `rohanz` as operator. A pre-deployment authenticated registry check returned eight visible repositories, all registered by `rohanz`; no rooms were opened or closed during that check.

## Validation

- Client configuration, local-room, explicit destination, login and creation tests cover the removed fallback and legacy alias recovery. Requests without a team URL make no network calls.
- A real server-process test exercises operator creation and closure, collaborator login/view/WebSocket access, refusal of collaborator and shared-token registration, refusal of collaborator closure, restart persistence, empty-admin fail-closed behavior, and compatibility with unmanaged servers. The test login provider represents users with push access; GitHub's production permission check is unchanged and covered by the admission suite.
- Docker now builds both server and viewer. A clean source copy without host `node_modules` or built assets passed the Compose workflow, viewer and health checks, synthetic login, operator-only registration, collaborator access and persistence across container restart. Test containers and their synthetic volume were removed. This did not re-exercise real GitHub/OIDC provider setup or TLS provisioning.
- Typecheck, repository hygiene and the plugin/web build passed. Trusted `plugins/room/hooks.json` is unchanged.
- The first broad run overlapped implementation/version edits and is not final validation. A second broad run passed 3,542 tests and failed two fixtures that relied on the former destination/default or leaked a saved destination. Both fixtures were corrected without changing runtime behavior. All four affected client/server suites then passed 168 tests; the final URL-preserving creation guidance additionally passed all 26 open-confirm tests. Full release CI is required before production deployment.

The initial user-allowlist implementation was replaced before publication by operator-managed registration. Neither approach was deployed during design discussion.

## Release and production verification

- Release commit `772405103ec59ac4425bd855960d2e1ded4ae602`: [CI 37411387936](https://github.com/rohanz/room/actions/runs/37411387936) passed all 3,544 tests in 323 files, typecheck, repository hygiene, web and server-image builds, plugin build and committed-asset verification.
- Installed 0.17.7 in both Claude Code and Codex. Bundles, join skills, hook metadata and the unchanged trusted hooks file match the checkout byte for byte. Doctor verified Claude's plugin/hooks and local relay; its Codex inventory request timed out, then a direct retry confirmed 0.17.7 installed and enabled. Existing sessions still need restarting to load the new plugin.
- Pre-deploy snapshot `vs_RJj5nvle4vgsA3gXo5a0Qy` completed on 2026-10-06 at 04:04:49 UTC with the production machine stopped, retention five days. No Postgres configuration was present. Only machine `48e10e6c9de518` and its existing volume `vol_491xoz0935ggnwor` were used.
- Fly release **70** deployed from an archive of the exact CI-passed commit, excluding local untracked files. Image `deployment-01M47Q80CEJD7QYMR7229J7Q4X`, digest `sha256:e173b8ed1c9c7cb0db1aa804b6e3f47a64aeac5e6286b891691876d54a56ce51`. Machine configuration confirms `ROOM_ADMINS=rohanz` and `ROOM_MANAGED_REPOS=true`.
- Production health and GitHub device-login configuration returned 200. The existing Rohan session still lists eight visible repositories. Anonymous POST and DELETE requests with empty bodies receive the operator-only 403; no repository was opened or closed. Collaborator joins were covered by the real-process integration test, not a second real GitHub identity in production.
- The portfolio article and its architecture diagram explain explicit self-hosting, optional operator approval and GitHub push access separately. Multi-machine scaling remains deferred in the roadmap.
