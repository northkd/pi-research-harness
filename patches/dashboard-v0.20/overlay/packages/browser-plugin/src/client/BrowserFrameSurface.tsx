/** Frame rendering and finite viewer input; owns no session, socket or navigation. */
import type { BrowserRelayInputMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type React from "react";
import { useEffect, useRef, useState } from "react";

type InputPayload<T> = T extends BrowserRelayInputMessage ? Omit<T, "type" | "instanceId" | "tabId"> : never;
export type BrowserFrameInput = InputPayload<BrowserRelayInputMessage>;

export interface BrowserFrameSurfaceProps {
  jpeg: string | null;
  canInput: boolean;
  fit: boolean;
  resizeEnabled: boolean;
  onInput: (input: BrowserFrameInput) => void;
  frameAlt: string;
  textBridgeLabel: string;
  empty?: React.ReactNode;
  overlay?: React.ReactNode;
  testIdPrefix?: string;
}

const RESIZE_THROTTLE_MS = 500;
const RESIZE_DEAD_BAND_PX = 16;

function keyText(keyType: "keyDown" | "keyUp", event: React.KeyboardEvent): string | undefined {
  if (keyType !== "keyDown" || event.metaKey || event.ctrlKey && !event.altKey) return undefined;
  if (event.key === "Enter") return "\r";
  return [...event.key].length === 1 ? event.key : undefined;
}

export function BrowserFrameSurface({ jpeg, canInput, fit, resizeEnabled, onInput, frameAlt, textBridgeLabel, empty, overlay, testIdPrefix = "browser-pane" }: BrowserFrameSurfaceProps): React.ReactElement {
  const areaRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [bridgeValue, setBridgeValue] = useState("");

  useEffect(() => {
    const el = areaRef.current;
    if (!resizeEnabled || !el || typeof ResizeObserver === "undefined") return;
    let lastSent: { w: number; h: number } | null = null;
    let latest: { w: number; h: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!latest) return;
      if (lastSent && Math.abs(latest.w - lastSent.w) < RESIZE_DEAD_BAND_PX && Math.abs(latest.h - lastSent.h) < RESIZE_DEAD_BAND_PX) return;
      lastSent = latest;
      onInput({ kind: "resize", width: latest.w, height: latest.h });
    };
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r || !Number.isFinite(r.width) || !Number.isFinite(r.height) || r.width <= 0 || r.height <= 0) return;
      latest = { w: Math.round(r.width), h: Math.round(r.height) };
      if (timer === null) timer = setTimeout(flush, RESIZE_THROTTLE_MS);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [resizeEnabled, onInput]);

  const point = (clientX: number, clientY: number) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!canInput || e.pointerType === "mouse" && e.button !== 0) return;
    const p = point(e.clientX, e.clientY);
    if (p) onInput({ kind: "mouse", ...p, action: "click", button: "left", clickCount: 1 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!canInput || e.pointerType !== "mouse") return;
    const p = point(e.clientX, e.clientY);
    if (p) onInput({ kind: "mouse", ...p, action: "move" });
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!canInput || !Number.isFinite(e.deltaX) || !Number.isFinite(e.deltaY)) return;
    const p = point(e.clientX, e.clientY);
    if (p) onInput({ kind: "scroll", ...p, deltaX: e.deltaX, deltaY: e.deltaY });
  };
  const onKey = (keyType: "keyDown" | "keyUp") => (e: React.KeyboardEvent) => {
    if (!canInput) return;
    const text = keyText(keyType, e);
    onInput({ kind: "key", keyType, key: e.key, code: e.code, ...(text !== undefined ? { text } : {}) });
  };
  const onBridgeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (canInput) for (const ch of Array.from(e.target.value)) onInput({ kind: "key", keyType: "char", key: ch, text: ch });
    setBridgeValue("");
  };
  const onBridgeKeyDown = (e: React.KeyboardEvent) => {
    if (!canInput) return;
    if (e.key === "Enter") onInput({ kind: "key", keyType: "keyDown", key: "Enter", code: "Enter", text: "\r" });
    else if (e.key === "Backspace") onInput({ kind: "key", keyType: "keyDown", key: "Backspace", code: "Backspace" });
    else if (e.key === "Tab") onInput({ kind: "key", keyType: "keyDown", key: "Tab", code: "Tab" });
    else return;
    e.preventDefault();
  };

  return (
    <>
      <div ref={areaRef} data-testid={`${testIdPrefix}-frame-area`} className={`relative min-h-0 min-w-0 flex-1 bg-black/5 ${fit ? "overflow-hidden" : "overflow-auto"}`}>
        <div
          ref={boxRef}
          tabIndex={0}
          data-testid={`${testIdPrefix}-frame-box`}
          className={`select-none outline-none ${fit ? "flex h-full w-full items-center justify-center" : "inline-block"}`}
          style={{ userSelect: "none", touchAction: "none" }}
          onPointerDown={(e) => {
            if (canInput) boxRef.current?.focus();
            if (e.pointerType === "mouse") e.preventDefault();
          }}
          onPointerUp={onPointerUp}
          onPointerMove={onPointerMove}
          onWheel={onWheel}
          onKeyDown={onKey("keyDown")}
          onKeyUp={onKey("keyUp")}
          onDragStart={(e) => e.preventDefault()}
        >
          {jpeg ? <img ref={imgRef} data-testid={`${testIdPrefix}-frame`} alt={frameAlt} src={`data:image/jpeg;base64,${jpeg}`} className={`block select-none ${fit ? "max-h-full max-w-full object-contain" : ""}`} draggable={false} /> : empty}
        </div>
        {overlay}
      </div>
      <div className="shrink-0 border-t border-[var(--border-primary)] p-1">
        <input type="text" data-testid={`${testIdPrefix}-text-bridge`} aria-label={textBridgeLabel} placeholder={textBridgeLabel}
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={!canInput}
          value={bridgeValue} onChange={onBridgeChange} onKeyDown={onBridgeKeyDown}
          className="w-full rounded border border-[var(--border-secondary)] bg-transparent px-2 py-1 text-xs" />
      </div>
    </>
  );
}
