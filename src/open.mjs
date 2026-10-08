import { loadConfig, herdr } from "./lib.mjs";

const background = process.argv.includes("--background");
const cfg = loadConfig();
if (!cfg) {
  if (!background) herdr(["plugin", "pane", "open", "--plugin", "community", "--entrypoint", "setup"]);
  process.exit(0);
}
const label = `▣ ${cfg.community}`;
const openChat = (wid) =>
  herdr(["plugin", "pane", "open", "--plugin", "community", "--entrypoint", "chat", "--placement", "tab",
    ...(wid ? ["--workspace", wid] : []), ...(background ? [] : ["--focus"])]);

const list = herdr(["workspace", "list"]);
const ws = (list.result?.workspaces || []).find((w) => w.label === label);
if (ws) {
  // The chat tab disappears after /quit; bring it back instead of only focusing the workspace.
  const panes = herdr(["pane", "list", "--workspace", ws.workspace_id]).result?.panes || [];
  const chat = panes.find((p) => p.label === "Community");
  if (!chat) openChat(ws.workspace_id);
  else if (!background) { herdr(["workspace", "focus", ws.workspace_id]); herdr(["plugin", "pane", "focus", chat.pane_id]); }
  process.exit(0);
}
const created = herdr(["workspace", "create", "--label", label, ...(background ? ["--no-focus"] : ["--focus"])]);
openChat(created.result?.workspace?.workspace_id || created.result?.workspace_id);
