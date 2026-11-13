#!/usr/bin/env bash
# Tear down what docs/demo/setup.sh created: stop both worktree instances and
# the shared instance, kill the tmux session, check that no process-compose
# from the demo is left, and delete the temp dir.
# Usage: bash docs/demo/teardown.sh "$DEMO_DIR"
set -u
DEMO_DIR="${1:?usage: teardown.sh <demo dir>}"
DEVTREES="$DEMO_DIR/bin/devtrees"

for wt in feature-a feature-b; do
  (cd "$DEMO_DIR/$wt" && "$DEVTREES" down >/dev/null)
done
(cd "$DEMO_DIR/shop" && "$DEVTREES" down --shared >/dev/null)
tmux -L devtrees-demo kill-server 2>/dev/null

# The demo dir name is unique, so any process-compose still naming it is ours.
left="$(pgrep -f "process-compose.*$(basename "$DEMO_DIR")" || true)"
if [ -n "$left" ]; then
  echo "teardown: process-compose still running: $left" >&2
  exit 1
fi
rm -rf "$DEMO_DIR"
