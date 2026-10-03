# Remaining large-repository fixes before cutover

Rohan approved addressing N1–N5 from the 0.17.1 live rehearsal before production
cutover. The already-reviewed fixes are retained in rc13; this follow-up changes
only the remaining measured paths.

- Index provider module paths and prepare imports when graph facts change, so
  resolving a symbol does not normalize every provider for every import.
- Hand off a same-checkout filesystem watcher during host rebind and compacted
  replica replacement. Detach old callbacks before retiring its daemon; attach
  fresh callbacks and reconcile disk state after the replacement is ready. Keep
  identity leases, transports, document replicas and sharing policy fresh.
- Carry only immutable, already-parsed base facts into the replacement index.
  Reuse requires the same checkout and base commit and fresh checks for changed
  or excluded paths. Changed files and all sharing authority are re-evaluated.
- Give completion calls a bounded, cancellable opportunity to reconnect. Do not
  bypass name fences, revocation or closed-room checks.

Validation includes import-resolution equivalence and measured work reduction,
watcher event delivery and cleanup across replacement, changed/hidden graph paths,
and completion after reconnect, cancellation, timeout and terminal failure.
Run the full suite and rebuilt plugin checks before publishing another candidate.
Production deployment remains separately authorized.
