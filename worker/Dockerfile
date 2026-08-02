# Controller image, not the OpenHands sandbox image.  The digest pins Node/npm for ACP commands.
FROM node:22-bookworm-slim@sha256:0f65470961851f2354dc8e560853e2f428ea928436135fc7e35780ab100c7e00

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 python3-pip ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN python3 -m pip install --break-system-packages --no-cache-dir .

ENV PYTHONUNBUFFERED=1 OPENHANDS_SUPPRESS_BANNER=1
ENTRYPOINT ["agentiz-worker"]
