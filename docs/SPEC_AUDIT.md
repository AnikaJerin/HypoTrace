# HypoTrace specification audit

## What works in the current prototype

- Privacy-filtered local semantic events and completed-run observations.
- Local SQLite storage, behavioral text embeddings when OpenAI is configured, and personal signature grouping.
- Multi-minute session gating before Agent A/B reasoning; rapid terminal repeats are not counted as full reasoning sessions.
- A/B hypotheses, a private forecast record, Ghost Mode, and a Thompson-sampling check selector.
- Dynamic project source assessment and all-time professional profile through the local OpenAI-backed service.
- An interactive SVG evidence view with labelled relationships.

## Still not complete against the specification

1. **Episode model:** it is a useful MVP segmenter, not a validated 2–5 minute episode builder with task phase, AST region and full run/debug/navigation sequence boundaries.
2. **Clustering:** personal nearest-neighbour grouping exists, but it does not yet perform robust online merge/split/stability tests such as HDBSCAN.
3. **Causal graph:** the graph is interactive, but it is an SVG view rather than React Flow/Cytoscape and lacks first-class context/effect/skill nodes and graph queries.
4. **Prediction:** forecast history and a Bayesian calibration estimate exist, but no lead-time, precision, recall, false-alarm, miss or signature-confusion audit is complete.
5. **Agent A/B:** candidate and counterevidence states exist, but a diagnostic probe is currently a reflection—not a generated discriminating task with independently scored outcome.
6. **Intervention policy:** Thompson sampling uses next matching recovery as a reward. It does not yet combine recovery time, dismissal, interruption cost, structural transfer and decay as the specification requires.
7. **Transfer and retention:** cross-workspace recovery and data-derived delayed checks are stored, but there is no robust unseen near/structural/far transfer-task generator, 3/14/30-day calendar, or decay workflow.
8. **False mastery:** recurrence after a recovery can be recorded, but template diversity, invariant explanation and surface-form-change tests are not implemented.
9. **Strengths, debt, prerequisites and roadmap:** the AI output is evidence-constrained, but its records are not yet first-class historical SQLite entities with confidence/state transitions.
10. **Self-evolving skills:** check arms are compared, but mutation, retirement and promotion are not yet controlled longitudinal experiments.
11. **Reasoning repair:** no personalized state animation, counterexample generator, Socratic fork, representation switch, or structured recovery drill exists yet.
12. **First install:** local startup is improved to use a fresh OS-assigned port, but a clean machine test still needs a supported Python-runtime packaging strategy and an end-to-end installation test.

## Static or conflicting code to remove in the clean rebuild

- Legacy skill-evolution functions contain fixed thresholds and candidate demo behavior.
- The optional code-coach path can return a corrected fragment, which violates the specification's no-solution contract.
- Multiple earlier dashboard renderers remain in one file, even though only the last renderer is active.
- Demo feature-test commands should remain test fixtures only and never affect a normal user's profile.

The clean rebuild should remove these paths rather than try to hide them.
