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

The initial user-allowlist implementation was replaced before publication by operator-managed registration. Neither approach was deployed during design discussion. Production and installation results are recorded after release verification.
