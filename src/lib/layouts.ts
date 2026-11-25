import { ControlItem, ControlRect, LayoutId, LayoutMeta } from '../types/gamepad';

export const LAYOUTS: Record<LayoutId, LayoutMeta> = {
  gamepad: {
    id: 'gamepad',
    title: 'Gamepad Pro',
    shortTitle: 'Gamepad',
    out: 'pad',
    note: 'GTA IV / GTA V on foot, any game with Xbox 360 ViGEmBus controller support',
    accent: '#e11d48',
  },
  driving: {
    id: 'driving',
    title: 'GTA V — Driving',
    shortTitle: 'Driving',
    out: 'pad',
    note: 'Precision steering slider, drag-to-look camera, XYAB actions, handbrake, horn & lights',
    accent: '#f59e0b',
  },
  mcpad: {
    id: 'mcpad',
    title: 'Minecraft — Controller',
    shortTitle: 'MC Pad',
    out: 'pad',
    note: 'Bedrock & Windows edition: use/place, attack, hotbar, inventory, sneak, jump, craft',
    accent: '#10b981',
  },
  minecraft: {
    id: 'minecraft',
    title: 'Minecraft Java — Keyboard',
    shortTitle: 'MC Java',
    out: 'kbm',
    note: 'Keyboard + mouse: drag-to-look with tap-hit & hold-mine, 1–9 hotbar, sneak, sprint',
    lookTap: true,
    accent: '#14b8a6',
  },
  fps: {
    id: 'fps',
    title: 'Keyboard + Mouse',
    shortTitle: 'PC KBM',
    out: 'kbm',
    note: 'PC shooters, GTA V keyboard controls, and any desktop Windows game',
    accent: '#6366f1',
  },
};

export const LAYOUT_ORDER: LayoutId[] = ['gamepad', 'driving', 'mcpad', 'minecraft', 'fps'];

/**
 * Pure responsive layout generator on a 190 x 100 ergonomic design canvas.
 * Preserves exact V21 hit zones while keeping every interactive target cleanly separated.
 */
