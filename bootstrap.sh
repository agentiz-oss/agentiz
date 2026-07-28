#!/bin/sh

# Диагностика без секретов: пароли и DATABASE_URL целиком не логируем.
echo "=== BOOTSTRAP ==="
echo "POSTGRES_USER: ${POSTGRES_USER:-<unset>}"
echo "POSTGRES_DB: ${POSTGRES_DB:-<unset>}"
if [ -n "$DATABASE_URL" ]; then
  echo "DATABASE_URL: set (${DATABASE_URL%%://*}://***)"
else
  echo "DATABASE_URL: <unset>"
fi
echo "================="

# Wait for PostgreSQL to be ready only if using PostgreSQL
if [ -n "$DATABASE_URL" ] && echo "$DATABASE_URL" | grep -q "^postgres://"; then
  echo "Using PostgreSQL, waiting for database..."
  # Prefer explicit env first, fallback to parsing DATABASE_URL
  DB_HOST="${DB_HOST:-$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:/]*\):\([0-9]*\)/.*|\1|p')}"
  DB_PORT="${DB_PORT:-$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:/]*\):\([0-9]*\)/.*|\2|p')}"

  if [ -z "$DB_HOST" ]; then
    DB_HOST="localhost"
  fi
  if [ -z "$DB_PORT" ]; then
    DB_PORT="5432"
  fi

  echo "Checking PostgreSQL at $DB_HOST:$DB_PORT"
  until nc -z "$DB_HOST" "$DB_PORT"; do
    echo "Waiting for PostgreSQL at $DB_HOST:$DB_PORT..."
    sleep 2
  done
  echo "PostgreSQL is ready!"
else
  echo "Using SQLite or no DATABASE_URL specified, skipping PostgreSQL wait."
fi

echo "Starting the app..."
# Start the app with explicit environment variables
export DATABASE_URL="$DATABASE_URL"
export POSTGRES_USER="$POSTGRES_USER"
export POSTGRES_PASSWORD="$POSTGRES_PASSWORD"
export POSTGRES_DB="$POSTGRES_DB"
export NODE_ENV="$NODE_ENV"

echo "Starting App..."
pm2-runtime start ecosystem.config.cjs
