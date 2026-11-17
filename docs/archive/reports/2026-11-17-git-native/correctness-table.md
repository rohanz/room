C = conflict; — = no conflict. Main shows both evaluator directions, all **run** against `2152836e`. “No conflict” includes absent slots; raw JSON retains slots and notice counts. This is collision evidence, not a claim that notice handoff/ownership was validated.

| Scenario (archived case mapping) | Expected | HEAD parent | Event graph | Main, both directions |
|---|---|---|---|---|
| 1. tracked: D edits, siblings untouched<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 2. tracked: keep D, sibling untouched<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 3. tracked: keep U unrelated output too<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 4. tracked: D edits again after keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 5. tracked: lead commits kept output<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 6. tracked: both edit before keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 7. tracked: both edit after D keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 8. tracked: two keeps, D third round/U edit<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 9. tracked: disjoint edits<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 10. tracked: disjoint edits after keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 11. untracked: D edits, siblings untouched<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 12. untracked: keep D, sibling untouched<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 13. untracked: keep U unrelated output too<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 14. untracked: D edits again after keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 15. untracked: lead commits kept output<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 16. untracked: both edit before keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 17. untracked: both edit after D keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 18. untracked: two keeps, D third round/U edit<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 19. untracked: disjoint edits<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 20. untracked: disjoint edits after keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 21. lead reverts delivered text; D changes again<br><small>stale-carried-conflict:revert</small> | C | C | C | C / C |
| 22. lead reverts; unchanged D versus U edit<br><small>unchanged-kept:republish then lead reverts</small> | C | C | C | C / C |
| 23. kept worker commits later edit<br><small>own-baseline:committed post-keep edits</small> | C | C | C | C / C |
| 24. both adopt C by fast-forward, D reverts<br><small>rev32/rev33:common adoption</small> | C | C | C | C / C |
| 25. both adopt C by merge, D reverts<br><small>rev32/rev33:common adoption</small> | C | C | C | C / C |
| 26. only D adopts C<br><small>rev33:only adopter</small> | — | — | — | C / C |
| 27. only U adopts C<br><small>rev33:only adopter</small> | C | C | C | C / C |
| 28. D resets away C after both adopt<br><small>rev33:reset</small> | C | C | C | C / C |
| 29. both adopt C, committed revert<br><small>rev33:committed revert</small> | C | C | C | C / C |
| 30. both adopt merge resolution C<br><small>rev33:merge resolution</small> | C | C | C | C / C |
| 31. committed tracked deletion<br><small>rev22:committed deletion</small> | C | C | C | C / C |
| 32. committed rename versus sibling edit<br><small>roadmap:F5 rename</small> | C | C | C | C / C |
| 33. untracked draft committed then deleted<br><small>own-baseline:F5 untracked deletion</small> | C | — | C | — / — |
| 34. scratch add/add remains after keep skipped it<br><small>unchanged-scratch:results.log</small> | C | C | C | C / C |
| 35. refresh accepted with disjoint worker edit<br><small>stale-carried-conflict:refresh</small> | — | C | — | C / C |
| 36. refresh conflicting, unchanged on refusal<br><small>given-baseline:conflicting refresh</small> | C | C | C | C / C |
| 37. shared adoption revert without keep<br><small>rev29:cold</small> | C | C | C | C / C |
| 38. shared adoption revert, prior conflict existed<br><small>rev29:existing conflict</small> | C | C | C | C / C |
| 39. later worker same bytes after lead commits and reverts<br><small>rev33:late U</small> | — | C | — | — / — |
| 40. equal current blobs after distinct histories<br><small>given-adoption:equal blob</small> | — | — | — | — / — |
| 41. adopt common unrelated commit, untracked draft survives<br><small>rev22:untracked common ancestor</small> | — | C | — | — / — |
| 42. supplement: scratch skipped, lead later adds competing log<br><small>unchanged-scratch:results.log, extended to lead</small> | C | C | — **needs rule** | C / C |
| 43. supplement: kept D reverts to given G, U edits<br><small>stale-carried-conflict:kept worker uses revert</small> | — | C | — | C / C |
| 44. supplement: committed revert to O without adoption<br><small>given-adoption:committed revert without adoption</small> | C | — | C | — / — |
| 45. supplement: adopted addition deleted versus edit<br><small>given-adoption:adopted addition</small> | C | C | C | — / — |
| 46. supplement: actual later spawn after lead change/revert, only U adopts<br><small>rev33:U given X after lead change and revert</small> | C | C | C | C / C |
| 47. supplement: merge adoption after independent commits<br><small>given-adoption:merge adoption</small> | C | C | C | C / C |
| 48. supplement: carried staged addition, committed deletion<br><small>own-baseline:committed deletion of carried staged addition</small> | C | — | C | — / — |
| 49. adopted 1000 files both delete, conflict survives<br><small>rev33:candidate cap</small> | C | C | C | C / C |
| 50. supplement: common unrelated adoption after keep<br><small>given-adoption:unrelated adoption</small> | C | C | C | C / C |
| 51. supplement: successful refresh after keep, then both edit<br><small>stale-carried-conflict:successful refresh (extended)</small> | C | C | C | C / C |
