# Second codebase rehearsal: httpx at `declared` sharing (plan)

Goal: run the trial rehearsal on a second codebase, with every agent at the `declared` sharing level
(only files in its declared area are shared), to check that Room's results are not Werkzeug-specific
and to exercise `declared` with real agents.

## Repository and cards

httpx (https://github.com/encode/httpx) at `15d09a3bbc20372cd87e48f17f7c9381c8220a0f` (2023-04-19),
published as a single snapshot commit in a private repo, so upstream history cannot give answers away.
Three PRs upstream merged within three weeks; each applies cleanly on its own (`git apply --check
--3way`), and stacking all three in either order reproduces upstream's `httpx/_urlparse.py` and
`tests/test_urlparse.py` exactly (the answer key). Each PR's tests fail at the base (1, 4 and 2).

| Card | Upstream | Task | Size |
|---|---|---|---|
| A | #2671 | Percent-encoding of already escaped values (`foo%2Fa` -> `foo%252Fa`; safe values unchanged) | `_urlparse.py` +22 -6, tests +18 |
| B | #2675 | Include the offending value in InvalidURL messages (`Invalid port: 'abc'`) | +4 -4, tests +4 -4 |
| C | #2701 | Which characters are escaped in path, query and fragment (gen-delims) | +10 -3, tests +30 |

Collisions: all three edit `httpx/_urlparse.py` (C at 256-261, B at 290-341, A at 402-420) and
`tests/test_urlparse.py`; A changes `quote()`'s behaviour, C changes the arguments passed to `quote()`,
and B's `encode_host` calls it: a contract change reaching other people's code in one file.

Check (Python 3.11, the 2023 pins): `uv run --isolated --python 3.11 --with-requirements
requirements.txt pytest -q -p no:cacheprovider tests/test_urlparse.py tests/models`: 237 passed at the
base, 243 with all three cards; under a second once cached.

Cards (as filed; they never name the upstream PRs):

- **A.** Query parameters are escaped wrongly when a value already contains `%`.
  `httpx.URL("http://webservice", params={"u": "with%20spaces"})` should stay `u=with%20spaces`, but a
  value that mixes a valid escape with characters that need quoting, such as
  `http://example.com?q=foo%2Fa`, must be fully escaped (`%` becomes `%25`, giving `...foo%252Fa`).
  Fix the percent-encoding helper in `httpx/_urlparse.py` and add tests.
- **B.** When a URL is rejected, `httpx.InvalidURL` does not say what was wrong with it. Include the
  offending value in the message for an invalid IPv4 address, IPv6 address, IDNA hostname and port (for
  example `Invalid port: 'abc'`). Update the existing tests.
- **C.** httpx percent-escapes characters in the path, query and fragment that do not need escaping there
  (for example `[`, `]` and `@` in a path, `:` `[` `]` `@` in a query, and `?` `#` in a fragment). Only the
  delimiters for that component (such as `?` and `#` in a path) should be escaped. Adjust how `urlparse()`
  quotes each component and add a test per component.

Every card ends: "Work from this repository only; do not look at upstream httpx, its pull requests or its
changelog."

## Risks

Card B is small (about 5 minutes) and may finish before any collision. Only one source file and one test
file collide, unlike Werkzeug's cross-file overlaps. Keep `--python 3.11`. `filterwarnings = error`.

## Before running

Fix the triage items that `declared` would hit, first of all "declared-sharing output is lost on restart"
(docs/triage-2026-09-26-roadmap.md, item 7).
