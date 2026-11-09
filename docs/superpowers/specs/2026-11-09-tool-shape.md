# Tool shape pass: fewer parameters, one job per tool

Status: proposal 2026-11-09, for Rohan's decision before implementation. Follows the
0.17.46 local-state collector and the channels retirement; precedes the benchmark rerun,
so the benchmark measures the tool we mean to ship.

## What is wrong today

Twenty-one tools, 9.3 KB of descriptions against a 9.5 KB budget. The core loop (join,
scope, claim, send, done, spawn, collect, preview) is sound. Three tools carry parameters
that belong to a different job, and the host model pays for every one of them on every turn:

| Tool | Params | The ones that do not belong |
|---|---:|---|
| `room_claim` | 6 | `plans` (public-API change declarations, a task-level fact, not a lock) |
| `room_send` | 9 | `message` (alias of `text`); `symbols` (Room detects changed definitions itself, per the etiquette skill); `refresh` (rebase of a stopped worker) |
| `room_collect` | 9 | `checkpoint`, `reason`, `reviewToken` (a review hold, refused unless called with no collection arguments: a second tool living inside the first) |

Agents in the benchmark logs call `room_claim` where `room_scope` was due and vice versa,
and `room_collect`'s description reads as an internal contract ("checkpoint gates collection").

## Changes

1. **`room_scope(area, summary, paths, plans?)`**: the once-per-task declaration gains `plans`.
   A public-API change is a plan for the task, announced to the files that use the symbol;
   it is not a property of one lock. `room_claim(path, symbol | from/to, intent)` becomes
   purely "reserve this region near someone else". Description: scope = "what I am doing
   and where, once"; claim = "reserve a region another participant is near".
2. **`room_send(type, to, text, paths?, inReplyTo?, priority?, refresh?)`**: drop the `message`
   alias (accept it silently for one release, then remove) and `symbols`. `refresh` stays:
   resuming a stopped worker is the only moment a rebase is safe, and that moment is a
   message to it. Description keeps the three trigger phrases.
3. **`room_review(action: hold | release | status, reason?, reviewToken?)`**: the collection
   review checkpoint becomes its own tool. `room_collect(tag, mode, discard, keep, paths,
   force)` keeps exactly the collection job; its description becomes "bring in their work,
   discard it, or keep it for resumption". Net one more tool, net fewer parameters, and
   the hold's own refusals ("reason is only for hold") disappear because the schema says it.
4. **Unchanged, noted for later**: `room_wait` (hosts lack a Room-aware block), `room_impact`
   (could be a `room_state` view), `room_open` (an action, stays separate from the link).

Tool count 22, estimated description size within the 9.5 KB budget (collect shrinks by
about as much as review adds). Budget test unchanged.

## Compatibility

Old plugins send `room_claim(plans)`, `room_send(message | symbols)`, `room_collect(checkpoint)`
only from old skill text; the MCP server and the skills ship together, so there is no
mixed-version caller. Accept the retired fields for one release with a one-line "moved to
…" note in the reply, remove in the next. The hub protocol and the room document are
untouched; `plans` are stored exactly as today.

## Validation

- Schema tests per tool; `tool-budget.test.ts`; `release-readiness` wording tests.
- `npm run eval:mocks` and the `claude plugin eval` suite, since descriptions route behaviour.
- Then the benchmark rerun (BullMQ, frozen spec, two matched trials) on the result.
