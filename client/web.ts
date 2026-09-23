import { Platform } from "react-native";

type El = {
  closest(selector: string): El | null;
  querySelector(selector: string): El | null;
  parentElement: El | null;
  click(): void;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; top: number };
  style: { transform: string; opacity: string };
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
  addEventListener(type: string, listener: (event: DomEvent) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: DomEvent) => void, capture: boolean): void;
};

// Paseo's own testIDs for the composer's model and thinking dropdowns.
const PICKERS = '[data-testid="combined-model-selector"],[data-testid="agent-thinking-selector"]';
const PILL = 'button[aria-label="Model benchmarks"]';
const EVENTS = ["pointerdown", "mousedown", "click", "keydown"];

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

// The plugin API cannot replace built-in controls, so on web we intercept their clicks and
// open the Bench popover instead. Shift-click still opens the original dropdown.
export function takeOverModelPicker(): () => void {
  if (Platform.OS !== "web") return () => {};
  const onEvent = (event: DomEvent) => {
    if (event.shiftKey) return;
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    const picker = event.target?.closest?.(PICKERS);
    if (!picker) return;
    let scope: El | null = picker;
    while (scope && !scope.querySelector(PILL)) scope = scope.parentElement;
    const pill = scope?.querySelector(PILL);
    if (!pill) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "click" || event.type === "keydown") openAt(pill, picker);
  };
  for (const type of EVENTS) document.addEventListener(type, onEvent, true);
  return () => {
    for (const type of EVENTS) document.removeEventListener(type, onEvent, true);
  };
}
