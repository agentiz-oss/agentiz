# App Migration Generator

CLI tool to generate SQL migrations for ### Install as a binary

After publishing, the package exposes a binary named `app-migrate-generator`:

```bash
# Install globally
npm install -g app-migrate-generator

# Run the CLI
app-migrate-generator --name "add user preferences" --app-path "/path/to/your-app"
```

The binary uses tsx to run TypeScript files directly, providing full decorator support without compilation.pe apps.

## Installation

### Prerequisites

- Docker (required for PostgreSQL and Atlas)
- Node.js 18+ (for local development)

### Setup

1. Clone the repository and navigate to the tool directory:
   ```bash
   cd devtools/migrations-utils
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. (Optional) Build the project:
   ```bash
   npm run build
   ```

### Docker Setup

Ensure Docker is installed and running:
```bash
docker --version
docker info
```

## Quick Start

### Docker (recommended)

```bash
# Go to the tool directory
cd devtools/migrations-utils

# Run migration generation
./scripts/run-in-docker.sh --name "add user table" --app-path "/path/to/your-app"
```

### Node + TSX (development)

```bash
# Go to the tool directory
cd devtools/migrations-utils

# Install deps
npm install

# Build once
npm run build

# Run the CLI (from built files)
npm run migrate -- --name "add user table" --app-path "/path/to/your-app"

# Or directly via TSX while developing
npx tsx ./bin/generate-migration.ts --name "add user table" --app-path "/path/to/your-app"
```

## Install as a binary

After publishing, the package exposes a binary named `app-migrate-generator`:

```bash
# Install globally (tsx is included as a dependency)
npm install -g app-migrate-generator

# Run the CLI
app-migrate-generator --name "add user preferences" --app-path "/path/to/your-app"
```

The binary uses the bundled tsx to run TypeScript files directly, providing full decorator support without requiring global tsx installation.

## CLI Options

- `--name`: Migration name (required)
- `--app-path`: Path to the app to inspect (required)

## Examples

```bash
# Generate migration for app-base
./scripts/run-in-docker.sh --name "add user preferences" --app-path "/path/to/your-app"

# Generate migration for your app
./scripts/run-in-docker.sh --name "add azimuth settings" --app-path "/path/to/your-app"

# Generate migration for a custom app
./scripts/run-in-docker.sh --name "add custom feature" --app-path "/path/to/custom/app"
```

## What it does

1. Starts PostgreSQL in Docker on a shared network
2. Loads the provided app and syncs models with Sequelize
3. Runs Atlas to diff schema and write a new SQL migration
4. Closes connections and leaves artifacts in the migrations folder

## Output Files

Migrations are saved in the app’s `migrations/` directory:
- `YYYYMMDDHHMMSS_migration_name.sql` — SQL migration file
- `atlas.sum` — Atlas checksum file

## Requirements

- Docker
- Node.js 18+ (for local non-Docker runs)
- Access to Docker socket

## App Contract

Your app must export a default class extending `AbstractApp`:

```typescript
import { AbstractApp } from '@nodeknit/app-manager'

export default class MyApp extends AbstractApp {
  appId: string = 'my-app'
  name: string = 'My Application'
}
```

## Troubleshooting

### "App path does not exist"
Check the `--app-path` value and ensure the directory exists.

### "No default export found in .../index.ts"
Ensure your app’s `index.ts` exports a default class extending `AbstractApp`.

### Docker errors
Make sure Docker is installed, running, and the current user can access the Docker socket.

### No new migration file
If no file appears, the schema likely hasn’t changed since the last migration.
