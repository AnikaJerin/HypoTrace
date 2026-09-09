# HypoTrace backend

This service persists privacy-filtered behavioral episodes in SQLite, embeds canonical behavior traces, retrieves similar prior episodes, calls the OpenAI Responses API for competing Agent A/B hypotheses, and emits a forecast only after two earlier examples.

```bash
export OPENAI_API_KEY='your key'
python3 backend/server.py
```

Check it with `http://127.0.0.1:8787/health`. For deployment, put the same service behind HTTPS, add authenticated user IDs, a managed Postgres database, rate limits, audit logs, and a secrets manager. Never place the key in the VS Code extension.
