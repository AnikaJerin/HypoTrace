# HypoTrace clean test cases

Use a new VS Code profile or uninstall the previous HypoTrace extension first. Keep the backend local; no web hosting is required.

## 1 Fresh install and backend isolation

1. Install the newest VSIX.
2. Run `Developer: Reload Window`.
3. Run `HypoTrace: Show Learning Status`.

Expected: a local backend URL uses `127.0.0.1` and a newly assigned port. It must not use an old `8787` or `8792` server. The dashboard starts with no strengths, patterns or score claims.

## 2 Normal run capture

1. Open an unrelated Python project.
2. Run a file with `python3 file.py` in the integrated VS Code terminal.
3. Make it fail with one SyntaxError, AssertionError, or IndexError.
4. Open the Current project tab.

Expected: one completed failed run appears. Opening files, typing, or editor red underlines alone must not change this count.

## 3 Pattern gating

1. Run two separate files that produce the same error family.
2. Run a third unrelated error family once.
3. Open Forecast.

Expected: the repeated family is marked as collecting/repeating evidence. The one-off family is only watched. No generic syntax/boundary popup appears.

## 4 Prediction and Ghost Mode

1. Turn on Ghost Mode from the command palette.
2. Make a similar code decision in a non-private file and wait for the IDE analysis pause.
3. Run the file.

Expected: if the personal pattern and code decision match, a silent prediction is saved before the run. The later run resolves it as recurrence or avoided recurrence. Forecast confidence stays explicitly uncertain until enough evaluated predictions exist.

## 5 Full episode and A B reasoning

1. Work on one comparable problem for at least two minutes, including edits, navigation/debugging and at least two runs.
2. Repeat in a second comparable session.
3. Repeat a third time.

Expected: two full sessions create possible reasons; three may allow Agent B to mark a reason supported. A fast sequence of terminal test runs must not count as three full sessions.

## 6 Intervention comparison

1. When a small AI check appears, answer it.
2. Run normally again on the matching pattern.
3. Repeat this with more than one offered check over later comparable cases.

Expected: the answer itself is not treated as success. The next real matching run measures recovery or recurrence. The dashboard reports that the policy is collecting outcomes until there are enough comparisons.

## 7 Transfer retention and false mastery

1. Recover from a known pattern in Project A.
2. Later recover from the same pattern in Project B.
3. Later repeat the pattern soon after a recovery.

Expected: Project B can add transfer evidence; a later personally spaced recovery can add retention evidence; a quick recurrence can add false-mastery evidence. None of these are awarded merely for typing or opening a dashboard.

## 8 Privacy check

1. Create a `.env` file and open it.
2. Use a filename containing `secret` or `credential`.
3. Check the SQLite database with a database viewer.

Expected: raw source, terminal output, key material, paths and identifiers are not stored. Only semantic labels and aggregate event/episode data are persisted.

## 9 Restart persistence

1. Close VS Code after several completed runs.
2. Reopen the same project and then a different project.
3. Open All-time profile and Current project.

Expected: all-time evidence remains private and cumulative; Current project shows only that workspace's saved evidence. A changed backend port must not erase the database.
