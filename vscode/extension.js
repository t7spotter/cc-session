const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");

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

async function copy(ctx) {
  const src = await pickLocation(ctx, "Copy FROM");
  if (!src) return;
  const proj = await pickProject(ctx, `Project on ${src}`, src, currentProject());
  if (!proj) return;
  const rows = await busy("Loading sessions …", () => api(ctx, "sessions", src, `--project=${proj}`));
  if (!rows.length) return vscode.window.showWarningMessage(`No sessions in ${src}/projects/${proj}`);
  const chosen = await vscode.window.showQuickPick(
    rows.map((r) => ({ label: r.title || r.id.slice(0, 8), description: `${r.modified}  ${r.mb} MB`, detail: r.id, id: r.id })),
    { title: `Sessions to copy (${rows.length})`, canPickMany: true, matchOnDetail: true, ignoreFocusOut: true });
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

const guard = (ctx, fn) => async () => {
  try {
    await fn(ctx);
  } catch (e) {
    output.appendLine("error: " + e.message);
    vscode.window.showErrorMessage("Claude Sessions: " + e.message, "Show log").then((b) => b && output.show());
  }
};

exports.activate = (ctx) => {
  output = vscode.window.createOutputChannel("Claude Sessions");
  ctx.subscriptions.push(
    output,
    vscode.commands.registerCommand("ccSession.copy", guard(ctx, copy)),
    vscode.commands.registerCommand("ccSession.addRemote", guard(ctx, async (c) => {
      const name = await addRemote(c);
      if (name) vscode.window.showInformationMessage(`Saved remote "${name}".`);
    })));
};
exports.deactivate = () => {};
