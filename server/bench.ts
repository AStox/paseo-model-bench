import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { benchData, benchSwitch } from "../shared/rpc";

type Paseo = Parameters<Parameters<PluginServerContext["handle"]>[1]>[1]["paseo"];
type Model = {
  id: string;
  thinkingOptions?: { id: string; label: string }[];
  metadata?: { supportedReasoningEfforts?: { reasoningEffort: string }[] };
};
type Row = { model: string; effort: string | null; score: number; cost: number; via?: string };
type Output = RpcOutput<typeof benchData>;

// Epoch rows are "<model>_<effort>"; score and cost column names differ per file.
const EPOCH = [
  { id: "deepswe", label: "DeepSWE v1.1", file: "deepswe_external.csv", score: "Pass@1", cost: "Mean cost (USD)", unit: "task" },
  { id: "cursorbench", label: "CursorBench", file: "cursorbench_external.csv", score: "Score", cost: "Cost per task", unit: "task" },
  { id: "frontierswe", label: "FrontierSWE", file: "frontierswe_external.csv", score: "Score", cost: "Average cost (USD)", unit: "task" },
  { id: "weirdml", label: "WeirdML", file: "weirdml_external.csv", score: "Accuracy", cost: "Cost per run", unit: "run" },
  { id: "proofbench", label: "ProofBench", file: "proofbench_external.csv", score: "Accuracy", cost: "Cost per test (USD)", unit: "test" },
];
const DATASETS = [
  { id: "aa-coding-agent", label: "AA Coding Agent Index", unit: "task" },
  EPOCH[0]!,
  { id: "arc-agi-2", label: "ARC-AGI-2", unit: "task" },
  ...EPOCH.slice(1),
];
const SOURCE: Record<string, string> = { "arc-agi-2": "ARC Prize", "aa-coding-agent": "Artificial Analysis" };

let cache: { at: number; data: Promise<{ rows: Record<string, Row[]>; names: Map<string, string> }> } | null = null;

