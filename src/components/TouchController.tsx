import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Edit3,
  Gamepad2,
  Maximize2,
  Menu,
  Monitor,
  Moon,
  RotateCcw,
  RotateCw,
  Sliders,
  Smartphone,
  Sun,
  Wifi,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { buildLayout, LAYOUT_ORDER, LAYOUTS } from '../lib/layouts';
import { triggerHaptic } from '../lib/sound';
import { ConnectionState, ConnectionTransport } from '../hooks/useGamepadSync';
import {
  ConnectedDevice,
  ControlItem,
  LayoutId,
  SavedControlTransform,
  SyncedSettings,
  TextureFinish,
} from '../types/gamepad';
import { PWAInstallButton } from './PWAInstallButton';

interface TouchControllerProps {
  pin: string;
  onPinChange: (pin: string) => void;
  transport: ConnectionTransport;
  onTransportChange: (t: ConnectionTransport) => void;
  lanAddress: string;
  onLanAddressChange: (addr: string) => void;
  settings: SyncedSettings;
  onUpdateSettings: (
    updater: Partial<SyncedSettings> | ((prev: SyncedSettings) => SyncedSettings)
  ) => void;
  connectionState: ConnectionState;
  rtt: number | null;
  devices: ConnectedDevice[];
  caps: { pad: string | null; kbm: string | null };
  syncPulse: 'idle' | 'syncing' | 'synced';
  onSendInput: (payload: Record<string, unknown>) => void;
  onReleaseAll: () => void;
  onSwitchToDesktopHub: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const LEFT_GROUP = ['UP', 'LEFT', 'RIGHT', 'DOWN'];
const RIGHT_GROUP = ['Y', 'X', 'B', 'A'];

export const TouchController: React.FC<TouchControllerProps> = ({
  pin,
  onPinChange,
  transport,
  onTransportChange,
  lanAddress,
  onLanAddressChange,
  settings,
  onUpdateSettings,
  connectionState,
  rtt,
  devices,
  caps,
  syncPulse,
  onSendInput,
  onReleaseAll,
  onSwitchToDesktopHub,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({
    w: typeof window !== 'undefined' ? window.innerWidth : 900,
    h: typeof window !== 'undefined' ? window.innerHeight : 420,
  });
  const [allowPortrait, setAllowPortrait] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuTab, setMenuTab] = useState<'layouts' | 'feel' | 'sync' | 'editor'>('layouts');
  const [editMode, setEditMode] = useState(false);
  const [selectedEditId, setSelectedEditId] = useState<string | null>(null);
  const [pinDraft, setPinDraft] = useState(pin);
  const [lanDraft, setLanDraft] = useState(lanAddress);

  // Active pressed digital & toggle controls
  const [pressedIds, setPressedIds] = useState<Record<string, boolean>>({});
  const [toggledIds, setToggledIds] = useState<Record<string, boolean>>({});

  // Live analog visuals stored in refs + DOM nodes for 60fps zero-jank motion
  const stickCapRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const steerKnobRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const lookRippleRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const stickStateRef = useRef<
    Record<
      string,
      {
        pid: number | null;
        x: number;
        y: number;
        sx: number | null;
        sy: number | null;
        keys: Record<string, boolean>;
        isKeys: boolean;
        padId?: string;
      }
    >
  >({});

  const steerStateRef = useRef<
    Record<string, { pid: number | null; x: number; sx: number | null; padId: string }>
  >({});

  const lookStateRef = useRef<
    Record<
      string,
      {
        pid: number | null;
        lx: number;
        ly: number;
        px: number;
        py: number;
        rx: number;
        ry: number;
        t0: number;
        dist: number;
        holding: boolean;
        timer: number | null;
        useTap: boolean;
      }
    >
  >({});

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const sendInputRef = useRef(onSendInput);
  sendInputRef.current = onSendInput;

  useEffect(() => {
    setPinDraft(pin);
  }, [pin]);

  useEffect(() => {
    setLanDraft(lanAddress);
  }, [lanAddress]);

  // Track viewport resize smoothly
  useEffect(() => {
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  // Release all inputs when tab blurs or hides
  useEffect(() => {
    const release = () => {
      setPressedIds({});
      setToggledIds({});
      onReleaseAll();
    };
    const onVis = () => {
      if (document.hidden) release();
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [onReleaseAll]);

  // 60fps RAF loop for analog sticks, steering slider, and camera look deltas
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      const cfg = settingsRef.current;
      const send = sendInputRef.current;

      // Sticks
      for (const st of Object.values(stickStateRef.current)) {
        if (st.isKeys) {
          const T = Math.max(0.18, cfg.deadzone + 0.14);
          const want: Record<string, boolean> = {
            w: st.y < -T,
            s: st.y > T,
            a: st.x < -T,
            d: st.x > T,
          };
          for (const k of ['w', 's', 'a', 'd']) {
            if (want[k] !== Boolean(st.keys[k])) {
              st.keys[k] = want[k];
              send({ t: 'k', k, v: want[k] ? 1 : 0 });
            }
          }
        } else if (st.padId) {
          const mag = Math.hypot(st.x, st.y);
          const dz = cfg.deadzone;
          let ax = 0;
          let ay = 0;
          if (mag > dz) {
            const scaled = (mag - dz) / (1 - dz);
            ax = +((st.x / mag) * scaled).toFixed(3);
            ay = +((st.y / mag) * scaled).toFixed(3);
          }
          if (ax !== st.sx || ay !== st.sy) {
            st.sx = ax;
            st.sy = ay;
            send({ t: 's', k: st.padId, x: ax, y: ay });
          }
        }
      }

      // Steering slider
      for (const st of Object.values(steerStateRef.current)) {
        const v = Math.abs(st.x) < cfg.deadzone ? 0 : +st.x.toFixed(3);
        if (v !== st.sx) {
          st.sx = v;
          send({ t: 's', k: st.padId, x: v, y: 0 });
        }
      }

      // Camera Look Touchpads
      for (const lk of Object.values(lookStateRef.current)) {
        if (!lk.px && !lk.py) continue;
        const mx = lk.px * cfg.sens + lk.rx;
        const my = lk.py * cfg.sens + lk.ry;
        const ix = Math.trunc(mx);
        const iy = Math.trunc(my);
        lk.rx = mx - ix;
        lk.ry = my - iy;
        lk.px = 0;
        lk.py = 0;
        if (ix || iy) {
          send({ t: 'm', dx: ix, dy: iy });
        }
      }

      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Build layout + apply any synced custom positions/sizes
  const items = useMemo(() => {
    const base = buildLayout(settings.layout, viewport.w, viewport.h);
    const saved = settings.customLayouts[settings.layout] || {};
    return base.map((it) => {
      const ov = saved[it.id];
      if (!ov) return it;
      return {
        ...it,
        x: ov.x * viewport.w,
        y: ov.y * viewport.h,
        w: ov.w * viewport.w,
        h: ov.h * viewport.h,
      };
    });
  }, [settings.layout, settings.customLayouts, viewport.w, viewport.h]);

  // Reset transient stick/toggle refs when layout switches
  useEffect(() => {
    stickStateRef.current = {};
    steerStateRef.current = {};
    lookStateRef.current = {};
    setPressedIds({});
    setToggledIds({});
    onReleaseAll();
  }, [settings.layout, onReleaseAll]);

  const fireControl = useCallback(
    (it: ControlItem, v: number) => {
      if (it.pad !== undefined) {
        onSendInput(it.analog ? { t: 'tr', k: it.pad, v } : { t: 'b', k: it.pad, v });
      } else if (it.key !== undefined) {
        onSendInput({ t: 'k', k: it.key, v });
      } else if (it.mouse !== undefined) {
        onSendInput({ t: 'mb', k: it.mouse, v });
      }
    },
    [onSendInput]
  );

  const goFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        const orient = screen.orientation as unknown as { lock?: (o: string) => Promise<void> };
        if (orient && typeof orient.lock === 'function') {
          await orient.lock('landscape').catch(() => {});
        }
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // iOS Safari fullscreen restrictions
    }
    try {
      const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<unknown> } }).wakeLock;
      if (wl) await wl.request('screen');
    } catch {
      // ignore wake lock errors
    }
  }, []);

  // ---------- Layout Editor Drag & Resize ----------
  const editDragRef = useRef<{
    id: string;
    pid: number;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    group: Array<{ id: string; x: number; y: number; w: number; h: number }>;
    square: boolean;
  } | null>(null);

  const [editPreview, setEditPreview] = useState<
    Record<string, { x: number; y: number; w: number; h: number }>
  >({});

  const commitTransforms = useCallback(
    (updates: Record<string, { x: number; y: number; w: number; h: number }>) => {
      onUpdateSettings((prev) => {
        const currentMap: Record<string, SavedControlTransform> = {
          ...(prev.customLayouts[prev.layout] || {}),
        };
        for (const [id, rect] of Object.entries(updates)) {
          currentMap[id] = {
            x: clamp(rect.x / Math.max(1, viewport.w), 0, 0.96),
            y: clamp(rect.y / Math.max(1, viewport.h), 0, 0.96),
            w: clamp(rect.w / Math.max(1, viewport.w), 0.03, 0.7),
            h: clamp(rect.h / Math.max(1, viewport.h), 0.03, 0.8),
          };
        }
        return {
          ...prev,
          customLayouts: {
            ...prev.customLayouts,
            [prev.layout]: currentMap,
          },
        };
      });
    },
    [onUpdateSettings, viewport.w, viewport.h]
  );

  const handleEditPointerDown = (e: React.PointerEvent, it: ControlItem, forceResize = false) => {
    if (!editMode || ['status', 'menu', 'fs'].includes(it.id)) return;
    e.preventDefault();
    e.stopPropagation();

    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const edge = 26;
    const inResizeZone =
      forceResize ||
      (e.clientX >= rect.right - edge && e.clientY >= rect.bottom - edge);
    const mode: 'move' | 'resize' = inResizeZone ? 'resize' : 'move';

    setSelectedEditId(it.id);

    const groupIds =
      mode === 'move' && LEFT_GROUP.includes(it.id)
        ? LEFT_GROUP
        : mode === 'move' && RIGHT_GROUP.includes(it.id)
          ? RIGHT_GROUP
          : [it.id];

    const group = groupIds
      .map((gid) => items.find((x) => x.id === gid))
      .filter((x): x is ControlItem => Boolean(x))
      .map((x) => {
        const cur = editPreview[x.id] || x;
        return { id: x.id, x: cur.x, y: cur.y, w: cur.w, h: cur.h };
      });

    editDragRef.current = {
      id: it.id,
      pid: e.pointerId,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      group,
      square: Math.abs(it.w - it.h) < Math.max(it.w, it.h) * 0.18,
    };

    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleEditPointerMove = (e: React.PointerEvent) => {
    const drag = editDragRef.current;
    if (!editMode || !drag || drag.pid !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const next: Record<string, { x: number; y: number; w: number; h: number }> = {};

    if (drag.mode === 'resize') {
      const base = drag.group[0];
      const min = 36;
      const maxW = Math.max(min, viewport.w * 0.45);
      const maxH = Math.max(min, viewport.h * 0.78);
      let w = base.w + dx;
      let h = base.h + dy;
      if (drag.square) {
        const delta = (dx + dy) / 2;
        w = base.w + delta;
        h = base.h + delta;
      }
      w = clamp(w, min, maxW);
      h = clamp(h, min, maxH);
      next[base.id] = {
        x: clamp(base.x, 0, viewport.w - w),
        y: clamp(base.y, 0, viewport.h - h),
        w,
        h,
      };
    } else {
      for (const m of drag.group) {
        next[m.id] = {
          x: clamp(m.x + dx, 0, viewport.w - m.w),
          y: clamp(m.y + dy, 0, viewport.h - m.h),
          w: m.w,
          h: m.h,
        };
      }
    }
    setEditPreview((prev) => ({ ...prev, ...next }));
  };

  const handleEditPointerUp = (e: React.PointerEvent) => {
    const drag = editDragRef.current;
    if (!drag || drag.pid !== e.pointerId) return;
    editDragRef.current = null;
    if (Object.keys(editPreview).length > 0) {
      commitTransforms(editPreview);
      setEditPreview({});
    }
  };

  const resizeSelectedBy = (factor: number) => {
    if (!selectedEditId) return;
    const it = items.find((x) => x.id === selectedEditId);
    if (!it) return;
    const min = 36;
    const w = clamp(it.w * factor, min, viewport.w * 0.45);
    const h = clamp(it.h * factor, min, viewport.h * 0.78);
    commitTransforms({
      [it.id]: {
        x: clamp(it.x, 0, viewport.w - w),
        y: clamp(it.y, 0, viewport.h - h),
        w,
        h,
      },
    });
  };

  const resetCurrentLayout = () => {
    onUpdateSettings((prev) => {
      const nextCustom = { ...prev.customLayouts };
      delete nextCustom[prev.layout];
      return { ...prev, customLayouts: nextCustom };
    });
    setSelectedEditId(null);
  };

  // ---------- Status Label ----------
  const isPadMode = LAYOUTS[settings.layout].out === 'pad';
  const statusLabel = useMemo(() => {
    if (connectionState === 'locked') return 'PIN locked · wait 60s';
    if (connectionState === 'reconnecting') return 'Reconnecting...';
    if (connectionState === 'connecting') return 'Connecting...';
    const bridgeCount = devices.filter((d) => d.role === 'bridge').length;
    const desktopCount = devices.filter((d) => d.role === 'desktop').length;
    const ms = rtt !== null ? `${rtt} ms` : '';
    if (transport === 'lan') {
      return `LAN Ready${ms ? ` · ${ms}` : ''}`;
    }
    if (bridgeCount > 0) {
      return `Windows ViGEmBus${ms ? ` · ${ms}` : ''}`;
    }
    if (desktopCount > 0) {
      return `Desktop Paired${ms ? ` · ${ms}` : ''}`;
    }
    return `PIN ${pin}${ms ? ` · ${ms}` : ''}`;
  }, [connectionState, devices, rtt, transport, pin]);

  const isStatusHealthy = connectionState === 'connected';
  const isPortrait = viewport.h > viewport.w * 1.08;
  const surfaceTexClass =
    settings.texture === 'carbon'
      ? 'tex-carbon'
      : settings.texture === 'brushed-metal'
        ? 'tex-brushed-metal'
        : 'tex-ceramic';

  const selectedItem = selectedEditId ? items.find((i) => i.id === selectedEditId) : null;

  return (
    <div
      ref={containerRef}
      className={`pad-surface ${surfaceTexClass} fixed inset-0 overflow-hidden select-none`}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Sculpted Metallic Ergonomic Controller Shell SVG for Pad Modes */}
      {isPadMode && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 190 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="padBodyGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: 'var(--pad-shell-1)' }} />
              <stop offset="100%" style={{ stopColor: 'var(--pad-shell-2)' }} />
            </linearGradient>
            <pattern id="padRidge" width="10" height="1.8" patternUnits="userSpaceOnUse">
              <rect width="10" height="0.35" style={{ fill: 'var(--pad-ridge)' }} />
            </pattern>
          </defs>
          <path
            d="M0,24 C0,10 8,4 24,4 L66,4 C78,4 84,11 95,11 C106,11 112,4 124,4 L166,4 C182,4 190,10 190,24 L190,100 L0,100 Z"
            fill="url(#padBodyGrad)"
            stroke="#c81e3a"
            strokeOpacity="0.62"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M0,24 C0,10 8,4 24,4 L66,4 C78,4 84,11 95,11 C106,11 112,4 124,4 L166,4 C182,4 190,10 190,24 L190,100 L0,100 Z"
            fill="url(#padRidge)"
          />
          <ellipse cx="38" cy="66" rx="45" ry="43" style={{ fill: 'var(--pad-lobe)' }} opacity="0.72" />
          <ellipse cx="152" cy="66" rx="45" ry="43" style={{ fill: 'var(--pad-lobe)' }} opacity="0.72" />
        </svg>
      )}

      {/* Subtle Perimeter Precision Frame */}
      <div
        className="pointer-events-none fixed inset-1.5 rounded-[22px] border border-[#e11d48]/25 shadow-[inset_0_0_24px_rgba(225,29,72,0.08)]"
        aria-hidden="true"
      />

      {/* Interactive Controls Layer */}
      {items.map((rawItem) => {
        const ov = editPreview[rawItem.id];
        const it = ov ? { ...rawItem, ...ov } : rawItem;
        const fontSize = clamp(Math.min(it.w, it.h) * (it.fs || 0.34), 9, 19);
        const isSelected = editMode && selectedEditId === it.id;

        const baseStyle: React.CSSProperties = {
          left: it.x,
          top: it.y,
          width: it.w,
          height: it.h,
          fontSize,
          zIndex: it.kind === 'look' ? 1 : it.kind === 'ui' ? 12 : 4,
        };

        const editOutlineClass = editMode
          ? isSelected
            ? 'ring-2 ring-amber-400 shadow-[0_0_18px_rgba(251,191,36,0.45)] cursor-move'
            : !['status', 'menu', 'fs'].includes(it.id)
              ? 'outline outline-1 outline-dashed outline-rose-400/80 cursor-move'
              : ''
          : '';

        // 1. UI Controls (Menu, Fullscreen, Status, Drive Quick-Switch)
        if (it.kind === 'ui') {
          if (it.ui === 'status') {
            return (
              <button
                key={it.id}
                type="button"
                style={baseStyle}
                onClick={() => {
                  setMenuTab('sync');
                  setMenuOpen(true);
                }}
                className={`absolute flex items-center justify-center gap-1.5 truncate rounded-full border px-2.5 font-mono-tabular font-semibold transition-colors ${
                  isStatusHealthy
                    ? 'border-emerald-500/35 bg-emerald-950/70 text-emerald-300'
                    : 'border-rose-500/40 bg-rose-950/75 text-rose-200'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    isStatusHealthy ? 'bg-emerald-400' : 'bg-rose-400'
                  }`}
                />
                <span className="truncate">{statusLabel}</span>
              </button>
            );
          }

          if (it.ui === 'menu' || it.ui === 'fs') {
            return (
              <button
                key={it.id}
                type="button"
                style={baseStyle}
                onClick={() => {
                  triggerHaptic(settings.vib, settings.audioClick, 'press');
                  if (it.ui === 'menu') {
                    onReleaseAll();
                    setMenuOpen(true);
                  } else {
                    goFullscreen();
                  }
                }}
                className="pad-btn absolute rounded-lg border border-[#e11d48]/45 text-xs font-semibold tracking-wider active:scale-95"
                aria-label={it.ui === 'menu' ? 'Open controller menu' : 'Toggle fullscreen'}
              >
                <span className="flex items-center gap-1">
                  {it.ui === 'menu' ? <Menu className="h-4 w-4" /> : <Maximize2 className="h-3.5 w-3.5" />}
                </span>
              </button>
            );
          }

          if (it.ui === 'drive') {
            const active = settings.layout === 'driving';
            return (
              <button
                key={it.id}
                type="button"
                style={baseStyle}
                onPointerDown={editMode ? (e) => handleEditPointerDown(e, it) : undefined}
                onPointerMove={editMode ? handleEditPointerMove : undefined}
                onPointerUp={editMode ? handleEditPointerUp : undefined}
                onClick={() => {
                  if (editMode) return;
                  triggerHaptic(settings.vib, settings.audioClick, 'toggle');
                  onUpdateSettings({ layout: active ? 'gamepad' : 'driving' });
                }}
                className={`pad-btn absolute rounded-full border ${
                  active
                    ? 'border-amber-400/80 text-amber-300 shadow-[0_0_16px_rgba(245,158,11,0.3)]'
                    : 'border-[#e11d48]/60 text-rose-400'
                } ${editOutlineClass}`}
                aria-label={active ? 'Switch to Gamepad layout' : 'Switch to Driving layout'}
              >
                {it.icon === 'car' ? (
                  <svg viewBox="0 0 32 32" className="h-3/5 w-3/5 stroke-current" fill="none" strokeWidth="2.3">
                    <path d="M5 19l2-7a3 3 0 0 1 3-2h12a3 3 0 0 1 3 2l2 7v6h-3v-3H8v3H5z" />
                    <path d="M8 17h16M11 10l2-4h6l2 4" />
                    <circle cx="10" cy="19" r="1.5" />
                    <circle cx="22" cy="19" r="1.5" />
                  </svg>
                ) : (
                  <Gamepad2 className="h-3/5 w-3/5" />
                )}
              </button>
            );
          }
        }

        // 2. Capacitive Drag-to-Look Camera Touchpad
        if (it.kind === 'look') {
          return (
            <div
              key={it.id}
              style={baseStyle}
              className={`pad-touchpad absolute flex flex-col items-center justify-center overflow-hidden ${editOutlineClass}`}
              onPointerDown={(e) => {
                if (editMode) {
                  handleEditPointerDown(e, it);
                  return;
                }
                e.preventDefault();
                if (!lookStateRef.current[it.id]) {
                  lookStateRef.current[it.id] = {
                    pid: null,
                    lx: 0,
                    ly: 0,
                    px: 0,
                    py: 0,
                    rx: 0,
                    ry: 0,
                    t0: 0,
                    dist: 0,
                    holding: false,
                    timer: null,
                    useTap: Boolean(it.tap && settings.tap),
                  };
                }
                const lk = lookStateRef.current[it.id];
                if (lk.pid !== null) return;
                lk.pid = e.pointerId;
                lk.lx = e.clientX;
                lk.ly = e.clientY;
                lk.dist = 0;
                lk.t0 = performance.now();
                lk.holding = false;
                lk.useTap = Boolean(it.tap && settings.tap);
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // ignore
                }

                // Visual touch ripple
                const ripple = lookRippleRefs.current[it.id];
                if (ripple) {
                  const r = e.currentTarget.getBoundingClientRect();
                  ripple.style.opacity = '1';
                  ripple.style.transform = `translate(${e.clientX - r.left - 28}px, ${e.clientY - r.top - 28}px) scale(1)`;
                }

                if (lk.useTap) {
                  lk.timer = window.setTimeout(() => {
                    if (lk.pid !== null && lk.dist < 10) {
                      lk.holding = true;
                      onSendInput({ t: 'mb', k: 'left', v: 1 });
                      triggerHaptic(settings.vib, settings.audioClick, 'trigger');
                    }
                  }, 320);
                }
              }}
              onPointerMove={(e) => {
                if (editMode) {
                  handleEditPointerMove(e);
                  return;
                }
                const lk = lookStateRef.current[it.id];
                if (!lk || lk.pid !== e.pointerId) return;
                const dx = e.clientX - lk.lx;
                const dy = e.clientY - lk.ly;
                lk.lx = e.clientX;
                lk.ly = e.clientY;
                lk.dist += Math.abs(dx) + Math.abs(dy);
                lk.px += dx;
                lk.py += dy;

                const ripple = lookRippleRefs.current[it.id];
                if (ripple) {
                  const r = e.currentTarget.getBoundingClientRect();
                  ripple.style.transform = `translate(${e.clientX - r.left - 28}px, ${e.clientY - r.top - 28}px) scale(1.12)`;
                }
              }}
              onPointerUp={(e) => {
                if (editMode) {
                  handleEditPointerUp(e);
                  return;
                }
                const lk = lookStateRef.current[it.id];
                if (!lk || lk.pid !== e.pointerId) return;
                lk.pid = null;
                if (lk.timer) {
                  window.clearTimeout(lk.timer);
                  lk.timer = null;
                }
                const ripple = lookRippleRefs.current[it.id];
                if (ripple) ripple.style.opacity = '0';

                if (lk.holding) {
                  lk.holding = false;
                  onSendInput({ t: 'mb', k: 'left', v: 0 });
                } else if (lk.useTap && lk.dist < 10 && performance.now() - lk.t0 < 250) {
                  onSendInput({ t: 'mb', k: 'left', v: 1 });
                  triggerHaptic(settings.vib, settings.audioClick, 'press');
                  window.setTimeout(() => onSendInput({ t: 'mb', k: 'left', v: 0 }), 45);
                }
              }}
              onPointerCancel={(e) => {
                const lk = lookStateRef.current[it.id];
                if (!lk || lk.pid !== e.pointerId) return;
                lk.pid = null;
                if (lk.timer) window.clearTimeout(lk.timer);
                if (lk.holding) {
                  lk.holding = false;
                  onSendInput({ t: 'mb', k: 'left', v: 0 });
                }
                const ripple = lookRippleRefs.current[it.id];
                if (ripple) ripple.style.opacity = '0';
              }}
            >
              <div
                ref={(el) => {
                  lookRippleRefs.current[it.id] = el;
                }}
                className="pointer-events-none absolute left-0 top-0 h-14 w-14 rounded-full bg-rose-500/30 opacity-0 blur-md transition-opacity duration-150"
              />
              <span className="pointer-events-none text-2xl leading-none text-rose-200/45">⌖</span>
              <span className="pointer-events-none mt-1 text-[10px] font-semibold tracking-[0.18em] text-rose-200/60">
                DRAG TO LOOK
              </span>
              {editMode && (
                <span
                  onPointerDown={(e) => handleEditPointerDown(e, it, true)}
                  className="absolute -bottom-2 -right-2 flex h-7 w-7 items-center justify-center rounded-lg border border-white bg-[#e11d48] text-xs font-bold text-white shadow-md cursor-nwse-resize"
                >
                  ⤢
                </span>
              )}
            </div>
          );
        }

        // 3. Analog / WASD Thumbstick
        if (it.kind === 'stick') {
          const capDia = Math.min(it.w, it.h) * 0.48;
          return (
            <div
              key={it.id}
              style={baseStyle}
              className={`pad-stick-well absolute flex items-center justify-center ${editOutlineClass}`}
              onPointerDown={(e) => {
                if (editMode) {
                  handleEditPointerDown(e, it);
                  return;
                }
                e.preventDefault();
                if (!stickStateRef.current[it.id]) {
                  stickStateRef.current[it.id] = {
                    pid: null,
                    x: 0,
                    y: 0,
                    sx: null,
                    sy: null,
                    keys: {},
                    isKeys: Boolean(it.keys),
                    padId: it.pad,
                  };
                }
                const st = stickStateRef.current[it.id];
                if (st.pid !== null) return;
                st.pid = e.pointerId;
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
                triggerHaptic(settings.vib, settings.audioClick, 'press');

                const r = e.currentTarget.getBoundingClientRect();
                const rad = r.width / 2;
                let x = ((e.clientX - (r.left + rad)) / rad) * settings.gain;
                let y = ((e.clientY - (r.top + rad)) / rad) * settings.gain;
                const m = Math.hypot(x, y);
                if (m > 1) {
                  x /= m;
                  y /= m;
                }
                st.x = x;
                st.y = y;
                const capEl = stickCapRefs.current[it.id];
                if (capEl) {
                  capEl.style.transition = 'none';
                  capEl.style.transform = `translate3d(${x * rad * 0.56}px, ${y * rad * 0.56}px, 0)`;
                }
              }}
              onPointerMove={(e) => {
                if (editMode) {
                  handleEditPointerMove(e);
                  return;
                }
                const st = stickStateRef.current[it.id];
                if (!st || st.pid !== e.pointerId) return;
                const r = e.currentTarget.getBoundingClientRect();
                const rad = r.width / 2;
                let x = ((e.clientX - (r.left + rad)) / rad) * settings.gain;
                let y = ((e.clientY - (r.top + rad)) / rad) * settings.gain;
                const m = Math.hypot(x, y);
                if (m > 1) {
                  x /= m;
                  y /= m;
                }
                st.x = x;
                st.y = y;
                const capEl = stickCapRefs.current[it.id];
                if (capEl) {
                  capEl.style.transform = `translate3d(${x * rad * 0.56}px, ${y * rad * 0.56}px, 0)`;
                }
              }}
              onPointerUp={(e) => {
                if (editMode) {
                  handleEditPointerUp(e);
                  return;
                }
                const st = stickStateRef.current[it.id];
                if (!st || st.pid !== e.pointerId) return;
                st.pid = null;
                st.x = 0;
                st.y = 0;
                const capEl = stickCapRefs.current[it.id];
                if (capEl) {
                  capEl.style.transition = 'transform 140ms cubic-bezier(0.16, 1, 0.3, 1)';
                  capEl.style.transform = 'translate3d(0px, 0px, 0)';
                }
              }}
              onPointerCancel={(e) => {
                const st = stickStateRef.current[it.id];
                if (!st || st.pid !== e.pointerId) return;
                st.pid = null;
                st.x = 0;
                st.y = 0;
                const capEl = stickCapRefs.current[it.id];
                if (capEl) {
                  capEl.style.transition = 'transform 140ms cubic-bezier(0.16, 1, 0.3, 1)';
                  capEl.style.transform = 'translate3d(0px, 0px, 0)';
                }
              }}
            >
              <div
                ref={(el) => {
                  stickCapRefs.current[it.id] = el;
                }}
                style={{ width: capDia, height: capDia }}
                className="pad-stick-cap pointer-events-none flex items-center justify-center"
              >
                <div className="h-[62%] w-[62%] rounded-full border border-white/15 bg-black/25 shadow-inner" />
              </div>
              {it.cap && (
                <span className="pointer-events-none absolute bottom-2 text-[9px] font-semibold tracking-[0.25em] text-zinc-400/75">
                  {it.cap}
                </span>
              )}
              {editMode && (
                <span
                  onPointerDown={(e) => handleEditPointerDown(e, it, true)}
                  className="absolute -bottom-2 -right-2 flex h-7 w-7 items-center justify-center rounded-lg border border-white bg-[#e11d48] text-xs font-bold text-white shadow-md cursor-nwse-resize"
                >
                  ⤢
                </span>
              )}
            </div>
          );
        }

        // 4. Driving Steering Slider
        if (it.kind === 'steer') {
          return (
            <div
              key={it.id}
              style={baseStyle}
              className={`pad-steer-track absolute flex items-center justify-center overflow-visible ${editOutlineClass}`}
              onPointerDown={(e) => {
                if (editMode) {
                  handleEditPointerDown(e, it);
                  return;
                }
                e.preventDefault();
                if (!steerStateRef.current[it.id]) {
                  steerStateRef.current[it.id] = { pid: null, x: 0, sx: null, padId: it.pad || 'L' };
                }
                const st = steerStateRef.current[it.id];
                if (st.pid !== null) return;
                st.pid = e.pointerId;
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // ignore
                }
                triggerHaptic(settings.vib, settings.audioClick, 'press');
                const r = e.currentTarget.getBoundingClientRect();
                const x = clamp(
                  (e.clientX - (r.left + r.width / 2)) / ((r.width / 2) * (0.85 / settings.gain)),
                  -1,
                  1
                );
                st.x = x;
                const knob = steerKnobRefs.current[it.id];
                if (knob) {
                  knob.style.transition = 'none';
                  knob.style.left = `${50 + x * 41}%`;
                }
              }}
              onPointerMove={(e) => {
                if (editMode) {
                  handleEditPointerMove(e);
                  return;
                }
                const st = steerStateRef.current[it.id];
                if (!st || st.pid !== e.pointerId) return;
                const r = e.currentTarget.getBoundingClientRect();
                const x = clamp(
                  (e.clientX - (r.left + r.width / 2)) / ((r.width / 2) * (0.85 / settings.gain)),
                  -1,
                  1
                );
                st.x = x;
                const knob = steerKnobRefs.current[it.id];
                if (knob) knob.style.left = `${50 + x * 41}%`;
              }}
              onPointerUp={(e) => {
                if (editMode) {
                  handleEditPointerUp(e);
                  return;
                }
                const st = steerStateRef.current[it.id];
                if (!st || st.pid !== e.pointerId) return;
                st.pid = null;
                st.x = 0;
                const knob = steerKnobRefs.current[it.id];
                if (knob) {
                  knob.style.transition = 'left 130ms cubic-bezier(0.16, 1, 0.3, 1)';
                  knob.style.left = '50%';
                }
              }}
              onPointerCancel={(e) => {
                const st = steerStateRef.current[it.id];
                if (!st || st.pid !== e.pointerId) return;
                st.pid = null;
                st.x = 0;
                const knob = steerKnobRefs.current[it.id];
                if (knob) {
                  knob.style.transition = 'left 130ms cubic-bezier(0.16, 1, 0.3, 1)';
                  knob.style.left = '50%';
                }
              }}
            >
              <div className="pointer-events-none absolute inset-x-4 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/10" />
              <div className="pointer-events-none absolute left-1/2 top-2 bottom-2 w-0.5 -translate-x-1/2 bg-[#e11d48]/50" />
              <span className="pointer-events-none text-xs font-bold tracking-[0.38em] text-zinc-400/70">
                STEER
              </span>
              <div
                ref={(el) => {
                  steerKnobRefs.current[it.id] = el;
                }}
                style={{ left: '50%' }}
                className="pointer-events-none absolute top-[10%] flex h-[80%] w-[18%] -translate-x-1/2 items-center justify-center gap-1 rounded-xl border border-rose-400/60 bg-gradient-to-b from-zinc-300 via-zinc-500 to-zinc-800 shadow-[0_6px_14px_rgba(0,0,0,0.6)]"
              >
                <span className="h-5 w-0.5 rounded-full bg-black/40" />
                <span className="h-5 w-0.5 rounded-full bg-black/40" />
              </div>
              {editMode && (
                <span
                  onPointerDown={(e) => handleEditPointerDown(e, it, true)}
                  className="absolute -bottom-2 -right-2 flex h-7 w-7 items-center justify-center rounded-lg border border-white bg-[#e11d48] text-xs font-bold text-white shadow-md cursor-nwse-resize"
                >
                  ⤢
                </span>
              )}
            </div>
          );
        }

        // 5. Hold & Toggle Tactile Buttons
        const isToggle = it.kind === 'toggle';
        const isPressed = isToggle ? Boolean(toggledIds[it.id]) : Boolean(pressedIds[it.id]);
        const extraCls = [
          it.dia ? 'pad-btn-dia' : '',
          it.face ? 'pad-face-crimson' : '',
          it.cls?.includes('shoulder-trigger') ? 'pad-shoulder-trigger' : '',
          it.cls?.includes('mc-hit') ? 'pad-mc-hit' : '',
          it.cls?.includes('mc-place') ? 'pad-mc-place' : '',
          it.cls?.includes('mc-jump') ? 'pad-mc-jump' : '',
          it.cls?.includes('mc-utility') ? 'pad-mc-utility' : '',
          isPressed ? 'is-pressed' : '',
          editOutlineClass,
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div
            key={it.id}
            style={baseStyle}
            className={`pad-btn ${extraCls}`}
            onPointerDown={(e) => {
              if (editMode) {
                handleEditPointerDown(e, it);
                return;
              }
              e.preventDefault();
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                // ignore
              }
              if (isToggle) {
                setToggledIds((prev) => {
                  const next = !prev[it.id];
                  fireControl(it, next ? 1 : 0);
                  triggerHaptic(settings.vib, settings.audioClick, 'toggle');
                  return { ...prev, [it.id]: next };
                });
              } else if (!pressedIds[it.id]) {
                setPressedIds((prev) => ({ ...prev, [it.id]: true }));
                triggerHaptic(
                  settings.vib,
                  settings.audioClick,
                  it.analog ? 'trigger' : 'press'
                );
                fireControl(it, 1);
              }
            }}
            onPointerUp={(e) => {
              if (editMode) {
                handleEditPointerUp(e);
                return;
              }
              if (!isToggle && pressedIds[it.id]) {
                setPressedIds((prev) => ({ ...prev, [it.id]: false }));
                fireControl(it, 0);
              }
            }}
            onPointerMove={editMode ? handleEditPointerMove : undefined}
            onPointerCancel={() => {
              if (!isToggle && pressedIds[it.id]) {
                setPressedIds((prev) => ({ ...prev, [it.id]: false }));
                fireControl(it, 0);
              }
            }}
            onLostPointerCapture={() => {
              if (!isToggle && pressedIds[it.id]) {
                setPressedIds((prev) => ({ ...prev, [it.id]: false }));
                fireControl(it, 0);
              }
            }}
          >
            <span className="pad-label pointer-events-none flex flex-col items-center justify-center leading-tight">
              <span>{it.label}</span>
              {it.sub && (
                <span className="mt-0.5 text-[0.52em] font-semibold tracking-wider opacity-75">
                  {it.sub}
                </span>
              )}
            </span>
            {editMode && (
              <span
                onPointerDown={(e) => handleEditPointerDown(e, it, true)}
                className="absolute -bottom-2 -right-2 flex h-7 w-7 items-center justify-center rounded-lg border border-white bg-[#e11d48] text-xs font-bold text-white shadow-md cursor-nwse-resize"
              >
                ⤢
              </span>
            )}
          </div>
        );
      })}

      {/* Floating Layout Editor Toolbar */}
      <AnimatePresence>
        {editMode && (
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 18 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2.5 rounded-2xl border border-[#e11d48]/50 bg-[#111319]/95 px-3.5 py-2 text-zinc-100 shadow-2xl backdrop-blur-md"
          >
            <button
              type="button"
              onClick={() => resizeSelectedBy(0.92)}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-rose-500/50 bg-rose-950/70 text-xl font-bold text-white active:scale-95"
              aria-label="Shrink selected control"
            >
              −
            </button>
            <div className="min-w-[130px] text-center">
              <div className="text-xs font-semibold text-zinc-100">
                {selectedItem ? selectedItem.id : 'Tap a control'}
              </div>
              <div className="font-mono-tabular text-[10px] text-zinc-400">
                {selectedItem
                  ? `${Math.round(selectedItem.w)} × ${Math.round(selectedItem.h)} px`
                  : 'Drag to move · Syncs live'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => resizeSelectedBy(1.08)}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-rose-500/50 bg-rose-950/70 text-xl font-bold text-white active:scale-95"
              aria-label="Enlarge selected control"
            >
              +
            </button>
            <button
              type="button"
              onClick={resetCurrentLayout}
              className="flex h-10 items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800 px-3 text-xs font-semibold text-zinc-200 hover:bg-zinc-700"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
            <button
              type="button"
              onClick={() => {
                setEditMode(false);
                setSelectedEditId(null);
              }}
              className="flex h-10 items-center gap-1.5 rounded-xl bg-[#e11d48] px-3.5 text-xs font-semibold text-white hover:bg-[#be123c]"
            >
              <Check className="h-3.5 w-3.5" />
              Done
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Portrait Orientation Helper (non-blocking — offers 1-tap continue) */}
      <AnimatePresence>
        {isPortrait && !allowPortrait && !menuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-30 flex flex-col items-center justify-center bg-[#090a0d]/95 p-6 text-center backdrop-blur-md"
          >
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-rose-500/30 bg-rose-950/30 text-rose-400">
              <RotateCw className="h-8 w-8" />
            </div>
            <h2 className="font-display text-xl font-bold text-white">Rotate to Landscape</h2>
            <p className="mt-2 max-w-xs text-sm text-zinc-400">
              Landscape orientation gives you full dual-thumb ergonomics for sticks, triggers, and face buttons.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={goFullscreen}
                className="rounded-xl bg-[#e11d48] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#be123c]"
              >
                Lock Landscape
              </button>
              <button
                type="button"
                onClick={() => setAllowPortrait(true)}
                className="rounded-xl border border-zinc-700 bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-zinc-200 hover:bg-zinc-800"
              >
                Continue in Portrait
              </button>
              <button
                type="button"
                onClick={onSwitchToDesktopHub}
                className="rounded-xl border border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-400 hover:text-white"
              >
                Open Hub
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fluid Spring Navigation & Settings Drawer */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-md sm:p-6"
            onClick={() => setMenuOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 14 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 14 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              style={{ touchAction: 'pan-y' }}
              className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white text-zinc-900 shadow-2xl dark:border-zinc-800 dark:bg-[#101218] dark:text-zinc-100"
            >
              {/* Drawer Header */}
              <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
                <div className="flex items-center gap-3">
                  <span className="font-display text-base font-bold tracking-tight">RedlinePad</span>
                  <span className="text-xs text-zinc-400">·</span>
                  <span className="font-mono-tabular text-xs text-zinc-500 dark:text-zinc-400">
                    PIN {pin} {syncPulse === 'synced' ? '· Synced' : syncPulse === 'syncing' ? '· Syncing' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <PWAInstallButton compact />
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onSwitchToDesktopHub();
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 whitespace-nowrap"
                  >
                    <Monitor className="h-3.5 w-3.5" />
                    <span>Desktop Hub</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMenuOpen(false)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    aria-label="Close controller menu"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Segmented Tabs */}
              <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-[#0c0d12]">
                {(
                  [
                    { id: 'layouts', label: 'Layouts', icon: Gamepad2 },
                    { id: 'feel', label: 'Feel & Texture', icon: Sliders },
                    { id: 'sync', label: 'Sync & Pair', icon: Wifi },
                    { id: 'editor', label: 'Layout Editor', icon: Edit3 },
                  ] as const
                ).map((tab) => {
                  const Icon = tab.icon;
                  const active = menuTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setMenuTab(tab.id)}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                        active
                          ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-800 dark:text-white'
                          : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Tab Content */}
              <div className="flex-1 overflow-y-auto p-5" style={{ touchAction: 'pan-y' }}>
                {menuTab === 'layouts' && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {LAYOUT_ORDER.map((lid: LayoutId) => {
                      const meta = LAYOUTS[lid];
                      const active = settings.layout === lid;
                      return (
                        <button
                          key={lid}
                          type="button"
                          onClick={() => {
                            onUpdateSettings({ layout: lid });
                            setMenuOpen(false);
                          }}
                          className={`rounded-xl border p-4 text-left transition-all ${
                            active
                              ? 'border-[#e11d48] bg-[#e11d48]/10'
                              : 'border-zinc-200 bg-zinc-50 hover:border-zinc-300 dark:border-zinc-800 dark:bg-[#151821] dark:hover:border-zinc-700'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-display text-sm font-bold">{meta.title}</span>
                            <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                              {meta.out === 'pad' ? 'Xbox 360' : 'Keyboard + Mouse'}
                            </span>
                          </div>
                          <p className="mt-1.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                            {meta.note}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                )}

                {menuTab === 'feel' && (
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    <div className="space-y-4">
                      <div>
                        <div className="mb-1.5 flex justify-between text-xs font-semibold">
                          <span>Camera Look Speed</span>
                          <span className="font-mono-tabular text-[#e11d48]">
                            {settings.sens.toFixed(1)}x
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0.5"
                          max="4"
                          step="0.1"
                          value={settings.sens}
                          onChange={(e) => onUpdateSettings({ sens: parseFloat(e.target.value) })}
                          className="w-full accent-[#e11d48]"
                        />
                      </div>

                      <div>
                        <div className="mb-1.5 flex justify-between text-xs font-semibold">
                          <span>Stick / Steering Gain</span>
                          <span className="font-mono-tabular text-[#e11d48]">
                            {settings.gain.toFixed(1)}x
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0.8"
                          max="2"
                          step="0.1"
                          value={settings.gain}
                          onChange={(e) => onUpdateSettings({ gain: parseFloat(e.target.value) })}
                          className="w-full accent-[#e11d48]"
                        />
                      </div>

                      <div>
                        <div className="mb-1.5 flex justify-between text-xs font-semibold">
                          <span>Center Deadzone</span>
                          <span className="font-mono-tabular text-[#e11d48]">
                            {Math.round(settings.deadzone * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="0.25"
                          step="0.01"
                          value={settings.deadzone}
                          onChange={(e) =>
                            onUpdateSettings({ deadzone: parseFloat(e.target.value) })
                          }
                          className="w-full accent-[#e11d48]"
                        />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <div className="mb-2 text-xs font-semibold">Surface Texture</div>
                        <div className="grid grid-cols-3 gap-2">
                          {(
                            [
                              { id: 'carbon', label: 'Carbon' },
                              { id: 'brushed-metal', label: 'Brushed' },
                              { id: 'ceramic', label: 'Ceramic' },
                            ] as Array<{ id: TextureFinish; label: string }>
                          ).map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => onUpdateSettings({ texture: t.id })}
                              className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                                settings.texture === t.id
                                  ? 'border-[#e11d48] bg-[#e11d48]/15 text-[#e11d48]'
                                  : 'border-zinc-200 dark:border-zinc-800'
                              }`}
                            >
                              {t.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <div className="mb-2 text-xs font-semibold">Theme</div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => onUpdateSettings({ theme: 'dark' })}
                            className={`inline-flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-semibold ${
                              settings.theme === 'dark'
                                ? 'border-[#e11d48] bg-[#e11d48]/15 text-[#e11d48]'
                                : 'border-zinc-200 dark:border-zinc-800'
                            }`}
                          >
                            <Moon className="h-3.5 w-3.5" /> Obsidian Dark
                          </button>
                          <button
                            type="button"
                            onClick={() => onUpdateSettings({ theme: 'light' })}
                            className={`inline-flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-semibold ${
                              settings.theme === 'light'
                                ? 'border-[#e11d48] bg-[#e11d48]/15 text-[#e11d48]'
                                : 'border-zinc-200 dark:border-zinc-800'
                            }`}
                          >
                            <Sun className="h-3.5 w-3.5" /> Titanium Light
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2.5 pt-1 text-xs">
                        <label className="flex items-center justify-between gap-2">
                          <span>Haptic Vibration (Android)</span>
                          <input
                            type="checkbox"
                            checked={settings.vib}
                            onChange={(e) => onUpdateSettings({ vib: e.target.checked })}
                            className="h-4 w-4 accent-[#e11d48]"
                          />
                        </label>
                        <label className="flex items-center justify-between gap-2">
                          <span>Tactile Switch Audio (iOS & Desktop)</span>
                          <input
                            type="checkbox"
                            checked={settings.audioClick}
                            onChange={(e) => onUpdateSettings({ audioClick: e.target.checked })}
                            className="h-4 w-4 accent-[#e11d48]"
                          />
                        </label>
                        <label className="flex items-center justify-between gap-2">
                          <span>Minecraft: Tap Hit / Hold Mine</span>
                          <input
                            type="checkbox"
                            checked={settings.tap}
                            onChange={(e) => onUpdateSettings({ tap: e.target.checked })}
                            className="h-4 w-4 accent-[#e11d48]"
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                )}

                {menuTab === 'sync' && (
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    <div className="space-y-4">
                      <div>
                        <label className="mb-1.5 block text-xs font-semibold">
                          Cross-Platform Pairing PIN
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={pinDraft}
                            onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, '').slice(0, 12))}
                            placeholder="6-digit PIN"
                            className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 font-mono-tabular text-sm dark:border-zinc-700"
                          />
                          <button
                            type="button"
                            onClick={() => onPinChange(pinDraft)}
                            className="rounded-lg bg-[#e11d48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#be123c] whitespace-nowrap"
                          >
                            Pair PIN
                          </button>
                        </div>
                      </div>

                      <div>
                        <div className="mb-1.5 text-xs font-semibold">Connection Transport</div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => onTransportChange('relay')}
                            className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
                              transport === 'relay'
                                ? 'border-[#e11d48] bg-[#e11d48]/15 text-[#e11d48]'
                                : 'border-zinc-200 dark:border-zinc-800'
                            }`}
                          >
                            Cloud Sync Relay
                          </button>
                          <button
                            type="button"
                            onClick={() => onTransportChange('lan')}
                            className={`rounded-lg border px-3 py-2 text-xs font-semibold ${
                              transport === 'lan'
                                ? 'border-[#e11d48] bg-[#e11d48]/15 text-[#e11d48]'
                                : 'border-zinc-200 dark:border-zinc-800'
                            }`}
                          >
                            Direct Local Wi-Fi
                          </button>
                        </div>
                      </div>

                      {transport === 'lan' && (
                        <div>
                          <label className="mb-1 block text-xs font-semibold">
                            Windows PC Local IP (Port 8765)
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={lanDraft}
                              onChange={(e) => setLanDraft(e.target.value)}
                              placeholder="e.g. 192.168.1.42:8765"
                              className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 font-mono-tabular text-xs dark:border-zinc-700"
                            />
                            <button
                              type="button"
                              onClick={() => onLanAddressChange(lanDraft)}
                              className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold dark:border-zinc-700"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="space-y-3">
                      <div className="text-xs font-semibold">
                        Paired Devices ({devices.length})
                      </div>
                      {devices.length === 0 ? (
                        <p className="text-xs text-zinc-500">
                          Waiting for paired Windows Desktop Hub or ViGEmBus Bridge with PIN {pin}.
                        </p>
                      ) : (
                        <ul className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                          {devices.map((dev) => (
                            <li key={dev.id} className="flex items-center justify-between px-3 py-2.5 text-xs">
                              <div className="flex items-center gap-2">
                                {dev.role === 'phone' ? (
                                  <Smartphone className="h-3.5 w-3.5 text-[#e11d48]" />
                                ) : (
                                  <Monitor className="h-3.5 w-3.5 text-emerald-500" />
                                )}
                                <span className="font-medium">{dev.name}</span>
                              </div>
                              <span className="text-[11px] text-zinc-500 capitalize">{dev.platform}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="text-[11px] leading-relaxed text-zinc-500">
                        Controller output: {caps.pad || 'Waiting for Windows bridge'} · KBM:{' '}
                        {caps.kbm || 'Waiting for Windows bridge'}
                      </div>
                    </div>
                  </div>
                )}

                {menuTab === 'editor' && (
                  <div className="space-y-4">
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      Customize button positions and sizes for <strong>{LAYOUTS[settings.layout].title}</strong>.
                      D-pad and ABXY diamond clusters move together automatically, and changes synchronize across all paired iOS, Android, and Windows devices.
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setEditMode(true);
                          setMenuOpen(false);
                        }}
                        className="rounded-xl bg-[#e11d48] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#be123c]"
                      >
                        Enter Layout Edit Mode
                      </button>
                      <button
                        type="button"
                        onClick={resetCurrentLayout}
                        className="rounded-xl border border-zinc-300 px-4 py-2.5 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        Reset {LAYOUTS[settings.layout].shortTitle} Defaults
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Drawer Footer */}
              <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
                <span className="text-xs text-zinc-500">
                  Changes sync automatically across iOS, Android, and Windows
                </span>
                <button
                  type="button"
                  onClick={() => setMenuOpen(false)}
                  className="rounded-xl bg-zinc-900 px-5 py-2 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
                >
                  Resume Playing
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
