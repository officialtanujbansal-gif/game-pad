import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ConnectedDevice,
  DEFAULT_SETTINGS,
  DeviceRole,
  PlatformKind,
  SyncedSettings,
  VigemReleaseInfo,
} from './src/types/gamepad.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// Persistent sync storage confined strictly inside project data directory
const DATA_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.resolve(__dirname, 'data');
const PUBLIC_DIR = process.env.APP_PUBLIC_DIR
  ? path.resolve(process.env.APP_PUBLIC_DIR)
  : path.resolve(__dirname, 'public');
const SYNC_STORE_PATH = path.resolve(DATA_DIR, 'sync-store.json');

interface RoomState {
  pin: string;
  settings: SyncedSettings;
  createdAt: number;
  updatedAt: number;
}

interface ClientSession {
  id: string;
  ws: WebSocket;
  pin: string | null;
  authed: boolean;
  role: DeviceRole;
  platform: PlatformKind;
  name: string;
  connectedAt: number;
  caps: { pad: string | null; kbm: string | null };
  lanUrls: string[];
  ip: string;
}

const rooms = new Map<string, RoomState>();
const roomClients = new Map<string, Set<ClientSession>>();
const authFailures = new Map<string, number[]>();

// Cached ViGEmBus GitHub release info (15 min TTL)
let cachedVigem: { data: VigemReleaseInfo; fetchedAt: number } | null = null;

const FALLBACK_VIGEM: VigemReleaseInfo = {
  tagName: 'v1.22.0',
  name: 'ViGEmBus v1.22.0 (Official GitHub Release)',
  publishedAt: '2023-09-21T14:00:00Z',
  htmlUrl: 'https://github.com/nefarius/ViGEmBus/releases/tag/v1.22.0',
  repoUrl: 'https://github.com/nefarius/ViGEmBus',
  body: 'Official Windows kernel-mode bus driver for virtual Xbox 360 and DualShock 4 gamepads (required for RedlinePad Xbox 360 controller mode on Windows 10/11 x64 & ARM64).',
  assets: [
    {
      name: 'ViGEmBus_1.22.0_x64_x86_arm64.exe',
      size: 6250000,
      downloadUrl:
        'https://github.com/nefarius/ViGEmBus/releases/download/v1.22.0/ViGEmBus_1.22.0_x64_x86_arm64.exe',
      contentType: 'application/octet-stream',
    },
  ],
  primaryInstallerUrl:
    'https://github.com/nefarius/ViGEmBus/releases/download/v1.22.0/ViGEmBus_1.22.0_x64_x86_arm64.exe',
  source: 'verified-fallback',
};

function isValidPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4,12}$/.test(pin);
}

function generatePin(): string {
  return String(crypto.randomInt(100000, 999999));
}

function loadStore() {
  try {
    if (!fs.existsSync(SYNC_STORE_PATH)) return;
    const raw = fs.readFileSync(SYNC_STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, RoomState>;
    for (const [pin, state] of Object.entries(parsed)) {
      if (isValidPin(pin) && state && typeof state === 'object') {
        rooms.set(pin, {
          pin,
          settings: sanitizeSettings(state.settings),
          createdAt: typeof state.createdAt === 'number' ? state.createdAt : Date.now(),
          updatedAt: typeof state.updatedAt === 'number' ? state.updatedAt : Date.now(),
        });
      }
    }
  } catch {
    // Start fresh if store is missing or unreadable
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSaveStore() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const obj: Record<string, RoomState> = {};
      for (const [k, v] of rooms.entries()) {
        obj[k] = v;
      }
      const tmp = path.resolve(DATA_DIR, 'sync-store.tmp.json');
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
      fs.renameSync(tmp, SYNC_STORE_PATH);
    } catch {
      // Ignore write failures in read-only environments
    }
  }, 400);
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function sanitizeSettings(input: unknown, base: SyncedSettings = DEFAULT_SETTINGS): SyncedSettings {
  if (!input || typeof input !== 'object') return { ...base };
  const raw = input as Record<string, unknown>;
  const validLayouts = new Set(['gamepad', 'driving', 'mcpad', 'minecraft', 'fps']);
  const validTextures = new Set(['carbon', 'brushed-metal', 'ceramic']);

  const layout =
    typeof raw.layout === 'string' && validLayouts.has(raw.layout)
      ? (raw.layout as SyncedSettings['layout'])
      : base.layout;

  const theme = raw.theme === 'light' ? 'light' : raw.theme === 'dark' ? 'dark' : base.theme;
  const texture =
    typeof raw.texture === 'string' && validTextures.has(raw.texture)
      ? (raw.texture as SyncedSettings['texture'])
      : base.texture;

  // Sanitize customLayouts strictly (prevent prototype pollution)
  const customLayouts: SyncedSettings['customLayouts'] = { ...(base.customLayouts || {}) };
  if (raw.customLayouts && typeof raw.customLayouts === 'object' && !Array.isArray(raw.customLayouts)) {
    const incoming = raw.customLayouts as Record<string, unknown>;
    for (const lid of Object.keys(incoming)) {
      if (!validLayouts.has(lid)) continue;
      const controls = incoming[lid];
      if (!controls || typeof controls !== 'object' || Array.isArray(controls)) continue;
      const cleanControls: Record<string, { x: number; y: number; w: number; h: number; fsr?: number }> = {};
      for (const [cid, rect] of Object.entries(controls as Record<string, unknown>)) {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(cid) || !rect || typeof rect !== 'object') continue;
        const r = rect as Record<string, unknown>;
        cleanControls[cid] = {
          x: clampNum(r.x, 0, 1, 0),
          y: clampNum(r.y, 0, 1, 0),
          w: clampNum(r.w, 0.02, 0.9, 0.1),
          h: clampNum(r.h, 0.02, 0.9, 0.1),
          ...(typeof r.fsr === 'number' && Number.isFinite(r.fsr)
            ? { fsr: clampNum(r.fsr, 0.1, 1.0, 0.36) }
            : {}),
        };
      }
      customLayouts[lid as SyncedSettings['layout']] = cleanControls;
    }
  }

  let profiles = base.profiles;
  if (Array.isArray(raw.profiles)) {
    const cleaned = raw.profiles
      .slice(0, 20)
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map((p) => ({
        id: typeof p.id === 'string' ? p.id.slice(0, 40) : crypto.randomUUID(),
        name: typeof p.name === 'string' ? p.name.trim().slice(0, 48) || 'Custom Profile' : 'Custom Profile',
        layout:
          typeof p.layout === 'string' && validLayouts.has(p.layout)
            ? (p.layout as SyncedSettings['layout'])
            : 'gamepad',
        sens: clampNum(p.sens, 0.5, 4, 1.5),
        gain: clampNum(p.gain, 0.8, 2, 1.3),
        deadzone: clampNum(p.deadzone, 0, 0.3, 0.08),
        vib: Boolean(p.vib),
        tap: Boolean(p.tap),
        audioClick: Boolean(p.audioClick),
        updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
      }));
    if (cleaned.length > 0) profiles = cleaned;
  }

  return {
    layout,
    sens: clampNum(raw.sens, 0.5, 4, base.sens),
    gain: clampNum(raw.gain, 0.8, 2, base.gain),
    deadzone: clampNum(raw.deadzone, 0, 0.3, base.deadzone),
    vib: typeof raw.vib === 'boolean' ? raw.vib : base.vib,
    tap: typeof raw.tap === 'boolean' ? raw.tap : base.tap,
    audioClick: typeof raw.audioClick === 'boolean' ? raw.audioClick : base.audioClick,
    theme,
    texture,
    customLayouts,
    profiles,
    activeProfileId:
      typeof raw.activeProfileId === 'string' ? raw.activeProfileId.slice(0, 40) : base.activeProfileId,
    updatedAt: Date.now(),
  };
}

