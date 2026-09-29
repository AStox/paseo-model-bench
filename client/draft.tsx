import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { ActivityIndicator, AppRegistry, Pressable, View } from "react-native";
import { BenchView, HEIGHT, WIDTH } from "./chart";
import { knownTheme, savePrefs, usePrefs } from "./store";
import { type Anchor, createOverlay, type Overlay, onEscape, openPaseoPicker, openProviderSettings, pageTheme, selectInDraft } from "./web";

type Draft = { picker: unknown; anchor: Anchor };
const PAD = 12;

let draft: Draft | null = null;
const listeners = new Set<() => void>();
let overlay: Overlay | null = null;
let stopEscape: (() => void) | null = null;
let paseo: PluginClientContext["paseo"];

function setDraft(next: Draft | null) {
  draft = next;
  if (!next) overlay?.setBehindModals(false);
  overlay?.setActive(!!next);
  stopEscape?.();
  stopEscape = next ? onEscape(() => setDraft(null)) : null;
  listeners.forEach((l) => l());
}

// Drafts have no agent, so the plugin API gives us nowhere to mount. Render our own React root
// into a window-sized overlay instead, created the first time a draft picker is clicked.
export function openDraft(picker: unknown, anchor: Anchor) {
  if (!overlay) {
    overlay = createOverlay();
    AppRegistry.registerComponent("benchmark-picker-draft", () => DraftHost);
    AppRegistry.runApplication("benchmark-picker-draft", { rootTag: overlay.root });
  }
  setDraft({ picker, anchor });
}

export function initDraft(api: PluginClientContext["paseo"]) {
  paseo = api;
  return () => setDraft(null);
}

export const DRAFT_SIZE = { width: WIDTH + PAD * 2, height: HEIGHT + PAD * 2 };

function DraftHost() {
  const [, tick] = useState(0);
  const [providers, setProviders] = useState<{ id: string; label: string }[] | null>(null);
  const prefs = usePrefs();
  useEffect(() => {
    const listener = () => tick((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  const open = !!draft;
  useEffect(() => {
    if (!open) return;
    paseo.providers
      .snapshot()
      .then((snap) =>
        setProviders(
          snap.entries
            .filter((e) => e.enabled && e.status === "ready" && e.models?.length)
            .map((e) => ({ id: e.provider, label: e.label ?? e.provider })),
        ),
      )
      .catch((error) => console.error("benchmark-picker: provider list failed", error));
  }, [open]);

  if (!draft) return null;
  const { picker, anchor } = draft;
  const theme = knownTheme() ?? pageTheme();
  const c = theme.colors;
  const provider = providers?.find((p) => p.id === prefs?.provider)?.id ?? providers?.[0]?.id;

  return (
    <View style={{ flex: 1 }}>
      <Pressable accessibilityLabel="Close Benchmark Picker" onPress={() => setDraft(null)} style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
      <View
        accessibilityRole="menu"
        style={{
          position: "absolute",
          left: anchor.left,
          top: anchor.top,
          bottom: anchor.bottom,
          padding: PAD,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.surface0,
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 8 },
        }}
      >
        {provider ? (
          <BenchView
            theme={theme}
            compact={false}
            provider={provider}
            providers={providers!}
            onProvider={(id) => savePrefs({ provider: id })}
            current={{ model: null, thinking: null }}
            onOpenSettings={() => {
              overlay!.setBehindModals(true);
              void openProviderSettings(provider, () => overlay?.setBehindModals(false));
            }}
            onPick={async (model, effort) => {
              setDraft(null);
              await selectInDraft(picker, provider, model.id, effort).catch((error) => {
                // The popup is gone by now, so fall back to Paseo's picker to finish by hand.
                console.error("benchmark-picker: draft selection failed", error);
                openPaseoPicker();
              });
            }}
          />
        ) : (
          <View style={{ width: WIDTH, height: HEIGHT, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={c.foregroundMuted} />
          </View>
        )}
      </View>
    </View>
  );
}
