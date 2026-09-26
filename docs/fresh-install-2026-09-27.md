# Fresh-install simulation, 2026-09-27

What a trial friend goes through, run on this machine with clean host configuration directories
(`CLAUDE_CONFIG_DIR` and `CODEX_HOME` pointing at empty folders) so nothing already installed helps.
Claude Code 2.1.283, codex-cli 0.157.1, Node 22.14, git 2.45.

## Steps and results

1. **Install from GitHub with the README's two commands.**
   - Claude Code: `claude plugin marketplace add rohanz/room && claude plugin install room@room`
     took 8.5 s and installed 0.16.18.
   - Codex: `codex plugin marketplace add rohanz/room && codex plugin add room@room` took 2 s and
     installed 0.16.18.
   - Neither needed a login.
2. **Start the bundled MCP server as the host would.**
   - The server was started in a new git repository with one commit, `node <plugin>/server/room-mcp.mjs`
     with `ROOM_HOST=claude`, over stdio.
   - `initialize` answered in 126 ms as `room 0.16.18`; `tools/list` returned 20 tools.
   - `room_state` joined `local/repo/main` in under a second. It said "nothing leaves this machine" and
     named the person from `git config user.name`.
3. **Stopped here:** starting `claude` or `codex` in the clean profile requires signing in, which this
   simulation cannot do. Trusting Room's hooks happens in that interactive first run, so it was not
   exercised here.

## Findings

- **Fixed in this pass:** the README said Node.js 24 LTS was required. `package.json` requires Node 22
  or later, CI runs 22, and this machine runs 22.14. The README now says "Node.js 22 or later", so a
  friend on 22 isn't turned away.
- **Not a bug:** the MCP server takes its directory from `ROOM_DIR`, then `PWD`, then the process
  directory, because Codex starts MCP servers elsewhere and passes the user's directory in `PWD`. A test
  harness that sets a working directory but inherits another `PWD` joins the wrong room. Real hosts set
  both consistently.
- **For the friend checklist:** Codex asks to trust Room's hooks on the first interactive run, and a
  declined prompt silently disables them. Claude Code does not trust-gate plugin hooks (verified on
  2.1.281). The checklist in docs/trial-plan.md now says to accept the Codex prompt.
