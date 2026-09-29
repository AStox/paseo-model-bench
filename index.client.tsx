import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { DRAFT_SIZE, initDraft, openDraft } from "./client/draft";
import { PillIcon, SessionBench } from "./client/session";
import { initStore } from "./client/store";
import { takeOverModelPicker } from "./client/web";

type AgentRef = { id: string; workspaceId?: string | null };

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  initStore(client.rpc);
  const closeDraft = initDraft(client.paseo);
  const restorePicker = takeOverModelPicker(openDraft, DRAFT_SIZE);

  const register = (agent: AgentRef) => {
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    const { id: agentId, workspaceId } = agent;
    pills.set(
      agentId,
      client.addComposerPill({
        id: "benchmark-picker",
        workspaceId,
        agentId,
        button: {
          title: "Benchmark Picker",
          icon: PillIcon,
          label: "Bench",
          behavior: { kind: "popover", Content: SessionBench },
        },
      }),
    );
  };
  const remove = (id: string) => {
    pills.get(id)?.remove();
    pills.delete(id);
  };

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") remove(update.agentId);
    else register(update.agent);
  });
  void client.paseo.agents
    .list({ subscribe: {}, filter: { includeArchived: false }, page: { limit: 200 } })
    .then((result) => result.entries.forEach(({ agent }) => register(agent)))
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("benchmark-picker: agent list failed", error);
    });

  return () => {
    lifetime.abort();
    unsubscribe();
    restorePicker();
    closeDraft();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
