const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");

const LOCAL = "@local";
let output;

// The bundled cc-session does all the work (listing, ssh, rsync); this file is only the UI.
function ccCommand(ctx) {
  const cfg = vscode.workspace.getConfiguration("ccSession");
  const custom = cfg.get("path");
  if (custom) return [custom];
  const bundled = path.join(ctx.extensionPath, "bin", "cc-session");
  if (!fs.existsSync(bundled)) throw new Error("bin/cc-session is missing; run `npm run prepackage` in the extension folder.");
  return [cfg.get("pythonPath") || "python3", bundled];
}

function run(ctx, args) {
  const [cmd, ...pre] = ccCommand(ctx);
  output.appendLine("$ cc-session " + args.join(" "));
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, [...pre, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stderr) output.appendLine(stderr.trim());
      if (err) return reject(new Error((stderr || err.message).replace(/^error:\s*/, "").trim()));
      resolve(stdout);
    });
  });
}

const api = async (ctx, ...args) => JSON.parse(await run(ctx, ["api", ...args]));
const loc = (machine, dir) => (machine === LOCAL ? dir : `${machine}:${dir}`);
const busy = (title, fn) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
const currentProject = () => {
  const f = vscode.workspace.workspaceFolders;
  return f ? f[0].uri.fsPath.replace(/[^A-Za-z0-9]/g, "-") : "";
};

async function addRemote(ctx) {
  const login = await vscode.window.showInputBox({ title: "Add remote", prompt: "Login, e.g. root@1.2.3.4 (or user@host:2222)", ignoreFocusOut: true });
  if (!login) return;
  const keys = await api(ctx, "keys");
  const pick = await vscode.window.showQuickPick(
    [...keys.map((k) => ({ label: k, key: k })), { label: "No key file (ssh agent / default keys)", key: "" }, { label: "Other… (type a path)", key: null }],
    { title: `SSH key for ${login}`, ignoreFocusOut: true });
  if (!pick) return;
  let key = pick.key;
  if (key === null) {
    key = await vscode.window.showInputBox({ title: "Path to the private key (.pem)", ignoreFocusOut: true });
    if (key === undefined) return;
  }
  const m = login.match(/^(.*?)(?::(\d+))?$/);
  const name = await vscode.window.showInputBox({ title: "Name for this remote", value: m[1].split("@").pop(), ignoreFocusOut: true, validateInput: (v) => (/^[^/:\s]+$/.test(v) ? null : "No spaces, / or :") });
  if (!name) return;
  const args = ["remote", "add", name, m[1]];
  if (key) args.push("-i", key);
  if (m[2]) args.push("--port", m[2]);
  await busy(`Connecting to ${m[1]} …`, () => run(ctx, args));
  return name;
}

async function pickMachine(ctx, title) {
  const machines = await api(ctx, "machines");
  const pick = await vscode.window.showQuickPick(
    [...machines.map((x) => ({ label: x.label, name: x.name })), { label: "$(add) Add remote…", name: null }],
    { title, ignoreFocusOut: true });
  if (!pick) return;
  return pick.name === null ? addRemote(ctx) : pick.name;
}

async function pickLocation(ctx, title) {
  for (;;) {
    const machine = await pickMachine(ctx, `${title}: which machine?`);
    if (!machine) return;
    let dirs = await busy("Looking for Claude data …", () => api(ctx, "dirs", machine));
    if (dirs.length === 1) return loc(machine, dirs[0]);
    for (;;) {
      const pick = await vscode.window.showQuickPick(
        [...dirs.map((d) => ({ label: d, dir: d })), { label: "$(search) Scan the whole machine…", dir: "@scan" }, { label: "$(edit) Type a path…", dir: "@type" }],
        { title: `${title}: which Claude config dir?`, ignoreFocusOut: true });
      if (!pick) break;
      if (pick.dir === "@scan") {
        dirs = await busy("Scanning for .claude folders …", () => api(ctx, "scan", machine));
        continue;
      }
      if (pick.dir === "@type") {
        const typed = await vscode.window.showInputBox({ title: "Path of the .claude dir on that machine", ignoreFocusOut: true });
        if (!typed) continue;
        return loc(machine, typed);
      }
      return loc(machine, pick.dir);
    }
  }
}

async function pickProject(ctx, title, where, prefer, sameAs) {
  const projs = await busy("Loading projects …", () => api(ctx, "projects", where));
  projs.sort((a, b) => (a.name === prefer ? -1 : b.name === prefer ? 1 : a.name.localeCompare(b.name)));
  const items = projs.filter((p) => p.name !== sameAs).map((p) => ({ label: p.name, description: `${p.sessions} sessions`, name: p.name }));
  if (sameAs) items.unshift({ label: sameAs, description: "same as source", name: sameAs });
  items.push({ label: "$(edit) Other… (type a project directory name)", name: null });
  const pick = await vscode.window.showQuickPick(items, { title, ignoreFocusOut: true });
  if (!pick) return;
  if (pick.name !== null) return pick.name;
  return vscode.window.showInputBox({ title, value: prefer, ignoreFocusOut: true });
}

