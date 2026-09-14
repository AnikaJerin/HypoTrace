# HypoTrace submission test flow — exact files, commands, and expected results

This is a **manual demo script**, not a claim that every research item in the product specification is complete. It proves the implemented local extension flow using normal integrated-terminal runs. Run the commands in the VS Code integrated terminal, never in an external terminal.

## 0. Start with a genuinely empty HypoTrace profile

1. Install `hypotrace-0.7.8.vsix`.
2. Reload VS Code.
3. Click the **HypoTrace** icon in the left Activity Bar.
4. Open the **All-time profile** tab.
5. Scroll to **Fresh demo** and press **Start fresh**. Confirm the warning.

Expected dashboard result:

```text
Personal growth snapshot: — or no evidence yet
Strengths will appear with more evidence
No repeated unresolved pattern is established yet
No forecast-ready pattern yet
```

Expected safety result: Your project files are unchanged. The reset erases only the current VS Code profile's local semantic run history, dashboard profile, SQLite patterns, forecasts, and AI reflections.

## 1. Create a clean test workspace

Create a new empty folder called `hypotrace-submission-test`, open **that folder** in VS Code, and create these seven files exactly.

### `syntax_a.py`

```python
def total(values)
    return sum(values)
```

### `syntax_b.py`

```python
for number in range(3)
    print(number)
```

### `index_a.py`

```python
values = [10, 20]
print(values[2])
```

### `assert_a.py`

```python
def add(left, right):
    return left + right

assert add(2, 2) == 5
```

### `success_a.py`

```python
def add(left, right):
    return left + right

assert add(2, 2) == 4
print("success")
```

### `.env`

```text
DEMO_SECRET=do-not-store-me
```

### `private_check.py`

```python
print("this file is only for the privacy check")
```

## 2. First normal failed run: syntax evidence only

In VS Code's integrated terminal, run:

```bash
python3 syntax_a.py
```

Expected terminal output:

```text
  File ".../syntax_a.py", line 1
    def total(values)
                     ^
SyntaxError: expected ':'
```

Then open **HypoTrace → Current project**.

Expected dashboard result:

```text
Normal runs observed: 1
Run outcomes: 1 failure · 0 confirmed recoveries
Patterns from real runs: Syntax Error — 1 finding
```

Expected forecast result:

```text
No forecast-ready pattern yet
```

Pass rule: opening a file, red squiggles, typing, saving, or refreshing the dashboard alone must not change `Normal runs observed`.

## 3. Repeated comparable pattern, plus a different error

Run these commands separately:

```bash
python3 syntax_b.py
python3 index_a.py
```

Expected terminal output, first command:

```text
  File ".../syntax_b.py", line 1
    for number in range(3)
                          ^
SyntaxError: expected ':'
```

Expected terminal output, second command:

```text
IndexError: list index out of range
```

Expected **Current project** result:

```text
Normal runs observed: 3
Run outcomes: 3 failures · 0 confirmed recoveries
Patterns from real runs includes a Syntax Error pattern with 2 failed runs
Patterns from real runs includes an Index Error pattern with 1 failed run
```

Expected **Forecast** result:

```text
Syntax Error: repeating / forecast confidence still learning or collecting evidence
Index Error: watching / seen once
```

Pass rule: it must show two distinct semantic families. It must not turn all three runs into one fixed “syntax/boundary” label.

## 4. Confirm a recovery changes the learning record

Replace `syntax_a.py` with this corrected code:

```python
def total(values):
    return sum(values)

assert total([1, 2, 3]) == 6
print("syntax recovery")
```

Run:

```bash
python3 syntax_a.py
```

Expected terminal output:

```text
syntax recovery
```

Expected **Current project** result after the dashboard refreshes:

```text
Normal runs observed: 4
Run outcomes: 3 failures · 1 confirmed recovery
```

Expected **Forecast** result:

```text
Syntax Error has 2 matching failed runs and 1 matching recovery
```

Pass rule: a successful run is the event that may reduce a relevant pattern. Merely editing the invalid `def` line must not count as recovery.

## 5. Current-project assessment and charts

Press **Current project → Refresh this project** once.

Expected dashboard result:

```text
Source health: hypotrace-submission-test
AI code-health snapshot: [a value]/100
Issues found in this project: labelled bars with counts
How this project has changed: a labelled line chart after a second refresh
```

Press **Refresh this project** a second time only after adding this harmless file:

### `clean_example.py`

```python
def mean(values):
    if not values:
        return 0
    return sum(values) / len(values)

print(mean([2, 4, 6]))
```

Expected chart result:

```text
Project progress: a line from Earlier assessment to Latest assessment
```

Pass rule: the issue bars and score are generated from the opened workspace scan. They are not copied from another project.

## 6. Privacy boundary

Open `.env`, edit it, and save it. Do not run it. Open `private_check.py` and do not run it.

Expected dashboard result:

