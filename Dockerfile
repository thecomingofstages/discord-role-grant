# Multi-stage would shave a few MB off but adds complexity; for a small bot
# a single stage is fine. Pinning the base image keeps Node + cloudflared
# reproducible across Railway's rebuilds.
FROM node:22-bookworm-slim

# The slim base image strips curl/wget/ca-certificates, so we have to add
# them back to download cloudflared. apt-get clean keeps the image small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install cloudflared from Cloudflare's official GitHub release. Using the
# exact URL (not /latest) keeps builds deterministic; bump the version
# intentionally when you want to upgrade.
ARG CLOUDFLARED_VERSION=2026.7.3
RUN curl -fsSL -o /tmp/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
 && install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared \
 && rm /tmp/cloudflared \
 && cloudflared --version

WORKDIR /app

# Install only production deps; this layer is cached as long as
# package.json/package-lock.json don't change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the source. start.sh and config.yml live at the repo
# root next to package.json so this picks them up automatically.
COPY . .

# Ensure start.sh stays executable after COPY (some filesystems strip the bit).
RUN chmod +x ./start.sh

# Start both processes via start.sh so a failure in either kills the container
# and Railway's restart policy takes over. See start.sh for the trap/wait logic.
CMD ["./start.sh"]
