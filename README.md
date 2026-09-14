# HypoTrace

HypoTrace is a private AI learning coach for VS Code. It watches completed coding runs, remembers privacy-filtered outcomes on the developer's own machine, and looks for mistakes that return over time. It is designed to help someone understand a repeated mistake rather than simply receive a corrected line of code.

The idea came from a simple problem: code assistants can help finish code quickly, but they do not always explain why the same type of mistake keeps coming back. HypoTrace keeps a small local history of outcomes such as syntax errors, failed tests, or runtime failures. When there is enough related evidence, it can show a forecast, offer a short question, and measure what happens on a later run.

## What it does

- Observes normal completed runs in the VS Code integrated terminal.
- Converts terminal and diagnostic output into privacy-filtered semantic outcomes.
- Stores personal learning evidence in a local SQLite database.
- Keeps current-project evidence separate from the all-time developer profile.
- Groups comparable outcomes into personal failure signatures.
- Tracks recoveries when a related later run succeeds.
- Builds longer problem-solving sessions from editing, navigation, run, and diagnostic activity.
- Uses OpenAI for plain-language project assessments, Agent A and Agent B reasoning, coaching checks, and reasoning replays.
- Lets Agent A propose possible reasons and Agent B describe counterevidence that could change those reasons.
- Records forecasts and later outcomes so the risk estimate can improve from the same user's history.
- Uses a small Thompson-sampling policy to select a coaching check from interventions that have been measured for that signature.
- Shows evidence connections between runs, patterns, possible reasons, forecasts, and coaching checks.
- Supports Ghost Mode, which records eligible forecasts without interrupting the developer.
- Provides a local Start fresh option that clears HypoTrace history without touching source files.

## How it works

```text
Normal VS Code run
  -> privacy-filtered semantic outcome
  -> local SQLite evidence
  -> personal pattern and recurrence score
  -> Agent A possible reasons + Agent B counterevidence
  -> forecast at a relevant later decision
  -> small non-solution coaching check
  -> next matching run measures the result
```

HypoTrace does not treat an AI explanation as proof. The dashboard distinguishes a possible reason from a supported conclusion. A conclusion needs repeated full sessions and evidence that competing explanations did not fit as well.

## Privacy

The learning database stores semantic information such as an error category, outcome, timing, edit-burst count, navigation count, and recovery evidence. It does not save raw source code, terminal history, API keys, secrets, clipboard contents, or keystroke logs.

Files matching private names such as `.env`, `secret`, or `credential` are excluded. If optional AI code analysis is enabled, the active non-private file can be sent transiently to the configured local backend for that one assessment. It is not written into HypoTrace's SQLite learning database. You can disable this in VS Code settings with `hypotrace.aiCodeAnalysis`.

The OpenAI key is read from macOS Keychain or an environment variable. Do not commit an API key or a `.env` file to this repository.

## Technology

- VS Code Extension API
- JavaScript and Node.js
- Python local backend
- SQLite with WAL mode
- OpenAI Responses API with structured JSON outputs
- Personal similarity grouping from semantic episode features
- HTML, CSS, and JavaScript webviews for the dashboard

## Install and run

### Requirements

- VS Code 1.136 or newer
- Python 3 available as `python3` (the extension uses a local Python backend)
- An OpenAI API key for AI features

### Install the extension

1. Download the latest `hypotrace-*.vsix` file from this project or the release package.
2. In VS Code, open **Extensions**.
3. Select **Install from VSIX** and choose the file.
4. Reload VS Code when prompted.
5. Click the HypoTrace icon in the Activity Bar. The dashboard is the normal entry point.

HypoTrace starts its local backend automatically on an available `127.0.0.1` port. You do not need to host a server or run `python3 backend/server.py` manually.

### For judges: quickest install and walkthrough

The easiest way to review HypoTrace is to download `HypoTrace-Submission.zip`, unzip it, and keep that folder open for the first-time setup. The ZIP includes the installer, source, and test cases.

1. Install `hypotrace-0.7.11.vsix` from the unzipped folder using **Extensions → Install from VSIX**.
2. Reload VS Code.
3. On macOS, open a terminal in the unzipped folder and run `zsh backend/store-openai-key-in-keychain.zsh`. Paste your own OpenAI API key when prompted. This step enables Agent A/B explanations, AI checks, and replays.
4. Open any small Python folder in VS Code and click the HypoTrace icon in the Activity Bar.
5. Run a Python file with a syntax error twice from the integrated terminal, then open **Forecast**. HypoTrace will show a repeated pattern after comparable completed runs.
6. Fix the file and run it again. The matching recovery is saved locally and appears in the dashboard after it refreshes.

