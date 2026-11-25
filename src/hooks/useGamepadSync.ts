import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectedDevice,
  DEFAULT_SETTINGS,
  DeviceRole,
  INITIAL_LIVE_INPUT,
  LiveInputState,
  SyncedSettings,
} from '../types/gamepad';
import { detectPlatform } from './usePWAInstall';

export type ConnectionTransport = 'relay' | 'lan';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'locked' | 'offline';

const LS_SETTINGS_KEY = 'redlinepad.settings.v2';
const LS_PIN_KEY = 'redlinepad.pin.v2';
const LS_LAN_KEY = 'redlinepad.lanUrl.v2';

function readLocalSettings(): SyncedSettings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<SyncedSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      customLayouts: parsed.customLayouts || {},
      profiles:
        Array.isArray(parsed.profiles) && parsed.profiles.length > 0
          ? parsed.profiles
          : DEFAULT_SETTINGS.profiles,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function readInitialPin(): string {
  try {
    const urlPin = new URLSearchParams(window.location.search).get('pin');
    if (urlPin && /^\d{4,12}$/.test(urlPin)) {
      localStorage.setItem(LS_PIN_KEY, urlPin);
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      return urlPin;
    }
    const stored = localStorage.getItem(LS_PIN_KEY);
    if (stored && /^\d{4,12}$/.test(stored)) return stored;
  } catch {
    // ignore storage errors
  }
  return '';
}

function applyInputToLiveState(prev: LiveInputState, msg: Record<string, unknown>): LiveInputState {
  const t = msg.t;
  if (t === 'b') {
    const k = String(msg.k);
    const v = Boolean(msg.v);
    return {
      ...prev,
      buttons: { ...prev.buttons, [k]: v },
      lastEventLabel: `Button ${k} ${v ? 'Pressed' : 'Released'}`,
      packetCount: prev.packetCount + 1,
    };
  }
  if (t === 's') {
    const k = msg.k === 'R' ? 'R' : 'L';
    const x = Number(msg.x) || 0;
    const y = Number(msg.y) || 0;
    return {
      ...prev,
      sticks: { ...prev.sticks, [k]: { x, y } },
      lastEventLabel: `Stick ${k} (${x.toFixed(2)}, ${y.toFixed(2)})`,
      packetCount: prev.packetCount + 1,
    };
  }
  if (t === 'tr') {
    const k = msg.k === 'RT' ? 'RT' : 'LT';
    const v = Number(msg.v) || 0;
    return {
      ...prev,
      triggers: { ...prev.triggers, [k]: v },
      lastEventLabel: `Trigger ${k} ${Math.round(v * 100)}%`,
      packetCount: prev.packetCount + 1,
    };
  }
  if (t === 'k') {
    const k = String(msg.k).toUpperCase();
    const v = Boolean(msg.v);
    return {
      ...prev,
      keys: { ...prev.keys, [k]: v },
      lastEventLabel: `Key ${k} ${v ? 'Down' : 'Up'}`,
      packetCount: prev.packetCount + 1,
    };
  }
  if (t === 'mb') {
    const k = String(msg.k);
    const v = Boolean(msg.v);
    return {
      ...prev,
      mouseButtons: { ...prev.mouseButtons, [k]: v },
      lastEventLabel: `Mouse ${k.toUpperCase()} ${v ? 'Down' : 'Up'}`,
      packetCount: prev.packetCount + 1,
    };
  }
  if (t === 'm') {
    const dx = Number(msg.dx) || 0;
    const dy = Number(msg.dy) || 0;
    return {
      ...prev,
      lastMouseDelta: { dx, dy, seq: prev.lastMouseDelta.seq + 1 },
      lastEventLabel: `Camera Look (${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy})`,
      packetCount: prev.packetCount + 1,
    };
  }
  if (t === 'reset') {
    return {
      ...INITIAL_LIVE_INPUT,
      lastEventLabel: 'All inputs released',
      packetCount: prev.packetCount + 1,
    };
  }
  return prev;
}

