# HypoTrace

HypoTrace is a personal VS Code learning agent. It observes normal coding and run outcomes, learns each developer's recurring mistake mechanisms, asks Agent A/B to challenge explanations after recurrence, and gives one short warning only when the current code reaches a similar decision again.

It does **not** use file names, seeded test folders, or a fixed syntax/boundary warning list to forecast. With AI Code Analysis enabled (the default), the active non-private file is sent transiently to the configured local backend after a short coding pause. The backend asks OpenAI for a semantic observation and stores only the returned label, score, and recovery evidence—not the code, output, identifier names, or paths. Disable `hypotrace.aiCodeAnalysis` if that trade-off is not acceptable.

## Two-scope dashboard

When an eligible source project opens, HypoTrace runs one bounded AI assessment (up to 10 non-private source files) and never stores those file contents. The interactive dashboard has:

- **All-time personal profile** — semantic recurrence counts learned from work done since installation.
- **Current project** — an AI code-health snapshot, issue distribution, suggested focus, strengths, and a quality trend that updates on each refresh.

An empty user or a folder with no source files remains empty rather than showing a fabricated assessment. Later scans happen only from **Refresh project assessment**, not on every edit. Set `hypotrace.projectAssessmentOnOpen` to `false` to disable the opening scan.

## Connect your OpenAI API key

HypoTrace uses the Responses API with strict JSON Schema outputs for its code observer plus the Agent A/Agent B review, and `text-embedding-3-small` for semantic-episode similarity. AI code inspection is transient and requests use `store: false`; the learning database receives only semantic aggregates.

1. For the packaged extension alone, open the Command Palette and run **HypoTrace: Configure OpenAI API Key**. For the optional local backend, keep the key in the `OPENAI_API_KEY` environment variable when starting `backend/server.py`.
2. Paste the key into the secure prompt. It is written to VS Code Secret Storage, not `settings.json`, the project, Git, or the dashboard.
3. Start a session and collect two similar outcomes. With the backend configured, Agent A and Agent B run automatically on the recurrent semantic episodes; the dashboard records their proposals and falsification review.
4. Set `hypotrace.openAIModel` only if your account uses a different available model. The default is `gpt-5-mini`.

Never paste the key into this repository or commit a `.env` containing it. OpenAI’s official quickstart recommends environment/secret-based API-key handling and the Responses API supports structured outputs. [Official OpenAI quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request).

### Keep the backend key out of the project

On macOS, run this once in a terminal:

```zsh
zsh backend/store-openai-key-in-keychain.zsh
```

It prompts without echoing the key and stores it in your login Keychain under `HypoTrace.OpenAI`; it never writes the key to a project file. Afterwards, each new session only needs:

```zsh
python3 backend/server.py
```

The startup line will say `OpenAI: keychain`. Check `http://127.0.0.1:8787/health` for `"openai_configured": true` without revealing the secret. To make one authenticated OpenAI verification request, run `curl http://127.0.0.1:8787/v1/verify`; it reports only whether the key was accepted and never returns the key.

## Hackathon demo loop

1. Open the Command Palette and run **HypoTrace: Load End-to-End Demo**.
2. Run **HypoTrace: Open Learning Dashboard**. The seeded profile shows semantic episodes, FS-03, Agent A's H17, Agent B's H24 counter-hypothesis, a timestamped Ghost Mode forecast, intervention evidence, retention, debt, strength, and transfer state.
3. Run **HypoTrace: Run 15-Second Probe** and enter `0 <= i < n`. This records a discriminating result, lowers H17 confidence, strengthens H24, and spends one intervention-budget unit. No code or solution is revealed.
4. Open `demo/tasks/unseen_boundary_task.py`, solve it independently, then run **HypoTrace: Record Transfer Test**. The outcome updates the transfer record, retention, and prediction audit.
5. Run **HypoTrace: Open Counterfactual Replay** and use its prediction checkpoint. Run **HypoTrace: Run False Mastery Challenge** to keep a previously solved concept from being mislabeled as mastered.

## Privacy model

The extension does not store code text, raw keystrokes, clipboard data, terminal output, passwords, or cursor replay. It saves only small local semantic aggregates such as edit-burst size, navigation count, diagnostics severity class, and save anchors. Files whose paths contain `.env`, `secret`, or `credential` are excluded entirely. The profile is stored in VS Code extension global storage and resettable with **HypoTrace: Reset Local Learning Profile**.

## Personal learning flow

On a fresh project the agent begins with no warnings. A concrete failure (language diagnostic, test/runtime failure, or AI-observed issue) adds evidence for its semantic mechanism. A second comparable failure creates a personal pattern. On a later coding pause, OpenAI is given the *current* code and the user's learned semantic patterns; it can issue a forecast only if it recognizes a matching decision. Two recovered comparable decisions reduce the score and silence that pattern. Different users have distinct `backendUserId` values and therefore distinct profiles; a production deployment must replace that development identifier with authenticated account identity and a hosted database.

## Test in VS Code

Install `hypotrace-0.5.3.vsix` and reload VS Code. Private observation and the bundled local backend start automatically at `127.0.0.1:8787`, storing the profile database in VS Code extension storage rather than the installed extension folder. On modern VS Code with terminal shell integration enabled, ordinary terminal commands such as `python3 my_file.py` are observed automatically. You do not need the special HypoTrace run command: it remains a fallback only. The AI observer runs after a 1.2-second coding pause—not on every keypress—and a warning requires two comparable failures for this personal profile.

## PyCharm status

This is a VS Code extension, so it cannot be installed directly in PyCharm. The product spec correctly recommends validating the method in VS Code first. A PyCharm port should reuse the semantic-event schema and local profile, but needs a JetBrains IntelliJ Platform plugin wrapper (document events, diagnostics, actions, and a tool window). See `pycharm-plugin/README.md` for a minimal port plan and test checklist.

## Honest MVP boundary

The seeded demo remains deterministic for presentation reliability. **Run Hypothesis and Falsifier Agents** now makes real schema-constrained OpenAI calls after explicit key configuration. Every result remains a hypothesis with evidence and counterevidence—not a diagnosis or a causal fact.
