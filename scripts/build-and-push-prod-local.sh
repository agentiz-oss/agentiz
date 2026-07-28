#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Build and push the Agentiz production Docker image using the same image
coordinates and build args as .gitlab-ci.yml.

Environment overrides:
  GITLAB_REGISTRY       Registry host. Required.
  CI_PROJECT_PATH       Registry project path. Default: derived from git origin
  CI_COMMIT_BRANCH      Image tag branch. Default: current git branch
  CI_COMMIT_SHA         Build git SHA. Default: current git HEAD
  GITHUB_NPM_TOKEN      GitHub Packages token passed as Docker BuildKit secret
  DOCKERHUB_USER        Registry login user
  DOCKERHUB_PASSWORD    Registry login password
  SKIP_DOCKER_LOGIN=1   Use existing Docker auth instead of docker login
  SKIP_MODULES_BUILD=1  Skip local_modules build before Docker build
  RUN_TSC_CHECK=1       Run npm run build before Docker build
  DOCKER_PLATFORM       Optional docker build --platform value

Examples:
  DOCKERHUB_USER=user DOCKERHUB_PASSWORD=pass GITHUB_NPM_TOKEN=... \
    ./scripts/build-and-push-prod-local.sh

  CI_COMMIT_BRANCH=dev SKIP_MODULES_BUILD=1 ./scripts/build-and-push-prod-local.sh
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

command -v git >/dev/null 2>&1 || {
  echo "git is required" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || {
  echo "docker is required" >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || {
  echo "npm is required" >&2
  exit 1
}

GITLAB_REGISTRY="${GITLAB_REGISTRY:?GITLAB_REGISTRY is required}"

derive_project_path() {
  remote_url="$(git config --get remote.origin.url || true)"
  if [ -z "$remote_url" ]; then
    echo "Unable to derive CI_PROJECT_PATH: remote.origin.url is empty" >&2
    exit 1
  fi

  path="$remote_url"
  case "$path" in
    git@*:*) path="${path#*:}" ;;
    ssh://git@*/*) path="${path#ssh://git@*/}" ;;
    http://*/*) path="${path#http://*/}" ;;
    https://*/*) path="${path#https://*/}" ;;
  esac
  path="${path%.git}"
  printf '%s\n' "$path"
}

CI_PROJECT_PATH="${CI_PROJECT_PATH:-$(derive_project_path)}"
CI_COMMIT_BRANCH="${CI_COMMIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
CI_COMMIT_SHA="${CI_COMMIT_SHA:-$(git rev-parse HEAD)}"
BUILD_TIME="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
IMAGE_TAG="${GITLAB_REGISTRY}/${CI_PROJECT_PATH}:${CI_COMMIT_BRANCH}"

if [ "${RUN_TSC_CHECK:-0}" = "1" ]; then
  echo "Running TypeScript check before Docker build..."
  npm run build
fi

if [ "${SKIP_MODULES_BUILD:-0}" != "1" ]; then
  echo "Building local modules before Docker build..."
  npm run build:modules
fi

if [ "${SKIP_DOCKER_LOGIN:-0}" != "1" ]; then
  if [ -z "${DOCKERHUB_USER:-}" ] || [ -z "${DOCKERHUB_PASSWORD:-}" ]; then
    echo "DOCKERHUB_USER and DOCKERHUB_PASSWORD are required for docker login." >&2
    echo "Set SKIP_DOCKER_LOGIN=1 to use existing Docker credentials." >&2
    exit 1
  fi
  printf '%s' "$DOCKERHUB_PASSWORD" | docker login "$GITLAB_REGISTRY" -u "$DOCKERHUB_USER" --password-stdin
fi

set -- docker build -f Dockerfile \
  --build-arg "GIT_SHA=${CI_COMMIT_SHA}" \
  --build-arg "BUILD_TIME=${BUILD_TIME}" \
  -t "$IMAGE_TAG"

if [ -n "${GITHUB_NPM_TOKEN:-}" ]; then
  set -- "$@" --secret id=github_npm_token,env=GITHUB_NPM_TOKEN
elif [ "${ALLOW_EMPTY_GITHUB_NPM_TOKEN:-0}" != "1" ]; then
  echo "GITHUB_NPM_TOKEN is required for private @nodeknit packages." >&2
  echo "Set ALLOW_EMPTY_GITHUB_NPM_TOKEN=1 only if Docker can build without it." >&2
  exit 1
fi

if [ -n "${DOCKER_PLATFORM:-}" ]; then
  set -- "$@" --platform "$DOCKER_PLATFORM"
fi

set -- "$@" .

echo "Building image: $IMAGE_TAG"
"$@"

echo "Pushing image: $IMAGE_TAG"
docker push "$IMAGE_TAG"

echo "Done: $IMAGE_TAG"
