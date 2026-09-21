# Audit: is Room invisible? (0.8.0, 2026-09-21)

The standard: Room exists only to make agents work well together, and should be effectively
invisible. The human should almost never notice it; the agent should spend almost nothing on it
when there is nothing to coordinate; it speaks only when that changes what someone does, once,
plainly, to the right party.

Two independent auditors with the same brief: Codex on gpt-6-astra at low effort (static: every
string a human or agent is shown, with file and line) and Claude Fable (the same, plus four real
headless sessions in scratch clones, measured). Neither saw the other's report.

## Fix status — 0.9.0

The observations below describe 0.8.0 and are retained as evidence. The release changes are
tracked in [the changelog](../CHANGELOG.md#090); a fixed item is not a claim that every delivery
path or the whole experience is solved.

| Finding | Status after this batch |
|---|---|
| Consent/truth 1–2: missing first-join disclosure; invalid share setting | Fixed: one destination-specific disclosure, including auto-joins; unknown levels share plans only. |
| Consent/truth 3: absolute no-disk-write promise | Fixed: guides distinguish live sharing, private metadata, requested collection and export. |
| Consent/truth 4: unsolicited collection commits | Fixed: default collection is uncommitted and unstaged; committing requires an explicit request. |
| Consent/truth 5: retained worker artifacts | Fixed for full successful collection; failed/partial work and dirty dismissed worktrees are deliberately retained. |
| Consent/truth 6: obsolete onboarding and ignore chores | Fixed: current collection guidance and automatic Git-private exclusion. |
| Agent cost: always-loaded catalog and contradictory solo rules | Reduced: 20 tools, 9,023 description/schema characters under a 9,500 regression budget; coordination rules apply with company. Conditional catalog loading is not added. |
| Agent cost: per-edit scope/read/claim/release/changed ceremony | Fixed: scope once, claim only on overlap, no routine release/changed calls. |
| Agent cost: duplicated replies and wait/state round trips | Fixed: wait-ending messages are consumed once and routine waiting needs no compulsory state call. |
| Agent cost: conflict notes cannot wake idle recipients | Fixed: actionable conflicts use the addressed conflict kind; feed-only kinds do not wake. |
| Human experience: mandatory timeout/commit/browser relays and privacy tool tour | Fixed: ordinary relays removed; state begins with the sharing boundary and links are requested explicitly. |
| Agent cost: host default and terminal worker instructions | Fixed: caller’s host by default; one-line terminal completion; no promise of replies after exit. |
| Human experience: buried installation and repeated flag explanation | Fixed: first-screen setup and one canonical explanation. |
| Human experience: invisible coordination failures | Improved: missing-hook, unwakeable-participant, skipped-file and startup-failure notices; this is detection, not a guarantee of delivery. |
| Human experience: terminology and marketplace jargon | Fixed in current guides, skills and manifest descriptions; historical audit quotes are preserved. |
| Human experience: branch isolation and stale session instructions | Documented: same branch is still required, and updates require a new session. Branch isolation is not fixed here. |

## Verdict (0.8.0)

Solo, Room is close to invisible, and that is measured: an ordinary coding task under Claude Code
and under Codex made 0 room calls, loaded no Room skill, said nothing about Room, and left no
process behind. Fable's estimate: agent solo about 90% there, human solo about 80% (a dot-file, a
scary flag, hook trust), any worker or team use about 50%. Room stops being invisible the moment
it is used.

## Confirmed consent and truth problems (fix before anyone else uses it)

1. **The first person into a team room is never told their work is visible.** The compact
   "alone here" join reply (0.7.0) returns before the line "uncommitted work in this clone is now
   visible to the repo's room members" (`tools/join.ts`). The first joiner is always alone.
2. **A typo in the sharing level widens to full text.** `config.ts`:
   `rawShare === 'intent' || rawShare === 'declared' ? rawShare : 'full'` runs before the parser
   that would reject it. An unknown privacy setting must never resolve to the least private one.
3. **"Room never touches your disk" is false.** The MCP instructions and the join skill say so;
   `room_collect` stages, commits as the lead and merges; `room_export` writes files; a solo
   session with zero room calls leaves `.room.json` in the repo root and seven files in `.git`.
