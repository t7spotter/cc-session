const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");

const LOCAL = "@local";
let output;

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

// Tree view provider for the sidebar
class SessionTreeProvider {
  constructor(ctx) {
    this.ctx = ctx;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.refresh = () => this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (!element) {
      return [
        new vscode.TreeItem("$(refresh) Refresh", vscode.TreeItemCollapsibleState.None),
        new vscode.TreeItem("$(add) Add remote", vscode.TreeItemCollapsibleState.None),
        new vscode.TreeItem("", vscode.TreeItemCollapsibleState.None),
        ...(await this.getMachines())
      ];
    }
    if (element.label === "$(refresh) Refresh") return [];
    if (element.label === "$(add) Add remote") return [];
    if (element.contextValue === "machine") return this.getProjects(element.machine);
    if (element.contextValue === "project") return this.getSessions(element.machine, element.project);
    return [];
  }

  async getMachines() {
    try {
      const machines = await api(this.ctx, "machines");
      return machines.map((m) => {
        const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "machine";
        item.machine = m.name;
        item.iconPath = new vscode.ThemeIcon(m.name === LOCAL ? "home" : "server-environment");
        return item;
      });
    } catch (e) {
      const item = new vscode.TreeItem("$(error) " + e.message, vscode.TreeItemCollapsibleState.None);
      return [item];
    }
  }

  async getProjects(machine) {
    try {
      const where = machine === LOCAL ? "/root/.claude" : `${machine}:/root/.claude`;
      const projs = await busy("Loading projects …", () => api(this.ctx, "projects", where));
      return projs.map((p) => {
        const item = new vscode.TreeItem(`${p.name} (${p.sessions})`, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = "project";
        item.machine = machine;
        item.project = p.name;
        item.iconPath = new vscode.ThemeIcon("folder");
        return item;
      });
    } catch (e) {
      const item = new vscode.TreeItem("$(error) " + e.message, vscode.TreeItemCollapsibleState.None);
      return [item];
    }
  }

  async getSessions(machine, project) {
    try {
      const where = machine === LOCAL ? "/root/.claude" : `${machine}:/root/.claude`;
      const rows = await busy("Loading sessions …", () => api(this.ctx, "sessions", where, `--project=${project}`));
      return rows.map((r) => {
        const item = new vscode.TreeItem(r.title || r.id.slice(0, 8), vscode.TreeItemCollapsibleState.None);
        item.description = `${r.modified}  ${r.mb} MB`;
        item.contextValue = "session";
        item.machine = machine;
        item.project = project;
        item.sessionId = r.id;
        item.tooltip = r.id;
        item.iconPath = new vscode.ThemeIcon("file-code");
        item.command = { title: "Copy", command: "ccSession.copyOne", arguments: [machine, project, r.id] };
        return item;
      });
    } catch (e) {
      const item = new vscode.TreeItem("$(error) " + e.message, vscode.TreeItemCollapsibleState.None);
      return [item];
    }
  }
}

async function copyOne(ctx, fromMachine, fromProject, sessionId) {
  const machines = await api(ctx, "machines");
  const toMachine = await vscode.window.showQuickPick(
    machines.filter((m) => m.name !== fromMachine).map((m) => ({ label: m.label, name: m.name })),
    { title: "Copy to which machine?", ignoreFocusOut: true });
  if (!toMachine) return;

  const where = toMachine.name === LOCAL ? "/root/.claude" : `${toMachine.name}:/root/.claude`;
  const projs = await busy("Loading projects …", () => api(ctx, "projects", where));
  const toProject = await vscode.window.showQuickPick(
    projs.map((p) => ({ label: p.name, name: p.name })),
    { title: "To which project?", ignoreFocusOut: true });
  if (!toProject) return;

  const action = await vscode.window.showQuickPick([{ label: "Copy", a: "go" }, { label: "Dry run", a: "dry" }], { ignoreFocusOut: true });
  if (!action) return;

  const fromLoc = fromMachine === LOCAL ? "/root/.claude" : `${fromMachine}:/root/.claude`;
  const toLoc = toMachine.name === LOCAL ? "/root/.claude" : `${toMachine.name}:/root/.claude`;
  await busy(`${action.a === "dry" ? "Dry run: " : ""}copying session …`, () =>
    run(ctx, [sessionId, fromLoc, toLoc, `--project=${fromProject}`, `--dest-project=${toProject.name}`, ...(action.a === "dry" ? ["-n"] : [])]));

  vscode.window.showInformationMessage(`${action.a === "dry" ? "Dry run done. " : ""}Session ${action.a === "dry" ? "would be " : ""}copied.`);
}

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
  vscode.window.showInformationMessage(`Saved remote "${name}".`);
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
  const treeProvider = new SessionTreeProvider(ctx);

  ctx.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider("ccSessionTree", treeProvider),
    vscode.commands.registerCommand("ccSession.refresh", () => treeProvider.refresh()),
    vscode.commands.registerCommand("ccSession.addRemote", guard(ctx, addRemote)),
    vscode.commands.registerCommand("ccSession.copyOne", guard(ctx, copyOne)),
    vscode.commands.registerTreeViewItemCommand("ccSession.refresh", () => treeProvider.refresh()),
    vscode.commands.registerTreeViewItemCommand("ccSession.addRemote", guard(ctx, addRemote)));
};
exports.deactivate = () => {};