export function buildLayout(name: LayoutId, W: number, H: number): ControlItem[] {
  const u = Math.min(W / 190, H / 100);
  const oy = (H - 100 * u) / 2;

  const L = (x: number, y: number, w: number, h: number): ControlRect => ({
    x: x * u,
    y: oy + y * u,
    w: w * u,
    h: h * u,
  });
  const R = (x: number, y: number, w: number, h: number): ControlRect => ({
    x: W - (x + w) * u,
    y: oy + y * u,
    w: w * u,
    h: h * u,
  });
  const M = (dx: number, y: number, w: number, h: number): ControlRect => ({
    x: W / 2 + dx * u,
    y: oy + y * u,
    w: w * u,
    h: h * u,
  });
  const CL = (cx: number, cy: number, w: number, h: number): ControlRect =>
    L(cx - w / 2, cy - h / 2, w, h);
  const CR = (cx: number, cy: number, w: number, h: number): ControlRect =>
    R(cx - w / 2, cy - h / 2, w, h);

  const items: ControlItem[] = [];
  const add = (o: Omit<ControlItem, 'x' | 'y' | 'w' | 'h'>, r: ControlRect) =>
    items.push({ ...o, ...r });

  const pad = (
    id: string,
    label: string,
    r: ControlRect,
    o?: Partial<Omit<ControlItem, 'x' | 'y' | 'w' | 'h'>>
  ) => add({ id, kind: 'btn', cls: 'btn', label, pad: id, ...o }, r);

  const key = (
    id: string,
    label: string,
    k: string,
    r: ControlRect,
    o?: Partial<Omit<ControlItem, 'x' | 'y' | 'w' | 'h'>>
  ) => add({ id, kind: 'btn', cls: 'btn', label, key: k, ...o }, r);

  const mouse = (
    id: string,
    label: string,
    b: 'left' | 'right' | 'middle',
    r: ControlRect,
    o?: Partial<Omit<ControlItem, 'x' | 'y' | 'w' | 'h'>>
  ) => add({ id, kind: 'btn', cls: 'btn', label, mouse: b, ...o }, r);

  const toggle = (id: string, label: string, k: string, r: ControlRect) =>
    add({ id, kind: 'toggle', cls: 'btn tg', label, key: k }, r);

  const topBar = () => {
    add({ id: 'menu', kind: 'ui', ui: 'menu', cls: 'ui', label: 'MENU' }, M(-16, 2.5, 14, 7.5));
    add({ id: 'fs', kind: 'ui', ui: 'fs', cls: 'ui', label: 'FULL' }, M(2, 2.5, 14, 7.5));
    add(
      { id: 'status', kind: 'ui', ui: 'status', cls: 'st', label: 'connecting...', fs: 0.34 },
      M(-17, 11.5, 34, 5.5)
    );
  };

  const lookArea = (tap: boolean) =>
    add(
      {
        id: 'look',
        kind: 'look',
        cls: 'look keyboard-look',
        label: 'DRAG TO LOOK',
        tap,
        fs: 0.16,
      },
      M(-40, 24, 80, 62)
    );

  const cross = (
    c: (cx: number, cy: number, w: number, h: number) => ControlRect,
    sg: number,
    cx: number,
    cy: number,
    s: number,
    a: number,
    d: Record<'up' | 'left' | 'right' | 'down', [string, string, string?, ('A' | 'B' | 'X' | 'Y')?]>
  ) => {
    const spot: Record<'up' | 'left' | 'right' | 'down', [number, number]> = {
      up: [cx, cy - s],
      down: [cx, cy + s],
      left: [cx - sg * s, cy],
      right: [cx + sg * s, cy],
    };
    (['up', 'left', 'right', 'down'] as const).forEach((k) => {
      const [id, label, sub, face] = d[k];
      pad(id, label, c(spot[k][0], spot[k][1], a, a), {
        cls: 'btn dia' + (face ? ' face-' + face : ' dpad-key'),
        dia: true,
        sub,
        face,
        fs: 0.31,
      });
    });
  };

  const padLayout = (c: Record<string, string | undefined>) => {
    topBar();
    if (name === 'gamepad') {
      add(
        {
          id: 'centerLook',
          kind: 'look',
          cls: 'look center-look',
          label: 'DRAG TO LOOK',
          tap: false,
          fs: 0.16,
        },
        M(-25, 69, 50, 25)
      );
    } else {
      add(
        {
          id: 'centerLook',
          kind: 'look',
          cls: 'look center-look',
          label: 'DRAG TO LOOK',
          tap: false,
          fs: 0.16,
        },
        M(-26, 69, 52, 24)
      );
    }
    pad('LT', 'LT', L(4, 3, 30, 9), { analog: true, cls: 'btn shoulder-trigger', sub: c.LT });
    pad('LB', 'LB', L(4, 14, 30, 8), { cls: 'btn shoulder-bumper', sub: c.LB });
    pad('RT', 'RT', R(4, 3, 30, 9), { analog: true, cls: 'btn shoulder-trigger', sub: c.RT });
    pad('RB', 'RB', R(4, 14, 30, 8), { cls: 'btn shoulder-bumper', sub: c.RB });
    pad('BACK', 'BACK', M(-20, 24.5, 18, 7), { cls: 'btn meta-btn', sub: c.BACK });
    pad('START', 'START', M(2, 24.5, 18, 7), { cls: 'btn meta-btn', sub: c.START });
    add(
      {
        id: 'driveMode',
        kind: 'ui',
        ui: 'drive',
        cls: 'ui mode-switch mode-logo',
        icon: 'car',
        label: '',
      },
      R(3, 24, 11, 10)
    );
    add({ id: 'L', kind: 'stick', cls: 'stick', pad: 'L', cap: c.L || 'MOVE' }, L(5, 68, 32, 30));
    add({ id: 'R', kind: 'stick', cls: 'stick', pad: 'R', cap: c.R || 'LOOK' }, R(5, 68, 32, 30));
    cross(CL, 1, 55, 40, 14.2, 12, {
      up: ['UP', '▲', c.UP],
      left: ['LEFT', '◀', c.LEFT],
      right: ['RIGHT', '▶', c.RIGHT],
      down: ['DOWN', '▼', c.DOWN],
    });
    cross(CR, -1, 49, 40, 14.2, 12, {
      up: ['Y', 'Y', c.Y, 'Y'],
      left: ['X', 'X', c.X, 'X'],
      right: ['B', 'B', c.B, 'B'],
      down: ['A', 'A', c.A, 'A'],
    });
    if (name === 'gamepad') {
      pad('L3', 'L3', L(16, 60, 18, 6.8), { cls: 'btn meta-btn', sub: c.L3 });
      pad('R3', 'R3', R(16, 60, 18, 6.8), { cls: 'btn meta-btn', sub: c.R3 });
    } else {
      pad('L3', 'L3', L(18, 24, 16, 7), { cls: 'btn meta-btn', sub: c.L3 });
      pad('R3', 'R3', R(18, 24, 16, 7), { cls: 'btn meta-btn', sub: c.R3 });
    }
  };

  if (name === 'gamepad') {
    padLayout({});
  } else if (name === 'mcpad') {
    padLayout({
      LT: 'USE / PLACE',
      RT: 'ATTACK',
      LB: '◀ HOTBAR',
      RB: 'HOTBAR ▶',
      BACK: 'PLAYERS',
      START: 'MENU',
      L3: 'RUN',
      L: 'MOVE',
      R: 'LOOK',
      LEFT: 'EMOTE',
      DOWN: 'DROP',
      RIGHT: 'CHAT',
      Y: 'INV',
      X: 'CRAFT',
      B: 'SNEAK',
      A: 'JUMP',
    });
  } else if (name === 'driving') {
    topBar();
    add(
      {
        id: 'driveMode',
        kind: 'ui',
        ui: 'drive',
        cls: 'ui mode-switch mode-logo active',
        icon: 'gamepad',
        label: '',
      },
      R(3, 24, 11, 10)
    );
    add(
      {
        id: 'driveLook',
        kind: 'look',
        cls: 'look drive-look',
        label: 'DRAG TO LOOK',
        tap: false,
        fs: 0.18,
      },
      M(-32, 49, 64, 32)
    );
    pad('LT', 'BRAKE / REV', L(3, 3, 20, 11), { analog: true, cls: 'btn shoulder-trigger brake-accent' });
    pad('LB', 'DRIVE-BY', L(25, 3, 20, 11), { cls: 'btn shoulder-bumper' });
    pad('RT', 'GAS', R(3, 3, 20, 11), { analog: true, cls: 'btn shoulder-trigger gas-accent' });
    pad('RB', 'H-BRAKE', R(25, 3, 20, 11), { cls: 'btn shoulder-bumper' });
    pad('BACK', 'BACK', M(-31, 24, 28, 10), { cls: 'btn meta-btn', sub: 'CAMERA' });
    pad('START', 'START', M(3, 24, 28, 10), { cls: 'btn meta-btn', sub: 'PAUSE' });
    cross(CL, 1, 28, 44, 14, 11.5, {
      up: ['UP', '▲', 'PHONE'],
      left: ['LEFT', '◀', 'RADIO'],
      right: ['RIGHT', '▶', 'LIGHTS'],
      down: ['DOWN', '▼', 'CHAR.'],
    });
    cross(CR, -1, 38, 62, 13.5, 11.5, {
      up: ['Y', 'Y', 'EXIT', 'Y'],
      left: ['X', 'X', 'WEAPON', 'X'],
      right: ['B', 'B', 'CINEMA', 'B'],
      down: ['A', 'A', 'H-BRAKE', 'A'],
    });
    add({ id: 'R', kind: 'stick', cls: 'stick cap-out', pad: 'R', cap: 'LOOK' }, CL(54, 24, 16, 16));
    pad('L3', 'L3', L(18, 22, 16, 8), { cls: 'btn meta-btn', sub: 'HORN' });
    pad('R3', 'R3', R(18, 22, 16, 8), { cls: 'btn meta-btn', sub: 'BEHIND' });
    add({ id: 'steer', kind: 'steer', cls: 'steer', label: 'STEER', pad: 'L' }, L(5, 74, 54, 20));
  } else if (name === 'minecraft') {
    lookArea(true);
    topBar();
    add({ id: 'move', kind: 'stick', cls: 'stick mc-move', keys: true, cap: 'WASD' }, L(6, 50, 38, 38));
    key('inv', 'INV', 'e', L(3, 3, 22, 12), { cls: 'btn mc-utility' });
    key('drop', 'DROP', 'q', L(27, 3, 22, 12), { cls: 'btn mc-utility' });
    key('view', 'F5', 'f5', L(3, 17, 22, 12), { cls: 'btn mc-utility' });
    key('esc', 'ESC', 'esc', R(3, 3, 22, 12), { cls: 'btn mc-utility' });
    toggle('sneak', 'SNEAK', 'shift', R(3, 27, 23, 11));
    toggle('sprint', 'SPRINT', 'ctrl', R(29, 27, 23, 11));
    mouse('attack', 'HIT', 'left', R(3, 48, 22, 22), { cls: 'btn mc-hit' });
    mouse('use', 'PLACE', 'right', R(3, 72, 22, 22), { cls: 'btn mc-place' });
    key('jump', 'JUMP', 'space', R(30, 62, 24, 24), { cls: 'btn mc-jump' });
    for (let i = 0; i < 9; i++) {
      key('slot' + (i + 1), String(i + 1), String(i + 1), M(-45 + i * 10, 88, 9.4, 10), {
        cls: 'btn tight mc-slot',
      });
    }
  } else if (name === 'fps') {
    lookArea(false);
    topBar();
    key('f', 'F', 'f', L(3, 3, 17, 12));
    key('q', 'Q', 'q', L(22, 3, 17, 12));
    key('r', 'R', 'r', L(3, 17, 17, 12));
    key('e', 'E', 'e', L(22, 17, 17, 12));
    key('v', 'V', 'v', L(41, 17, 17, 12));
    key('esc', 'ESC', 'esc', R(3, 3, 17, 12));
    key('tab', 'TAB', 'tab', R(22, 3, 17, 12));
    key('c', 'C', 'c', R(41, 3, 17, 12));
    toggle('shift', 'SHIFT', 'shift', L(6, 36, 19, 11));
    toggle('ctrl', 'CTRL', 'ctrl', L(27, 36, 19, 11));
    add({ id: 'move', kind: 'stick', cls: 'stick', keys: true, cap: 'WASD' }, L(6, 50, 38, 38));
    mouse('fire', 'FIRE', 'left', R(3, 48, 22, 22), { cls: 'btn mc-hit' });
    mouse('aim', 'AIM', 'right', R(3, 72, 22, 22), { cls: 'btn mc-utility' });
    key('jump', 'JUMP', 'space', R(30, 62, 24, 24), { cls: 'btn mc-jump' });
  }

  return items;
}
