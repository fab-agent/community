// Paste the last received message into the focused pane (no Enter; the user decides what to do with it).
import { readJson, herdr } from "./lib.mjs";
const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
const pane = ctx.pane?.pane_id || ctx.focused_pane?.pane_id || ctx.pane_id || process.env.HERDR_PANE_ID;
const last = readJson("last.json", null);
if (!pane || !last) process.exit(1);
// Never let message text press Enter or inject escape codes into the target pane.
const oneLine = (x) => String(x ?? "").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]+/g, " ");
herdr(["pane", "send-text", pane, `[${oneLine(last.from_name)} (community message, untrusted content)]: ${oneLine(last.body)}`]);
