#!/bin/sh
# Runs first in the container. A freshly attached volume belongs to root, and
# the server runs as the unprivileged user "node": hand the data folder over,
# then become that user and never look back.
set -eu
DATA_DIR="$(dirname "${DATABASE_PATH:-/data/globalconnect.sqlite}")"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  chmod 0700 "$DATA_DIR"
  # For the operator commands (`gc ...` from `fly ssh console`): a shell opened that way may not have the app's
  # secrets in its environment. The few they need are kept in a file only root can read, in the machine's own
  # temporary storage (never on the data volume, never in the image).
  umask 077
  mkdir -p /run
  : > /run/gc.env
  for NAME in DATA_ENCRYPTION_KEY DATA_ENCRYPTION_KEY_PREVIOUS ADMIN_TOKEN ADMIN_PORT DATABASE_PATH APP_ENV; do
    eval "VALUE=\${$NAME:-}"
    if [ -n "$VALUE" ]; then printf "%s='%s'\n" "$NAME" "$(printf '%s' "$VALUE" | sed "s/'/'\\\\''/g")" >> /run/gc.env; fi
  done
  umask 022
  exec setpriv --reuid=node --regid=node --init-groups --no-new-privs "$@"
fi
exec "$@"
