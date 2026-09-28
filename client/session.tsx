import { type PluginButtonContentProps, type PluginButtonIconProps, useAgent } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import { Platform } from "react-native";
import { benchSwitch } from "../shared/rpc";
import { BenchView } from "./chart";
import { callRpc, rememberTheme, savePrefs, usePrefs } from "./store";
import { openProviderSettings } from "./web";

export function SessionBench(props: PluginButtonContentProps) {
  const { theme, layout, close } = props;
  rememberTheme(theme);
  const agentId = props.context === "agent" ? props.agentId : "";
  const agent = useAgent(agentId, (a) => ({ provider: a.provider, model: a.model, thinking: a.thinkingOptionId }));
  const toast = useToast();
  const prefs = usePrefs();
  // Drafts have no agent to ask, so they start on the provider used here last.
  useEffect(() => {
    if (prefs && agent?.provider && prefs.provider !== agent.provider) savePrefs({ provider: agent.provider });
  }, [!!prefs, agent?.provider]);
  if (!agent) return null;
  return (
    <BenchView
      theme={theme}
      compact={layout.compact}
      provider={agent.provider}
      current={{ model: agent.model, thinking: agent.thinking }}
      onOpenSettings={
        Platform.OS === "web"
          ? () => void openProviderSettings(agent.provider)
          : undefined
      }
      onPick={async (model, effort) => {
        await callRpc(benchSwitch, { agentId, modelId: model.id, thinkingOptionId: effort?.id ?? null });
        toast.show(`Switched to ${model.label}${effort ? ` (${effort.label})` : ""}`, { variant: "success" });
        close();
      }}
    />
  );
}

// Pill icons render with the host theme, which the draft popup (outside Paseo's tree) reuses.
export function PillIcon({ theme, size, color }: PluginButtonIconProps) {
  rememberTheme(theme);
  return <Icon name="ChartScatter" size={size} color={color} />;
}
