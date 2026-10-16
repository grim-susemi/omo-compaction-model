// Isolated one-shot check: temp agent dir, RPC session, two prompts, one manual compaction.
// Usage: node run-isolated.mjs <sessionModel> <evidenceDir>
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, appendFileSync, rmSync, cpSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [sessionModel, evidence, candidateFile = "omo-compaction-model.ts", override] = process.argv.slice(2);
const LIVE_AGENT = process.env.OMO_TEST_SOURCE_AGENT_DIR;
const CLI = process.env.SENPI_CLI;
const BUN = process.env.BUN ?? "bun";
if (!sessionModel || !evidence || !override || !LIVE_AGENT || !CLI) {
  console.error("usage: OMO_TEST_SOURCE_AGENT_DIR=<dir> SENPI_CLI=<cli.js> node run-isolated.mjs <sessionModel> <evidenceDir> <extensionFile> <overrideModel>");
  process.exit(2);
}
const DEADLINE_MS = 58_000;

mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "cmp-iso-"));
const agent = join(root, "agent");
const work = join(root, "work");
const home = join(root, "home");
for (const d of [agent, work, home]) mkdirSync(d, { recursive: true });
copyFileSync(join(LIVE_AGENT, "auth.json"), join(agent, "auth.json"));
for (const f of ["models.json", "models-store.json", "models.yml"]) copyFileSync(join(LIVE_AGENT, f), join(agent, f));
let hangServer;
const hangSockets = new Set();
if (override.startsWith("omo-test-hang/")) {
  hangServer = createServer((socket) => { hangSockets.add(socket); socket.on("error", () => {}); });
  await new Promise((resolve) => hangServer.listen(0, "127.0.0.1", resolve));
}
if (override.startsWith("omo-test-dead/") || hangServer) {
  const provider = override.slice(0, override.indexOf("/"));
  const id = override.slice(override.indexOf("/") + 1);
  const port = hangServer ? hangServer.address().port : 9;
  const models = JSON.parse(readFileSync(join(agent, "models.json"), "utf8"));
  models.providers[provider] = {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "isolated-test",
    models: [{ id, name: id, contextWindow: 128000, maxTokens: 8192 }],
  };
  writeFileSync(join(agent, "models.json"), JSON.stringify(models, null, 2));
}
const AUTO = process.env.OMO_TEST_AUTO === "1";
if (AUTO) {
  const [sp, sid] = [sessionModel.slice(0, sessionModel.indexOf("/")), sessionModel.slice(sessionModel.indexOf("/") + 1)];
  const models = JSON.parse(readFileSync(join(agent, "models.json"), "utf8"));
  const entry = models.providers?.[sp]?.models?.find((m) => m.id === sid);
  if (!entry) throw new Error(`auto mode: ${sessionModel} not in temp models.json`);
  entry.contextWindow = 72000;
  writeFileSync(join(agent, "models.json"), JSON.stringify(models, null, 2));
}
writeFileSync(join(agent, "settings.json"), JSON.stringify({
  compaction: { enabled: true, model: override, keepRecentTokens: 1 },
}, null, 2));

const receipt = join(evidence, "receipt.jsonl");
const rpcLog = join(evidence, "rpc.jsonl");
const env = {
  ...process.env,
  HOME: home, USERPROFILE: home,
  SENPI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, OMO_CODING_AGENT_DIR: agent,
  OMO_COMPACTION_MODEL_RECEIPT: receipt,
};
const args = [CLI, "--mode", "rpc", "--model", sessionModel,
  "--session-dir", join(evidence, "sessions"),
  "-e", join(here, "..", "src", candidateFile),
  "-e", join(here, "probe-provider-requests.ts")];
const child = spawn(BUN, args, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
appendFileSync(receipt, `${JSON.stringify({ at: new Date().toISOString(), driver: "spawned", pid: child.pid, sessionModel })}\n`);

const killOwn = () => {
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
};
const timer = setTimeout(() => { appendFileSync(receipt, `${JSON.stringify({ driver: "deadline-kill", pid: child.pid })}\n`); killOwn(); }, DEADLINE_MS);

let buf = "";
const waiters = [];
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    appendFileSync(rpcLog, `${line}\n`);
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  }
});
child.stderr.on("data", (c) => appendFileSync(join(evidence, "stderr.log"), c));
child.on("exit", (code) => { for (const w of waiters.splice(0)) w.resolve({ type: "child_exit", code }); });
const send = (cmd) => child.stdin.write(`${JSON.stringify(cmd)}\n`);
const waitFor = (match) => new Promise((resolve) => waiters.push({ match, resolve }));
const prompt = async (id, message) => {
  let started = false;
  const end = waitFor((m) => {
    if (m.type === "response" && m.id === id && !m.success) return true;
    if (m.type === "message_end" && m.message?.role === "user" && JSON.stringify(m.message.content).includes(message.slice(0, 40))) started = true;
    return started && m.type === "agent_idle";
  });
  send({ id, type: "prompt", message });
  const m = await end;
  if (m.type !== "agent_idle") throw new Error(`prompt ${id} failed: ${m.error ?? m.type}`);
};

try {
  if (AUTO) {
    const filler = (tag) => Array.from({ length: 1500 }, (_, i) => `${tag} log line ${i}: status nominal, value ${(i * 37) % 1000}.`).join("\n");
    const autoEnd = waitFor((m) => m.type === "compaction_end");
    await prompt("p1", `Remember the code word MANGO. Below is a log for later; do not analyze it. Reply with OK only.\n${filler("alpha")}`);
    await prompt("p2", `Remember a second code word KIWI. Another log; do not analyze it. Reply with OK only.\n${filler("beta")}`);
    const quick = await Promise.race([autoEnd, new Promise((r) => setTimeout(() => r(undefined), 8000))]);
    if (!quick) await prompt("p3", "Which two code words did I give you? Answer in one line.");
    const end = quick ?? await Promise.race([autoEnd, new Promise((r) => setTimeout(() => r({ type: "no-auto-compaction" }), 15000))]);
    appendFileSync(receipt, `${JSON.stringify({ at: new Date().toISOString(), driver: "auto-compaction-end", type: end.type, reason: end.reason ?? null, accepted: end.accepted ?? null, details: end.result?.details ?? null })}\n`);
    throw Object.assign(new Error("auto-done"), { autoDone: true });
  }
  await prompt("p1", "Remember the code word MANGO. Reply with one short sentence.");
  await prompt("p2", "Now remember a second code word KIWI. Reply with one short sentence.");
  const compacted = waitFor((m) => m.type === "response" && m.id === "c1");
  send({ id: "c1", type: "compact" });
  const res = await compacted;
  appendFileSync(receipt, `${JSON.stringify({ at: new Date().toISOString(), driver: "compact-response", success: res.success, error: res.error ?? null })}\n`);
} catch (error) {
  if (error?.autoDone) { /* auto mode ends here */ } else
  appendFileSync(receipt, `${JSON.stringify({ at: new Date().toISOString(), driver: "error", error: String(error) })}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  killOwn();
  if (hangServer) { for (const s of hangSockets) s.destroy(); hangServer.close(); }
  if (existsSync(join(agent, "logs"))) cpSync(join(agent, "logs"), join(evidence, "agent-logs"), { recursive: true });
  rmSync(root, { recursive: true, force: true });
  appendFileSync(receipt, `${JSON.stringify({ at: new Date().toISOString(), driver: "cleaned", tempRootRemoved: root })}\n`);
}
