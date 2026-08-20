#!/bin/sh
# Create the buildx builder the control plane uses for multi-arch builds.
#
# Two things are needed beyond a default builder:
#   1. QEMU emulators, so an arm64 host can produce amd64 and armv7 images.
#   2. host networking plus an insecure-registry config, because the default
#      docker-container driver runs in its own namespace where "localhost" is
#      itself, not the host's registry — and a local registry speaks HTTP.
set -eu

BUILDER="${BUILDER:-fleet-builder}"
REGISTRY="${REGISTRY:-localhost:5001}"
CONFIG="$(mktemp -d)/buildkitd.toml"

cat > "$CONFIG" <<EOF
[registry."${REGISTRY}"]
  http = true
  insecure = true
EOF

echo "installing QEMU emulators…"
docker run --privileged --rm tonistiigi/binfmt --install all >/dev/null

echo "creating builder \"${BUILDER}\"…"
docker buildx rm "$BUILDER" >/dev/null 2>&1 || true
docker buildx create --name "$BUILDER" \
  --driver docker-container \
  --driver-opt network=host \
  --config "$CONFIG" \
  --use >/dev/null

docker buildx inspect --bootstrap | grep -i platforms
echo "done — set BUILDX_BUILDER=${BUILDER} and REGISTRY_URL=${REGISTRY}"
