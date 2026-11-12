# Upgrading Room

Upgrade the server and installed plugins together, then restart sessions to load the updated tools. Sessions, servers and relays still select a shared contract before syncing (see [the reference](reference.md)); interoperability with older Room releases is no longer maintained.

## Room 0.16 upgrade path retired

**v0.17.47 is the last release that can migrate Room 0.16 state.** To migrate an old server or clone, install v0.17.47 first and use [that release's upgrade guide](https://github.com/rohanz/room/blob/v0.17.47/docs/upgrading.md). Preserve the original state and backups until migration is complete, then update to the current release.

Current servers refuse 0.16 peers, unmigrated server registries and unregistered existing documents without reading legacy document values. Completed schema-2 migrations, their archives and imported workers remain supported.

Locally, Room 0.17 ignores 0.16 session records, relay discovery, snapshots and worker carry sources: it never opens, imports, renames or deletes them, and they do not block a join. An old remembered per-branch local room is ignored so the clone joins its default repository room; the choice file is not rewritten. Explicit schema-2 choices and custom room names still work. Old import journals, including incomplete ones, stay untouched and do not block existing schema-2 worker records; completion evidence keeps its current retention.

Root `.room.json` and old retained-declared grant files are also ignored. Room no longer lists 0.16 leftovers in diagnostics or reclaims unresolved placeholder identities. Existing unresolved entries and aliases remain readable as migrated history. Active `room.json` bookkeeping updates its room, name and directory on a normal join; obsolete legacy identity hints are dropped.
