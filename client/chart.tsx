import { type PluginButtonContentProps, useAgent, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { benchData, benchSwitch } from "../shared/rpc";
import { preferences } from "../shared/settings";

// React Native Web adds `hovered`; native platforms leave it undefined.
type Hover = PressableStateCallbackType & { hovered?: boolean };

const PALETTE = ["#5b8def", "#f2c14e", "#b9a6f5", "#f09a6b", "#e0a030", "#8f6ee6", "#4fc3a1", "#f06b8f", "#6fc8f0", "#a8d05a"];
const MARKERS = ["★", "●", "◆", "■", "▲", "✹", "⬟", "✚", "◐", "✦"];
const WIDTH = 380;
const HEIGHT = 400;
const Y_AXIS = 36;
const X_AXIS = 20;
const PAD_RIGHT = 14;
const MARKER = 16;

const money = (v: number) => `$${v >= 10 ? Math.round(v) : v >= 0.1 ? v.toFixed(2) : Number(v.toPrecision(2))}`;
const pct = (v: number) => `${(v * 100).toFixed(v >= 0.995 ? 0 : 1)}%`;

export function BenchChart(props: PluginButtonContentProps) {
  const { theme, layout, close } = props;
  const agentId = props.context === "agent" ? props.agentId : "";
  const agent = useAgent(agentId, (a) => ({ provider: a.provider, model: a.model, thinking: a.thinkingOptionId }));
  const settings = useSettings(preferences);
  // Local draft so rapid toggles apply at once; the effect below saves it one revision at a time.
  const [draft, setDraft] = useState<typeof preferences.schema._output | null>(null);
  const stored = settings.status === "ready" ? settings.values : null;
  const saved = draft ?? stored;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selected, setSelected] = useState<{ s: string; p: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const fetchData = useRpc(benchData);
  const switchModel = useRpc(benchSwitch);
  const toast = useToast();
  const provider = agent?.provider ?? "";
  const query = useQuery({
    queryKey: ["bench", provider, saved?.datasetId],
    queryFn: () => fetchData({ provider, datasetId: saved?.datasetId }),
    enabled: !!provider && !!saved,
    staleTime: 600_000,
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  const c = theme.colors;
  const dataset = data?.datasets.find((d) => d.id === data.datasetId);
  const hidden = new Set(saved?.hidden ?? []);
  const series = (data?.series ?? []).map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length]!, marker: MARKERS[i % MARKERS.length]! }));
  const visible = series.filter((s) => !hidden.has(s.label));

  function save(patch: Partial<NonNullable<typeof saved>>) {
    if (saved) setDraft({ ...saved, ...patch });
  }

  useEffect(() => {
    if (!draft || settings.status !== "ready" || settings.saving) return;
    if (settings.saveError) {
      setDraft(null);
      void settings.reload();
      return;
    }
    if (JSON.stringify(draft) === JSON.stringify(settings.values)) setDraft(null);
    else void settings.save(draft, settings.revision);
  }, [draft, settings]);

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
    const y = (score: number) => 8 + innerH - ((score - yMin) / (yMax - yMin || 1)) * innerH;
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
      bottom: 8 + innerH,
      xTicks: ticks.filter((_, i) => i % step === 0),
      yTicks: Array.from({ length: Math.round((yMax - yMin) / yStep) + 1 }, (_, i) => yMin + i * yStep),
      yMin,
    };
  }, [visible.map((s) => s.label).join("|"), data, size]);

  const pickSeries = selected && visible.find((s) => s.modelId === selected.s);
  const pick = pickSeries?.points[selected!.p] ? { series: pickSeries, point: pickSeries.points[selected!.p]! } : null;
  const isCurrent = (modelId: string, thinking: string | null) =>
    agent?.model === modelId && (!thinking || agent.thinking === thinking);

  async function apply() {
    if (!pick) return;
    setSwitching(true);
    try {
      await switchModel({ agentId, modelId: pick.series.modelId, thinkingOptionId: pick.point.thinkingOptionId });
      toast.show(`Switched to ${pick.series.label} (${pick.point.label})`, { variant: "success" });
      close();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSwitching(false);
    }
  }

  const muted = { color: c.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums" as const] };
  const loading = !agent || !saved || (query.isLoading && !data);

  return (
    <View style={{ width: layout.compact ? undefined : WIDTH, height: HEIGHT, gap: 10 }}>
      {/* Header: benchmark name doubles as the picker trigger. */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", zIndex: 2 }}>
        <View style={{ flexShrink: 1 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Benchmark: ${dataset?.label ?? "loading"}. Change benchmark`}
            onPress={() => setMenuOpen((v) => !v)}
            style={({ hovered }: Hover) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              alignSelf: "flex-start",
              borderRadius: 6,
              paddingHorizontal: 4,
              marginLeft: -4,
              backgroundColor: hovered || menuOpen ? c.surface2 : "transparent",
            })}
          >
            <Text style={{ color: c.foreground, fontSize: 17, fontWeight: "700", letterSpacing: -0.3 }}>
              {dataset?.label ?? "Benchmarks"}
            </Text>
            <Icon name={menuOpen ? "ChevronUp" : "ChevronDown"} size={16} color={c.foregroundMuted} />
          </Pressable>
          <Text style={muted}>
            Score vs cost per {dataset?.unit ?? "task"} · {dataset?.source ?? "loading"}
          </Text>
        </View>
        {query.isFetching && data ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : null}

        {menuOpen && data ? (
          <View
            style={{
              position: "absolute",
              top: 30,
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
            {data.datasets.map((d) => (
              <Pressable
                key={d.id}
                accessibilityRole="menuitem"
                onPress={() => {
                  setMenuOpen(false);
                  setSelected(null);
                  save({ datasetId: d.id });
                }}
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
                <Text style={{ color: c.foreground, fontSize: 13, fontWeight: d.id === data.datasetId ? "600" : "400" }}>
                  {d.label}
                </Text>
                {d.id === data.datasetId ? <Icon name="Check" size={14} color={c.accent} /> : null}
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={c.foregroundMuted} />
        </View>
      ) : query.error ? (
        <Text style={{ color: c.statusDanger, fontSize: 12 }}>{String(query.error)}</Text>
      ) : !series.length ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={[muted, { fontSize: 12 }]}>No {provider} models have results here yet.</Text>
        </View>
      ) : (
        <>
          {/* Legend: each chip toggles its model on the chart. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {series.map((s) => {
              const on = !hidden.has(s.label);
              const current = agent.model === s.modelId;
              return (
                <Pressable
                  key={s.modelId}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${on ? "Hide" : "Show"} ${s.label}`}
                  onPress={() => {
                    const next = new Set(hidden);
                    if (on) next.add(s.label);
                    else next.delete(s.label);
                    save({ hidden: [...next] });
                  }}
                  style={({ hovered }: Hover) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: current ? c.foreground : on ? c.border : "transparent",
                    backgroundColor: on ? (hovered ? c.surface2 : c.surface1) : "transparent",
                    opacity: on ? 1 : hovered ? 0.7 : 0.45,
                  })}
                >
                  <Text style={{ color: on ? s.color : c.foregroundMuted, fontSize: 11 }}>{s.marker}</Text>
                  <Text
                    style={{
                      color: on ? c.foreground : c.foregroundMuted,
                      fontSize: 11,
                      fontWeight: current ? "700" : "500",
                      textDecorationLine: on ? "none" : "line-through",
                    }}
                  >
                    {s.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Plot. overflow hidden keeps edge tick labels from making the popover scroll. */}
          <View
            style={{ flex: 1, overflow: "hidden", borderRadius: 10, backgroundColor: c.surface1 }}
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
                      {Math.round(v * 100)}%
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
                    const focus = !pick || pick.series.modelId === s.modelId;
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
                    const current = isCurrent(s.modelId, p.thinkingOptionId);
                    const focus = !pick || pick.series.modelId === s.modelId;
                    return (
                      <Pressable
                        key={`${s.modelId}-p${j}`}
                        accessibilityRole="button"
                        accessibilityLabel={`${s.label} ${p.label}: ${pct(p.score)} at ${money(p.cost)}`}
                        onPress={() => setSelected({ s: s.modelId, p: j })}
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
                          backgroundColor: active || current ? `${s.color}33` : "transparent",
                          borderWidth: active || current ? 1.5 : 0,
                          borderColor: current ? c.foreground : s.color,
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

          {/* Detail bar for the hovered or tapped point. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 40 }}>
            {pick ? (
              <>
                <Text style={{ color: pick.series.color, fontSize: 18 }}>{pick.series.marker}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>
                    {pick.series.label} <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}>· {pick.point.label}</Text>
                  </Text>
                  <Text style={[muted, { fontSize: 11 }]}>
                    <Text style={{ color: c.foreground, fontWeight: "700" }}>{pct(pick.point.score)}</Text> score ·{" "}
                    <Text style={{ color: c.foreground, fontWeight: "700" }}>{money(pick.point.cost)}</Text> per {dataset?.unit}
                  </Text>
                </View>
                {isCurrent(pick.series.modelId, pick.point.thinkingOptionId) ? (
                  <Text style={[muted, { fontSize: 11 }]}>Current</Text>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${pick.series.label} ${pick.point.label}`}
                    disabled={switching}
                    onPress={() => void apply()}
                    style={({ hovered }: Hover) => ({
                      paddingHorizontal: 12,
                      paddingVertical: 7,
                      borderRadius: 8,
                      backgroundColor: c.accent,
                      opacity: switching ? 0.5 : hovered ? 0.85 : 1,
                    })}
                  >
                    <Text style={{ color: c.accentForeground, fontSize: 12, fontWeight: "600" }}>
                      {switching ? "Switching…" : "Use model"}
                    </Text>
                  </Pressable>
                )}
              </>
            ) : (
              <Text style={[muted, { fontSize: 11 }]}>Hover a point to compare. Tap a model to hide it. Shift-click the model name for the full list.</Text>
            )}
          </View>
        </>
      )}
    </View>
  );
}
