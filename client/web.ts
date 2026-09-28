import type { PluginTheme } from "@getpaseo/plugin";
import { Platform } from "react-native";

type Rect = { left: number; top: number; right: number; bottom: number };
type El = {
  closest(selector: string): El | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
  parentElement: El | null;
  isConnected: boolean;
  textContent: string | null;
  dataset: Record<string, string | undefined>;
  click(): void;
  appendChild(child: El): void;
  insertBefore(child: El, before: El | null): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): Rect;
  getClientRects(): { length: number };
  style: Record<string, string>;
};
type DomEvent = {
  type: string;
  key?: string;
  shiftKey?: boolean;
  target: El | null;
  preventDefault(): void;
  stopImmediatePropagation(): void;
};
declare const MutationObserver: new (cb: () => void) => {
  observe(target: El, options: { attributes: boolean; attributeFilter: string[] }): void;
  disconnect(): void;
};
declare const document: {
  body: El;
  getElementById(id: string): El | null;
  documentElement: El & { removeAttribute(name: string): void };
  createElement(tag: string): El;
  querySelectorAll(selector: string): ArrayLike<El>;
  addEventListener(type: string, listener: (event: DomEvent) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: DomEvent) => void, capture: boolean): void;
};
declare const window: { innerWidth: number; innerHeight: number };
declare const getComputedStyle: (el: El) => { backgroundColor: string; color: string; fontFamily: string };

// Paseo's own testIDs for the composer, its dropdowns, and the dropdown's contents.
const MODEL = '[data-testid="combined-model-selector"]';
const THINKING = '[data-testid="agent-thinking-selector"]';
const PICKERS = `${MODEL},${THINKING}`;
const COMPOSER = '[data-testid="message-input-root"]';
const MENU = '[data-testid="combobox-desktop-container"]';
const PILL = 'button[aria-label="Model benchmarks"]';
const EVENTS = ["pointerdown", "mousedown", "click", "keydown"];

export type Anchor = { left: number; top?: number; bottom?: number };
type DraftOpener = (picker: unknown, anchor: Anchor) => void;

let bypass = false;
let lastPicker: El | null = null;

const visible = (el: El | null | undefined): el is El => !!el && el.isConnected && el.getClientRects().length > 0;
const byTestId = (root: { querySelectorAll(s: string): ArrayLike<El> }, id: string) =>
  // Compare in JS: model ids contain "[", "/" and ":", which would need CSS escaping.
  Array.from(root.querySelectorAll("[data-testid]")).find((e) => e.dataset.testid === id && visible(e)) ?? null;

function realClick(el: El) {
  bypass = true;
  try {
    el.click();
  } finally {
    bypass = false;
  }
}

async function waitFor<T>(find: () => T | null, ms = 2500): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const hit = find();
    if (hit || Date.now() > end) return hit;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
}

