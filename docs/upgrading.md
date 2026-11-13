# Upgrading Room

Upgrade the server and installed plugins together, then restart sessions to load the updated tools. Sessions, servers and relays still select a shared contract before syncing (see [the reference](reference.md)); interoperability with older Room releases is no longer maintained.

On the next local join or daemon recovery, a newer numbered client gracefully stops an older daemon using its authenticated instance nonce, then starts its own release under the existing authority lock. The stop saves state and changes generation when its snapshot would not shed content; attached sessions recover as for planned compaction. Same-release and older clients reuse the daemon, so mixed installed versions do not make it flap. A release that is `development` or not of the form `x.y.z` has no version order, so the daemon is reused. Room attempts one hand-over per join and then looks again: if the stop was refused and the daemon still serves, Room keeps using it and logs one diagnostic line; it never kills the process. Older daemons that refuse a stop with active writers require those clients to leave before a retry. `room_state(check=true)` shows the authenticated daemon release on its existing `local daemon:` line (`unknown` if health is unavailable).

## Room 0.16 upgrade path retired

**v0.17.47 is the last release that can migrate Room 0.16 state.** To migrate an old server or clone, install v0.17.47 first and use [that release's upgrade guide](https://github.com/rohanz/room/blob/v0.17.47/docs/upgrading.md). Preserve the original state and backups until migration is complete, then update to the current release.

Current servers refuse 0.16 peers, unmigrated server registries and unregistered existing documents without reading legacy document values. Completed schema-2 migrations, their archives and imported workers remain supported.

Locally, Room 0.17 ignores 0.16 session records, relay discovery, snapshots and worker carry sources: it never opens, imports, renames or deletes them, and they do not block a join. An old remembered per-branch local room is ignored so the clone joins its default repository room; the choice file is not rewritten. Explicit schema-2 choices and custom room names still work. Old import journals, including incomplete ones, stay untouched and do not block existing schema-2 worker records; completion evidence keeps its current retention.

Root `.room.json` and old retained-declared grant files are also ignored. Room no longer lists 0.16 leftovers in diagnostics or reclaims unresolved placeholder identities. Existing unresolved entries and aliases remain readable as migrated history. Active `room.json` bookkeeping updates its room, name and directory on a normal join; obsolete legacy identity hints are dropped.
