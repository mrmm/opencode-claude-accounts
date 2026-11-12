# The real OpenCode TUI with this plugin, in the $HOME seed.sh prepared.
# OpenCode's free model answers the prompt: the sidebar lives in a session.
#   HOME=<fake-home> vhs scripts/tui-capture/sidebar.tape

Output shots/tui.gif
Set Shell "bash"
Set Width 1600
Set Height 900
Set FontSize 16
Set Padding 16
Set Theme "Catppuccin Mocha"

Hide
Type "mkdir -p /tmp/demo && cd /tmp/demo && opencode" Enter
Sleep 10s
Type "hello" Enter
Sleep 10s
Show
Sleep 1s
Screenshot shots/tui.png
