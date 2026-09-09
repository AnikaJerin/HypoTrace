# HypoTrace Feature Test Lab

These are repeatable tests for the live learning loop. Run them as VS Code tasks from **Terminal → Run Task**. Each failure is a distinct observed attempt; after the second failure in the same category, HypoTrace silently creates or strengthens that category's signature. The forecast appears on the next related coding opportunity, before a third attempt fails. After two clean successful tasks, that category is marked `improving` and its warnings are suppressed.

| Level | Run twice to learn | Run next to forecast | Expected sector |
| --- | --- | --- | --- |
| Easy | HypoTrace Easy Syntax 1 and 2 | HypoTrace Easy Syntax Forecast | Syntax and language fundamentals |
| Medium | HypoTrace Medium Boundary 1 and 2 | HypoTrace Medium Boundary Forecast | Arrays, strings, and pointer boundaries |
| Advanced | HypoTrace Advanced Algorithm 1 and 2 | HypoTrace Advanced Algorithm Forecast | Algorithm invariants and dynamic-programming state |

Run either matching `Clean` task twice to verify alert suppression and the `improving` trend. Use the dashboard to inspect all signatures separately; do not reset the profile between attempts.
