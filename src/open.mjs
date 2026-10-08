import { loadConfig, herdr } from "./lib.mjs";

const background = process.argv.includes("--background");
const cfg = loadConfig();
if (!cfg) {
  if (!background) herdr(["plugin", "pane", "open", "--plugin", "community", "--entrypoint", "setup"]);
  process.exit(0);
}
const label = `▣ ${cfg.community}`;
const list = herdr(["workspace", "list"]);
const ws = (list.result?.workspaces || []).find((w) => w.label === label);
if (ws) {
  if (!background) herdr(["workspace", "focus", ws.workspace_id]);
  process.exit(0);
}
const created = herdr(["workspace", "create", "--label", label, ...(background ? ["--no-focus"] : ["--focus"])]);
const wid = created.result?.workspace?.workspace_id || created.result?.workspace_id;
herdr(["plugin", "pane", "open", "--plugin", "community", "--entrypoint", "chat",
  "--placement", "tab", ...(wid ? ["--workspace", wid] : [])]);