No cloud deployment, account creation, or manual server command is required. The key is optional for the local evidence, pattern, and recovery flow. Without a key, the extension still records privacy-filtered local outcomes, but AI-generated explanations, replays, and coaching questions are unavailable.

For exact example files, commands, expected output, and expected dashboard changes, open `docs/FULL_SUBMISSION_TEST_FLOW.md` in the unzipped folder.

### Configure the API key on macOS

Run this once from the project folder:

```zsh
zsh backend/store-openai-key-in-keychain.zsh
```

The script stores the key in your login Keychain. It does not put the key in the project folder, settings file, Git history, or SQLite database.

To confirm the key without printing it:

```zsh
python3 -c "from backend.server import verify_openai_key; print(verify_openai_key())"
```

The expected result contains `"valid": True` and never prints the key itself.

## Use the dashboard

### Current project

This tab shows a bounded source assessment, completed normal runs, run outcomes, project-specific patterns, and a project progress history. Use **Refresh this project** when you want another source assessment. Editing a file does not update learning progress by itself.

### All-time profile

This tab combines privacy-filtered evidence from projects opened under the same local profile. It can show evidence-backed strengths, learning debt, prerequisites, and a next-step roadmap when enough evidence exists.

### Forecast

This tab shows repeated patterns, possible reasons, prediction history, the saved evidence graph, transfer, retention, and coaching controls. A warning or coaching check appears only after relevant completed-run evidence. It does not appear just because a file was opened or edited.

## Test the full flow

Use the detailed run-by-run test plan in `docs/FULL_SUBMISSION_TEST_FLOW.md`. It includes exact Python files, commands, expected terminal output, expected dashboard changes, privacy checks, project isolation, Agent A/B reasoning, forecasts, Ghost Mode, and Start fresh.

For a quick check:

1. Open a new folder in VS Code.
2. Run two files with the same kind of error in the integrated terminal.
3. Open the Forecast tab and confirm that the pattern is marked as repeating.
4. Run a related corrected file and confirm that the recovery count changes.
5. Select **Try a small AI check** after two comparable normal runs.
6. Open **Your saved evidence** to inspect the links from runs to patterns, possible reasons, forecasts, and checks.

## Project structure

```text
src/extension.js                 VS Code observation, profile, dashboard, and commands
src/backendClient.js             Local HTTP client
src/aiClient.js                  OpenAI Responses API client
backend/server.py                SQLite, reasoning, forecasts, and intervention policy
backend/store-openai-key-in-keychain.zsh
docs/FULL_SUBMISSION_TEST_FLOW.md
docs/TEST_CASES.md
docs/SPEC_AUDIT.md
demo/feature-tests/              Test fixtures only
```

## What is implemented now

This repository is a working hackathon MVP. The closed loop is implemented: normal run outcome, local semantic memory, personal pattern, Agent A/B review, forecast record, non-solution coaching check, later outcome, and dashboard update.

It is deliberately local-first. One user's personal profile is not mixed into another user's warnings. The local backend uses an OS-assigned loopback port, and the database lives in VS Code extension storage.

## What comes next

The product specification also describes a longer research path. The next work should focus on validating the learning method rather than adding generic tutoring features:

- Improve session segmentation with task phases, AST regions, and fuller run/debug/navigation boundaries.
- Replace simple online similarity grouping with tested merge, split, and stability checks.
- Add a forecast audit with lead time, precision, recall, false alarms, misses, and signature confusion.
- Turn reflection probes into independently scored discriminating tasks.
- Measure intervention reward using recovery time, interruption cost, structural transfer, and later decay.
- Add unseen transfer tasks and scheduled 3-day, 14-day, and 30-day retention checks.
- Add stronger false-mastery tests based on changed surface form, invariant explanation, and task diversity.
- Store strengths, debt, prerequisites, milestones, and state changes as first-class historical SQLite entities.
- Validate skill promotion, mutation, and retirement with controlled longitudinal comparisons.

These are research goals, not claims made by the current MVP. The current project stores evidence and uncertainty so it can be tested honestly as the system grows.

## Submission notes

The source ZIP should include the extension source, backend, documentation, test fixtures, and the latest VSIX. It should exclude SQLite databases, Python caches, older VSIX builds, `.env` files, and API keys.

## License

No license has been selected yet.
