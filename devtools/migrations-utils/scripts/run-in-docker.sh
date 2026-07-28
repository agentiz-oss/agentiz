#!/bin/bash

# Migration Generator Docker Runner
# This script builds and runs the migration generator in a Docker container

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    print_error "Docker is not running. Please start Docker first."
    exit 1
fi

# Parse arguments
MIGRATION_NAME=""
APP_PATH=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --name)
            MIGRATION_NAME="$2"
            shift 2
            ;;
        --app-path)
            APP_PATH="$2"
            shift 2
            ;;
        *)
            print_error "Unknown argument: $1"
            echo "Usage: $0 --name \"migration name\" --app-path \"/path/to/app\""
            exit 1
            ;;
    esac
done

# Validate arguments
if [ -z "$MIGRATION_NAME" ]; then
    print_error "Migration name is required"
    echo "Usage: $0 --name \"migration name\" --app-path \"/path/to/app\""
    exit 1
fi

if [ -z "$APP_PATH" ]; then
    print_error "App path is required"
    echo "Usage: $0 --name \"migration name\" --app-path \"/path/to/app\""
    exit 1
fi

# Check if app path exists
if [ ! -d "$APP_PATH" ]; then
    print_error "App path does not exist: $APP_PATH"
    exit 1
fi

print_info "Building migration generator Docker image..."
docker build -t agentiz-migrations .

print_success "Docker image built successfully"

print_info "Running migration generator..."
print_info "Migration name: $MIGRATION_NAME"
print_info "App path: $APP_PATH"

# Run the migration generator in Docker
# Mount the app path and current directory for access to source code
docker run --rm \
    -v "$(pwd)":/workspace \
    -v "$APP_PATH":/app-source \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --network host \
    -e MIGRATION_NAME="$MIGRATION_NAME" \
    -e APP_PATH="/app-source" \
    agentiz-migrations \
    npm run migrate -- --name "$MIGRATION_NAME" --app-path "/app-source"

print_success "Migration generation completed!"
print_info "Check the ./migrations directory for generated SQL files"