# Controller image, not the OpenHands sandbox image.  The digest pins Node/npm for ACP commands.
# Debian trixie supplies Python 3.13; OpenHands 1.40 requires Python >= 3.12.
FROM node:22-trixie-slim@sha256:c14465d88b83d14caaaa7e6e1f3efa49776a9868dc9713dddf7c79af3abb1d83

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 python3-pip ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN python3 -m pip install --break-system-packages --no-cache-dir .

ENV PYTHONUNBUFFERED=1 OPENHANDS_SUPPRESS_BANNER=1
ENTRYPOINT ["agentiz-worker"]