4. **`room_collect` commits and merges without being asked, and the rules disagree.** Etiquette
   rule 13: "Never commit or push unless they say yes". Workers skill step 6: "call
   room_collect(tag): it commits … and merges". Measured: a request to split two docstrings left
   three commits the human never asked for, with 300-character subjects ending "Not committed."
5. **Nothing cleans up after workers.** After both workers were collected: two `room/<tag>`
   branches, two worktrees, four logs, 20 MB under `.room/` (each worktree built its own venv).
   Retirement removes room records only, never the worktree or branch.
6. **Onboarding contradicts the product**: "Room tools do not merge branches themselves" next to a
   step saying the lead commits and merges. It also tells the human to add `.room/` to
   `.gitignore`, and the spawn reply repeats that tip even when `.room/` is already excluded.

## What the agent pays

- Always in context: about 1,100 characters of instructions, about 800 of skill descriptions, and
  24 tools totalling 17,000 to 18,500 characters of names, descriptions and schemas. Claude Code
  defers tool schemas until first use; a host that loads them eagerly pays all of it, every
  session, with nobody to coordinate with. `room_spawn` alone is 2,368 characters; seven
  account and lifecycle tools used about once ever are 5,255.
- With company the prescribed sequence is scope, read, claim, release, send-changed per edited
  region: five calls, eight for a single-file task with preview and done. `scope`, `release` and
  `changed` are feed-only, so no agent reads them; `changed` is also derived from the diff.
- Instructions rule 1 says "while alone, work normally"; rules 3 to 5 then say "before editing,
  call room_scope, then room_read and room_claim" with no condition.
- For trivial parallel work Room dominates: 8 of 11 lead tool calls, 5,557 characters of replies
  (about half duplicated), for two one-line docstrings. The skill says not to spawn for a few
  lines; the always-loaded instruction "when asked to parallelise … use room_spawn" wins.
- Replies say things twice: the done message that ends a wait appears in the inbox block and again
  as the wait result; each spawn reply repeats three boilerplate lines; "NOT previewed" lists
  `.venv/`, `__pycache__/` and Room's own files; "call room_state before continuing" follows every
  wait.
- Kinds that are not worth an inbox (`scope`, `release`, `changed`, `claim`) still declare
  `wakes: 'always'`. A real merge conflict, by contrast, is posted as a note and cannot wake an
  idle agent.
- `room_spawn` defaults the host to Claude even when called from Codex; the skill spends a
  paragraph correcting it. Workers are told to "stay in the room for questions" though a finished
  worker cannot answer, and to give a "one-paragraph summary" to a field documented as one line.

## What the human sees

- The README is 27,800 characters; the install command is on line 44, after Status and a
  hackathon narrative. The channels flag is explained in six places.
- Mandated relays leak vocabulary: "Tell your human" on a timeout where the agent can carry on;
  "ask whether to commit and push"; "the browser link". In the measured run the human read
  "workers", "commits", "merge commit". Exactly one relay is warranted: the sharing consent.
- `room_state` prints a 190-character link with an access key on every call.
- Asking "what is this room thing, is anything leaving my machine?" got a correct answer that
  cost 8 tool calls and 2,000 characters, because no text the agent holds answers it.
- Failures are silent: auto-join failure and "not logged in" are log lines; untrusted Codex hooks
  are skipped with nothing detecting it; a question to a session that cannot be woken waits with
  the asker never told; files skipped for size or budget are not visible to the agent.
- The marketplace description is jargon ("declare intent, claim lines").
- Same thing, several names: team / web / shared room / hosted server; human / user; lead /
  "rohanz's agent"; the priority printed twice per line.
- Rooms are per branch, and the README does not say so next to its promise. In a team where each
  person works on their own branch, everyone is alone and Room does nothing.
- A long-lived session keeps the instructions of the plugin version it started with.

## Already invisible in 0.8.0, must not regress

Solo hooks inject nothing; solo sessions make no room calls and say nothing about Room (Claude
and Codex); no nag without the launcher when alone; no orphan processes; `.room.json` is
self-excluded so `git status` stays clean; local by default held in every path run; the alone join
reply is three lines; skills load on demand; offline states are honest; expired logins recover by
device code; questions to finished workers answer at once; dead workers report with their log tail.
