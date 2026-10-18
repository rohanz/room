# Room development archive

These records explain what was tried, why decisions were made, and what validation actually established. They describe their dated versions and environments. They are not current setup instructions, unresolved-issue lists or guarantees of current behavior. Start with the [current guides](../README.md) for those purposes.

Historical reports may name temporary checkouts or private local evidence that is no longer available. Those paths are provenance, not public downloads. Source links point to the current checkout unless a commit is explicitly pinned; reported line numbers belong to the original audit.

## Design and validation collections

The existing collections retain their paths so development references remain stable:

- [Design specifications](../superpowers/specs/) - original proposals; consult current reference documentation before relying on behavior.
- [Implementation plans](../superpowers/plans/) - historical task lists, including superseded approaches.
- [Rehearsals and release validation](../superpowers/rehearsals/) - bounded experiments, failures, recovery checks and release evidence.
- [Host documentation snapshots](../host-snapshots/) - dated source material for host integration decisions.
- [Decisions log](../decisions.md) - append-only decisions in chronological order.
- [Prior-art research](../prior-art.md), [trial plan](trial-plan.md) and [httpx rehearsal plan](rehearsal-httpx-plan.md) - historical research and evaluation setup.

## Audits, host surveys and early rehearsals

- [audit-2026-09-21-invisibility-astra](reports/audit-2026-09-21-invisibility-astra.md)
- [audit-2026-09-21-invisibility](reports/audit-2026-09-21-invisibility.md)
- [audit-2026-09-21-qube](reports/audit-2026-09-21-qube.md)
- [audit-2026-09-21-review](reports/audit-2026-09-21-review.md)
- [audit-2026-09-22-readiness](reports/audit-2026-09-22-readiness.md)
- [audit-2026-09-23-carry-astra](reports/audit-2026-09-23-carry-astra.md)
- [audit-2026-09-23-carry-opus](reports/audit-2026-09-23-carry-opus.md)
- [audit-2026-09-24-cleanliness](reports/audit-2026-09-24-cleanliness.md)
- [audit-2026-09-25-astra](reports/audit-2026-09-25-astra.md)
- [audit-2026-09-25-website-logs](reports/audit-2026-09-25-website-logs.md)
- [audit-2026-09-26-0.16.12](reports/audit-2026-09-26-0.16.12.md)
- [audit-2026-09-26-cleanliness](reports/audit-2026-09-26-cleanliness.md)
- [audit-2026-09-27-design-astra](reports/audit-2026-09-27-design-astra.md)
- [audit-2026-09-27-design-fable](reports/audit-2026-09-27-design-fable.md)
- [audit-2026-09-27-design](reports/audit-2026-09-27-design.md)
- [fresh-install-2026-09-27](reports/fresh-install-2026-09-27.md)
- [host-survey-2026-09-24-claude-code](reports/host-survey-2026-09-24-claude-code.md)
- [host-survey-2026-09-24-codex](reports/host-survey-2026-09-24-codex.md)
- [host-survey-2026-09-24-cursor-pi](reports/host-survey-2026-09-24-cursor-pi.md)
- [host-survey-2026-09-24-gemini-opencode](reports/host-survey-2026-09-24-gemini-opencode.md)
- [host-survey-2026-09-24-landscape](reports/host-survey-2026-09-24-landscape.md)
- [rehearsal-2026-09-25](reports/rehearsal-2026-09-25.md)
- [rehearsal-2026-09-26-httpx](reports/rehearsal-2026-09-26-httpx.md)
- [rehearsal-2026-09-27-click](reports/rehearsal-2026-09-27-click.md)
- [rehearsal-2026-09-28-codex](reports/rehearsal-2026-09-28-codex.md)
- [rehearsal-2026-09-28-flask](reports/rehearsal-2026-09-28-flask.md)
- [rehearsal-2026-09-29-flask](reports/rehearsal-2026-09-29-flask.md)
- [rehearsal-2026-09-29-httpx](reports/rehearsal-2026-09-29-httpx.md)
- [rehearsal-2026-09-29-werkzeug](reports/rehearsal-2026-09-29-werkzeug.md)
- [rehearsal-2026-09-29b-flask](reports/rehearsal-2026-09-29b-flask.md)
- [rehearsal-2026-09-29b-httpx](reports/rehearsal-2026-09-29b-httpx.md)
- [rehearsal-2026-09-29b-werkzeug](reports/rehearsal-2026-09-29b-werkzeug.md)
- [triage-2026-09-26-roadmap](reports/triage-2026-09-26-roadmap.md)

## Hackathon submission

- [Original brief](../../RULES.md) and [submission checklist and demo draft](submission.md).
- [Submission answers (Markdown)](submission/submission-answers.md).
- [Submission answers (Word)](submission/submission-answers.docx), retained as a historical artifact alongside the text version.

## Operator-specific material

The [Fly operations runbook](../../deploy/DEPLOYING.md) records the maintainer's deployment and cutover procedures. To host your own team room, use [self-hosting](../../deploy/self-hosting.md).

- [Roadmap history](roadmap-history.md) — resolved 0.16.x issues and earlier findings.