async function get(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

// Minimal zip reader: the Epoch export is one zip and the plugin has no unzip dependency.
function unzip(buf: Buffer, names: Set<string>) {
  const out: Record<string, string> = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = buf.readUInt16LE(eocd + 10); i > 0; i--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const local = buf.readUInt32LE(p + 42);
    if (names.has(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      out[name] = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') field += c, i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n") row.push(field.replace(/\r$/, "")), rows.push(row), (row = []), (field = "");
    else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header = [], ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}

// Artificial Analysis has no keyless API; its leaderboard page embeds the results in the
// Next.js flight payload, one object per agent + model run.
async function artificialAnalysis(): Promise<Row[]> {
  const html = await (await get("https://artificialanalysis.ai/agents/coding-agents")).text();
  let flight = "";
  for (const [, chunk] of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) flight += JSON.parse(`"${chunk}"`);
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const m of flight.matchAll(/\{"id":"[0-9a-f]{32}","isDefault"/g)) {
    const run = JSON.parse(jsonObjectAt(flight, m.index!)) as {
      id: string;
      agentName: string;
      isUnavailable: boolean;
      indexScore: number | null;
      display: { model: string };
      mean: { costUsd: number | null } | null;
    };
    const cost = run.mean?.costUsd ?? 0;
    // Skip repeats and multi-model runs like "Fable 5.1 XHigh + SWE-2 Medium".
    if (seen.has(run.id) || run.isUnavailable || run.indexScore == null || !(cost > 0) || run.display.model.includes("+")) continue;
    seen.add(run.id);
    const name = run.display.model.replace(/\s*\(.*$/, "");
    rows.push({
      model: name.toLowerCase().replace(/\s+/g, "-"),
      effort: /\(([^)]+)\)/.exec(run.display.model)?.[1] ?? null,
      score: run.indexScore,
      cost,
      via: run.agentName.replace(/\s+v?\d+(\.\d+)+.*$/, ""),
    });
  }
  if (!rows.length) throw new Error("Artificial Analysis page had no coding agent results");
  return rows;
}

function jsonObjectAt(text: string, start: number) {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("Unterminated JSON object");
}

async function load() {
  const [aa, zip, evals, models] = await Promise.all([
    artificialAnalysis().catch((error) => {
      console.error("Artificial Analysis fetch failed", error);
      return [];
    }),
    get("https://epoch.ai/data/benchmark_data.zip").then(async (r) => Buffer.from(await r.arrayBuffer())),
    get("https://arcprize.org/media/data/evaluations.json").then((r) => r.json()),
    get("https://arcprize.org/media/data/models.json").then((r) => r.json()),
  ]);
  const files = unzip(zip, new Set(EPOCH.map((b) => b.file)));
  const rows: Record<string, Row[]> = {};
  for (const b of EPOCH) {
    rows[b.id] = parseCsv(files[b.file] ?? "").flatMap((r) => {
      const [model, effort] = r["Model version"]!.split("_");
      const score = Number(r[b.score]);
      const cost = Number(r[b.cost]);
      return model && cost > 0 && Number.isFinite(score) ? [{ model, effort: effort ?? null, score, cost }] : [];
    });
  }
  // ARC Prize ids are free-form; its modelGroup plus the "(Effort)" in displayName identify a point.
  const names = new Map<string, string>();
  const arcModels = new Map<string, { displayName: string; modelGroup: string | null }>();
  for (const m of models) {
    arcModels.set(m.id, m);
    if (m.modelGroup) names.set(modelKey(m.modelGroup), m.displayName.replace(/\s*\([^)]*\)\s*$/, ""));
  }
  rows["arc-agi-2"] = (evals as { datasetId: string; modelId: string; score: number; costPerTask: number | null; display: boolean }[]).flatMap((e) => {
    const m = arcModels.get(e.modelId);
    if (e.datasetId !== "v2_Semi_Private" || !e.display || !m?.modelGroup || !(e.costPerTask! > 0)) return [];
    return [{ model: m.modelGroup, effort: /\(([^)]+)\)\s*$/.exec(m.displayName)?.[1] ?? null, score: e.score, cost: e.costPerTask! }];
  });
  rows["aa-coding-agent"] = aa;
  return { rows, names };
}

function data() {
  if (!cache || Date.now() - cache.at > 3_600_000) {
    cache = { at: Date.now(), data: load() };
    cache.data.catch(() => (cache = null));
  }
  return cache.data;
}

// "anthropic/claude-opus-4-8[1m]", "anthropic-opus-4-8" and "claude-opus-4.8" all become "opus-4-8".
function modelKey(id: string) {
  return id
    .toLowerCase()
    .split("/")
    .pop()!
    .replace(/\[.*?\]|:.*$/g, "")
    .replace(/[._]/g, "-")
    .replace(/^(openai-|anthropic-|claude-|codex-)+/, "");
}

function thinkingFor(model: Model, effort: string | null) {
  const want = effort?.toLowerCase();
  if (!want || want === "unknown") return null;
  const ids = [
    ...(model.thinkingOptions ?? []).flatMap((o) => [
      [o.id.toLowerCase(), o.id],
      [o.label.toLowerCase(), o.id],
    ]),
    ...(model.metadata?.supportedReasoningEfforts ?? []).map((e) => [e.reasoningEffort, e.reasoningEffort]),
  ];
  const aliases = want === "none" ? ["none", "off"] : [want];
  return ids.find(([name]) => aliases.includes(name!))?.[1] ?? null;
}

export async function getBenchData(
  { provider, datasetId }: RpcInput<typeof benchData>,
  { paseo }: { paseo: Paseo },
): Promise<Output> {
  const [{ rows, names }, snapshot] = await Promise.all([data(), paseo.providers.snapshot()]);
  const models = ((snapshot.entries.find((e) => e.provider === provider)?.models ?? []) as Model[])
    .slice()
    .sort((a, b) => a.id.length - b.id.length);
  const byKey = new Map<string, Model>();
  for (const m of models) if (!byKey.has(modelKey(m.id))) byKey.set(modelKey(m.id), m);

  const dataset = DATASETS.find((d) => d.id === datasetId) ?? DATASETS[0]!;
  const series = new Map<string, Output["series"][number]>();
  for (const r of rows[dataset.id] ?? []) {
    const key = modelKey(r.model);
    const model = byKey.get(key);
    if (!model) continue;
    // "claude-sonnet-5" -> "Claude Sonnet 5", "claude-opus-4-6" -> "Claude Opus 4.6", "gpt-5.5" -> "GPT-5.5".
    const label =
      names.get(key) ??
      r.model
        .replace(/(\d)-(?=\d)/g, "$1.")
        .replace(/-/g, " ")
        .replace(/\b[a-z]/g, (c) => c.toUpperCase())
        .replace(/^Gpt /, "GPT-");
    const s = series.get(model.id) ?? { label, modelId: model.id, points: [] };
    series.set(model.id, s);
    const effort = r.effort && r.effort !== "unknown" ? r.effort : null;
    s.points.push({
      label: (effort ? effort[0]!.toUpperCase() + effort.slice(1) : "Default") + (r.via ? ` via ${r.via}` : ""),
      thinkingOptionId: thinkingFor(model, effort),
      score: r.score,
      cost: r.cost,
    });
  }
  return {
    datasetId: dataset.id,
    datasets: DATASETS.map((d) => ({ id: d.id, label: d.label, unit: d.unit, source: SOURCE[d.id] ?? "Epoch AI" })),
    series: [...series.values()].map((s) => ({ ...s, points: s.points.sort((a, b) => a.cost - b.cost) })),
  };
}

function daemonUrl() {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  let listen = "127.0.0.1:6767";
  try {
    const pid = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8"));
    if (typeof pid.listen === "string" && pid.listen.includes(":") && !pid.listen.startsWith("/")) listen = pid.listen;
  } catch {}
  return `ws://${listen}/ws`;
}

// The plugin SDK has no model setter yet, so talk to the daemon the way the CLI does.
export async function switchModel({ agentId, modelId, thinkingOptionId }: RpcInput<typeof benchSwitch>) {
  const client = new DaemonClient({
    url: daemonUrl(),
    clientId: "model-bench-plugin",
    clientType: "cli",
    password: process.env.PASEO_PASSWORD || undefined,
    reconnect: { enabled: false },
  });
  await client.connect();
  try {
    await client.setAgentModel(agentId, modelId);
    if (thinkingOptionId) await client.setAgentThinkingOption(agentId, thinkingOptionId);
  } finally {
    await client.close().catch(() => {});
  }
  return {};
}
