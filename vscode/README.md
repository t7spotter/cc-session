# Claude Sessions Transfer (VS Code)

Copy Claude Code sessions between users or machines from the command palette
(`Claude Sessions: Copy Sessions…`, `Claude Sessions: Add Remote…`).

It drives the `cc-session` tool in the parent folder: remotes are saved in `~/.config/cc-session/hosts.json`
(shared with the CLI), Claude data is auto-discovered, and files move with `rsync` over `ssh`.
Needs `python3`, `rsync` (3.2.3+) and `ssh` on this machine, and `python3` on remote ones. macOS/Linux (or WSL).

## Build and install

```bash
cd vscode
npm run package            # copies ../cc-session into bin/ and writes cc-session-0.1.0.vsix
code --install-extension cc-session-0.1.0.vsix
```

Settings: `ccSession.path` (use another cc-session binary), `ccSession.pythonPath`.
