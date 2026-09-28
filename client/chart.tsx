import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, type PressableStateCallbackType, ScrollView, Text, View } from "react-native";
import { type Bench, savePrefs, useBench, usePrefs } from "./store";

// React Native Web adds `hovered`; native platforms leave it undefined.
type Hover = PressableStateCallbackType & { hovered?: boolean };
type Effort = { id: string; label: string };
type Model = Bench["models"][number];

const PALETTE = ["#5b8def", "#f2c14e", "#b9a6f5", "#f09a6b", "#e0a030", "#8f6ee6", "#4fc3a1", "#f06b8f", "#6fc8f0", "#a8d05a"];
const MARKERS = ["★", "●", "◆", "■", "▲", "✹", "⬟", "✚", "◐", "✦"];
export const WIDTH = 380;
export const HEIGHT = 400;
const Y_AXIS = 36;
const X_AXIS = 20;
const PAD_RIGHT = 14;
const MARKER = 16;

const money = (v: number) => `$${v >= 10 ? Math.round(v) : v >= 0.1 ? v.toFixed(2) : Number(v.toPrecision(2))}`;
const pct = (v: number) => `${(v * 100).toFixed(v >= 0.995 ? 0 : 1)}%`;

export type BenchViewProps = {
  theme: PluginTheme;
  compact: boolean;
  provider: string;
  /** Draft composers have no agent yet, so the user picks the provider here. */
  providers?: { id: string; label: string }[];
  onProvider?(id: string): void;
  current: { model: string | null; thinking: string | null };
  onPick(model: { id: string; label: string }, effort: Effort | null): Promise<void>;
  /** Opens the provider settings window from Paseo's own picker. */
  onOpenSettings?(): void;
};