function getOrCreateRoom(pin: string): RoomState {
  let room = rooms.get(pin);
  if (!room) {
    room = {
      pin,
      settings: { ...DEFAULT_SETTINGS, updatedAt: Date.now() },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    rooms.set(pin, room);
    scheduleSaveStore();
  }
  return room;
}

function isIpLocked(ip: string): boolean {
  const now = Date.now();
  const list = (authFailures.get(ip) || []).filter((ts) => now - ts < 60_000);
  authFailures.set(ip, list);
  return list.length >= 5;
}

function getRoomDevices(pin: string): ConnectedDevice[] {
  const set = roomClients.get(pin);
  if (!set) return [];
  return Array.from(set).map((c) => ({
    id: c.id,
    role: c.role,
    platform: c.platform,
    name: c.name,
    connectedAt: c.connectedAt,
    caps: c.caps,
    lanUrls: c.lanUrls.length > 0 ? c.lanUrls : undefined,
  }));
}

function getAggregatedCaps(pin: string): { pad: string | null; kbm: string | null } {
  const set = roomClients.get(pin);
  let pad: string | null = null;
  let kbm: string | null = null;
  if (set) {
    for (const c of set) {
      if (c.role === 'bridge') {
        if (c.caps.pad) pad = c.caps.pad;
        if (c.caps.kbm) kbm = c.caps.kbm;
      }
    }
    // If desktop companion browser is connected without native bridge yet, report live visualizer capability
    if (!pad && Array.from(set).some((c) => c.role === 'desktop')) {
      pad = 'Desktop Live Visualizer (install ViGEmBus Bridge for Windows games)';
    }
    if (!kbm && Array.from(set).some((c) => c.role === 'desktop')) {
      kbm = 'Desktop Live Visualizer (run Windows Bridge for SendInput)';
    }
  }
  return { pad, kbm };
}

function safeSend(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastRoomPresence(pin: string) {
  const set = roomClients.get(pin);
  if (!set) return;
  const devices = getRoomDevices(pin);
  const caps = getAggregatedCaps(pin);
  for (const c of set) {
    safeSend(c.ws, { t: 'presence', devices, caps });
  }
}

function broadcastRoomSettings(pin: string, settings: SyncedSettings, excludeId?: string) {
  const set = roomClients.get(pin);
  if (!set) return;
  for (const c of set) {
    if (excludeId && c.id === excludeId) continue;
    safeSend(c.ws, { t: 'sync:state', settings });
  }
}

function loadEmbeddedControllerB64(): string {
  try {
    const htmlPath = path.resolve(PUBLIC_DIR, 'assets/aistudio/gamepad_controller_v21_30dcfafa.html');
    if (fs.existsSync(htmlPath)) {
      return fs.readFileSync(htmlPath).toString('base64');
    }
  } catch {
    // fallback below
  }
  return Buffer.from(
    '<!doctype html><html><body style="background:#090a0d;color:#eee;font-family:sans-serif;padding:24px"><h2>RedlinePad LAN Bridge Active</h2><p>Connect via the RedlinePad app in Direct Local Wi-Fi mode.</p></body></html>',
    'utf-8'
  ).toString('base64');
}

function getLocalIpv4Addresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.')) {
        if (!out.includes(info.address)) out.push(info.address);
      }
    }
  }
  return out;
}

