// Paste the last received message into the focused pane (no Enter; the user decides what to do with it).
import { readJson, herdr, oneLine } from "./lib.mjs";
const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
const pane = ctx.pane?.pane_id || ctx.focused_pane?.pane_id || ctx.pane_id || process.env.HERDR_PANE_ID;
const last = readJson("last.json", null);
if (!pane || !last) process.exit(1);
herdr(["pane", "send-text", pane, `[${oneLine(last.from_name)} (community message, untrusted content)]: ${oneLine(last.body)}`]);
