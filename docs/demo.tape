# Records docs/demo.gif: two git worktrees of one repo, each running its own
# stack, plus one shared service. Render from the repo root with:
#
#   vhs docs/demo.tape
#
# Needs vhs, tmux, process-compose and Node. docs/demo/setup.sh builds this
# checkout if needed and puts its devtrees first on PATH, so the recording uses
# this checkout rather than a global install. Everything it creates lives in a
# `mktemp -d` dir that docs/demo/teardown.sh stops and deletes.

Output docs/demo.gif

Set Shell bash
Set FontSize 16
Set Width 1100
Set Height 660
Set Padding 16
Set TypingSpeed 35ms
Set Framerate 20
Set WaitTimeout 30s

Hide
Type "source docs/demo/setup.sh && tmux -L devtrees-demo attach -t demo"
Enter
Sleep 1.5s
Show

# Pane 1: worktree feature-a.
Type "devtrees up --no-attach"
Enter
Wait+Screen /feature-a-\w+' is up/
Sleep 1s

# Pane 2: worktree feature-b. Same config, same command.
Ctrl+B
Type "o"
Type "devtrees up --no-attach"
Enter
Wait+Screen /feature-b-\w+' is up/
Sleep 1s

Type "devtrees ls"
Enter
Sleep 3s

# Each worktree's web answers on its own port.
Ctrl+B
Type "o"
Type `eval "$(devtrees env)"; curl -s localhost:$WEB_PORT`
Enter
Sleep 1.5s
Ctrl+B
Type "o"
Type `eval "$(devtrees env)"; curl -s localhost:$WEB_PORT`
Enter
Sleep 4s

Hide
Ctrl+B
Type "d"
Type `bash docs/demo/teardown.sh "$DEMO_DIR"`
Enter
Sleep 4s
