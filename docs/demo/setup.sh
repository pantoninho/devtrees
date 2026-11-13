# Set up the throwaway repo that docs/demo.tape records. Source it from the
# repo root (`source docs/demo/setup.sh`); docs/demo/teardown.sh undoes it.
#
# It creates, in a fresh `mktemp -d` dir outside this repo:
#   bin/devtrees   a wrapper that runs this checkout's dist/cli.mjs
#   shop/          a git repo holding docs/demo/devtrees.yaml + server.mjs
#   feature-a/     a git worktree of shop
#   feature-b/     another git worktree of shop
# and a detached tmux session (own socket, no user config) with one pane per
# worktree. It exports DEMO_DIR for teardown.sh.

DEMO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DEMO_REPO_ROOT="$(cd "$DEMO_SRC/../.." && pwd)"

if [ ! -f "$DEMO_REPO_ROOT/dist/cli.mjs" ]; then
  (cd "$DEMO_REPO_ROOT" && vp run build >/dev/null)
fi

DEMO_DIR="$(mktemp -d -t devtrees-demo)"
export DEMO_DIR

mkdir -p "$DEMO_DIR/bin"
printf '#!/bin/sh\nexec node "%s/dist/cli.mjs" "$@"\n' "$DEMO_REPO_ROOT" >"$DEMO_DIR/bin/devtrees"
chmod +x "$DEMO_DIR/bin/devtrees"

mkdir "$DEMO_DIR/shop"
cp "$DEMO_SRC/devtrees.yaml" "$DEMO_SRC/server.mjs" "$DEMO_DIR/shop/"
# An AGENTS.md that mentions devtrees keeps `up` from suggesting `init --agents`.
echo "Run the stack with devtrees." >"$DEMO_DIR/shop/AGENTS.md"
git -C "$DEMO_DIR/shop" init -q
git -C "$DEMO_DIR/shop" add .
git -C "$DEMO_DIR/shop" -c user.name=demo -c user.email=demo@example.com commit -q -m init
git -C "$DEMO_DIR/shop" worktree add -q ../feature-a -b feature-a
git -C "$DEMO_DIR/shop" worktree add -q ../feature-b -b feature-b

# One pane per worktree, stacked so `devtrees ls` rows fit the width.
DEMO_TMUX="tmux -L devtrees-demo -f /dev/null"
DEMO_SHELL="env PATH=$DEMO_DIR/bin:$PATH PS1='\\W \$ ' bash --norc --noprofile"
$DEMO_TMUX new-session -d -s demo -x 110 -y 30 -c "$DEMO_DIR/feature-a" "$DEMO_SHELL"
$DEMO_TMUX split-window -v -t demo -c "$DEMO_DIR/feature-b" "$DEMO_SHELL"
$DEMO_TMUX set -g status off
$DEMO_TMUX set -g pane-border-status top
$DEMO_TMUX set -g pane-border-format ' #{b:pane_current_path} '
$DEMO_TMUX set -g pane-active-border-style fg=green
$DEMO_TMUX select-pane -t demo:0.0
