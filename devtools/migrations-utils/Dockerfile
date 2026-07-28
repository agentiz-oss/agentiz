# Migration Generator Dockerfile
FROM node:18-alpine

# Install system dependencies for Atlas and PostgreSQL client
RUN apk add --no-cache \
    bash \
    docker \
    docker-compose \
    postgresql-client \
    netcat-openbsd \
    && rm -rf /var/cache/apk/*

# Set working directory
WORKDIR /workspace

# Copy package files
COPY package.json ./

# Install Node.js dependencies
RUN npm install

# Copy source code
COPY . .

# Create migrations directory
RUN mkdir -p migrations

# Set environment variables
ENV NODE_ENV=development
ENV DOCKER_HOST=unix:///var/run/docker.sock

# Default command - can be overridden
CMD ["echo", "Migration generator ready. Use with specific commands."]