```text
Normal runs observed remains 4
No .env value, secret, file text, terminal command, or source code is visible in dashboard cards, replay, or graph
```

Pass rule: only the semantic outcome of a completed normal run is saved. Private file contents are excluded.

## 7. All-time profile and project isolation

1. Open **All-time profile**.
2. Open **Current project**.
3. Create and open another folder called `hypotrace-second-project`.
4. Create this file there:

### `second_project.py`

```python
items = [1]
print(items[3])
```

5. Run:

```bash
python3 second_project.py
```

Expected **Current project** result in the second folder:

```text
Normal runs observed: 1
Patterns from real runs: Index Error — 1 finding
```

Expected **All-time profile** result:

```text
The profile may update its own evidence-backed growth summary
It may include evidence from both projects
It must not display a workspace-comparison table
```

Expected isolation result when switching back to the first folder:

```text
Normal runs observed: 4 or more, depending only on first-project runs
The second project's single Index Error is not counted in the first project's current-project card
```

## 8. Forecast, Ghost Mode, and prediction history

Use the first project. Create a third comparable syntax case:

### `syntax_c.py`

```python
if True
    print("missing colon")
```

Run:

```bash
python3 syntax_c.py
```

Expected terminal output:

```text
SyntaxError: expected ':'
```

Then make a meaningful edit in a non-private Python file and wait briefly for the extension's normal inspection delay. Run a comparable file afterward.

Expected **Forecast** result when enough matching evidence exists:

```text
[pattern name]
[number] matching failed runs · [number] matching recoveries
Forecast confidence: Still learning ... OR [percentage] calibrated from [number] tested forecasts
Prediction record: [pattern] · [percentage] predicted risk
```

Expected Ghost Mode behaviour:

```text
No popup interrupts you.
A later matching completed run can resolve the saved forecast as matched, avoided, or waiting for outcome.
```

Pass rule: a forecast is only useful if its timestamp is before the run it evaluates. Do not claim calibrated prediction from one or two cases.

## 9. Agent A / Agent B and evidence graph

For a credible manual demo, perform **three separate coding sessions** for the same error family. Each session should contain at least two minutes of real work, an edit, navigation or debugging, and two runs. Do not use rapid retries as a substitute.

Suggested session commands:

```bash
python3 syntax_a.py
python3 syntax_b.py
```

Then inspect **Forecast**.

Expected possible-reason cards:

```text
Possible reason — [short plain-language possibility]
Evidence: [number] full coding sessions
What could change it: [counterevidence]
```

Expected conclusion behaviour:

```text
No conclusion yet
```

is correct until the stored evidence is strong enough. If it later appears, expected wording is:

```text
Best explanation so far
It may change if: [counterevidence]
```

Expected graph behaviour:

```text
Sessions → patterns → possible reasons → checks
Clicking a circle reveals its own saved relationship.
Arrows are labelled supports, suggests, challenged by, predicts, tested against, or helped by.
```

Pass rule: Agent A suggests a possibility; Agent B gives a reason it might be wrong. Neither is a diagnosis of the developer.

## 10. AI check and intervention measurement

In **Forecast**, click **Try a small AI check** only when it is offered. Enter one short answer, then run a comparable file normally.

Example answer:

```text
I will check each block header for a colon before I run the file.
```

Expected immediate message:

```text
HypoTrace saved your reflection. The next matching run will measure whether this check helped.
```

Expected result after the next matching successful run:

```text
The intervention is resolved from the matching run outcome.
It is not marked successful merely because a reflection was typed.
```

Pass rule: the policy remains data-limited until several comparable checks and later outcomes exist. This implementation does not yet prove the full research-spec reward model for time, dismissal, interruption, transfer, and decay.

## 11. Restart and local startup

1. Close VS Code completely.
2. Reopen the first test workspace.
3. Click the HypoTrace Activity Bar icon.
4. Run:

```bash
python3 success_a.py
```

Expected terminal output:

```text
success
```

Expected dashboard result:

```text
Earlier all-time and first-project evidence remains available.
The local backend starts without a fixed-port collision.
The next completed run is added to the appropriate project.
```

## What this script can and cannot prove against the DOCX

This script verifies: local semantic run capture, private local persistence, project isolation, dynamic workspace assessment, recurring signatures, recovery evidence, forecast records, Bayesian-style confidence records, Agent A/B candidate/counterevidence display, interactive relationship graph, and a measured next-run intervention flow.

It does **not** prove the full research claims without more development and longitudinal data: validated 2–5 minute task-phase episodes, HDBSCAN merge/split clustering, precision/recall/lead-time forecasting audits, independently scored generated probes, comprehensive intervention reward, 3/14/30-day retention scheduling, generated transfer tasks, robust false-mastery tests, controlled self-evolving skill experiments, or clean-machine Python runtime packaging. Keep those claims out of the final submission unless you implement and document them.
