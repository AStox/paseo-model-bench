import { settingsRpc, type PluginTheme, type RpcOutput } from "@getpaseo/plugin";
import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { benchData } from "../shared/rpc";
import { preferences } from "../shared/settings";

// Everything here goes through client.rpc instead of host hooks, so the draft popup, which
// runs in its own React root outside Paseo's providers, can share it with the session popover.
export type Rpc = PluginCommandCapabilities["rpc"];
export type Prefs = { datasetId?: string; provider?: string; hidden: string[] };
export type Bench = RpcOutput<typeof benchData>;

let rpc: Rpc;
export function initStore(clientRpc: Rpc) {
  rpc = clientRpc;
}
export const callRpc: Rpc = (contract, input) => rpc(contract, input);

const settings = settingsRpc(preferences.id);
let prefs: Prefs | null = null;
let revision = "";
let pending: Prefs | null = null;
let writing = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function readPrefs() {
  const res = await rpc(settings.read, {});
  revision = res.revision;
  if (!pending) {
    const parsed = res.status === "ready" ? preferences.schema.safeParse(res.values) : null;
    prefs = parsed?.success ? parsed.data : { hidden: [] };
    emit();
  }
}

// One write in flight at a time; rapid toggles collapse into the latest values.
async function flush() {
  if (writing || !pending) return;
  writing = true;
  const next = pending;
  pending = null;
  try {
    const res = await rpc(settings.write, { revision, values: next });
    if (res.status === "saved") revision = res.revision;
    else if (res.status === "conflict") {
      pending ??= next;
      await readPrefs();
    }
  } catch (error) {
    console.error("model-bench: saving preferences failed", error);
  } finally {
    writing = false;
    void flush();
  }
}

export function savePrefs(patch: Partial<Prefs>) {
  if (!prefs) return;
  prefs = { ...prefs, ...patch };
  pending = prefs;
  emit();
  void flush();
}

export function usePrefs() {
  const [, tick] = useState(0);
  useEffect(() => {
    const listener = () => tick((n) => n + 1);
    listeners.add(listener);
    if (!writing && !pending) readPrefs().catch((error) => console.error("model-bench: loading preferences failed", error));
    return () => void listeners.delete(listener);
  }, []);
  return prefs;
}

const benchCache = new Map<string, { at: number; promise: Promise<Bench> }>();

export function useBench(provider: string, datasetId: string | undefined, enabled: boolean) {
  const key = `${provider}|${datasetId ?? ""}`;
  const [state, setState] = useState<{ key: string; data?: Bench; error?: unknown }>({ key: "" });
  useEffect(() => {
    if (!enabled || !provider) return;
    let hit = benchCache.get(key);
    if (!hit || Date.now() - hit.at > 600_000) {
      hit = { at: Date.now(), promise: rpc(benchData, { provider, datasetId }) };
      benchCache.set(key, hit);
      hit.promise.catch(() => benchCache.delete(key));
    }
    let live = true;
    hit.promise.then(
      (data) => live && setState({ key, data }),
      (error) => live && setState((s) => ({ key, data: s.data, error })),
    );
    return () => void (live = false);
  }, [key, enabled]);
  return {
    data: state.data,
    error: state.key === key ? state.error : undefined,
    // Previous benchmark's data stays up while the next one loads.
    fetching: state.key !== key,
  };
}

let lastTheme: PluginTheme | null = null;
export function rememberTheme(theme: PluginTheme) {
  lastTheme = theme;
}
export function knownTheme() {
  return lastTheme;
}
