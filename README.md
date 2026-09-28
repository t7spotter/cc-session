# Claude Sessions

A VS Code extension that browses, opens, copies and deletes
[Claude Code](https://claude.com/claude-code) sessions across users and machines, from a sidebar.

- **Browse:** an activity-bar panel lists every machine (this one, saved remotes, `~/.ssh/config`
  hosts), and each machine's Claude projects and sessions.
- **Open:** click a session to read its conversation, as a Markdown tab. Works for sessions on
  remote machines too.
- **Copy:** move a session between users or machines, including between two remote machines
  (staged through this one). Uses `rsync` over `ssh`.
- **Delete:** permanently remove a session, with a confirmation.
- **Remotes:** add an `ssh` login (with an optional `.pem` key) from the sidebar; it's saved for
  next time.
- **Updates:** a button checks GitHub for a newer release and can install it for you.

## Install

Download the `.vsix` from the [latest release](https://github.com/t7spotter/cc-session/releases/latest)
and run:

```bash
code --install-extension cc-session-*.vsix
```

Then open the "Claude Sessions" icon in the activity bar. Needs `python3` (3.8+), `rsync` (any
version, including the 2.6.9 that macOS ships) and `ssh` on this machine; remote hosts need
`python3` too. After install, the "Check for Updates" button in the sidebar can update the
extension itself.

## Privacy and safety

Session files contain your **full conversations, file contents, command output and possibly
secrets** that appeared in them. This extension sends nothing anywhere except the machines *you*
pick, over your own ssh, plus one read-only request to GitHub's release API when you press "Check
for Updates". It has no telemetry. Before you share a session file, a screenshot or a bug report,
look through it. Never commit `~/.claude` or copied sessions to a public repo. Saved remotes
(`~/.config/cc-session/hosts.json`, mode 600) hold host names and key *paths*, never key contents.
Delete is permanent (no trash), and it asks for confirmation first.

## Development

`vscode/cc-session` is the engine (listing, ssh, rsync); `vscode/extension.js` is the UI, and
shells out to it. Build and install a local copy:

```bash
cd vscode
npm run package             # bundles vscode/cc-session into bin/, writes cc-session-*.vsix
code --install-extension cc-session-*.vsix
```

Settings: `ccSession.path` (use another cc-session binary instead of the bundled one),
`ccSession.pythonPath`.
