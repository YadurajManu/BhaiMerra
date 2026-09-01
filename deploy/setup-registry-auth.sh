#!/bin/sh
# Generate credentials for the fleet registry.
#
#   ./setup-registry-auth.sh
#
# The registry has no access control of its own. That is survivable while it
# only listens on a LAN, and not survivable the moment it is reachable from
# anywhere else — anyone who finds the address could pull every image you have
# built, and push whatever they liked for your nodes to run.
#
# Writes deploy/registry-auth/htpasswd, which is gitignored, and prints the
# REGISTRY_CREDENTIALS line for your .env. Run it once per deployment; the
# password is shown only here.
set -eu

cd "$(dirname "$0")"

USER_NAME="${1:-fleet}"
AUTH_DIR="registry-auth"

if [ -f "$AUTH_DIR/htpasswd" ]; then
  printf 'registry-auth/htpasswd already exists.\n'
  printf 'Delete it first if you mean to rotate the credential — every node\n'
  printf 'and the control plane will need the new one.\n'
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  printf 'docker is required to generate a bcrypt htpasswd entry.\n' >&2
  exit 1
}

PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40)

mkdir -p "$AUTH_DIR"
# registry:2 requires bcrypt; the httpd image is the least surprising way to
# produce one without depending on a local apache2-utils.
docker run --rm --entrypoint htpasswd httpd:2-alpine \
  -Bbn "$USER_NAME" "$PASSWORD" > "$AUTH_DIR/htpasswd"
chmod 600 "$AUTH_DIR/htpasswd"

printf '\n  wrote %s/htpasswd\n\n' "$AUTH_DIR"
printf '  Add this to deploy/.env — it is not stored anywhere else:\n\n'
printf '    REGISTRY_CREDENTIALS=%s:%s\n\n' "$USER_NAME" "$PASSWORD"
printf '  Then: docker compose up -d registry control-plane\n\n'
