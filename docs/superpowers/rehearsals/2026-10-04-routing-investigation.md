# Extra native delegation investigation — 2026-10-04

The collection-checkpoint evaluation reported 59/60 plugin-enabled runs passing. Its failing `codex-half` run **did call `room_spawn` with `host: codex` and load the workers skill**. The failing grader detected an additional `Agent` or `Task` call somewhere in the complete trace. This does not establish that initial delegation selected the wrong tool or replaced the requested Room worker.

The original trace `/private/tmp/e-nAB4yJ/out/trace.jsonl` was removed by the evaluator's default cleanup. Its aggregate verdict remains in `/tmp/room-collection-checkpoint-evals/aggregate-result.json`. Without that trace, the extra call's purpose and position cannot be recovered from the verdict.

## Reproduction

Ran the unchanged case six times against unchanged plugin source at `ceac6839`, using Claude Code 2.1.289, no baseline arm, concurrency three, retained traces, and the existing pinned shop scaffold:

```sh
claude plugin eval . --case codex-half --runs 6 --ablation none \
  --scaffold --trust-plugin --allow-tools Edit Write --keep-temp \
  --no-publish --concurrency 3 \
  --output-dir /tmp/room-routing-investigation-before
```

**6/6 passed**, 191 seconds, $2.51. All six loaded the workers skill and spawned a Codex Room worker. Direct inspection of their retained tool calls found **zero native Agent/Task calls**. Four runs spawned one Room worker; two spawned two. These are routing-grader passes, not successful end-to-end task completions or proof of a real-world success rate.

Retained traces: `/private/tmp/e-BwUxZ6`, `e-QHuwPq`, `e-ltOnQY`, `e-r2rqRi`, `e-a1oXGh`, and `e-vPw8vU`, each under `out/trace.jsonl`. Aggregate and HTML report: `/tmp/room-routing-investigation-before/`.

## Confirmed evaluation limitation

The shared static `room_spawn` mock acknowledges the supplied worker tag, but `room_wait` always returns a timeout. `room_state` always describes an unrelated finished worker, `ada+pricing-fix`, and another participant's existing tiers claim. It never lists the newly spawned worker. The evaluator also provides no shell tool for the lead's own tests. Retained transcripts explicitly notice missing workers, unrelated claims and missing test evidence, and stop or attempt recovery.

The case therefore exercises recovery from an inconsistent mocked workflow as well as initial routing. The blanket no-native-subagent grader checks the entire run; it does not distinguish a wrong initial route from an auxiliary or recovery delegation. That grader was not weakened.

## Conclusion

The original extra native call remains unreproduced and unexplained. Mock-induced recovery is a plausible contributing factor, **not a demonstrated cause of the original failure**. No product routing change was made on speculation, and the original 59/60 result remains recorded. Future failures need retained traces before changing instructions. A follow-up evaluation should separately measure dispatch-only routing and workflow recovery with coherent worker-state mocks, retaining the existing whole-run regression.