function buildUpgradedPythonBridge(defaultPin: string, defaultRelayUrl: string): string {
  const safePin = isValidPin(defaultPin) ? defaultPin : '';
  const controllerB64 = loadEmbeddedControllerB64();
  let safeRelay = '';
  try {
    const u = new URL(defaultRelayUrl);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && /^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(u.host)) {
      // If downloaded from an authenticated ais-dev preview, point bridge to public ais-pre relay when available
      const relayHost = u.host.startsWith('ais-dev-') ? u.host.replace(/^ais-dev-/, 'ais-pre-') : u.host;
      safeRelay = (u.protocol === 'https:' ? 'wss://' : 'ws://') + relayHost + '/ws';
    }
  } catch {
    safeRelay = '';
  }

  return `#!/usr/bin/env python3
"""
RedlinePad — Windows PC Receiver & Cross-Platform Cloud Bridge (V22)

Converts touch inputs from iOS, Android, and Web RedlinePad apps into:
  * Real virtual Xbox 360 controller  (Windows + vgamepad + ViGEmBus driver)
  * Native Windows keyboard & mouse   (Windows SendInput API, zero extra drivers)

Supports TWO seamless modes:
  1. Cross-Platform Cloud Relay Mode (works across ANY network or Wi-Fi):
       python redlinepad_windows_receiver.py --pin ${safePin || '123456'}${safeRelay ? ` --relay ${safeRelay}` : ''}
  2. Direct Local Wi-Fi LAN Mode (ultra-low latency on same Wi-Fi, port 8765):
       python redlinepad_windows_receiver.py --lan --pin ${safePin || '123456'}

ViGEmBus Driver (required for Xbox 360 controller emulation):
  https://github.com/nefarius/ViGEmBus/releases

Install Python Xbox driver wrapper once:
  pip install vgamepad websockets
"""
import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
import pathlib
import platform
import secrets
import socket
import struct
import sys
import time

SKIN = "RedlinePad-Windows-Bridge-v22"
PORT = int(os.environ.get("GAMEPAD_PORT", "8765"))
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HERE = pathlib.Path(__file__).resolve().parent
PIN_FILE = HERE / "gamepad_pin.txt"
DEFAULT_PIN = "${safePin}"
DEFAULT_RELAY = "${safeRelay}"

KEY_VK = {c: ord(c.upper()) for c in "abcdefghijklmnopqrstuvwxyz0123456789"}
KEY_VK.update({
    "space": 0x20, "shift": 0xA0, "ctrl": 0xA2, "tab": 0x09, "esc": 0x1B,
    "enter": 0x0D, "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
})
KEY_VK.update({f"f{i}": 0x6F + i for i in range(1, 13)})
EXTENDED_VK = {0x26, 0x28, 0x25, 0x27}
MOUSE_FLAGS = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010), "middle": (0x0020, 0x0040)}


class DryPad:
    name = "dry run (prints only)"
    def __init__(self): self._last = 0.0
    def button(self, k, down): print(f"  [pad] button {k} {'DOWN' if down else 'UP'}", flush=True)
    def stick(self, k, x, y):
        now = time.time()
        if (x == 0 and y == 0) or now - self._last > 0.15:
            self._last = now
            print(f"  [pad] stick {k} x={x:+.2f} y={y:+.2f}", flush=True)
    def trigger(self, k, v): print(f"  [pad] trigger {k} {v:.2f}", flush=True)
    def reset(self): print("  [pad] reset", flush=True)


class DryKbm:
    name = "dry run (prints only)"
    def __init__(self): self._last = 0.0
    def key(self, name, down): print(f"  [key] {name} {'DOWN' if down else 'UP'}", flush=True)
    def move(self, dx, dy):
        now = time.time()
        if now - self._last > 0.15:
            self._last = now
            print(f"  [mouse] dx={dx} dy={dy}", flush=True)
    def button(self, name, down): print(f"  [mouse] {name} {'DOWN' if down else 'UP'}", flush=True)
    def reset(self): print("  [kbm] reset", flush=True)


class XboxPad:
    """Virtual Xbox 360 controller via vgamepad + ViGEmBus (Windows)."""
    name = "Xbox 360 Controller (ViGEmBus + vgamepad)"

    def __init__(self):
        import vgamepad as vg
        B = vg.XUSB_BUTTON
        self.map = {
            "A": B.XUSB_GAMEPAD_A, "B": B.XUSB_GAMEPAD_B,
            "X": B.XUSB_GAMEPAD_X, "Y": B.XUSB_GAMEPAD_Y,
            "LB": B.XUSB_GAMEPAD_LEFT_SHOULDER, "RB": B.XUSB_GAMEPAD_RIGHT_SHOULDER,
            "BACK": B.XUSB_GAMEPAD_BACK, "START": B.XUSB_GAMEPAD_START,
            "L3": B.XUSB_GAMEPAD_LEFT_THUMB, "R3": B.XUSB_GAMEPAD_RIGHT_THUMB,
            "UP": B.XUSB_GAMEPAD_DPAD_UP, "DOWN": B.XUSB_GAMEPAD_DPAD_DOWN,
            "LEFT": B.XUSB_GAMEPAD_DPAD_LEFT, "RIGHT": B.XUSB_GAMEPAD_DPAD_RIGHT,
        }
        self.pad = vg.VX360Gamepad()

    def button(self, k, down):
        b = self.map.get(k)
        if b is None:
            return
        (self.pad.press_button if down else self.pad.release_button)(button=b)
        self.pad.update()

    def stick(self, k, x, y):
        fn = self.pad.left_joystick_float if k == "L" else self.pad.right_joystick_float
        fn(x_value_float=x, y_value_float=-y)
        self.pad.update()

    def trigger(self, k, v):
        fn = self.pad.left_trigger_float if k == "LT" else self.pad.right_trigger_float
        fn(value_float=v)
        self.pad.update()

    def reset(self):
        self.pad.reset()
        self.pad.update()


def make_input_types():
    import ctypes
    WORD, DWORD, LONG, ULONG_PTR = ctypes.c_uint16, ctypes.c_uint32, ctypes.c_int32, ctypes.c_size_t
    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", WORD), ("wScan", WORD), ("dwFlags", DWORD), ("time", DWORD), ("dwExtraInfo", ULONG_PTR)]
    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", LONG), ("dy", LONG), ("mouseData", DWORD), ("dwFlags", DWORD), ("time", DWORD), ("dwExtraInfo", ULONG_PTR)]
    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", DWORD), ("wParamL", WORD), ("wParamH", WORD)]
    class _U(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]
    class INPUT(ctypes.Structure):
        _fields_ = [("type", DWORD), ("u", _U)]
    return INPUT, KEYBDINPUT, MOUSEINPUT


class WinKbm:
    """Native Windows SendInput keyboard & mouse driver."""
    name = "Keyboard + Mouse (Windows SendInput)"

    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("Windows SendInput is only available on Windows")
        import ctypes
        self.ct = ctypes
        self.INPUT, self.KI, self.MI = make_input_types()
        self.user32 = ctypes.windll.user32
        self.keys, self.buttons = set(), set()

    def _send(self, inp):
        self.user32.SendInput(1, self.ct.byref(inp), self.ct.sizeof(self.INPUT))

    def key(self, name, down):
        vk = KEY_VK.get(name)
        if vk is None or down == (vk in self.keys):
            return
        (self.keys.add if down else self.keys.discard)(vk)
        scan = self.user32.MapVirtualKeyW(vk, 0)
        flags = 0x0008 | (0 if down else 0x0002) | (0x0001 if vk in EXTENDED_VK else 0)
        inp = self.INPUT(type=1)
        inp.u.ki = self.KI(0, scan, flags, 0, 0)
        self._send(inp)

    def move(self, dx, dy):
        inp = self.INPUT(type=0)
        inp.u.mi = self.MI(dx, dy, 0, 0x0001, 0, 0)
        self._send(inp)

    def button(self, name, down):
        fl = MOUSE_FLAGS.get(name)
        if fl is None or down == (name in self.buttons):
            return
        (self.buttons.add if down else self.buttons.discard)(name)
        inp = self.INPUT(type=0)
        inp.u.mi = self.MI(0, 0, 0, fl[0] if down else fl[1], 0, 0)
        self._send(inp)

    def reset(self):
        for vk in list(self.keys):
            name = next((n for n, v in KEY_VK.items() if v == vk), None)
            if name:
                self.key(name, False)
        for b in list(self.buttons):
            self.button(b, False)


PAD = None
KBM = None
PIN = ""
CLIENTS = 0
FAILS = {}


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def reset_all():
    for b in (PAD, KBM):
        if b is not None:
            try:
                b.reset()
            except Exception:
                pass


def dispatch(d):
    t = d.get("t")
    if t == "b" and PAD:
        PAD.button(str(d["k"]), bool(d["v"]))
    elif t == "s" and PAD:
        if d["k"] in ("L", "R"):
            PAD.stick(d["k"], clamp(float(d["x"]), -1.0, 1.0), clamp(float(d["y"]), -1.0, 1.0))
    elif t == "tr" and PAD:
        if d["k"] in ("LT", "RT"):
            PAD.trigger(d["k"], clamp(float(d["v"]), 0.0, 1.0))
    elif t == "k" and KBM:
        KBM.key(str(d["k"]), bool(d["v"]))
    elif t == "m" and KBM:
        KBM.move(int(clamp(float(d["dx"]), -2000, 2000)), int(clamp(float(d["dy"]), -2000, 2000)))
    elif t == "mb" and KBM:
        KBM.button(str(d["k"]), bool(d["v"]))
    elif t == "reset":
        reset_all()


def pick_backends(dry):
    problems = []
    if dry:
        return DryPad(), DryKbm(), problems
    pad = kbm = None
    try:
        pad = XboxPad()
    except Exception as e:
        problems.append(
            f"Xbox 360 controller unavailable ({e}). Install: pip install vgamepad "
            "and ViGEmBus from https://github.com/nefarius/ViGEmBus/releases"
        )
    try:
        kbm = WinKbm()
    except Exception as e:
        problems.append(f"Keyboard/mouse unavailable ({e}).")
    if pad is None and kbm is None:
        problems.append("Switching to dry run (prints input events).")
        return DryPad(), DryKbm(), problems
    return pad, kbm, problems


def load_pin(cli_pin):
    if cli_pin:
        return cli_pin
    if DEFAULT_PIN:
        return DEFAULT_PIN
    try:
        p = PIN_FILE.read_text().strip()
        if p.isdigit() and 4 <= len(p) <= 12:
            return p
    except OSError:
        pass
    p = "".join(secrets.choice("0123456789") for _ in range(6))
    try:
        PIN_FILE.write_text(p + "\\n")
    except OSError:
        pass
    return p


async def relay_bridge_loop(relay_url, pin):
    """Connects outbound to RedlinePad Cloud Relay so iOS/Android can control this PC seamlessly."""
    try:
        import websockets
    except ImportError:
        print("[!] Cloud Relay mode needs the 'websockets' package. Run: pip install websockets")
        print("    Or start with --lan for standard-library local Wi-Fi mode.")
        return

    hostname = socket.gethostname() or "Windows PC"
    while True:
        try:
            print(f"[relay] Connecting to {relay_url} (PIN: {pin})...", flush=True)
            async with websockets.connect(relay_url, ping_interval=15, ping_timeout=10) as ws:
                await ws.send(json.dumps({
                    "t": "auth",
                    "pin": pin,
                    "role": "bridge",
                    "platform": "windows" if os.name == "nt" else platform.system().lower(),
                    "name": f"{hostname} (ViGEmBus Bridge)",
                    "pad": PAD.name if PAD else None,
                    "kbm": KBM.name if KBM else None,
                    "lanUrls": [f"http://{ip}:{PORT}" for ip in local_ips()],
                }))
                async for raw in ws:
                    d = json.loads(raw)
                    t = d.get("t")
                    if t == "auth":
                        if d.get("ok"):
                            print(f"[ok] Paired with RedlinePad session PIN {pin}! Ready for phone input.", flush=True)
                        else:
                            print("[!] PIN rejected by relay.", flush=True)
                            return
                    elif t == "p":
                        await ws.send(json.dumps({"t": "p", "n": d.get("n")}))
                    elif t in ("b", "s", "tr", "k", "m", "mb", "reset"):
                        dispatch(d)
        except Exception as e:
            reset_all()
            print(f"[relay] Disconnected ({e}). Reconnecting in 2s...", flush=True)
            await asyncio.sleep(2)


# ---------- Direct LAN WebSocket Server (Port 8765, zero dependencies) ----------
def pin_locked(ip):
    now = time.time()
    FAILS[ip] = [t for t in FAILS.get(ip, []) if now - t < 60]
    return len(FAILS[ip]) >= 5

def http_response(status, body, ctype="text/plain; charset=utf-8"):
    if isinstance(body, str):
        body = body.encode("utf-8")
    head = (f"HTTP/1.1 {status}\\r\\nContent-Type: {ctype}\\r\\nContent-Length: {len(body)}\\r\\n"
            "Access-Control-Allow-Origin: *\\r\\nCache-Control: no-store\\r\\nConnection: close\\r\\n\\r\\n")
    return head.encode("latin1") + body

async def read_frame(reader):
    b1, b2 = await reader.readexactly(2)
    fin, op = bool(b1 & 0x80), b1 & 0x0F
    masked, ln = bool(b2 & 0x80), b2 & 0x7F
    if ln == 126: ln = struct.unpack(">H", await reader.readexactly(2))[0]
    elif ln == 127: ln = struct.unpack(">Q", await reader.readexactly(8))[0]
    if ln > 1_000_000: raise ValueError("frame too large")
    mask = await reader.readexactly(4) if masked else b""
    data = await reader.readexactly(ln) if ln else b""
    if masked: data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
    return fin, op, data

def frame(op, payload=b""):
    n = len(payload)
    if n < 126: head = bytes([0x80 | op, n])
    elif n < 65536: head = bytes([0x80 | op, 126]) + struct.pack(">H", n)
    else: head = bytes([0x80 | op, 127]) + struct.pack(">Q", n)
    return head + payload

def send_json(writer, obj):
    writer.write(frame(0x1, json.dumps(obj).encode()))

async def ws_session(reader, writer, headers, peer):
    global CLIENTS
    ip = peer[0]
    key = headers.get("sec-websocket-key")
    if not key:
        writer.write(http_response("400 Bad Request", "missing key"))
        return
    accept = base64.b64encode(hashlib.sha1(key.encode() + WS_GUID).digest()).decode()
    writer.write(("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\n"
                  f"Connection: Upgrade\\r\\nSec-WebSocket-Accept: {accept}\\r\\n\\r\\n").encode())
    await writer.drain()
    CLIENTS += 1
    authed = False
    buf = b""
    print(f"[lan +] phone connected: {ip}", flush=True)
    try:
        while True:
            fin, op, data = await asyncio.wait_for(read_frame(reader), 20)
            if op == 0x8:
                writer.write(frame(0x8))
                break
            if op == 0x9:
                writer.write(frame(0xA, data))
                continue
            if op in (0x1, 0x0):
                buf += data
                if not fin: continue
                msg, buf = buf, b""
                d = json.loads(msg.decode("utf-8"))
                t = d.get("t")
                if t == "p":
                    send_json(writer, {"t": "p", "n": d.get("n")})
                elif t == "auth":
                    if pin_locked(ip):
                        send_json(writer, {"t": "auth", "ok": False, "locked": True})
                        await writer.drain()
                        break
                    if hmac.compare_digest(str(d.get("pin", "")).encode(), PIN.encode()):
                        authed = True
                        FAILS.pop(ip, None)
                        send_json(writer, {"t": "auth", "ok": True,
                                           "pad": PAD.name if PAD else None,
                                           "kbm": KBM.name if KBM else None})
                        print(f"[lan ok] {ip} authenticated", flush=True)
                    else:
                        FAILS.setdefault(ip, []).append(time.time())
                        send_json(writer, {"t": "auth", "ok": False})
                elif authed:
                    dispatch(d)
            await writer.drain()
    except Exception:
        pass
    finally:
        CLIENTS -= 1
        if CLIENTS <= 0:
            reset_all()
        print(f"[lan -] phone disconnected: {ip}", flush=True)

EMBEDDED_CONTROLLER_HTML = base64.b64decode("${controllerB64}").decode("utf-8", errors="replace")

async def handle_lan(reader, writer):
    peer = writer.get_extra_info("peername") or ("?", 0)
    sock = writer.get_extra_info("socket")
    try:
        if sock is not None:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        head = await asyncio.wait_for(reader.readuntil(b"\\r\\n\\r\\n"), 10)
        lines = head.decode("latin1").split("\\r\\n")
        _method, path_raw, _ver = lines[0].split(" ", 2)
        headers = {}
        for ln in lines[1:]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        req_path = path_raw.split("?", 1)[0]
        if req_path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
            await ws_session(reader, writer, headers, peer)
        elif req_path in ("/", "/index.html"):
            print(f"[lan page] served direct touch controller to {peer[0]}", flush=True)
            writer.write(http_response("200 OK", EMBEDDED_CONTROLLER_HTML, "text/html; charset=utf-8"))
        elif req_path == "/ping":
            writer.write(http_response("200 OK", "ok"))
        else:
            writer.write(http_response("404 Not Found", "not found"))
        await writer.drain()
    except Exception:
        pass
    finally:
        try: writer.close()
        except Exception: pass

def local_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.append(info[4][0])
    except Exception:
        pass
    out = []
    for ip in ips:
        if ip not in out and not ip.startswith(("127.", "169.254.")):
            out.append(ip)
    return out

async def run_all(relay_url, enable_lan):
    tasks = []
    if enable_lan:
        server = await asyncio.start_server(handle_lan, "0.0.0.0", PORT)
        print("\\nDirect Phone Browser URLs (same Wi-Fi — zero login, ultra-low latency):")
        for ip in local_ips() or ["<your-pc-ip>"]:
            print(f"      http://{ip}:{PORT}/?pin={PIN}")
        print()
        tasks.append(asyncio.create_task(server.serve_forever()))
    if relay_url:
        tasks.append(asyncio.create_task(relay_bridge_loop(relay_url, PIN)))
    await asyncio.gather(*tasks)

def main():
    global PAD, KBM, PIN
    ap = argparse.ArgumentParser(description="RedlinePad Windows PC Receiver & Cloud Bridge")
    ap.add_argument("--dry", action="store_true", help="Print inputs only")
    ap.add_argument("--pin", help="6-digit pairing PIN")
    ap.add_argument("--relay", default=DEFAULT_RELAY, help="RedlinePad Cloud Relay WebSocket URL")
    ap.add_argument("--lan-only", action="store_true", help="Run only local LAN WebSocket server on port 8765")
    a = ap.parse_args()
    PAD, KBM, problems = pick_backends(a.dry)
    PIN = load_pin(a.pin)
    print(f"=== {SKIN} ===")
    print(f"Controller Output : {PAD.name if PAD else 'NOT AVAILABLE'}")
    print(f"Keyboard + Mouse  : {KBM.name if KBM else 'NOT AVAILABLE'}")
    print(f"Pairing PIN       : {PIN}")
    for p in problems:
        print("[!]", p)
    print()
    try:
        asyncio.run(run_all(None if a.lan_only else a.relay, enable_lan=True))
    except KeyboardInterrupt:
        print("\\nStopped.")
    finally:
        reset_all()

if __name__ == "__main__":
    main()
`;
}