async function copy(ctx, node) {
  // From the sidebar the source, project and (for a session node) the session are already known.
  const src = node ? node.where : await pickLocation(ctx, "Copy FROM");
  if (!src) return;
  const proj = node ? node.project : await pickProject(ctx, `Project on ${src}`, src, currentProject());
  if (!proj) return;
  let chosen;
  if (node && node.sessionId) {
    chosen = [{ id: node.sessionId }];
  } else {
    const rows = await busy("Loading sessions …", () => api(ctx, "sessions", src, `--project=${proj}`));
    if (!rows.length) return vscode.window.showWarningMessage(`No sessions in ${src}/projects/${proj}`);
    chosen = await vscode.window.showQuickPick(
      rows.map((r) => ({ label: r.title || r.id.slice(0, 8), description: `${r.modified}  ${r.mb} MB`, detail: r.id, id: r.id })),
      { title: `Sessions to copy (${rows.length})`, canPickMany: true, matchOnDetail: true, ignoreFocusOut: true });
  }
  if (!chosen || !chosen.length) return;
  let dst;
  for (;;) {
    dst = await pickLocation(ctx, "Copy TO");
    if (!dst) return;
    if (dst !== src) break;
    vscode.window.showWarningMessage("Destination is the same as the source.");
  }
  let dproj = proj;
  for (;;) {
    const action = await vscode.window.showQuickPick(
      [{ label: "Copy", a: "go" }, { label: "Dry run (copy nothing)", a: "dry" }, { label: `Destination project: ${dproj}`, description: "change…", a: "proj" }],
      { title: `Copy ${chosen.length} session(s): ${src} → ${dst}`, ignoreFocusOut: true });
    if (!action) return;
    if (action.a === "proj") {
      dproj = (await pickProject(ctx, `Project on destination ${dst}`, dst, proj, proj)) || dproj;
      continue;
    }
    const dry = action.a === "dry";
    await busy(`${dry ? "Dry run: " : ""}copying ${chosen.length} session(s) …`, async () => {
      for (const c of chosen) await run(ctx, [c.id, src, dst, `--project=${proj}`, `--dest-project=${dproj}`, ...(dry ? ["-n"] : [])]);
    });
    vscode.window.showInformationMessage(`${dry ? "Dry run done. " : ""}${chosen.length} session(s) ${dry ? "would be " : ""}copied to ${dst}. Restart or re-open Claude Code there to see them.`);
    return;
  }
}

async function del(ctx, node) {
  const src = node ? node.where : await pickLocation(ctx, "Delete FROM");
  if (!src) return;
  const proj = node ? node.project : await pickProject(ctx, `Project on ${src}`, src, currentProject());
  if (!proj) return;
  let chosen;
  if (node && node.sessionId) {
    chosen = [{ id: node.sessionId, label: node.label }];
  } else {
    const rows = await busy("Loading sessions …", () => api(ctx, "sessions", src, `--project=${proj}`));
    if (!rows.length) return vscode.window.showWarningMessage(`No sessions in ${src}/projects/${proj}`);
    chosen = await vscode.window.showQuickPick(
      rows.map((r) => ({ label: r.title || r.id.slice(0, 8), description: `${r.modified}  ${r.mb} MB`, detail: r.id, id: r.id })),
      { title: "Sessions to DELETE", canPickMany: true, matchOnDetail: true, ignoreFocusOut: true });
  }
  if (!chosen || !chosen.length) return;
  const ok = await vscode.window.showWarningMessage(
    `Permanently delete ${chosen.length} session(s) from ${src}? This cannot be undone.`, { modal: true }, "Delete");
  if (ok !== "Delete") return;
  await busy("Deleting …", async () => {
    for (const c of chosen) await run(ctx, ["delete", c.id, src, `--project=${proj}`, "-y"]);
  });
  vscode.window.showInformationMessage(`${chosen.length} session(s) deleted from ${src}.`);
  vscode.commands.executeCommand("ccSession.refresh");
}

// Sidebar: machine > Claude config dir > project > session. Every node carries the location it came from.
class SessionTree {
  constructor(ctx) {
    this.ctx = ctx;
    this._changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._changed.event;
  }
  refresh() { this._changed.fire(); }
  getTreeItem(node) { return node; }

  node(label, state, icon, props) {
    const n = new vscode.TreeItem(label, state);
    n.iconPath = new vscode.ThemeIcon(icon);
    return Object.assign(n, props);
  }

