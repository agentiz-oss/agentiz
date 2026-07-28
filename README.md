# Agentiz

Agentiz is a server for running configurable agent pipelines against repository tasks.

The server exposes the Agentiz dashboard at `/dashboard/agentiz`, stores pipeline
state in SQLite by default, and can sync tasks from configured Git providers.

## Run locally

```bash
npm install
npm run dev
```

The default address is `http://localhost:17280`. The first non-production run creates
the demo Agentiz project and pipeline data. Set `AGENTIZ_SYNC_ENABLED=true` to enable
scheduled repository synchronization.

## Configuration

Use SQLite by default or set `DB_DIALECT=postgres` with `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_PASS`, and `DB_NAME`. See `.env.example` for the available environment variables.

Only `layers/app-agentiz` is a local application layer. The admin dashboard is loaded
from the `@nodeknit/app-adminizer` dependency.
