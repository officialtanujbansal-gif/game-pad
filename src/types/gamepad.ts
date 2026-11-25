export type LayoutId = 'gamepad' | 'driving' | 'mcpad' | 'minecraft' | 'fps';

export type OutputMode = 'pad' | 'kbm';

export type ThemeMode = 'dark' | 'light';

export type TextureFinish = 'carbon' | 'brushed-metal' | 'ceramic';

export type DeviceRole = 'phone' | 'desktop' | 'bridge';

export type PlatformKind = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'web';

export interface LayoutMeta {
  id: LayoutId;
  title: string;
  shortTitle: string;
  out: OutputMode;
  note: string;
  lookTap?: boolean;
  accent: string;
}

export interface ControlRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ControlItem extends ControlRect {
  id: string;
  kind: 'btn' | 'toggle' | 'stick' | 'steer' | 'pedal' | 'look' | 'ui';
  cls?: string;
  label?: string;
  sub?: string;
  pad?: string;
  key?: string;
  mouse?: 'left' | 'right' | 'middle';
  analog?: boolean;
  dia?: boolean;
  cap?: string;
  keys?: boolean;
  tap?: boolean;
  ui?: 'menu' | 'fs' | 'drive' | 'status' | 'desktop';
  icon?: 'car' | 'gamepad';
  fs?: number;
  face?: 'A' | 'B' | 'X' | 'Y';
}

export interface SavedControlTransform {
  x: number;
  y: number;
  w: number;
  h: number;
  fsr?: number;
}

export type CustomLayoutMap = Partial<Record<LayoutId, Record<string, SavedControlTransform>>>;

export interface GamepadProfile {
  id: string;
  name: string;
  layout: LayoutId;
  sens: number;
  gain: number;
  deadzone: number;
  vib: boolean;
  tap: boolean;
  audioClick: boolean;
  updatedAt: number;
}

export interface SyncedSettings {
  layout: LayoutId;
  sens: number;
  gain: number;
  deadzone: number;
  vib: boolean;
  tap: boolean;
  audioClick: boolean;
  theme: ThemeMode;
  texture: TextureFinish;
  customLayouts: CustomLayoutMap;
  profiles: GamepadProfile[];
  activeProfileId: string;
  updatedAt: number;
}

export interface ConnectedDevice {
  id: string;
  role: DeviceRole;
  platform: PlatformKind;
  name: string;
  connectedAt: number;
  caps?: {
    pad: string | null;
    kbm: string | null;
  };
  lanUrls?: string[];
}

export interface LiveInputState {
  buttons: Record<string, boolean>;
  keys: Record<string, boolean>;
  mouseButtons: Record<string, boolean>;
  sticks: {
    L: { x: number; y: number };
    R: { x: number; y: number };
  };
  triggers: {
    LT: number;
    RT: number;
  };
  lastMouseDelta: { dx: number; dy: number; seq: number };
  lastEventLabel: string;
  packetCount: number;
}

export interface VigemAsset {
  name: string;
  size: number;
  downloadUrl: string;
  contentType: string;
}

export interface VigemReleaseInfo {
  tagName: string;
  name: string;
  publishedAt: string;
  htmlUrl: string;
  repoUrl: string;
  body: string;
  assets: VigemAsset[];
  primaryInstallerUrl: string;
  source: 'github-live' | 'verified-fallback';
}

export const DEFAULT_PROFILES: GamepadProfile[] = [
  {
    id: 'gta-foot',
    name: 'GTA V — On Foot',
    layout: 'gamepad',
    sens: 1.5,
    gain: 1.3,
    deadzone: 0.08,
    vib: true,
    tap: true,
    audioClick: true,
    updatedAt: 1700000000000,
  },
  {
    id: 'gta-drive',
    name: 'GTA V — Driving',
    layout: 'driving',
    sens: 1.6,
    gain: 1.35,
    deadzone: 0.06,
    vib: true,
    tap: true,
    audioClick: true,
    updatedAt: 1700000000000,
  },
  {
    id: 'mc-bedrock',
    name: 'Minecraft Bedrock',
    layout: 'mcpad',
    sens: 1.5,
    gain: 1.25,
    deadzone: 0.08,
    vib: true,
    tap: true,
    audioClick: false,
    updatedAt: 1700000000000,
  },
  {
    id: 'mc-java',
    name: 'Minecraft Java (KBM)',
    layout: 'minecraft',
    sens: 1.8,
    gain: 1.2,
    deadzone: 0.1,
    vib: true,
    tap: true,
    audioClick: false,
    updatedAt: 1700000000000,
  },
  {
    id: 'pc-fps',
    name: 'PC Tactical FPS',
    layout: 'fps',
    sens: 2.0,
    gain: 1.4,
    deadzone: 0.06,
    vib: true,
    tap: false,
    audioClick: true,
    updatedAt: 1700000000000,
  },
];

export const DEFAULT_SETTINGS: SyncedSettings = {
  layout: 'gamepad',
  sens: 1.5,
  gain: 1.3,
  deadzone: 0.08,
  vib: true,
  tap: true,
  audioClick: true,
  theme: 'dark',
  texture: 'carbon',
  customLayouts: {},
  profiles: DEFAULT_PROFILES,
  activeProfileId: 'gta-foot',
  updatedAt: 0,
};

export const INITIAL_LIVE_INPUT: LiveInputState = {
  buttons: {},
  keys: {},
  mouseButtons: {},
  sticks: { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } },
  triggers: { LT: 0, RT: 0 },
  lastMouseDelta: { dx: 0, dy: 0, seq: 0 },
  lastEventLabel: 'Ready for input',
  packetCount: 0,
};