function buildWindowsLauncherBat(defaultPin: string): string {
  const safePin = isValidPin(defaultPin) ? defaultPin : '123456';
  return `@echo off
title RedlinePad Windows ViGEmBus Bridge
color 0C
echo ============================================================
echo   RedlinePad - Windows Xbox 360 & Keyboard/Mouse Bridge
echo ============================================================
echo.
where python >nul 2>nul
if errorlevel 1 (
  echo [!] Python 3 is not installed. Please install Python 3 from python.org
  pause
  exit /b 1
)
echo [*] Checking required Python packages (vgamepad + websockets)...
python -m pip install --quiet vgamepad websockets
echo.
echo [*] Starting RedlinePad Bridge with Pairing PIN: ${safePin}
echo     Make sure ViGEmBus driver is installed from:
echo     https://github.com/nefarius/ViGEmBus/releases
echo.
python "%~dp0redlinepad_windows_receiver.py" --pin ${safePin}
pause
`;
}

async function fetchVigemRelease(): Promise<VigemReleaseInfo> {
  const now = Date.now();
  if (cachedVigem && now - cachedVigem.fetchedAt < 15 * 60 * 1000) {
    return cachedVigem.data;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch('https://api.github.com/repos/nefarius/ViGEmBus/releases/latest', {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'RedlinePad-Desktop-Companion',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`GitHub HTTP ${resp.status}`);
    const json = (await resp.json()) as {
      tag_name?: string;
      name?: string;
      published_at?: string;
      html_url?: string;
      body?: string;
      assets?: Array<{
        name?: string;
        size?: number;
        browser_download_url?: string;
        content_type?: string;
      }>;
    };
    const assets = (json.assets || [])
      .filter((a) => typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith('https://github.com/'))
      .map((a) => ({
        name: String(a.name || 'ViGEmBus_Setup.exe'),
        size: Number(a.size || 0),
        downloadUrl: String(a.browser_download_url),
        contentType: String(a.content_type || 'application/octet-stream'),
      }));

    const exeAsset = assets.find((a) => a.name.toLowerCase().endsWith('.exe')) || assets[0];
    const data: VigemReleaseInfo = {
      tagName: String(json.tag_name || FALLBACK_VIGEM.tagName),
      name: String(json.name || `ViGEmBus ${json.tag_name || 'Latest'}`),
      publishedAt: String(json.published_at || FALLBACK_VIGEM.publishedAt),
      htmlUrl: String(json.html_url || FALLBACK_VIGEM.htmlUrl),
      repoUrl: 'https://github.com/nefarius/ViGEmBus',
      body: String(json.body || FALLBACK_VIGEM.body).slice(0, 1200),
      assets: assets.length > 0 ? assets : FALLBACK_VIGEM.assets,
      primaryInstallerUrl: exeAsset ? exeAsset.downloadUrl : FALLBACK_VIGEM.primaryInstallerUrl,
      source: 'github-live',
    };
    cachedVigem = { data, fetchedAt: now };
    return data;
  } catch {
    return FALLBACK_VIGEM;
  }
}

async function startServer() {
  loadStore();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));

  // Create new pairing session PIN
  app.post('/api/session/create', (_req, res) => {
    let pin = generatePin();
    while (rooms.has(pin)) {
      pin = generatePin();
    }
    const room = getOrCreateRoom(pin);
    res.json({ pin: room.pin, settings: room.settings });
  });

  // Retrieve synced room state
  app.get('/api/sync/:pin', (req, res) => {
    const { pin } = req.params;
    if (!isValidPin(pin)) {
      res.status(400).json({ error: 'Invalid pairing PIN format (4-12 digits)' });
      return;
    }
    const room = getOrCreateRoom(pin);
    res.json({
      pin: room.pin,
      settings: room.settings,
      devices: getRoomDevices(pin),
      caps: getAggregatedCaps(pin),
    });
  });

  // Update synced room state via REST and broadcast live over WebSocket
  app.put('/api/sync/:pin', (req, res) => {
    const { pin } = req.params;
    if (!isValidPin(pin)) {
      res.status(400).json({ error: 'Invalid pairing PIN format' });
      return;
    }
    const room = getOrCreateRoom(pin);
    room.settings = sanitizeSettings(req.body, room.settings);
    room.updatedAt = Date.now();
    scheduleSaveStore();
    broadcastRoomSettings(pin, room.settings);
    res.json({ pin: room.pin, settings: room.settings });
  });

  // Official ViGEmBus GitHub Releases endpoint
  app.get('/api/vigem/releases', async (_req, res) => {
    const release = await fetchVigemRelease();
    res.json(release);
  });

  // Download upgraded Windows Python Receiver Bridge pre-configured with room PIN & relay
  app.get('/api/download/windows-receiver', (req, res) => {
    const pinParam = typeof req.query.pin === 'string' ? req.query.pin : '';
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host') || '';
    const relayBase = host ? `${proto}://${host}` : '';
    const script = buildUpgradedPythonBridge(pinParam, relayBase);
    res.setHeader('Content-Type', 'text/x-python; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="redlinepad_windows_receiver.py"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  });

  // Download Windows .bat quick launcher
  app.get('/api/download/windows-launcher', (req, res) => {
    const pinParam = typeof req.query.pin === 'string' ? req.query.pin : '';
    const bat = buildWindowsLauncherBat(pinParam);
    res.setHeader('Content-Type', 'application/x-bat; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="Launch_RedlinePad_Windows.bat"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(bat);
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, activeRooms: rooms.size });
  });

  // Expose safe network / shareable URL metadata so QR codes never point phones to 403-protected dev proxies
  app.get('/api/network-info', (req, res) => {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host') || '';
    const isDevProxy = host.startsWith('ais-dev-');
    const envShared = process.env.SHARED_APP_URL || '';
    const derivedShared = isDevProxy
      ? `${proto}://${host.replace(/^ais-dev-/, 'ais-pre-')}`
      : host
        ? `${proto}://${host}`
        : '';
    const sharedAppUrl = envShared || derivedShared;
    const isCloudHosted = host.endsWith('.run.app') || isDevProxy;
    const localServerIps = isCloudHosted
      ? []
      : getLocalIpv4Addresses().map((ip) => `http://${ip}:${PORT}`);

    res.json({
      isDevProxy,
      sharedAppUrl,
      localServerIps,
      defaultLanPort: 8765,
    });
  });

  const server = http.createServer(app);

  // Vite dev middleware or static dist
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    process.env.DISABLE_HMR = 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });

    // Prevent /@vite/client from opening an unreachable port-24678 HMR WebSocket while keeping CSS/HMR exports intact
    app.use(async (req, res, next) => {
      if (req.path === '/@vite/client') {
        try {
          const result = await vite.transformRequest('/@vite/client');
          if (result && result.code) {
            const patched = result.code
              .replace(
                /transport\.connect\(createHMRHandler\(handleMessage\)\);?/g,
                '/* HMR WebSocket disabled */'
              )
              .replace(
                /throw new SendBeforeConnectError\([^)]*\);?/g,
                'return;'
              );
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.send(patched);
            return;
          }
        } catch {
          // Fall through to default Vite middleware
        }
      }
      next();
    });

    app.use(vite.middlewares);
  } else {
    const distPath = process.env.APP_DIST_DIR
      ? path.resolve(process.env.APP_DIST_DIR)
      : path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/ws') {
        next();
        return;
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Real-time WebSocket Relay & Cross-Platform Sync Hub on /ws
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws, req) => {
    const ip =
      String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
        .split(',')[0]
        .trim();

    const session: ClientSession = {
      id: crypto.randomUUID(),
      ws,
      pin: null,
      authed: false,
      role: 'phone',
      platform: 'web',
      name: 'Device',
      connectedAt: Date.now(),
      caps: { pad: null, kbm: null },
      lanUrls: [],
      ip,
    };

    ws.on('message', (rawBuf) => {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(rawBuf.toString('utf-8'));
      } catch {
        return;
      }
      const t = d.t;

      // Ping/pong latency measurement
      if (t === 'p') {
        safeSend(ws, { t: 'p', n: d.n });
        return;
      }

      // Authenticate / join pairing room by PIN
      if (t === 'auth') {
        if (isIpLocked(ip)) {
          safeSend(ws, { t: 'auth', ok: false, locked: true });
          return;
        }
        const pin = typeof d.pin === 'string' ? d.pin.trim() : '';
        if (!isValidPin(pin)) {
          const list = authFailures.get(ip) || [];
          list.push(Date.now());
          authFailures.set(ip, list);
          safeSend(ws, { t: 'auth', ok: false });
          return;
        }

        // Leave previous room if switching PIN
        if (session.pin && roomClients.has(session.pin)) {
          roomClients.get(session.pin)!.delete(session);
          broadcastRoomPresence(session.pin);
        }

        const role =
          d.role === 'desktop' || d.role === 'bridge' || d.role === 'phone' ? d.role : 'phone';
        const validPlatforms = new Set(['ios', 'android', 'windows', 'macos', 'linux', 'web']);
        const platform =
          typeof d.platform === 'string' && validPlatforms.has(d.platform)
            ? (d.platform as PlatformKind)
            : 'web';

        session.pin = pin;
        session.authed = true;
        session.role = role;
        session.platform = platform;
        session.name = typeof d.name === 'string' ? d.name.slice(0, 48) : `${platform} ${role}`;
        session.caps = {
          pad: typeof d.pad === 'string' ? d.pad.slice(0, 80) : null,
          kbm: typeof d.kbm === 'string' ? d.kbm.slice(0, 80) : null,
        };
        if (Array.isArray(d.lanUrls)) {
          session.lanUrls = d.lanUrls
            .filter(
              (u): u is string =>
                typeof u === 'string' &&
                /^https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/.test(u.trim())
            )
            .slice(0, 4);
        } else {
          session.lanUrls = [];
        }

        const room = getOrCreateRoom(pin);
        if (!roomClients.has(pin)) roomClients.set(pin, new Set());
        roomClients.get(pin)!.add(session);
        authFailures.delete(ip);

        const caps = getAggregatedCaps(pin);
        safeSend(ws, {
          t: 'auth',
          ok: true,
          pin,
          clientId: session.id,
          pad: caps.pad,
          kbm: caps.kbm,
          settings: room.settings,
          devices: getRoomDevices(pin),
        });
        broadcastRoomPresence(pin);
        return;
      }

      if (!session.authed || !session.pin) return;

      // Cross-platform settings / layout sync mutation
      if (t === 'sync:update') {
        const room = getOrCreateRoom(session.pin);
        room.settings = sanitizeSettings(d.settings, room.settings);
        room.updatedAt = Date.now();
        scheduleSaveStore();
        broadcastRoomSettings(session.pin, room.settings, session.id);
        safeSend(ws, { t: 'sync:ack', updatedAt: room.settings.updatedAt });
        return;
      }

      // Real-time low-latency gamepad & KBM input packets -> broadcast to desktop & bridge peers
      if (t === 'b' || t === 's' || t === 'tr' || t === 'k' || t === 'm' || t === 'mb' || t === 'reset') {
        const peers = roomClients.get(session.pin);
        if (!peers) return;
        const msgStr = JSON.stringify(d);
        for (const peer of peers) {
          if (peer.id !== session.id && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(msgStr);
          }
        }
      }
    });

    ws.on('close', () => {
      if (session.pin && roomClients.has(session.pin)) {
        const set = roomClients.get(session.pin)!;
        set.delete(session);
        // Safety reset so no virtual buttons stay stuck on disconnect
        if (session.role === 'phone') {
          const resetMsg = JSON.stringify({ t: 'reset' });
          for (const peer of set) {
            if (peer.ws.readyState === WebSocket.OPEN) {
              peer.ws.send(resetMsg);
            }
          }
        }
        if (set.size === 0) {
          roomClients.delete(session.pin);
        } else {
          broadcastRoomPresence(session.pin);
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(PORT, '0.0.0.0', () => {
      server.off('error', onError);
      console.log(`OmniSync Bridge server running on http://0.0.0.0:${PORT}`);
      resolve();
    });
  });

  // The desktop shell owns the server lifecycle and closes it on application exit.
  return async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    });
  };
}

export { startServer };

// Electron imports the server and starts it explicitly. Keep direct CLI/dev startup too.
if (process.env.ELECTRON_MAIN_PROCESS !== 'true') {
  startServer().catch((error) => {
    console.error('OmniSync server failed to start:', error);
    process.exitCode = 1;
  });
}
