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

On first boot the dashboard asks for an administrator login and password — there is no
seeded account, and the credentials are only ever stored as a hash of
`login + password + AP_PASSWORD_SALT`. To start over, delete the `userap` row (or the
whole `.tmp/app-db.sqlite`) and reopen `/dashboard`.

## Seed data

Seeds are not a separate command: `runSeeds()` is called from `index.ts` on every boot,
after all apps are mounted and before the server starts listening. A boot that fails to
bind its port has therefore already seeded the database.

`NODE_ENV=production` — the default in `Dockerfile` and `deploy/.env.example` — disables
them outright:

```
[seeds] Hard-disabled in production environment (set FORCE_SEED=1 to override)
```

To run them against a real server, restart it once with `FORCE_SEED=1`. Every seed is a
find-or-create on `slug`/`key`, and the "refresh in place" branches are additionally
gated on `NODE_ENV !== 'production'`, so a production run only fills in what is missing
and never overwrites existing projects, roles or pipeline specs. Two things to weigh
first:

- The seeds insert demo content (three projects from `agentiz-projects.seed`, plus
  `demo-repo` and a demo task from `agentiz.seed`), not schema changes. Migrations are a
  separate mechanism.
- `agentiz-projects.seed` needs a user to own its projects and skips the whole seed until
  one exists. Despite its name, `firstAdminId()` does not filter on `isAdministrator` — it
  takes the lowest `UserAP` id — so on an established database the projects may land on an
  ordinary user, who is then the only one seeing them through the mobile API.

There is no way to run the seeds without restarting the process; a standalone entry point
would have to boot `AppManager` without calling `lift()`.

## Configuration

Use SQLite by default or set `DB_DIALECT=postgres` with `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_PASS`, and `DB_NAME`. See `.env.example` for the available environment variables.

Only `layers/app-agentiz` is a local application layer. The admin dashboard is loaded
from the `@nodeknit/app-adminizer` dependency.

## Documentation

Project documentation is indexed in [`docs/README.md`](docs/README.md). In particular, see
[`docs/mcp-usage.md`](docs/mcp-usage.md) for calling the MCP endpoint and
[`docs/mcp-development.md`](docs/mcp-development.md) for adding or extending MCP tools. For the
Adminizer flow of `worker_workspace` pipelines with manual diff approval, see
[`docs/workspace-git-review.md`](docs/workspace-git-review.md).
