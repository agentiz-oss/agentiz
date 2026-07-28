#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/build-and-push-prod-image.sh [options]

Builds local_modules, builds the production Docker image, and pushes it.

Options:
  --tag <image:tag>       Full image tag. Required: $REGISTRY/$PROJECT_PATH:<git-branch>
  --registry <host>       Registry host. Required (or set $REGISTRY)
  --project <path>        Registry project path. Required (or set $PROJECT_PATH)
  --branch <name>         Tag suffix when --tag is not set. Default: current git branch
  --platform <platform>   Optional docker build platform, for example linux/amd64
  --typecheck             Run root npm run build before Docker build
  --no-push               Build only, do not push
  -h, --help              Show this help

Environment:
  GITHUB_NPM_TOKEN        Required for GitHub Packages dependencies in Dockerfile
  GIT_SHA                 Optional, default: current git commit
  BUILD_TIME              Optional, default: current UTC time
EOF
}

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
REGISTRY="${REGISTRY:-}"
PROJECT_PATH="${PROJECT_PATH:-}"
BRANCH="${BRANCH:-}"
IMAGE_TAG="${IMAGE_TAG:-}"
PLATFORM="${PLATFORM:-}"
PUSH=1
TYPECHECK=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --registry)
      REGISTRY="$2"
      shift 2
      ;;
    --project)
      PROJECT_PATH="$2"
      shift 2
      ;;
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --platform)
      PLATFORM="$2"
      shift 2
      ;;
    --typecheck)
      TYPECHECK=1
      shift
      ;;
    --no-push)
      PUSH=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "${GITHUB_NPM_TOKEN:-}" ]; then
  echo "GITHUB_NPM_TOKEN is required for production Docker build." >&2
  exit 1
fi

if [ -z "$BRANCH" ]; then
  BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
fi

if [ -z "$IMAGE_TAG" ]; then
  if [ -z "$REGISTRY" ] || [ -z "$PROJECT_PATH" ]; then
    echo "Set --tag, or provide --registry/--project (or \$REGISTRY/\$PROJECT_PATH)." >&2
    exit 1
  fi
  IMAGE_TAG="$REGISTRY/$PROJECT_PATH:$BRANCH"
fi

GIT_SHA="${GIT_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

cd "$ROOT_DIR"

echo "Building local_modules into dist..."
npm run build:modules

if [ "$TYPECHECK" -eq 1 ]; then
  echo "Running TypeScript regression build..."
  npm run build
fi

DOCKER_BUILD_ARGS="
  --file Dockerfile
  --secret id=github_npm_token,env=GITHUB_NPM_TOKEN
  --build-arg GIT_SHA=$GIT_SHA
  --build-arg BUILD_TIME=$BUILD_TIME
  --tag $IMAGE_TAG
"

if [ -n "$PLATFORM" ]; then
  DOCKER_BUILD_ARGS="--platform $PLATFORM $DOCKER_BUILD_ARGS"
fi

echo "Building production image: $IMAGE_TAG"
# shellcheck disable=SC2086
docker build $DOCKER_BUILD_ARGS .

if [ "$PUSH" -eq 1 ]; then
  echo "Pushing production image: $IMAGE_TAG"
  docker push "$IMAGE_TAG"
else
  echo "Push skipped: $IMAGE_TAG"
fi
