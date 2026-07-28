# Deployment Guide

This folder contains Docker Compose files for running **Agentiz** in production.

## Usage

1. Copy `.env.example` from the project root to `.env` and adjust the variables as needed (see [../docs/nodeknit-data-migrations.md](../docs/nodeknit-data-migrations.md) for database configuration and migration mode).
2. Run the default compose setup:

```sh
docker compose -f docker-compose.yml up -d
```

This builds the image from the repository and exposes port `17280`.

## ARM (Raspberry Pi)

To deploy on ARM devices like the Raspberry Pi, use the ARM compose file. It
sets `platform: linux/arm64` so the image is built for that architecture:

```sh
docker compose -f docker-compose.arm.yml build
docker compose -f docker-compose.arm.yml up -d
```

Ensure that Docker Desktop or Buildx is configured to build multi-architecture
images. When using a remote builder, use the `--builder` flag with `docker
buildx`.
