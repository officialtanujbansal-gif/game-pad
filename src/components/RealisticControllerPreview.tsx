import React from 'react';
import { LiveInputState, TextureFinish } from '../types/gamepad';

interface RealisticControllerPreviewProps {
  liveInput: LiveInputState;
  texture: TextureFinish;
  onTestButton?: (buttonId: string, down: boolean) => void;
  onTestTrigger?: (triggerId: 'LT' | 'RT', value: number) => void;
}

export const RealisticControllerPreview: React.FC<RealisticControllerPreviewProps> = ({
  liveInput,
  texture,
  onTestButton,
  onTestTrigger,
}) => {
  const b = liveInput.buttons;
  const lx = liveInput.sticks.L.x;
  const ly = liveInput.sticks.L.y;
  const rx = liveInput.sticks.R.x;
  const ry = liveInput.sticks.R.y;
  const lt = liveInput.triggers.LT;
  const rt = liveInput.triggers.RT;

  const bindBtn = (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      onTestButton?.(id, true);
    },
    onPointerUp: () => onTestButton?.(id, false),
    onPointerLeave: () => {
      if (b[id]) onTestButton?.(id, false);
    },
    style: { cursor: 'pointer' } as React.CSSProperties,
  });

  const bindTrigger = (id: 'LT' | 'RT') => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      onTestTrigger?.(id, 1);
    },
    onPointerUp: () => onTestTrigger?.(id, 0),
    onPointerLeave: () => {
      if ((id === 'LT' ? lt : rt) > 0) onTestTrigger?.(id, 0);
    },
    style: { cursor: 'pointer' } as React.CSSProperties,
  });

  const activeKeys = Object.entries(liveInput.keys)
    .filter(([, down]) => down)
    .map(([k]) => k);
  const activeMouse = Object.entries(liveInput.mouseButtons)
    .filter(([, down]) => down)
    .map(([k]) => k.toUpperCase());

  const patternId =
    texture === 'carbon'
      ? 'url(#ctrlCarbon)'
      : texture === 'brushed-metal'
        ? 'url(#ctrlBrushed)'
        : 'url(#ctrlCeramic)';

  return (
    <div className="relative flex flex-col items-center justify-center select-none">
      {/* Analog Trigger Pressure Gauges */}
      <div className="mb-3 grid w-full max-w-[540px] grid-cols-2 gap-8 px-6">
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold tracking-wide">LT Trigger</span>
            <span className="font-mono-tabular">{Math.round(lt * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-[#e11d48] transition-transform duration-75 origin-left"
              style={{ transform: `scaleX(${Math.max(0.02, lt)})` }}
            />
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold tracking-wide">RT Trigger</span>
            <span className="font-mono-tabular">{Math.round(rt * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-[#e11d48] transition-transform duration-75 origin-left"
              style={{ transform: `scaleX(${Math.max(0.02, rt)})` }}
            />
          </div>
        </div>
      </div>

      {/* Sculpted Hardware Controller SVG */}
      <svg
        viewBox="0 0 640 380"
        className="w-full max-w-[580px] drop-shadow-[0_24px_38px_rgba(0,0,0,0.45)]"
        role="img"
        aria-label="Interactive live controller telemetry visualizer"
      >
        <defs>
          <linearGradient id="shellGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#323642" />
            <stop offset="48%" stopColor="#1c1f27" />
            <stop offset="100%" stopColor="#101218" />
          </linearGradient>
          <linearGradient id="shellRim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.85" />
            <stop offset="50%" stopColor="#52586a" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#e11d48" stopOpacity="0.8" />
          </linearGradient>
          <linearGradient id="btnMetal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3c414f" />
            <stop offset="100%" stopColor="#181a22" />
          </linearGradient>
          <linearGradient id="btnCrimson" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fb4760" />
            <stop offset="100%" stopColor="#8f102c" />
          </linearGradient>
          <radialGradient id="stickWell" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#07080b" />
            <stop offset="72%" stopColor="#12141b" />
            <stop offset="86%" stopColor="#e11d48" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#262934" />
          </radialGradient>
          <radialGradient id="stickCap" cx="38%" cy="32%" r="62%">
            <stop offset="0%" stopColor="#6a7080" />
            <stop offset="55%" stopColor="#2d313d" />
            <stop offset="100%" stopColor="#111319" />
          </radialGradient>
          <pattern id="ctrlCarbon" width="8" height="8" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="transparent" />
            <path d="M0 4 L4 0 L8 4 L4 8 Z" fill="rgba(255,255,255,0.032)" />
          </pattern>
          <pattern id="ctrlBrushed" width="6" height="4" patternUnits="userSpaceOnUse">
            <line x1="0" y1="1" x2="6" y2="1" stroke="rgba(255,255,255,0.045)" strokeWidth="1" />
          </pattern>
          <pattern id="ctrlCeramic" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="10" cy="10" r="0.6" fill="rgba(255,255,255,0.04)" />
          </pattern>
          <filter id="crimsonGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Left & Right Analog Triggers (LT / RT) */}
        <g {...bindTrigger('LT')} transform={`translate(0, ${lt * 6})`}>
          <path
            d="M126 60 C134 34 176 26 218 32 L212 68 L118 76 Z"
            fill={lt > 0.05 ? 'url(#btnCrimson)' : '#1c1f28'}
            stroke={lt > 0.05 ? '#fda4af' : '#4a4f5f'}
            strokeWidth="1.5"
          />
          <text x="166" y="54" textAnchor="middle" fill="#e5e7eb" fontSize="11" fontWeight="700" fontFamily="Outfit">
            LT
          </text>
        </g>

        <g {...bindTrigger('RT')} transform={`translate(0, ${rt * 6})`}>
          <path
            d="M514 60 C506 34 464 26 422 32 L428 68 L522 76 Z"
            fill={rt > 0.05 ? 'url(#btnCrimson)' : '#1c1f28'}
            stroke={rt > 0.05 ? '#fda4af' : '#4a4f5f'}
            strokeWidth="1.5"
          />
          <text x="474" y="54" textAnchor="middle" fill="#e5e7eb" fontSize="11" fontWeight="700" fontFamily="Outfit">
            RT
          </text>
        </g>

        {/* Left & Right Bumpers (LB / RB) */}
        <g {...bindBtn('LB')} transform={b.LB ? 'translate(0, 3)' : undefined}>
          <path
            d="M110 86 C132 62 184 56 232 62 L226 86 C182 82 142 86 116 102 Z"
            fill={b.LB ? 'url(#btnCrimson)' : 'url(#btnMetal)'}
            stroke={b.LB ? '#fda4af' : '#555b6d'}
            strokeWidth="1.5"
          />
          <text x="172" y="79" textAnchor="middle" fill="#f3f4f6" fontSize="11" fontWeight="700" fontFamily="Outfit">
            LB
          </text>
        </g>

        <g {...bindBtn('RB')} transform={b.RB ? 'translate(0, 3)' : undefined}>
          <path
            d="M530 86 C508 62 456 56 408 62 L414 86 C458 82 498 86 524 102 Z"
            fill={b.RB ? 'url(#btnCrimson)' : 'url(#btnMetal)'}
            stroke={b.RB ? '#fda4af' : '#555b6d'}
            strokeWidth="1.5"
          />
          <text x="468" y="79" textAnchor="middle" fill="#f3f4f6" fontSize="11" fontWeight="700" fontFamily="Outfit">
            RB
          </text>
        </g>

        {/* Main Sculpted Ergonomic Controller Body */}
        <path
          d="M162 76 L478 76 C530 76 566 112 580 172 L602 276 C612 324 576 356 534 352 C504 349 482 326 460 296 L432 260 C422 248 408 242 392 242 L248 242 C232 242 218 248 208 260 L180 296 C158 326 136 349 106 352 C64 356 28 324 38 276 L60 172 C74 112 110 76 162 76 Z"
          fill="url(#shellGrad)"
          stroke="url(#shellRim)"
          strokeWidth="2.4"
        />
        <path
          d="M162 76 L478 76 C530 76 566 112 580 172 L602 276 C612 324 576 356 534 352 C504 349 482 326 460 296 L432 260 C422 248 408 242 392 242 L248 242 C232 242 218 248 208 260 L180 296 C158 326 136 349 106 352 C64 356 28 324 38 276 L60 172 C74 112 110 76 162 76 Z"
          fill={patternId}
          pointerEvents="none"
        />

        {/* Grip Contours */}
        <path
          d="M92 204 C74 238 66 288 84 328"
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="14"
          strokeLinecap="round"
        />
        <path
          d="M548 204 C566 238 574 288 556 328"
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="14"
          strokeLinecap="round"
        />

        {/* Center PS5-Inspired Capacitive Touchpad */}
        <rect
          x="236"
          y="92"
          width="168"
          height="74"
          rx="14"
          fill="#11131a"
          stroke={liveInput.lastMouseDelta.seq > 0 ? '#f43f5e' : '#3a3f4f'}
          strokeWidth="1.5"
        />
        <line x1="252" y1="94" x2="388" y2="94" stroke="#f43f5e" strokeOpacity="0.65" strokeWidth="2" strokeLinecap="round" />
        <text x="320" y="133" textAnchor="middle" fill="#6b7280" fontSize="9.5" fontWeight="600" letterSpacing="2">
          TOUCH CAMERA
        </text>

        {/* BACK & START Buttons */}
        <g {...bindBtn('BACK')}>
          <rect
            x="252"
            y="182"
            width="44"
            height="20"
            rx="6"
            fill={b.BACK ? 'url(#btnCrimson)' : 'url(#btnMetal)'}
            stroke={b.BACK ? '#fda4af' : '#4a4f5e'}
          />
          <text x="274" y="196" textAnchor="middle" fill="#e5e7eb" fontSize="8.5" fontWeight="700">
            BACK
          </text>
        </g>
        <g {...bindBtn('START')}>
          <rect
            x="344"
            y="182"
            width="44"
            height="20"
            rx="6"
            fill={b.START ? 'url(#btnCrimson)' : 'url(#btnMetal)'}
            stroke={b.START ? '#fda4af' : '#4a4f5e'}
          />
          <text x="366" y="196" textAnchor="middle" fill="#e5e7eb" fontSize="8.5" fontWeight="700">
            START
          </text>
        </g>

        {/* Center Redline Emblem */}
        <circle cx="320" cy="192" r="14" fill="#14161e" stroke="#e11d48" strokeOpacity="0.7" strokeWidth="1.6" />
        <circle cx="320" cy="192" r="5" fill="#f43f5e" filter="url(#crimsonGlow)" />

        {/* Left D-Pad Diamond Cluster */}
        <g transform="translate(152, 166)">
          <circle cx="0" cy="0" r="46" fill="#0d0f14" stroke="#2f3442" strokeWidth="1.2" />
          {[
            { id: 'UP', x: 0, y: -24, lbl: '▲' },
            { id: 'DOWN', x: 0, y: 24, lbl: '▼' },
            { id: 'LEFT', x: -24, y: 0, lbl: '◀' },
            { id: 'RIGHT', x: 24, y: 0, lbl: '▶' },
          ].map((d) => (
            <g key={d.id} {...bindBtn(d.id)} transform={`translate(${d.x}, ${d.y})`}>
              <rect
                x="-13"
                y="-13"
                width="26"
                height="26"
                rx="6"
                transform="rotate(45)"
                fill={b[d.id] ? 'url(#btnCrimson)' : 'url(#btnMetal)'}
                stroke={b[d.id] ? '#fda4af' : '#52586a'}
                strokeWidth="1.3"
                filter={b[d.id] ? 'url(#crimsonGlow)' : undefined}
              />
              <text x="0" y="4" textAnchor="middle" fill="#f3f4f6" fontSize="10" fontWeight="700">
                {d.lbl}
              </text>
            </g>
          ))}
        </g>

        {/* Right ABXY Diamond Cluster */}
        <g transform="translate(488, 166)">
          <circle cx="0" cy="0" r="46" fill="#0d0f14" stroke="#2f3442" strokeWidth="1.2" />
          {[
            { id: 'Y', x: 0, y: -25, color: '#f59e0b' },
            { id: 'A', x: 0, y: 25, color: '#10b981' },
            { id: 'X', x: -25, y: 0, color: '#38bdf8' },
            { id: 'B', x: 25, y: 0, color: '#f43f5e' },
          ].map((face) => {
            const on = Boolean(b[face.id]);
            return (
              <g key={face.id} {...bindBtn(face.id)} transform={`translate(${face.x}, ${face.y})`}>
                <rect
                  x="-13"
                  y="-13"
                  width="26"
                  height="26"
                  rx="7"
                  transform="rotate(45)"
                  fill={on ? face.color : 'url(#btnCrimson)'}
                  stroke={on ? '#ffffff' : '#fb7185'}
                  strokeWidth={on ? '2' : '1.2'}
                  filter={on ? 'url(#crimsonGlow)' : undefined}
                />
                <text
                  x="0"
                  y="4.5"
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize="12"
                  fontWeight="800"
                  fontFamily="Outfit"
                >
                  {face.id}
                </text>
              </g>
            );
          })}
        </g>

        {/* Left Analog Stick (L + L3) */}
        <g transform="translate(226, 250)" {...bindBtn('L3')}>
          <circle cx="0" cy="0" r="36" fill="url(#stickWell)" stroke="#484e5e" strokeWidth="1.5" />
          <g transform={`translate(${lx * 15}, ${ly * 15})`}>
            <circle
              cx="0"
              cy="0"
              r="22"
              fill="url(#stickCap)"
              stroke={b.L3 ? '#f43f5e' : '#71788a'}
              strokeWidth={b.L3 ? '2.5' : '1.4'}
            />
            <circle cx="0" cy="0" r="14" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
            <text x="0" y="4" textAnchor="middle" fill="#cbd5e1" fontSize="9" fontWeight="700">
              L
            </text>
          </g>
        </g>

        {/* Right Analog Stick (R + R3) */}
        <g transform="translate(414, 250)" {...bindBtn('R3')}>
          <circle cx="0" cy="0" r="36" fill="url(#stickWell)" stroke="#484e5e" strokeWidth="1.5" />
          <g transform={`translate(${rx * 15}, ${ry * 15})`}>
            <circle
              cx="0"
              cy="0"
              r="22"
              fill="url(#stickCap)"
              stroke={b.R3 ? '#f43f5e' : '#71788a'}
              strokeWidth={b.R3 ? '2.5' : '1.4'}
            />
            <circle cx="0" cy="0" r="14" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
            <text x="0" y="4" textAnchor="middle" fill="#cbd5e1" fontSize="9" fontWeight="700">
              R
            </text>
          </g>
        </g>
      </svg>

      {/* Clean Tabular Telemetry Footer Strip */}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="font-mono-tabular">
          L ({lx >= 0 ? '+' : ''}{lx.toFixed(2)}, {ly >= 0 ? '+' : ''}{ly.toFixed(2)})
        </span>
        <span aria-hidden="true">·</span>
        <span className="font-mono-tabular">
          R ({rx >= 0 ? '+' : ''}{rx.toFixed(2)}, {ry >= 0 ? '+' : ''}{ry.toFixed(2)})
        </span>
        <span aria-hidden="true">·</span>
        <span className="font-medium text-zinc-700 dark:text-zinc-200">{liveInput.lastEventLabel}</span>
        {activeKeys.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular text-[#e11d48]">Keys: {activeKeys.join(', ')}</span>
          </>
        )}
        {activeMouse.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular text-[#e11d48]">Mouse: {activeMouse.join(', ')}</span>
          </>
        )}
      </div>
    </div>
  );
};