// Paseo anchors the popover to the pill, so park the (invisible) pill over the picker while it
// opens, and put it back once the popover closes (aria-expanded flips to false).
function openAt(pill: El, picker: El) {
  const from = pill.getBoundingClientRect();
  const to = picker.getBoundingClientRect();
  pill.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px)`;
  pill.style.opacity = "0";
  const restore = new MutationObserver(() => {
    if (pill.getAttribute("aria-expanded") === "true") return;
    restore.disconnect();
    pill.style.transform = "";
    pill.style.opacity = "";
  });
  restore.observe(pill, { attributes: true, attributeFilter: ["aria-expanded"] });
  pill.click();
}

function anchorFor(picker: El, width: number, height: number): Anchor {
  const r = picker.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left - 12, window.innerWidth - width - 8));
  return r.top > height + 16 ? { left, bottom: window.innerHeight - r.top + 8 } : { left, top: r.bottom + 8 };
}

// The plugin API cannot replace built-in controls, so on web we intercept their clicks. Session
// composers open the Bench popover; draft composers (no agent yet, so no pill) open the draft
// popup. Shift-click still opens the original dropdown.
export function takeOverModelPicker(openDraft: DraftOpener, size: { width: number; height: number }): () => void {
  if (Platform.OS !== "web") return () => {};
  installQuietStyle();
  const onEvent = (event: DomEvent) => {
    if (bypass || event.shiftKey) return;
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    const picker = event.target?.closest?.(PICKERS);
    const composer = picker?.closest(COMPOSER);
    if (!picker || !composer) return;
    // Only this composer's own pill; climbing past it would find a hidden session's pill.
    // Start above the composer: querySelectorAll never counts the element it's called on.
    let scope = composer.parentElement;
    while (scope && !scope.querySelector(PILL) && scope.querySelectorAll(COMPOSER).length === 1) scope = scope.parentElement;
    const pill = scope?.querySelector(PILL);
    const own = visible(pill) && scope!.querySelectorAll(COMPOSER).length === 1;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== "click" && event.type !== "keydown") return;
    lastPicker = picker;
    if (own) openAt(pill!, picker);
    else openDraft(picker, anchorFor(picker, size.width, size.height));
  };
  for (const type of EVENTS) document.addEventListener(type, onEvent, true);
  return () => {
    for (const type of EVENTS) document.removeEventListener(type, onEvent, true);
  };
}

/** Opens Paseo's own model picker, for its search, profiles, and provider settings. */
export function openPaseoPicker() {
  const picker = visible(lastPicker)
    ? (lastPicker.closest(COMPOSER)?.querySelector(MODEL) ?? lastPicker)
    : Array.from(document.querySelectorAll(MODEL)).filter(visible).pop();
  if (picker) realClick(picker);
}

const QUIET = "data-model-bench-quiet";
const SHEET = "provider-settings-sheet";

// While we click through Paseo's picker for the user, it stays invisible and unclickable.
function installQuietStyle() {
  const css = document.createElement("style");
  css.textContent = `html[${QUIET}] ${MENU} { opacity: 0 !important; pointer-events: none !important; }`;
  document.body.appendChild(css);
}

/**
 * Opens the provider settings window that the gear in Paseo's own picker opens, without
 * showing that picker. Resolves once the window is up; `onClosed` runs when it goes away.
 */
export async function openProviderSettings(provider: string, onClosed?: () => void) {
  document.documentElement.setAttribute(QUIET, "");
  let opened = false;
  try {
    openPaseoPicker();
    const gear = `selector-header-settings-${provider}`;
    let button = await waitFor(() => byTestId(document, gear), 1200);
    if (!button) {
      // The picker opened on another provider or on the provider list (drafts); walk to ours.
      byTestId(document, "sheet-header-back")?.click();
      (await waitFor(() => byTestId(document, `model-provider-${provider}`)))?.click();
      button = await waitFor(() => byTestId(document, gear));
    }
    button?.click();
    opened = !!(await waitFor(() => byTestId(document, SHEET)));
  } finally {
    if (!opened) closeQuietPicker().then(onClosed);
  }
  if (opened) void untilGone(() => byTestId(document, SHEET)).then(closeQuietPicker).then(onClosed);
}

async function untilGone(find: () => El | null) {
  while (find()) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 250);
    await promise;
  }
}

// Paseo leaves its picker open behind the settings window; toggle it shut, then unhide.
async function closeQuietPicker() {
  const menu = () => Array.from(document.querySelectorAll(MENU)).find(visible) ?? null;
  if (menu()) openPaseoPicker();
  await waitFor(() => (menu() ? null : true), 800);
  document.documentElement.removeAttribute(QUIET);
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^extra/, "x");

// Drafts have no agent to switch, so drive Paseo's own dropdowns the way a user would.
export async function selectInDraft(pickerHandle: unknown, provider: string, modelId: string, effort: { id: string; label: string } | null) {
  const picker = pickerHandle as El;
  const composer = picker.closest(COMPOSER);
  const model = composer?.querySelector(MODEL);
  if (!composer || !visible(model)) throw new Error("That draft is gone.");
  realClick(model);
  const rowId = `model-row-${provider}-${modelId}`;
  let row = await waitFor(() => byTestId(document, rowId), 1200);
  if (!row) {
    // The dropdown reopens on the last provider; step back to the provider list if needed.
    const back = byTestId(document, "sheet-header-back");
    if (back) back.click();
    (await waitFor(() => byTestId(document, `model-provider-${provider}`)))?.click();
    row = await waitFor(() => byTestId(document, rowId));
  }
  if (!row) throw new Error("Couldn't find that model in Paseo's picker.");
  row.click();
  if (!effort) return;
  const thinking = await waitFor(() => {
    const el = composer.querySelector(THINKING);
    return visible(el) && !visible(Array.from(document.querySelectorAll(MENU)).pop()) ? el : null;
  });
  if (!thinking) throw new Error("This model has no effort setting in Paseo.");
  if (thinking.getAttribute("aria-label")?.includes(`(${effort.label})`)) return;
  realClick(thinking);
  const want = [normalize(effort.label), normalize(effort.id)];
  const option = await waitFor(() => {
    const menu = Array.from(document.querySelectorAll(MENU)).filter(visible).pop();
    if (!menu) return null;
    return (
      Array.from(menu.querySelectorAll('[role="button"],button')).find((b) => want.includes(normalize(b.textContent ?? ""))) ?? null
    );
  });
  if (!option) throw new Error(`Paseo has no "${effort.label}" effort for this model.`);
  option.click();
}

export type Overlay = { root: unknown; setActive(active: boolean): void; setBehindModals(behind: boolean): void };

/** A full-window layer for the draft popup's own React root; inert until the popup opens. */
export function createOverlay(): Overlay {
  const root = document.createElement("div");
  root.setAttribute("data-model-bench", "overlay");
  // Flex column so React Native Web's app container (flex: 1) fills the window.
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    display: "flex",
    flexDirection: "column",
    zIndex: "2147483000",
    pointerEvents: "none",
  });
  // React Native Web text sets its own system font; match the font Paseo's composer uses.
  const label = Array.from(document.querySelectorAll(`${MODEL} [dir="auto"]`)).find(visible);
  const font = label ? getComputedStyle(label).fontFamily : "";
  if (font) {
    const css = document.createElement("style");
    css.textContent = `[data-model-bench="overlay"] * { font-family: ${font} !important; }`;
    root.appendChild(css);
  }
  // Sit just before Paseo's #overlay-root: at its z-index, its modals then paint over us.
  document.body.insertBefore(root, document.getElementById("overlay-root"));
  return {
    root: root as unknown,
    setActive(active: boolean) {
      root.style.pointerEvents = active ? "auto" : "none";
    },
    // Paseo's own modals live in #overlay-root; match its z-index to drop just under them.
    setBehindModals(behind: boolean) {
      root.style.zIndex = behind ? "1" : "2147483000";
    },
  };
}

export function onEscape(close: () => void) {
  const listener = (event: DomEvent) => {
    // Escape belongs to Paseo's settings window while it's open over the popup.
    if (event.key === "Escape" && !byTestId(document, SHEET)) close();
  };
  document.addEventListener("keydown", listener, true);
  return () => document.removeEventListener("keydown", listener, true);
}

// Before any session popover has rendered we have no host theme, so guess one from the page.
export function pageTheme(): PluginTheme {
  const composer = Array.from(document.querySelectorAll(COMPOSER)).filter(visible).pop();
  let el: El | null = composer ?? document.body;
  let bg = "rgb(255, 255, 255)";
  for (; el; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor;
    if (color && !/rgba\(.*,\s*0\)|transparent/.test(color)) {
      bg = color;
      break;
    }
  }
  const [r = 255, g = 255, b = 255] = (bg.match(/\d+/g) ?? []).map(Number);
  const dark = 0.299 * r + 0.587 * g + 0.114 * b < 128;
  return {
    colors: dark
      ? {
          surface0: "#1b1b1b",
          surface1: "#222222",
          surface2: "#2c2c2c",
          border: "#343434",
          foreground: "#ececec",
          foregroundMuted: "#9b9b9b",
          accent: "#1d7a4c",
          accentForeground: "#ffffff",
          statusSuccess: "#35c264",
          statusWarning: "#e3c93c",
          statusDanger: "#f7796d",
        }
      : {
          surface0: "#ffffff",
          surface1: "#f7f7f7",
          surface2: "#eeeeee",
          border: "#e3e3e3",
          foreground: "#141414",
          foregroundMuted: "#6d6d6d",
          accent: "#1d7a4c",
          accentForeground: "#ffffff",
          statusSuccess: "#299f51",
          statusWarning: "#a3901a",
          statusDanger: "#d23b3b",
        },
  };
}