  async getChildren(parent) {
    const C = vscode.TreeItemCollapsibleState;
    try {
      if (!parent) {
        return (await api(this.ctx, "machines")).map((m) =>
          this.node(m.label, C.Collapsed, m.name === LOCAL ? "home" : "server-environment", { kind: "machine", machine: m.name }));
      }
      if (parent.kind === "machine") {
        const dirs = await api(this.ctx, "dirs", parent.machine);
        if (!dirs.length) return [this.node("No Claude data found", C.None, "info", {})];
        return dirs.map((d) => this.node(d, C.Collapsed, "root-folder", { kind: "dir", where: loc(parent.machine, d) }));
      }
      if (parent.kind === "dir") {
        return (await api(this.ctx, "projects", parent.where)).map((p) =>
          this.node(p.name, C.Collapsed, "folder", { kind: "project", where: parent.where, project: p.name, description: `${p.sessions}`, contextValue: "project" }));
      }
      if (parent.kind === "project") {
        return (await api(this.ctx, "sessions", parent.where, `--project=${parent.project}`)).map((r) =>
          this.node(r.title || r.id.slice(0, 8), C.None, "comment-discussion", {
            kind: "session", where: parent.where, project: parent.project, sessionId: r.id,
            description: `${r.modified}  ${r.mb} MB`, tooltip: r.id, contextValue: "session" }));
      }
    } catch (e) {
      output.appendLine("error: " + e.message);
      return [this.node(e.message, C.None, "error", {})];
    }
    return [];
  }
}

// ~/.ssh/config on the machine the extension runs on, which is where cc-session reads its hosts from.
async function openSshConfig() {
  const file = path.join(os.homedir(), ".ssh", "config");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, "# Host myserver\n#   HostName 1.2.3.4\n#   User root\n#   IdentityFile ~/.ssh/key.pem\n", { mode: 0o600 });
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
}

function latestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get("https://api.github.com/repos/t7spotter/cc-session/releases/latest",
      { headers: { "User-Agent": "cc-session-vscode", Accept: "application/vnd.github+json" }, timeout: 10000 }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`GitHub answered ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
    req.on("timeout", () => req.destroy(new Error("GitHub did not answer in time")));
    req.on("error", reject);
  });
}

// GitHub serves release assets through a redirect to another host.
function download(url, file, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error("too many redirects"));
    https.get(url, { headers: { "User-Agent": "cc-session-vscode" }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, file, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download failed: ${res.statusCode}`)); }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
    }).on("error", reject).on("timeout", function () { this.destroy(new Error("download timed out")); });
  });
}

const newer = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function checkUpdate(ctx) {
  const rel = await busy("Checking for updates …", latestRelease);
  const latest = String(rel.tag_name || "").replace(/^v/, "");
  const mine = ctx.extension.packageJSON.version;
  if (!newer(latest, mine)) return vscode.window.showInformationMessage(`Claude Sessions ${mine} is up to date.`);
  const asset = (rel.assets || []).find((x) => /\.vsix$/.test(x.name));
  const pick = await vscode.window.showInformationMessage(
    `Claude Sessions ${latest} is available (you have ${mine}).`, ...(asset ? ["Update now"] : []), "Release page");
  if (pick === "Release page") return vscode.env.openExternal(vscode.Uri.parse(rel.html_url));
  if (pick !== "Update now") return;
  const file = path.join(os.tmpdir(), asset.name);
  await busy(`Downloading ${asset.name} …`, () => download(asset.browser_download_url, file));
  await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(file));
  fs.rmSync(file, { force: true });
  const r = await vscode.window.showInformationMessage(`Claude Sessions ${latest} installed. Reload the window to use it.`, "Reload Window");
  if (r) vscode.commands.executeCommand("workbench.action.reloadWindow");
}

const guard = (ctx, fn) => async (...args) => {
  try {
    await fn(ctx, ...args);
  } catch (e) {
    output.appendLine("error: " + e.message);
    vscode.window.showErrorMessage("Claude Sessions: " + e.message, "Show log").then((b) => b && output.show());
  }
};

exports.activate = (ctx) => {
  output = vscode.window.createOutputChannel("Claude Sessions");
  const tree = new SessionTree(ctx);
  ctx.subscriptions.push(
    output,
    vscode.window.createTreeView("ccSessionTree", { treeDataProvider: tree }),
    vscode.commands.registerCommand("ccSession.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("ccSession.copy", guard(ctx, copy)),
    vscode.commands.registerCommand("ccSession.openSshConfig", guard(ctx, openSshConfig)),
    vscode.commands.registerCommand("ccSession.checkUpdate", guard(ctx, checkUpdate)),
    vscode.commands.registerCommand("ccSession.delete", guard(ctx, del)),
    vscode.commands.registerCommand("ccSession.addRemote", guard(ctx, async (c) => {
      const name = await addRemote(c);
      if (name) {
        vscode.window.showInformationMessage(`Saved remote "${name}".`);
        tree.refresh();
      }
    })));
};
exports.deactivate = () => {};
