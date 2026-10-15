import test from "node:test";
import assert from "node:assert/strict";
import { redact, listAgents, agentCard, planMachines, agentRows, pullTarget, outputExcerpt, outputMessage } from "../src/share.mjs";

test("strict redaction removes addresses, hosts, urls and home paths; normal pass keeps them", () => {
  const t = "ada@example.com 10.1.2.3 db1.corp.internal https://h.example/x?a=1 /home/ada/app";
  const loose = redact(t);
  assert.match(loose.text, /10\.1\.2\.3/);
  const strict = redact(t, { strict: true });
  assert.ok(!/ada@|10\.1|corp\.internal|https:|\/home\/ada/.test(strict.text), strict.text);
  assert.ok(strict.count >= 4);
});

test("planMachines: sharing is off unless a machine is listed, disabled machines are skipped", () => {
  const saved = [{ label: "a", enabled: true }, { label: "b", enabled: true }, { label: "c", enabled: false }];
  assert.deepEqual(planMachines(saved, {}), { shared: [], off: ["a", "b"] });
  assert.deepEqual(planMachines(saved, { share_machines: ["a", "c"] }), { shared: ["a"], off: ["b"] });
  assert.deepEqual(planMachines(null, null), { shared: [], off: [] });
});

test("agentRows groups Local first and then one group per machine with its note", () => {
  const p = [{ pane_id: "w1:p1", workspace_id: "w1", agent: "claude" }];
  const local = listAgents(p, { w1: "Dev" });
  const remote = listAgents(p, { w1: "Dev" }, "build-box");
  assert.notEqual(local[0].key, remote[0].key); // same pane id on two machines must stay distinct
  const rows = agentRows([{ machine: null, agents: local }, { machine: "build-box", agents: remote }, { machine: "x", agents: [], note: "unavailable" }]);
  assert.deepEqual(rows.map((r) => r.header ?? r.note ?? r.agent.machine ?? "local"), ["Local", "local", "Machine build-box", "build-box", "Machine x", "unavailable"]);
});

test("remote cards and excerpts name the machine and redact harder", () => {
  const a = listAgents([{ pane_id: "p", workspace_id: "w", agent: "claude", agent_status: "idle", terminal_title_stripped: "on 10.0.0.9" }], { w: "Dev" }, "build-box")[0];
  assert.match(agentCard(a), /machine "build-box"/);
  assert.ok(!/10\.0\.0\.9/.test(agentCard(a)));
  const ex = outputExcerpt("user ada@example.com", { strict: true });
  assert.ok(!/ada@/.test(ex.text));
  assert.match(outputMessage(a, ex), /machine "build-box"/);
});

test("/pull refuses remote machines and panes that are not local", () => {
  const ids = ["w1:p1"];
  assert.equal(pullTarget("w1:p1", ids, ["build-box"]).ok, true);
  assert.equal(pullTarget("build-box/w1:p1", ids, ["build-box"]).ok, false);
  assert.equal(pullTarget("build-box", ids, ["build-box"]).ok, false);
  assert.equal(pullTarget("w9:p9", ids, []).ok, false);
  assert.equal(pullTarget("", ids, []).ok, false);
});