export function BenchView(props: BenchViewProps) {
  const { theme, compact, provider, current, onPick } = props;
  const c = theme.colors;
  const prefs = usePrefs();
  const bench = useBench(provider, prefs?.datasetId, !!prefs);
  const data = bench.data;
  const [view, setView] = useState<"chart" | "list">("chart");
  const [menu, setMenu] = useState<"dataset" | "provider" | null>(null);
  const [selected, setSelected] = useState<{ s: string; p: number } | null>(null);
  const [hoverChip, setHoverChip] = useState<string | null>(null);
  const [listModel, setListModel] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const dataset = data?.datasets.find((d) => d.id === data.datasetId);
  // Index benchmarks score in points (0-100), the rest in percent.
  const score = (v: number) => (dataset?.points ? (v * 100).toFixed(1) : pct(v));
  const hidden = new Set(prefs?.hidden ?? []);
  // Colors go to shown models first, so hiding some frees colors instead of repeating them.
  const raw = data?.series ?? [];
  const order = [...raw.filter((s) => !hidden.has(s.label)), ...raw.filter((s) => hidden.has(s.label))].map((s) => s.modelId);
  const series = raw.map((s) => {
    const i = order.indexOf(s.modelId);
    return {
      ...s,
      color: PALETTE[i % PALETTE.length]!,
      // Shift the marker once colors wrap so no two models share both.
      marker: MARKERS[(i + Math.floor(i / PALETTE.length)) % MARKERS.length]!,
    };
  });
  const bySeries = new Map(series.map((s) => [s.modelId, s]));
  const visible = series.filter((s) => !hidden.has(s.label));
  const models = data?.models ?? [];
  const unbenched = models.filter((m) => !m.benched).length;
  // No results for this provider at all: the list is the only useful view.
  const mode = series.length ? view : "list";
  const openModel = models.find((m) => m.id === listModel);

  const plot = useMemo(() => {
    const all = visible.flatMap((s) => s.points);
    if (!all.length || size.width <= 0) return null;
    const lo = Math.log10(Math.min(...all.map((p) => p.cost)) / 1.3);
    const hi = Math.log10(Math.max(...all.map((p) => p.cost)) * 1.3);
    // Zoom the y-axis to the visible scores, with a step that yields about four gridlines.
    const sMin = Math.min(...all.map((p) => p.score));
    const sMax = Math.max(...all.map((p) => p.score));
    const yStep = [0.02, 0.05, 0.1, 0.2].find((s) => (sMax - sMin) / s <= 4) ?? 0.25;
    const yMin = Math.max(0, Math.floor(sMin / yStep - 0.25) * yStep);
    const yMax = Math.min(1, Math.ceil(sMax / yStep + 0.25) * yStep) || yStep;
    const innerW = size.width - Y_AXIS - PAD_RIGHT;
    const innerH = size.height - X_AXIS - 8;
    const x = (cost: number) => Y_AXIS + ((Math.log10(cost) - lo) / (hi - lo || 1)) * innerW;
    const y = (value: number) => 8 + innerH - ((value - yMin) / (yMax - yMin || 1)) * innerH;
    const logTicks = (mantissas: number[]) => {
      const out: number[] = [];
      for (let k = Math.floor(lo); k <= Math.ceil(hi); k++)
        for (const m of mantissas) if (Math.log10(m * 10 ** k) >= lo && Math.log10(m * 10 ** k) <= hi) out.push(m * 10 ** k);
      return out;
    };
    let ticks = logTicks([1, 2, 5]);
    if (ticks.length < 3) ticks = logTicks([1, 1.5, 2, 3, 5, 7]);
    const step = Math.ceil(ticks.length / 6);
    return {
      x,
      y,
      yMin,
      bottom: 8 + innerH,
      xTicks: ticks.filter((_, i) => i % step === 0),
      yTicks: Array.from({ length: Math.round((yMax - yMin) / yStep) + 1 }, (_, i) => yMin + i * yStep),
    };
  }, [visible.map((s) => s.label).join("|"), data, size]);

  const pickSeries = selected && visible.find((s) => s.modelId === selected.s);
  const pick = pickSeries?.points[selected!.p] ? { series: pickSeries, point: pickSeries.points[selected!.p]! } : null;
  // A hovered legend chip wins over the hovered point for which line stands out.
  const focusId = hoverChip ?? pick?.series.modelId ?? null;
  // Touch has no hover, so the first tap previews a point and the second one switches.
  const clickToUse = Platform.OS === "web";
  const isCurrent = (modelId: string, thinking: string | null) =>
    current.model === modelId && (!thinking || current.thinking === thinking);
  const effortLabel = (modelId: string, id: string | null) => models.find((m) => m.id === modelId)?.efforts.find((e) => e.id === id);

  async function choose(model: { id: string; label: string }, effort: Effort | null) {
    setSwitching(true);
    setError(null);
    try {
      await onPick(model, effort);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(false);
    }
  }

  function pressModel(m: Model) {
    if (m.efforts.length) setListModel(m.id);
    else void choose(m, null);
  }

  const muted = { color: c.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums" as const] };
  const loading = !prefs || (!data && !bench.error);
  const providerLabel = props.providers?.find((p) => p.id === provider)?.label ?? provider;

  const row = (hovered: boolean | undefined, active = false) => ({
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: active || hovered ? c.surface2 : "transparent",
  });

  return (
    <View style={{ width: compact ? undefined : WIDTH, height: HEIGHT, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", zIndex: 2 }}>
        <View style={{ flexShrink: 1 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Benchmark: ${dataset?.label ?? "loading"}. Change benchmark`}
            onPress={() => setMenu((m) => (m === "dataset" ? null : "dataset"))}
            style={({ hovered }: Hover) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              alignSelf: "flex-start",
              borderRadius: 6,
              paddingHorizontal: 4,
              marginLeft: -4,
              backgroundColor: hovered || menu === "dataset" ? c.surface2 : "transparent",
            })}
          >
            <Text style={{ color: c.foreground, fontSize: 17, fontWeight: "700", letterSpacing: -0.3 }}>{dataset?.label ?? "Benchmarks"}</Text>
            <Icon name={menu === "dataset" ? "ChevronUp" : "ChevronDown"} size={16} color={c.foregroundMuted} />
          </Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {props.providers ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Provider: ${providerLabel}. Change provider`}
                onPress={() => setMenu((m) => (m === "provider" ? null : "provider"))}
                style={({ hovered }: Hover) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 2,
                  borderRadius: 4,
                  paddingHorizontal: 3,
                  marginLeft: -3,
                  backgroundColor: hovered || menu === "provider" ? c.surface2 : "transparent",
                })}
              >
                <Text style={[muted, { color: c.foreground, fontWeight: "600" }]}>{providerLabel}</Text>
                <Icon name="ChevronDown" size={11} color={c.foregroundMuted} />
              </Pressable>
            ) : null}
            <Text style={muted} numberOfLines={1}>
              {props.providers ? "· " : ""}Score vs cost per {dataset?.unit ?? "task"} · {dataset?.source ?? "loading"}
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {bench.fetching && data ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
          {props.onOpenSettings ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${providerLabel} settings`}
              onPress={props.onOpenSettings}
              style={({ hovered }: Hover) => ({
                padding: 5,
                borderRadius: 7,
                borderWidth: 1,
                borderColor: hovered ? c.border : "transparent",
                backgroundColor: hovered ? c.surface1 : "transparent",
              })}
            >
              <Icon name="Settings" size={14} color={c.foregroundMuted} />
            </Pressable>
          ) : null}
          <View style={{ flexDirection: "row", padding: 2, gap: 2, borderRadius: 8, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}>
            {(["chart", "list"] as const).map((v) => (
              <Pressable
                key={v}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === v, disabled: v === "chart" && !series.length }}
                accessibilityLabel={v === "chart" ? "Chart view" : "All models"}
                disabled={v === "chart" && !series.length}
                onPress={() => {
                  setView(v);
                  setListModel(null);
                }}
                style={({ hovered }: Hover) => ({
                  paddingHorizontal: 7,
                  paddingVertical: 4,
                  borderRadius: 6,
                  backgroundColor: mode === v ? c.surface0 : hovered ? c.surface2 : "transparent",
                  borderWidth: 1,
                  borderColor: mode === v ? c.border : "transparent",
                  opacity: v === "chart" && !series.length ? 0.35 : 1,
                })}
              >
                <Icon name={v === "chart" ? "ChartScatter" : "List"} size={14} color={mode === v ? c.foreground : c.foregroundMuted} />
              </Pressable>
            ))}
          </View>
        </View>

        {menu === "dataset" && data ? (
          <Menu
            theme={theme}
            top={30}
            items={data.datasets}
            selected={data.datasetId}
            onSelect={(id) => {
              setMenu(null);
              setSelected(null);
              savePrefs({ datasetId: id });
            }}
          />
        ) : null}
        {menu === "provider" && props.providers ? (
          <Menu
            theme={theme}
            top={40}
            items={props.providers}
            selected={provider}
            onSelect={(id) => {
              setMenu(null);
              setSelected(null);
              setListModel(null);
              props.onProvider?.(id);
            }}
          />
        ) : null}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={c.foregroundMuted} />
        </View>
      ) : bench.error && !data ? (
        <Text style={{ color: c.statusDanger, fontSize: 12 }}>{String(bench.error)}</Text>
      ) : mode === "list" ? (
        <>
          {/* Escape hatch that mirrors Paseo's picker: model first, then effort. */}
          <View style={{ flex: 1, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
            {openModel ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Back to all models`}
                  onPress={() => setListModel(null)}
                  style={({ hovered }: Hover) => ({
                    ...row(hovered),
                    borderRadius: 0,
                    borderBottomWidth: 1,
                    borderColor: c.border,
                    paddingVertical: 8,
                  })}
                >
                  <Icon name="ChevronLeft" size={14} color={c.foregroundMuted} />
                  <Text style={{ flex: 1, color: c.foreground, fontSize: 12.5, fontWeight: "700" }} numberOfLines={1}>
                    {openModel.label}
                  </Text>
                  <Text style={muted}>Effort</Text>
                </Pressable>
                <ScrollView contentContainerStyle={{ padding: 4 }} showsVerticalScrollIndicator={false}>
                  {openModel.efforts.map((e) => {
                    const point = bySeries.get(openModel.id)?.points.find((p) => p.thinkingOptionId === e.id);
                    const on = current.model === openModel.id && current.thinking === e.id;
                    return (
                      <Pressable
                        key={e.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Use ${openModel.label} ${e.label}`}
                        disabled={switching}
                        onPress={() => void choose(openModel, e)}
                        style={({ hovered }: Hover) => row(hovered)}
                      >
                        <Text style={{ flex: 1, color: c.foreground, fontSize: 12.5, fontWeight: on ? "700" : "500" }}>{e.label}</Text>
                        {point ? (
                          <Text style={[muted, { fontSize: 10.5 }]}>
                            {score(point.score)} · {money(point.cost)}
                          </Text>
                        ) : null}
                        {on ? <Icon name="Check" size={13} color={c.accent} /> : null}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </>
            ) : (
              <ScrollView contentContainerStyle={{ padding: 4 }} showsVerticalScrollIndicator={false}>
                {models.map((m) => {
                  const s = bySeries.get(m.id);
                  const on = current.model === m.id;
                  const best = s && Math.max(...s.points.map((p) => p.score));
                  return (
                    <Pressable
                      key={m.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${m.label}${on ? ", current model" : ""}`}
                      disabled={switching}
                      onPress={() => pressModel(m)}
                      style={({ hovered }: Hover) => row(hovered)}
                    >
                      <Text style={{ width: 14, textAlign: "center", fontSize: 11, color: s ? s.color : c.foregroundMuted }}>{s ? s.marker : "○"}</Text>
                      <Text style={{ flex: 1, color: c.foreground, fontSize: 12.5, fontWeight: on ? "700" : "500" }} numberOfLines={1}>
                        {m.label}
                      </Text>
                      <Text style={[muted, { fontSize: 10.5 }]}>{best != null ? `best ${score(best)}` : "No results"}</Text>
                      {on ? <Icon name="Check" size={13} color={c.accent} /> : null}
                      {m.efforts.length ? <Icon name="ChevronRight" size={13} color={c.foregroundMuted} /> : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>
          <Footer theme={theme} error={error} switching={switching}>
            {openModel
              ? "Pick an effort level."
              : unbenched
                ? `${unbenched} of ${models.length} have no ${dataset?.label} results. Any of them works.`
                : "Pick a model, then an effort level."}
          </Footer>
        </>
      ) : (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {series.map((s) => {
              const on = !hidden.has(s.label);
              const active = current.model === s.modelId;
              return (
                <Pressable
                  key={s.modelId}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${on ? "Hide" : "Show"} ${s.label}`}
                  onHoverIn={() => on && setHoverChip(s.modelId)}
                  onHoverOut={() => setHoverChip((id) => (id === s.modelId ? null : id))}
                  onPress={() => {
                    if (on) setHoverChip(null);
                    const next = new Set(hidden);
                    if (on) next.add(s.label);
                    else next.delete(s.label);
                    savePrefs({ hidden: [...next] });
                  }}
                  style={({ hovered }: Hover) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: active ? c.foreground : on ? c.border : "transparent",
                    backgroundColor: on ? (hovered ? c.surface2 : c.surface1) : "transparent",
                    opacity: on ? 1 : hovered ? 0.7 : 0.45,
                  })}
                >
                  <Text style={{ color: on ? s.color : c.foregroundMuted, fontSize: 11 }}>{s.marker}</Text>
                  <Text
                    style={{
                      color: on ? c.foreground : c.foregroundMuted,
                      fontSize: 11,
                      fontWeight: active ? "700" : "500",
                      textDecorationLine: on ? "none" : "line-through",
                    }}
                  >
                    {s.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* overflow hidden keeps edge tick labels from making the popover scroll. */}
          <View
            style={{ flex: 1, overflow: "hidden", borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}
            onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
          >
            {!plot ? (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <Text style={[muted, { fontSize: 12 }]}>All models hidden. Tap one above.</Text>
              </View>
            ) : (
              <>
                {plot.yTicks.map((v) => (
                  <View key={`y${v}`}>
                    <View
                      style={{
                        position: "absolute",
                        left: Y_AXIS,
                        right: PAD_RIGHT,
                        top: plot.y(v),
                        borderTopWidth: 1,
                        borderStyle: v === plot.yMin ? "solid" : "dashed",
                        borderColor: c.border,
                        opacity: v === plot.yMin ? 1 : 0.6,
                      }}
                    />
                    <Text style={[muted, { position: "absolute", left: 0, width: Y_AXIS - 6, top: plot.y(v) - 7, textAlign: "right" }]}>
                      {Math.round(v * 100)}
                      {dataset?.points ? "" : "%"}
                    </Text>
                  </View>
                ))}
                {plot.xTicks.map((v) => (
                  <Text
                    key={`x${v}`}
                    style={[muted, { position: "absolute", left: Math.min(plot.x(v) - 24, size.width - 48), width: 48, top: plot.bottom + 4, textAlign: "center" }]}
                  >
                    {money(v)}
                  </Text>
                ))}

                {visible.map((s) =>
                  s.points.slice(1).map((p, j) => {
                    const a = s.points[j]!;
                    const [x1, y1, x2, y2] = [plot.x(a.cost), plot.y(a.score), plot.x(p.cost), plot.y(p.score)];
                    const len = Math.hypot(x2 - x1, y2 - y1);
                    const focus = !focusId || focusId === s.modelId;
                    return (
                      <View
                        key={`${s.modelId}-l${j}`}
                        pointerEvents="none"
                        style={{
                          position: "absolute",
                          left: (x1 + x2) / 2 - len / 2,
                          top: (y1 + y2) / 2 - 1,
                          width: len,
                          height: 2,
                          borderRadius: 1,
                          backgroundColor: s.color,
                          opacity: focus ? 0.9 : 0.25,
                          transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }],
                        }}
                      />
                    );
                  }),
                )}

                {visible.map((s) =>
                  s.points.map((p, j) => {
                    const active = pick?.series.modelId === s.modelId && selected?.p === j;
                    const on = isCurrent(s.modelId, p.thinkingOptionId);
                    const focus = !focusId || focusId === s.modelId;
                    return (
                      <Pressable
                        key={`${s.modelId}-p${j}`}
                        accessibilityRole="button"
                        accessibilityLabel={`${s.label} ${p.label}: ${score(p.score)} at ${money(p.cost)}`}
                        accessibilityHint={on ? "Current model" : `Switches to ${s.label} ${p.label}`}
                        disabled={switching}
                        onPress={() => {
                          if (on || (!clickToUse && !active)) return setSelected({ s: s.modelId, p: j });
                          void choose({ id: s.modelId, label: s.label }, effortLabel(s.modelId, p.thinkingOptionId) ?? null);
                        }}
                        onHoverIn={() => setSelected({ s: s.modelId, p: j })}
                        hitSlop={4}
                        style={{
                          position: "absolute",
                          left: plot.x(p.cost) - MARKER / 2,
                          top: plot.y(p.score) - MARKER / 2,
                          width: MARKER,
                          height: MARKER,
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: MARKER / 2,
                          backgroundColor: active || on ? `${s.color}33` : "transparent",
                          borderWidth: active || on ? 1.5 : 0,
                          borderColor: on ? c.foreground : s.color,
                          opacity: focus ? 1 : 0.3,
                          transform: [{ scale: active ? 1.35 : 1 }],
                        }}
                      >
                        <Text style={{ color: s.color, fontSize: 12, lineHeight: 14 }}>{s.marker}</Text>
                      </Pressable>
                    );
                  }),
                )}
              </>
            )}
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 40 }}>
            {pick ? (
              <>
                <Text style={{ color: pick.series.color, fontSize: 18 }}>{pick.series.marker}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
                    {pick.series.label} <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>· {pick.point.label}</Text>
                  </Text>
                  <Text style={[muted, { fontSize: 11, color: error ? c.statusDanger : c.foregroundMuted }]} numberOfLines={1}>
                    {error ?? (
                      <>
                        <Text style={{ color: c.foreground, fontWeight: "700" }}>{score(pick.point.score)}</Text> score ·{" "}
                        <Text style={{ color: c.foreground, fontWeight: "700" }}>{money(pick.point.cost)}</Text> per {dataset?.unit}
                      </>
                    )}
                  </Text>
                </View>
                <Text style={[muted, { fontSize: 11, color: switching ? c.foreground : c.foregroundMuted }]}>
                  {switching
                    ? "Switching…"
                    : isCurrent(pick.series.modelId, pick.point.thinkingOptionId)
                      ? "Current"
                      : clickToUse
                        ? "Click to use"
                        : "Tap again to use"}
                </Text>
              </>
            ) : (
              <>
                <Text style={[muted, { fontSize: 11, flex: 1 }]} numberOfLines={1}>
                  Click a point to use it · tap a chip to hide
                </Text>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Show all ${models.length} models`}
                  onPress={() => setView("list")}
                  style={({ hovered }: Hover) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 3,
                    paddingHorizontal: 6,
                    paddingVertical: 3,
                    borderRadius: 6,
                    backgroundColor: hovered ? c.surface2 : "transparent",
                  })}
                >
                  <Text style={{ color: c.accent, fontSize: 11, fontWeight: "600" }}>All {models.length} models</Text>
                  <Icon name="ChevronRight" size={12} color={c.accent} />
                </Pressable>
              </>
            )}
          </View>
        </>
      )}
    </View>
  );
}

function Menu(props: {
  theme: PluginTheme;
  top: number;
  items: { id: string; label: string }[];
  selected: string;
  onSelect(id: string): void;
}) {
  const c = props.theme.colors;
  return (
    <View
      style={{
        position: "absolute",
        top: props.top,
        left: -4,
        minWidth: 180,
        padding: 4,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
        shadowColor: "#000",
        shadowOpacity: 0.25,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
      }}
    >
      {props.items.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="menuitem"
          onPress={() => props.onSelect(item.id)}
          style={({ hovered }: Hover) => ({
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            paddingHorizontal: 10,
            paddingVertical: 7,
            borderRadius: 7,
            backgroundColor: hovered ? c.surface2 : "transparent",
          })}
        >
          <Text style={{ color: c.foreground, fontSize: 13, fontWeight: item.id === props.selected ? "600" : "400" }}>{item.label}</Text>
          {item.id === props.selected ? <Icon name="Check" size={14} color={c.accent} /> : null}
        </Pressable>
      ))}
    </View>
  );
}

function Footer(props: { theme: PluginTheme; error: string | null; switching: boolean; children: ReactNode }) {
  const c = props.theme.colors;
  return (
    <View style={{ minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8 }}>
      {props.switching ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}
      <Text style={{ flex: 1, fontSize: 11, color: props.error ? c.statusDanger : c.foregroundMuted }} numberOfLines={2}>
        {props.error ?? props.children}
      </Text>
    </View>
  );
}
