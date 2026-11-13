#!/usr/bin/env bash
# Build the multi-arch image and push it, the same way as the other cp0x pi-* interfaces:
#   docker/build.sh 0.1.0
# Set PUSH=0 to build for this machine only and load the image into the local Docker instead.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.1.3"
  exit 1
fi

VERSION="$1"
IMAGE="cp0x/pi-swap-interface"
PLATFORMS="linux/amd64,linux/arm64"
cd "$(dirname "$0")/.."

if [ "${PUSH:-1}" = "0" ]; then
  echo "Building $IMAGE:$VERSION for this machine..."
  docker buildx build --load -t "$IMAGE:$VERSION" .
  echo "Built $IMAGE:$VERSION (not pushed)"
  exit 0
fi

echo "Building version $VERSION..."
docker buildx build \
  --platform "$PLATFORMS" \
  -t "$IMAGE:$VERSION" \
  --push \
  .

echo "Successfully built and pushed $IMAGE:$VERSION"