export function useGamepadSync(role: DeviceRole) {
  const [pin, setPinState] = useState<string>(() => readInitialPin());
  const [transport, setTransport] = useState<ConnectionTransport>('relay');
  const [lanAddress, setLanAddressState] = useState<string>(() => {
    try {
      return localStorage.getItem(LS_LAN_KEY) || '';
    } catch {
      return '';
    }
  });
  const [settings, setSettings] = useState<SyncedSettings>(() => readLocalSettings());
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [rtt, setRtt] = useState<number | null>(null);
  const [devices, setDevices] = useState<ConnectedDevice[]>([]);
  const [caps, setCaps] = useState<{ pad: string | null; kbm: string | null }>({
    pad: null,
    kbm: null,
  });
  const [syncPulse, setSyncPulse] = useState<'idle' | 'syncing' | 'synced'>('idle');
  const [liveInput, setLiveInput] = useState<LiveInputState>(INITIAL_LIVE_INPUT);
  const [clientId, setClientId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const authedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const isRemoteUpdateRef = useRef(false);
  const platformRef = useRef(detectPlatform());

  // Apply theme class to document root smoothly
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', settings.theme === 'dark' ? '#090a0d' : '#f1f3f7');
    }
  }, [settings.theme]);

  // Persist local settings mirror
  useEffect(() => {
    try {
      localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // ignore quota errors
    }
  }, [settings]);

  // Auto-create a valid 6-digit PIN if none exists yet
  useEffect(() => {
    if (pin) return;
    let cancelled = false;
    fetch('/api/session/create', { method: 'POST' })
      .then((r) => r.json())
      .then((data: { pin?: string }) => {
        if (!cancelled && data.pin) {
          setPinState(data.pin);
          try {
            localStorage.setItem(LS_PIN_KEY, data.pin);
          } catch {
            // ignore
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          const fallback = String(Math.floor(100000 + Math.random() * 900000));
          setPinState(fallback);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pin]);

  const setPin = useCallback((nextPin: string) => {
    const clean = nextPin.replace(/\D/g, '').slice(0, 12);
    setPinState(clean);
    try {
      if (clean) localStorage.setItem(LS_PIN_KEY, clean);
      else localStorage.removeItem(LS_PIN_KEY);
    } catch {
      // ignore
    }
  }, []);

  const createNewPin = useCallback(async () => {
    try {
      const resp = await fetch('/api/session/create', { method: 'POST' });
      const data = (await resp.json()) as { pin: string };
      if (data.pin) {
        setPin(data.pin);
        return data.pin;
      }
    } catch {
      const fallback = String(Math.floor(100000 + Math.random() * 900000));
      setPin(fallback);
      return fallback;
    }
    return pin;
  }, [pin, setPin]);

  const setLanAddress = useCallback((addr: string) => {
    const trimmed = addr.trim();
    setLanAddressState(trimmed);
    try {
      localStorage.setItem(LS_LAN_KEY, trimmed);
    } catch {
      // ignore
    }
  }, []);

  // WebSocket Connection Lifecycle
  useEffect(() => {
    if (!pin || pin.length < 4) return;
    let disposed = false;

    const getSocketUrl = () => {
      if (transport === 'lan' && lanAddress) {
        if (lanAddress.startsWith('ws://') || lanAddress.startsWith('wss://')) {
          return lanAddress.endsWith('/ws') ? lanAddress : `${lanAddress.replace(/\/$/, '')}/ws`;
        }
        const hostPort = lanAddress.includes(':') ? lanAddress : `${lanAddress}:8765`;
        return `ws://${hostPort}/ws`;
      }
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws`;
    };

    const connect = () => {
      if (disposed) return;
      setConnectionState((prev) => (prev === 'connected' ? 'connected' : 'connecting'));
      let sock: WebSocket;
      try {
        sock = new WebSocket(getSocketUrl());
      } catch {
        setConnectionState('reconnecting');
        reconnectTimerRef.current = window.setTimeout(connect, 1800);
        return;
      }
      wsRef.current = sock;
      authedRef.current = false;

      sock.onopen = () => {
        if (disposed) return;
        const p = platformRef.current;
        const deviceName =
          p === 'ios'
            ? 'iPhone / iPad'
            : p === 'android'
              ? 'Android Device'
              : p === 'windows'
                ? 'Windows Desktop'
                : p === 'macos'
                  ? 'macOS Desktop'
                  : 'Web Browser';

        sock.send(
          JSON.stringify({
            t: 'auth',
            pin,
            role,
            platform: p,
            name: `${deviceName} (${role === 'phone' ? 'Controller' : 'Hub'})`,
          })
        );
      };

      sock.onmessage = (ev) => {
        if (disposed) return;
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const t = d.t;
        if (t === 'auth') {
          if (d.ok) {
            authedRef.current = true;
            setConnectionState('connected');
            if (typeof d.clientId === 'string') setClientId(d.clientId);
            setCaps({
              pad: typeof d.pad === 'string' ? d.pad : null,
              kbm: typeof d.kbm === 'string' ? d.kbm : null,
            });
            if (Array.isArray(d.devices)) {
              setDevices(d.devices as ConnectedDevice[]);
            }
            if (d.settings && typeof d.settings === 'object') {
              const serverSettings = d.settings as SyncedSettings;
              setSettings((local) => {
                if ((serverSettings.updatedAt || 0) >= (local.updatedAt || 0)) {
                  isRemoteUpdateRef.current = true;
                  return { ...DEFAULT_SETTINGS, ...serverSettings };
                }
                // Local has newer edits -> push up to room
                sock.send(JSON.stringify({ t: 'sync:update', settings: local }));
                return local;
              });
              setSyncPulse('synced');
            }
          } else if (d.locked) {
            setConnectionState('locked');
          } else {
            setConnectionState('reconnecting');
          }
        } else if (t === 'p' && typeof d.n === 'number') {
          setRtt(Math.max(1, Math.round(performance.now() - d.n)));
        } else if (t === 'presence') {
          if (Array.isArray(d.devices)) setDevices(d.devices as ConnectedDevice[]);
          if (d.caps && typeof d.caps === 'object') {
            const c = d.caps as { pad?: string | null; kbm?: string | null };
            setCaps({ pad: c.pad || null, kbm: c.kbm || null });
          }
        } else if (t === 'sync:state' && d.settings && typeof d.settings === 'object') {
          isRemoteUpdateRef.current = true;
          setSettings({ ...DEFAULT_SETTINGS, ...(d.settings as SyncedSettings) });
          setSyncPulse('synced');
        } else if (t === 'sync:ack') {
          setSyncPulse('synced');
        } else if (
          t === 'b' ||
          t === 's' ||
          t === 'tr' ||
          t === 'k' ||
          t === 'm' ||
          t === 'mb' ||
          t === 'reset'
        ) {
          setLiveInput((prev) => applyInputToLiveState(prev, d));
        }
      };

      sock.onerror = () => {
        try {
          sock.close();
        } catch {
          // ignore
        }
      };

      sock.onclose = () => {
        if (disposed) return;
        authedRef.current = false;
        setConnectionState('reconnecting');
        reconnectTimerRef.current = window.setTimeout(connect, 1400);
      };
    };

    connect();

    const pingId = window.setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && authedRef.current) {
        wsRef.current.send(JSON.stringify({ t: 'p', n: performance.now() }));
      }
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(pingId);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
        wsRef.current = null;
      }
    };
  }, [pin, role, transport, lanAddress]);

  const sendInput = useCallback((payload: Record<string, unknown>) => {
    setLiveInput((prev) => applyInputToLiveState(prev, payload));
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && authedRef.current) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const releaseAll = useCallback(() => {
    sendInput({ t: 'reset' });
  }, [sendInput]);

  const updateSettings = useCallback(
    (updater: Partial<SyncedSettings> | ((prev: SyncedSettings) => SyncedSettings)) => {
      setSettings((prev) => {
        const next: SyncedSettings =
          typeof updater === 'function'
            ? { ...updater(prev), updatedAt: Date.now() }
            : { ...prev, ...updater, updatedAt: Date.now() };
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && authedRef.current) {
          setSyncPulse('syncing');
          wsRef.current.send(JSON.stringify({ t: 'sync:update', settings: next }));
        }
        return next;
      });
    },
    []
  );

  // Reset isRemoteUpdate flag after render
  useEffect(() => {
    if (isRemoteUpdateRef.current) {
      isRemoteUpdateRef.current = false;
    }
  }, [settings]);

  return {
    pin,
    setPin,
    createNewPin,
    transport,
    setTransport,
    lanAddress,
    setLanAddress,
    settings,
    updateSettings,
    connectionState,
    rtt,
    devices,
    caps,
    syncPulse,
    liveInput,
    clientId,
    sendInput,
    releaseAll,
  };
}
