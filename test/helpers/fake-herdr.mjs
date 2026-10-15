// Stand-in for the `herdr` CLI used by the TUI smoke test. Logs every call to $FAKE_HERDR_LOG.
import fs from "node:fs";
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(a) + "\n");
let machine = null;
if (a[0] === "--machine") { machine = a[1]; a.splice(0, 2); }
const out = (r) => console.log(JSON.stringify({ id: "x", result: r }));
if (machine === "flaky") { console.error("error: machine 'flaky' is unreachable"); process.exit(1); }
if (a[0] === "machine" && a[1] === "list") {
  console.log(JSON.stringify([{ label: "build-box", enabled: true }, { label: "demo-srv", enabled: true }, { label: "flaky", enabled: true }, { label: "old-box", enabled: false }]));
} else if (a[0] === "workspace" && a[1] === "list") {
  out({ workspaces: [{ workspace_id: "w1", label: machine ? "RemoteWork" : "LocalWork" }] });
} else if (a[0] === "pane" && a[1] === "list") {
  out({ panes: [{ pane_id: machine ? "w1:p7" : "w1:p1", workspace_id: "w1", agent: "claude", agent_status: "idle", terminal_title_stripped: machine ? "deploy" : "docs", cwd: "/x" }] });
} else if (a[0] === "pane" && a[1] === "read") {
  console.log("deploying to 10.1.2.3 as ada@example.com in /home/ada/app");
} else if (a[0] === "pane" && a[1] === "send-text") {
  console.log("{}");
} else { console.log("{}"); }
