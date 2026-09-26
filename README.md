# cc-session

Copy [Claude Code](https://claude.com/claude-code) sessions between users or machines, with an arrow-key
interface. Uses `rsync` over `ssh`; no other dependencies.

## Install

Needs `python3` (3.8+), `rsync` (3.2.3+) and `ssh` on this machine; remote hosts need `python3` too.

```bash
git clone <this repo> && cd cc-session && ./install.sh     # -> ~/.local/bin/cc-session
```

Or a single file: copy `cc-session` anywhere on your `PATH` and `chmod +x` it.

## Use

```bash
cc-session                                   # interactive: pick from, to, project, sessions
cc-session -i ~/.ssh/key.pem                 # same, with an ssh key for remote hosts
cc-session list host:/root/.claude           # sessions on another machine
cc-session ID /root/.claude host:/root/.claude --project=-home-me-app
```

Locations are Claude config dirs: `/home/me/.claude` or `[user@]host:/path/.claude`.
`--project` is the directory name under `projects/` (your working directory with every non-alphanumeric
character replaced by `-`); use `--dest-project` if the path differs on the destination.
Hosts in `~/.ssh/config` show up in the picker. `CC_SESSION_SSH_OPTS="-p 2222"` adds ssh options.

Notes: remote listing uses `ssh -o BatchMode=yes`, so accept the host key once by hand first. Running as
root into another local user's `~/.claude` sets file ownership to that user. Existing sessions with the same
id are overwritten.

## VS Code extension

`vscode/` wraps this tool in command-palette pickers (`Claude Sessions: Copy Sessions…`, `Add Remote…`).
Build with `cd vscode && npm run package`, install with `code --install-extension cc-session-0.1.0.vsix`.
