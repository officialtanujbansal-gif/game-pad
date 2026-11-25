#!/usr/bin/env python3
"""
Phone Gamepad - PC receiver (single file, standard library only).

Serves the touch controller page to your phone and turns the touches it sends over
WebSocket into:
  * a virtual Xbox 360 controller      (Windows + vgamepad + ViGEmBus driver)
  * keyboard keys and mouse movement   (Windows, built in, no extra software)
  * or just prints them                (--dry, any OS, for testing)

    python gamepad_server.py            normal start
    python gamepad_server.py --dry      only print input, control nothing
    python gamepad_server.py --pin 4321 use this PIN instead of the saved one
"""
import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
import pathlib
import secrets
import socket
import struct
import time

SKIN = "v21 Python-hosted gamepad with drag-edge resizing"
PORT = int(os.environ.get("GAMEPAD_PORT", "8765"))
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HERE = pathlib.Path(__file__).resolve().parent
PIN_FILE = HERE / "gamepad_pin.txt"

# ----------------------------------------------------------------------------
# Phone page (served at /)
# ----------------------------------------------------------------------------
PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#0f1115">
<title>Phone Gamepad V21</title>
<style>
:root{--bg:#060607;--body1:#2c2c30;--body2:#1b1b1e;--lobe:#141416;--edge:#45454b;--ridge:rgba(255,255,255,.05);--btn1:#303034;--btn2:#1b1b1e;--bedge:#45454b;--txt:#e8e8eb;--dim:#93939b;--well:#0e0e10;--d1:#a8a8ae;--d2:#5c5c63;--d3:#2a2a2e;--acc:#d6b46a;--accbg:#2b2518;--sh:rgba(0,0,0,.65);--hi:rgba(255,255,255,.08);--okc:#8fd3a2;--okb:#14211a;--okl:#24392c;--bdc:#e0a0a0;--bdb:#2a1717;--bdl:#432727;--menu:#09090a}
:root[data-theme=light]{--bg:#c4c5c9;--body1:#f4f4f6;--body2:#dcdce0;--lobe:#cdcdd2;--edge:#b3b3ba;--ridge:rgba(0,0,0,.05);--btn1:#fbfbfc;--btn2:#e3e3e7;--bedge:#bdbdc4;--txt:#2a2a2e;--dim:#6a6a72;--well:#c2c2c8;--d1:#7a7a82;--d2:#45454b;--d3:#222226;--acc:#9a6a0e;--accbg:#f3e7c9;--sh:rgba(0,0,0,.22);--hi:rgba(255,255,255,.9);--okc:#1f6b3a;--okb:#dcf0e2;--okl:#a6d4b5;--bdc:#8a2b2b;--bdb:#f3dcdc;--bdl:#dba9a9;--menu:#e9e9ec}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:none}
html,body{margin:0;height:100%;background:var(--bg);color:var(--txt);font-family:"Segoe UI",system-ui,-apple-system,Roboto,sans-serif;overflow:hidden;overscroll-behavior:none}
#pad{position:fixed;inset:0}
.body{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;filter:drop-shadow(0 0 5px rgba(226,35,48,.20))}
.body path:first-of-type{stroke:#a8323d!important;filter:drop-shadow(0 0 3px rgba(255,45,58,.58))}
.body path:nth-of-type(2){opacity:.8}
#pad:after{content:'';position:fixed;inset:5px;border:1px solid rgba(218,48,60,.24);border-radius:22px;box-shadow:inset 0 0 18px rgba(180,25,38,.08),0 0 12px rgba(220,35,48,.12);pointer-events:none;z-index:0}
.it{position:absolute;z-index:2;display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--txt);text-align:center;line-height:1.1;white-space:pre-line;letter-spacing:.06em}
.btn{background:linear-gradient(180deg,var(--btn1),var(--btn2));border:1px solid var(--bedge);border-radius:12px;box-shadow:inset 0 1px 0 var(--hi),0 2px 5px var(--sh);transition:background .05s,border-color .05s,transform .05s}
.btn::before{content:"";position:absolute;inset:-5px}
.btn.tight::before{inset:0}
/* Fine-grain controller finish: satin metal, soft edge highlights and subtle stipple. */
.btn{position:absolute;isolation:isolate;overflow:visible;background-image:linear-gradient(155deg,rgba(255,255,255,.11),transparent 38%,rgba(0,0,0,.22)),repeating-linear-gradient(135deg,rgba(255,255,255,.018) 0 1px,transparent 1px 4px),linear-gradient(180deg,var(--btn1),var(--btn2));border-radius:13px;box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset 0 -2px 0 rgba(0,0,0,.28),inset 0 0 0 1px rgba(210,45,58,.13),0 0 0 1px rgba(174,38,50,.34),0 0 7px rgba(226,35,48,.16),0 4px 9px rgba(0,0,0,.34)}
.btn::after{content:"";position:absolute;inset:2px;border-radius:10px;border:1px solid rgba(255,255,255,.055);pointer-events:none;z-index:-1}
.btn.on{filter:brightness(1.18);transform:translateY(1px) scale(.96)}
.mc-hit{--mc:#ff5b61;--mcbg:#351a22;border-color:#a83e4b;background-image:linear-gradient(155deg,rgba(255,150,150,.22),transparent 42%),repeating-linear-gradient(135deg,rgba(255,255,255,.025) 0 1px,transparent 1px 4px),linear-gradient(180deg,#51232b,#24151d);color:#ffe5e5}
.mc-place{--mc:#55d6c2;--mcbg:#123c3b;border-color:#258f83;background-image:linear-gradient(155deg,rgba(130,255,235,.2),transparent 42%),repeating-linear-gradient(135deg,rgba(255,255,255,.025) 0 1px,transparent 1px 4px),linear-gradient(180deg,#20534d,#142c2e);color:#d9fff7}
.mc-jump{--mc:#f4c45f;--mcbg:#45351a;border-color:#b88b36;background-image:linear-gradient(155deg,rgba(255,230,160,.24),transparent 42%),repeating-linear-gradient(135deg,rgba(255,255,255,.025) 0 1px,transparent 1px 4px),linear-gradient(180deg,#61491f,#302316);color:#fff1c9}
.mc-utility{border-color:#596d9c;background-image:linear-gradient(155deg,rgba(160,190,255,.18),transparent 42%),repeating-linear-gradient(135deg,rgba(255,255,255,.02) 0 1px,transparent 1px 4px),linear-gradient(180deg,#303d5d,#1a2234);color:#e4edff}
.mc-slot{border-color:#687b8b;background-image:linear-gradient(155deg,rgba(180,220,255,.14),transparent 45%),linear-gradient(180deg,#344655,#1b2834);color:#e8f4ff}
.mc-move{border-color:#637d91;background-image:radial-gradient(circle at 50% 45%,#1b2a37 0,#111b25 60%,#2a4050 100%)}
.mc-hit.on{background-color:#5a2028;border-color:#ff777c;color:#fff}
.mc-place.on{background-color:#15524b;border-color:#75f2dc;color:#fff}
.mc-jump.on{background-color:#594016;border-color:#ffda83;color:#fff}
@media (max-height:520px){.mc-hit,.mc-place{border-radius:11px}.mc-hit .t,.mc-place .t{font-size:.95em}}
.btn.on{background:var(--accbg);border-color:var(--acc);color:var(--acc);transform:scale(.95);box-shadow:inset 0 0 14px rgba(214,180,106,.25),0 1px 3px var(--sh)}
.round{border-radius:50%}
.stick{border-radius:50%;background:radial-gradient(circle,var(--well) 0,var(--well) 54%,#303034 56%,#171719 72%,#d52b39 74%,#7d1721 79%,var(--btn1) 82%);border:1px solid #555057;box-shadow:inset 0 4px 14px rgba(0,0,0,.55),0 0 7px rgba(235,35,52,.34),0 2px 6px var(--sh)}
.nub{position:absolute;border-radius:50%;background:radial-gradient(circle at 38% 30%,var(--d1) 0%,var(--d2) 55%,var(--d3) 100%);border:1px solid var(--d2);box-shadow:0 4px 9px var(--sh),inset 0 1px 0 rgba(255,255,255,.18);pointer-events:none;left:50%;top:50%}
.steer{border-radius:16px;background:linear-gradient(180deg,var(--well),var(--btn2));border:1px solid var(--bedge);color:var(--dim);letter-spacing:.35em;box-shadow:inset 0 4px 14px rgba(0,0,0,.4)}
.knob{position:absolute;top:10%;height:80%;width:16%;left:50%;transform:translateX(-50%);background:linear-gradient(180deg,var(--d1),var(--d3));border:1px solid var(--d2);border-radius:12px;box-shadow:0 3px 8px var(--sh);pointer-events:none}
.pedal{background:linear-gradient(180deg,var(--well),var(--btn2));border:1px solid var(--bedge);border-radius:16px;overflow:hidden;color:var(--dim);letter-spacing:.3em;box-shadow:inset 0 4px 14px rgba(0,0,0,.4)}
.pedal .fill{position:absolute;left:0;right:0;bottom:0;height:0;background:rgba(214,180,106,.3);pointer-events:none}
.pedal.brake .fill{background:rgba(205,90,90,.32)}
.pedal .lbl{position:relative;z-index:1}
.look{position:absolute;z-index:1;isolation:isolate;color:rgba(220,225,235,.62);opacity:.88;font-weight:700;letter-spacing:.18em;border:1px solid rgba(151,164,183,.22);border-radius:30px 30px 24px 24px;background:radial-gradient(ellipse at 50% 8%,rgba(226,45,58,.13),rgba(32,35,43,.34) 42%,rgba(8,10,14,.28) 100%),repeating-linear-gradient(0deg,rgba(255,255,255,.018) 0 1px,transparent 1px 5px);box-shadow:inset 0 1px 0 rgba(255,255,255,.10),inset 0 0 34px rgba(220,35,48,.09),0 0 18px rgba(220,35,48,.08);pointer-events:auto;text-shadow:0 1px 4px #000;overflow:hidden}
.look:before{content:'⌖';position:absolute;left:0;right:0;top:29%;text-align:center;font-size:clamp(30px,5vw,48px);line-height:1;color:rgba(255,205,208,.52);letter-spacing:0;text-shadow:0 0 16px rgba(245,50,65,.22);pointer-events:none}
.look:after{content:'DRAG TO LOOK  •  MOUSE CAMERA';position:absolute;left:0;right:0;top:65%;text-align:center;font-size:clamp(8px,1.35vw,11px);letter-spacing:.14em;color:rgba(255,155,162,.68);pointer-events:none}
.look .t{display:none}
/* Wide PS5-inspired centre touch surface, behind the lower inner edges of both control clusters. */
.center-look,.drive-look{opacity:.92;border:1px solid rgba(235,75,85,.38);border-radius:34px 34px 22px 22px;background:radial-gradient(ellipse at 50% 0%,rgba(226,45,58,.17),rgba(32,35,43,.40) 42%,rgba(8,10,14,.34) 100%),repeating-linear-gradient(135deg,rgba(255,255,255,.018) 0 1px,transparent 1px 6px);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),inset 0 0 38px rgba(220,35,48,.11),0 0 20px rgba(220,35,48,.10)}
.center-look:before,.drive-look:before{top:16%;color:rgba(255,205,208,.60);font-size:clamp(34px,5.4vw,52px);text-shadow:0 0 17px rgba(245,50,65,.30)}
.center-look:after,.drive-look:after{top:68%;color:rgba(255,155,162,.76)}
.center-look{border-color:rgba(235,75,85,.44);border-radius:18px;background:radial-gradient(ellipse at 50% 0%,rgba(226,45,58,.16),rgba(32,35,43,.34) 48%,rgba(8,10,14,.24) 100%),repeating-linear-gradient(135deg,rgba(255,255,255,.018) 0 1px,transparent 1px 6px);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),inset 0 0 24px rgba(220,35,48,.09),0 0 14px rgba(220,35,48,.08)}
.drive-look{border-radius:18px}
.keyboard-look{border-radius:20px;border-color:rgba(235,75,85,.38);background:radial-gradient(ellipse at 50% 0%,rgba(226,45,58,.13),rgba(32,35,43,.32) 48%,rgba(8,10,14,.22) 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.11),inset 0 0 24px rgba(220,35,48,.08),0 0 14px rgba(220,35,48,.07)}
.drive-look{border-color:rgba(235,75,85,.48);color:rgba(255,205,208,.76)}
.keyboard-look:before{top:30%;font-size:clamp(28px,4.6vw,42px)}
.keyboard-look:after{top:65%;font-size:clamp(8px,1.15vw,10px)}
.look:active{filter:brightness(1.12)}
.ui{background:linear-gradient(180deg,#303034,#19191d);border:1px solid rgba(194,55,65,.55);border-radius:8px;font-weight:700;color:#e5dfe0;letter-spacing:.06em;box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 0 7px rgba(220,38,52,.16),0 2px 5px var(--sh)}
.mode-switch{color:#ffb4b8;border-color:#b8444d;text-shadow:0 0 5px rgba(255,55,65,.25)}
.mode-switch.active{background:linear-gradient(180deg,#4b252b,#24171b);color:#ffdadd;box-shadow:inset 0 0 10px rgba(235,45,58,.20),0 0 9px rgba(220,35,48,.24)}
.mode-logo{border-radius:50%;padding:0;color:#ff343f;text-shadow:0 0 7px rgba(255,35,48,.7)}
.mode-logo .t{display:flex;width:100%;height:100%;align-items:center;justify-content:center}
.mode-logo svg{width:72%;height:72%;display:block;overflow:visible}
.mode-logo svg path,.mode-logo svg circle,.mode-logo svg rect{stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;fill:none}
.st{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--bdb);color:var(--bdc);border:1px solid var(--bdl);border-radius:10px;font-weight:600;padding:1px 6px}
.st.ok{background:var(--okb);color:var(--okc);border-color:var(--okl)}
.t{display:block}
.t small{display:block;font-size:max(8px,.55em);font-weight:600;letter-spacing:.06em;color:var(--dim);margin-top:2px;white-space:nowrap}
.btn.on small{color:var(--acc)}
.dia{border-radius:16%;transform:rotate(45deg);border-color:#9f2732;color:#ffeded;background:linear-gradient(150deg,#fa3444,#8e101c);box-shadow:inset 0 1px 0 rgba(255,255,255,.28),0 0 8px rgba(240,35,50,.34),0 3px 8px rgba(0,0,0,.45)}
.dia .t{transform:rotate(-45deg)}
.dia .t small{letter-spacing:0;margin-top:0}
.dia.on{transform:rotate(45deg) scale(.94)}
.dia::before{inset:-3px}
.stick[data-cap]::after{content:attr(data-cap);position:absolute;left:0;right:0;bottom:13%;text-align:center;font-size:9px;letter-spacing:.3em;color:var(--dim);opacity:.7;pointer-events:none}
.stick.cap-out::after{bottom:-15px}
.pedal .lbl{writing-mode:vertical-rl;letter-spacing:.35em;font-size:14px}
#rotate{display:none;position:fixed;inset:0;z-index:9;background:var(--bg);align-items:center;justify-content:center;font-size:22px;text-align:center;padding:24px;color:var(--dim)}
@media (orientation:portrait){#rotate{display:flex}}
#menu{position:fixed;inset:0;z-index:20;background:var(--menu);display:flex;align-items:center;justify-content:center}
#menu.hide{display:none}
#menu .panel,#menu .panel *{touch-action:pan-y}
.panel{width:min(94vw,860px);max-height:94vh;overflow:auto;display:grid;grid-template-columns:1.2fr 1fr;gap:20px;padding:16px}
.panel h2{margin:0 0 10px;font-size:12px;color:var(--acc);font-weight:600;text-transform:uppercase;letter-spacing:.2em}
.lay{display:block;width:100%;text-align:left;margin:0 0 8px;padding:10px 12px;border-radius:10px;border:1px solid var(--bedge);background:linear-gradient(180deg,var(--btn1),var(--btn2));color:var(--txt);font-size:15px;font-weight:600}
.lay small{display:block;font-weight:400;color:var(--dim);margin-top:2px;font-size:12px}
.lay.sel{border-color:var(--acc);background:var(--accbg)}
.row{margin:0 0 14px;font-size:14px;color:var(--txt)}
.row input[type=range]{width:100%;accent-color:#c9a86a}
.row input[type=checkbox]{accent-color:#c9a86a}
.row label{display:flex;gap:8px;align-items:center}
.mb{padding:10px 16px;border-radius:10px;border:1px solid var(--bedge);background:linear-gradient(180deg,var(--btn1),var(--btn2));color:var(--txt);font-size:15px;font-weight:600;margin-right:8px}
.mb.pri{background:var(--accbg);border-color:var(--acc);color:var(--acc)}

#pad.editing-layout .it{outline:1px dashed rgba(255,90,100,.9)!important;cursor:move;touch-action:none!important}
#pad.editing-layout .it.resize-edge{cursor:nwse-resize!important}
#pad.editing-layout .it .resize-grip{pointer-events:none!important;opacity:.9}
#pad.editing-layout .it.resize-active{outline:2px solid #ffdf80!important;box-shadow:0 0 0 2px rgba(255,190,60,.28),0 0 15px rgba(255,80,60,.55)!important}
#pad.editing-layout .it.edit-selected{outline:2px solid #ffdf80!important;box-shadow:0 0 0 2px rgba(255,190,60,.35),0 0 15px rgba(255,80,60,.65)!important}
#size-tools{display:none;position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:200;align-items:center;gap:10px;padding:9px 12px;border:1px solid #a83b45;border-radius:14px;background:rgba(20,13,15,.96);box-shadow:0 5px 22px #000b;color:#ffe8e9;font:600 13px system-ui;touch-action:manipulation;white-space:nowrap}
#pad.editing-layout~#size-tools{display:flex}
#size-tools button{width:44px;height:42px;border:1px solid #e45b66;border-radius:10px;background:linear-gradient(180deg,#61242b,#2a1419);color:#fff;font-size:23px;font-weight:800;touch-action:manipulation}
#size-tools button:active{transform:scale(.94);background:#8e2934}
#size-tools .size-label{min-width:118px;text-align:center;font-size:11px;color:#ffdadd}
#pad.editing-layout .resize-grip{position:absolute;right:-9px;bottom:-9px;width:32px;height:32px;border:2px solid #fff0f1;border-radius:9px;background:linear-gradient(135deg,#ff7881,#b10f22);box-shadow:0 0 0 2px rgba(70,0,0,.75),0 0 13px rgba(255,45,60,.9);z-index:50;touch-action:none!important;cursor:nwse-resize;display:grid;place-items:center;pointer-events:auto}
#pad.editing-layout .resize-grip:after{content:'⤢';color:white;font-size:21px;font-weight:900;line-height:1;text-shadow:0 1px 3px #500}
#pad.editing-layout .it.resizing{outline:2px solid #ff6974!important}
#pad.editing-layout .look{outline:2px dashed #ff6872!important}
#pad.editing-layout:after{content:'EDIT MODE • MOVE OR RESIZE';position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:99;padding:6px 12px;border:1px solid #b8444d;border-radius:999px;background:#251317;color:#ffdadd;font-size:11px;letter-spacing:.12em;pointer-events:none}
</style>
</head>
<body>
<div id="rotate">Rotate your phone to landscape</div>
<div id="pad"></div>
<div id="size-tools"><button type="button" id="sizeDown" aria-label="Decrease selected control size">−</button><span class="size-label" id="sizeLabel">Select a control</span><button type="button" id="sizeUp" aria-label="Increase selected control size">+</button></div>
<div id="menu" class="hide">
  <div class="panel">
    <div>
      <h2>Layout</h2>
      <div id="layouts"></div>
    </div>
    <div>
      <h2>Settings</h2>
      <div class="row">Look speed (keyboard + mouse layouts): <b id="sensv"></b>
        <input id="sens" type="range" min="0.5" max="4" step="0.1"></div>
      <div class="row">Theme: <button class="mb" id="thDark">Dark</button><button class="mb" id="thLight">Light</button></div>
      <div class="row">Stick / steering sensitivity: <b id="gainv"></b>
        <input id="gain" type="range" min="0.8" max="2" step="0.1"></div>
      <div class="row"><label><input id="vib" type="checkbox"> Vibrate on touch</label></div>
      <div class="row"><label><input id="tap" type="checkbox"> Minecraft: tap = hit, hold still = mine</label></div>
      <div class="row"><button class="mb pri" id="editGamepad">Edit Gamepad layout</button><button class="mb" id="resetGamepad">Reset Gamepad layout</button></div>
      <div class="row" style="font-size:12px;color:var(--dim)">In edit mode, tap a control to select it, then use − / + to resize. Drag controls to move them. Changes are saved on this device.</div>
      <div class="row"><button class="mb pri" id="close">Close</button><button class="mb" id="forget">Forget PIN</button></div>
      <div class="row" id="info" style="color:#7a7a83;font-size:12px"></div>
    </div>
  </div>
</div>
<script>
// LAYOUT-BEGIN
// Design canvas is 190 x 100 units; u = size of one unit in pixels. Pure functions, no DOM.
const LAYOUTS = {
  gamepad:   { title: 'Gamepad', out: 'pad', note: 'GTA IV / GTA V on foot, any game with Xbox-controller support' },
  driving:   { title: 'GTA V - Driving', out: 'pad', note: 'Vehicle controls: steering, drag-to-look camera, XYAB actions, handbrake, horn, radio, lights' },
  mcpad:     { title: 'Minecraft - Controller', out: 'pad', note: 'Bedrock / Windows edition: use, attack, hotbar, inventory, sneak, jump, craft' },
  minecraft: { title: 'Minecraft Java - Keyboard', out: 'kbm', note: 'Keyboard + mouse: drag to look, hotbar, sneak, sprint', lookTap: true },
  fps:       { title: 'Keyboard + mouse', out: 'kbm', note: 'GTA V with keyboard controls, shooters, any PC game' },
};

function buildLayout(name, W, H) {
  const u = Math.min(W / 190, H / 100), oy = (H - 100 * u) / 2;
  const L = (x, y, w, h) => ({ x: x * u, y: oy + y * u, w: w * u, h: h * u });
  const R = (x, y, w, h) => ({ x: W - (x + w) * u, y: oy + y * u, w: w * u, h: h * u });
  const M = (dx, y, w, h) => ({ x: W / 2 + dx * u, y: oy + y * u, w: w * u, h: h * u });
  // centre-based variants (cx is measured from the left edge / the right edge / the screen centre)
  const CL = (cx, cy, w, h) => L(cx - w / 2, cy - h / 2, w, h);
  const CR = (cx, cy, w, h) => R(cx - w / 2, cy - h / 2, w, h);
  const CM = (dx, cy, w, h) => M(dx - w / 2, cy - h / 2, w, h);
  const items = [];
  const add = (o, r) => items.push(Object.assign({}, o, r));
  const pad = (id, label, r, o) => add(Object.assign({ id, kind: 'btn', cls: 'btn', label, pad: id }, o), r);
  const key = (id, label, k, r, o) => add(Object.assign({ id, kind: 'btn', cls: 'btn', label, key: k }, o), r);
  const mouse = (id, label, b, r, o) => add(Object.assign({ id, kind: 'btn', cls: 'btn', label, mouse: b }, o), r);
  const toggle = (id, label, k, r) => add({ id, kind: 'toggle', cls: 'btn tg', label, key: k }, r);
  const topBar = () => {
    // Compact top-centre controls leave the shoulder and face-button zones clear.
    add({ id: 'menu', kind: 'ui', ui: 'menu', cls: 'ui', label: '☰' }, M(-9, 3, 13, 7));
    add({ id: 'fs', kind: 'ui', ui: 'fs', cls: 'ui', label: '⛶' }, M(9, 3, 13, 7));
    add({ id: 'status', kind: 'ui', ui: 'status', cls: 'st', label: 'connecting...', fs: 0.38 }, M(0, 12, 30, 5));
  };
  // Keyboard/FPS camera surface occupies only the central empty lane between controls.
  const lookArea = tap => add({ id: 'look', kind: 'look', cls: 'look keyboard-look', label: 'DRAG TO LOOK', tap: !!tap, fs: 0.16 }, M(-40, 24, 80, 62));
  // four buttons as rotated squares in a diamond; d = { up, left, right, down }, each [id, label, caption, colourClass]
  const cross = (c, sg, cx, cy, s, a, d) => {
    const spot = { up: [cx, cy - s], down: [cx, cy + s], left: [cx - sg * s, cy], right: [cx + sg * s, cy] };
    for (const k in d) {
      const [id, label, sub, face] = d[k];
      pad(id, label, c(spot[k][0], spot[k][1], a, a), { cls: 'btn dia' + (face ? ' ' + face : ''), dia: true, sub, fs: 0.30 });
    }
  };
  // Controller-inspired arrangement: D-pad upper-left, both joysticks lower,
  // and the four face buttons upper-right with non-overlapping hit areas.
  // All controls use separated hit areas so they remain usable on narrow phones.
  const padLayout = c => {
    topBar();
    // Gamepad-only camera touchpad occupies the central lower lane.
    // It is deliberately narrower than the gap between the left/right control clusters.
    if (name === 'gamepad') {
      add({ id: 'centerLook', kind: 'look', cls: 'look center-look', label: 'DRAG TO LOOK', tap: false, fs: 0.16 }, M(-25, 69, 50, 25));
    } else {
      add({ id: 'centerLook', kind: 'look', cls: 'look center-look', label: 'DRAG TO LOOK', tap: false, fs: 0.16 }, M(-82.5, 58, 165, 8));
    }
    pad('LT', 'LT', L(4, 3, 30, 9), { analog: true, sub: c.LT });
    pad('LB', 'LB', L(4, 14, 30, 8), { sub: c.LB });
    pad('RT', 'RT', R(4, 3, 30, 9), { analog: true, sub: c.RT });
    pad('RB', 'RB', R(4, 14, 30, 8), { sub: c.RB });
    pad('BACK', 'BACK', M(-18, 25, 18, 7), { sub: c.BACK });
    pad('START', 'START', M(5, 25, 18, 7), { sub: c.START });
    add({ id: 'driveMode', kind: 'ui', ui: 'drive', cls: 'ui mode-switch mode-logo', icon: 'car', label: '' }, R(3, 24, 11, 10));
    // Larger thumbsticks sit low on both sides. Their 34-unit diameter is
    // deliberately much larger than the 12-unit action buttons.
    add({ id: 'L', kind: 'stick', cls: 'stick', pad: 'L', cap: c.L }, L(5, 70, 34, 30));
    add({ id: 'R', kind: 'stick', cls: 'stick', pad: 'R', cap: c.R }, R(5, 70, 34, 30));
    // Larger diamond buttons with wider centre spacing keep their rotated hit
    // boxes separate. D-pad sits mid-left; ABXY sits mid-right.
    cross(CL, 1, 55, 40, 14.5, 12, { up: ['UP', '▲', c.UP], left: ['LEFT', '◀', c.LEFT], right: ['RIGHT', '▶', c.RIGHT], down: ['DOWN', '▼', c.DOWN] });
    cross(CR, -1, 49, 40, 14.5, 12, { up: ['Y', 'Y', c.Y, 'Y'], left: ['X', 'X', c.X, 'X'], right: ['B', 'B', c.B, 'B'], down: ['A', 'A', c.A, 'A'] });
    // Stick-click buttons are kept in the open lower-centre gap.
    if (name === 'gamepad') {
      pad('L3', 'L3', L(16, 62, 18, 7), { sub: c.L3 });
      pad('R3', 'R3', R(16, 62, 18, 7), { sub: c.R3 });
    } else {
      pad('L3', 'L3', L(18, 24, 16, 7), { sub: c.L3 });
      pad('R3', 'R3', R(18, 24, 16, 7), { sub: c.R3 });
    }
  };

  if (name === 'gamepad') {
    padLayout({});
  } else if (name === 'mcpad') {
    // Minecraft controller map
    padLayout({ LT: 'USE / PLACE', RT: 'ATTACK', LB: '◀ HOTBAR', RB: 'HOTBAR ▶', BACK: 'PLAYERS', START: 'MENU',
      L3: 'RUN', L: 'MOVE', R: 'LOOK', LEFT: 'EMOTE', DOWN: 'DROP', RIGHT: 'CHAT', Y: 'INV', X: 'CRAFT', B: 'SNEAK', A: 'JUMP' });
  } else if (name === 'driving') {
    // GTA V driving map: keep steering and compact XYAB; camera touch surface
    // is limited to the central gap between the left and right action clusters.
    topBar();
    add({ id: 'driveMode', kind: 'ui', ui: 'drive', cls: 'ui mode-switch mode-logo active', icon: 'gamepad', label: '' }, R(3, 24, 11, 10));
    add({ id: 'driveLook', kind: 'look', cls: 'look drive-look', label: 'DRAG TO LOOK', tap: false, fs: 0.18 }, M(-34, 49, 68, 32));
    pad('LB', 'LB', L(3, 3, 40, 13), { sub: 'DRIVE-BY' });
    pad('RB', 'RB', R(3, 3, 40, 13), { sub: 'HANDBRAKE' });
    pad('BACK', 'BACK', M(-31, 24, 30, 11), { sub: 'CAMERA' });
    pad('START', 'START', M(1, 24, 30, 11), { sub: 'PAUSE' });
    cross(CL, 1, 28, 44, 14.5, 12, { up: ['UP', '▲', 'PHONE'], left: ['LEFT', '◀', 'RADIO'], right: ['RIGHT', '▶', 'LIGHTS'], down: ['DOWN', '▼', 'CHAR.'] });
    // XYAB now occupy the former pedal side; compact diamond spacing keeps
    // each red touch target distinct while reducing the visual gap by ~50%.
    cross(CR, -1, 38, 61, 13.5, 12, { up: ['Y', 'Y', 'EXIT', 'Y'], left: ['X', 'X', 'WEAPON', 'X'], right: ['B', 'B', 'CINEMA', 'B'], down: ['A', 'A', 'H-BRAKE', 'A'] });
    add({ id: 'R', kind: 'stick', cls: 'stick cap-out', pad: 'R', cap: 'LOOK' }, CL(54, 24, 16, 16));
    pad('L3', 'L3', L(18, 24, 16, 8), { sub: 'HORN' });
    pad('R3', 'R3', R(18, 24, 16, 8), { sub: 'BEHIND' });
    add({ id: 'steer', kind: 'steer', cls: 'steer', label: 'STEER', pad: 'L' }, L(5, 74, 54, 20));
  } else if (name === 'minecraft') {
    lookArea(LAYOUTS.minecraft.lookTap);
    topBar();
    // Left thumb is reserved for movement. High-frequency actions are grouped on the right.
    add({ id: 'move', kind: 'stick', cls: 'stick mc-move', keys: true }, L(6, 50, 40, 40));
    key('inv', 'INV', 'e', L(3, 3, 22, 12), { cls: 'btn mc-utility' });
    key('drop', 'DROP', 'q', L(27, 3, 22, 12), { cls: 'btn mc-utility' });
    key('view', 'F5', 'f5', L(3, 17, 22, 12), { cls: 'btn mc-utility' });
    key('esc', 'ESC', 'esc', R(3, 3, 22, 12), { cls: 'btn mc-utility' });
    toggle('sneak', 'SNEAK', 'shift', R(3, 27, 23, 11));
    toggle('sprint', 'SPRINT', 'ctrl', R(29, 27, 23, 11));
    mouse('attack', 'HIT', 'left', R(3, 48, 22, 22), { cls: 'btn mc-hit' });
    mouse('use', 'PLACE', 'right', R(3, 72, 22, 22), { cls: 'btn mc-place' });
    key('jump', 'JUMP', 'space', R(30, 62, 24, 24), { cls: 'btn mc-jump' });
    // Hotbar remains along the lower edge for quick thumb selection.
    for (let i = 0; i < 9; i++) key('slot' + (i + 1), String(i + 1), String(i + 1), M(-45 + i * 10, 88, 9.4, 10), { cls: 'btn tight mc-slot' });
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
    add({ id: 'move', kind: 'stick', cls: 'stick', keys: true }, L(6, 50, 40, 40));
    mouse('fire', 'FIRE', 'left', R(3, 48, 22, 22));
    mouse('aim', 'AIM', 'right', R(3, 72, 22, 22));
    key('jump', 'JUMP', 'space', R(30, 62, 24, 24));
  }
  return items;
}
// LAYOUT-END

const $ = id => document.getElementById(id);
const SKIN = 'redline-controller-v18-group-move-editor';
const BODY_SVG = '<svg class="body" viewBox="0 0 190 100" preserveAspectRatio="none" aria-hidden="true">' +
  '<defs><linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--body1)"/><stop offset="1" style="stop-color:var(--body2)"/></linearGradient>' +
  '<pattern id="ridge" width="10" height="1.7" patternUnits="userSpaceOnUse"><rect width="10" height="0.3" style="fill:var(--ridge)"/></pattern></defs>' +
  '<path d="M0,26 C0,12 8,5 24,5 L66,5 C78,5 84,12 95,12 C106,12 112,5 124,5 L166,5 C182,5 190,12 190,26 L190,100 L0,100 Z" fill="url(#bg1)" style="stroke:var(--edge)" stroke-width="1.2" vector-effect="non-scaling-stroke"/>' +
  '<path d="M0,26 C0,12 8,5 24,5 L66,5 C78,5 84,12 95,12 C106,12 112,5 124,5 L166,5 C182,5 190,12 190,26 L190,100 L0,100 Z" fill="url(#ridge)"/>' +
  '<ellipse cx="40" cy="64" rx="46" ry="44" style="fill:var(--lobe)" opacity=".8"/>' +
  '<ellipse cx="150" cy="64" rx="46" ry="44" style="fill:var(--lobe)" opacity=".8"/></svg>';
const padEl = $('pad');
const store = {
  get(k, d) { try { const v = localStorage.getItem('gp.' + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('gp.' + k, v); } catch (e) {} },
};
const S = {
  layout: store.get('layout', 'gamepad'),
  sens: parseFloat(store.get('sens', '1.5')) || 1.5,
  gain: parseFloat(store.get('gain', '1.3')) || 1.3,
  vib: store.get('vib', '1') === '1',
  tap: store.get('tap', '1') === '1',
  theme: store.get('theme', 'dark') === 'light' ? 'light' : 'dark',
};
function applyTheme() {
  document.documentElement.setAttribute('data-theme', S.theme);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', S.theme === 'light' ? '#c4c5c9' : '#060607');
}
if (!LAYOUTS[S.layout]) S.layout = 'gamepad';
applyTheme();

let legacy = false, legacyTimer = 0;
let els = {}, ticks = [], ws = null, authed = false, caps = { pad: null, kbm: null }, rtt = null, failures = 0;
let statusText = 'connecting...', statusOk = false;
let pin = '';
try {
  const q = new URLSearchParams(location.search).get('pin');
  if (q) { pin = q; store.set('pin', q); history.replaceState(null, '', location.pathname); }
} catch (e) {}
if (!pin) pin = store.get('pin', '');

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const buzz = () => { if (S.vib) { try { navigator.vibrate && navigator.vibrate(10); } catch (e) {} } };

// ---------- connection ----------
function setStatus(t, ok) {
  statusText = t; statusOk = !!ok;
  const s = els.status; if (s) { s.textContent = t; s.classList.toggle('ok', statusOk); }
}
function refreshStatus() {
  if (!authed) return;
  const need = LAYOUTS[S.layout].out;
  if (!caps[need]) setStatus(need === 'pad' ? 'no controller driver on PC' : 'no keyboard/mouse on PC', false);
  else if (legacy) setStatus('connected - old PC program', true);
  else setStatus('connected' + (rtt !== null ? ' ' + rtt + ' ms' : '') + ' \u00B7 ' + SKIN.split(' ')[0], true);
}
const send = o => {
  if (ws && ws.readyState === 1 && (authed || o.t === 'auth' || o.t === 'p')) ws.send(JSON.stringify(o));
};
function askPin() {
  const p = prompt('Enter the PIN shown in the PC window');
  if (p === null) { setStatus('PIN needed - tap here', false); return false; }
  pin = p.trim(); return true;
}
function sendAuth() { send({ t: 'auth', pin }); }
function connect() {
  if (location.protocol.indexOf('http') !== 0) { setStatus('open via PC address', false); return; }
  let sock;
  try { sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
  catch (e) { retry(); return; }
  ws = sock; authed = false; legacy = false;
  function armLegacy() {                 // an old PC program never answers the login: keep working, but say so
    clearTimeout(legacyTimer);
    legacyTimer = setTimeout(() => { if (!authed && ws && ws.readyState === 1) { legacy = true; authed = true; caps = { pad: 'old PC program', kbm: null }; refreshStatus(); } }, 2500);
  }
  sock.onopen = () => { failures = 0; setStatus('logging in...', false); if (pin) sendAuth(); else if (askPin()) sendAuth(); armLegacy(); };
  sock.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.t === 'auth') {
      clearTimeout(legacyTimer);
      if (d.ok) { authed = true; caps = { pad: d.pad, kbm: d.kbm }; store.set('pin', pin); send({ t: 'reset' }); refreshStatus(); }
      else if (d.locked) setStatus('wrong PIN - wait 1 min', false);
      else if (askPin()) sendAuth();
    } else if (d.t === 'p') { rtt = Math.round(performance.now() - d.n); refreshStatus(); }
  };
  sock.onerror = () => { try { sock.close(); } catch (e) {} };
  sock.onclose = () => { if (ws === sock) { authed = false; legacy = false; retry(); } };
}
function retry() {
  failures++;
  setStatus(failures > 4 ? 'cannot reach PC' : 'reconnecting...', false);
  setTimeout(connect, 1000);
}
setInterval(() => send({ t: 'p', n: performance.now() }), 2000);

// ---------- actions ----------
function fire(it, v) {
  if (it.pad !== undefined) send(it.analog ? { t: 'tr', k: it.pad, v } : { t: 'b', k: it.pad, v });
  else if (it.key !== undefined) send({ t: 'k', k: it.key, v });
  else if (it.mouse !== undefined) send({ t: 'mb', k: it.mouse, v });
}
function releaseAll() { send({ t: 'reset' }); }

function bindHold(el, it) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch (x) {}
    if (!el.classList.contains('on')) { el.classList.add('on'); buzz(); fire(it, 1); }
  });
  const up = () => { if (el.classList.contains('on')) { el.classList.remove('on'); fire(it, 0); } };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
}
function bindToggle(el, it) {
  let on = false;
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); on = !on; el.classList.toggle('on', on); buzz(); fire(it, on ? 1 : 0);
  });
}
function bindStick(el, it) {
  const nub = document.createElement('div'); nub.className = 'nub'; el.appendChild(nub);
  const d = it.w * 0.4;
  Object.assign(nub.style, { width: d + 'px', height: d + 'px', marginLeft: -d / 2 + 'px', marginTop: -d / 2 + 'px' });
  const st = { pid: null, x: 0, y: 0, sx: null, sy: null, keys: {} };
  const draw = () => { const rad = el.getBoundingClientRect().width / 2; nub.style.transform = 'translate(' + st.x * rad * 0.6 + 'px,' + st.y * rad * 0.6 + 'px)'; };
  const move = e => {
    const r = el.getBoundingClientRect(), rad = r.width / 2;
    let x = (e.clientX - (r.left + rad)) / rad, y = (e.clientY - (r.top + rad)) / rad;
    x *= S.gain; y *= S.gain;
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    st.x = x; st.y = y; draw();
  };
  const end = e => { if (e && st.pid !== null && e.pointerId !== st.pid) return; st.pid = null; st.x = 0; st.y = 0; draw(); };
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); if (st.pid !== null) return;
    st.pid = e.pointerId; try { el.setPointerCapture(e.pointerId); } catch (x) {} buzz(); move(e);
  });
  el.addEventListener('pointermove', e => { if (e.pointerId === st.pid) move(e); });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  ticks.push(() => {
    if (it.keys) {                                   // digital WASD
      const T = 0.22, want = { w: st.y < -T, s: st.y > T, a: st.x < -T, d: st.x > T };
      for (const k in want) if (want[k] !== !!st.keys[k]) { st.keys[k] = want[k]; send({ t: 'k', k, v: want[k] ? 1 : 0 }); }
    } else {                                         // analog stick
      const x = +st.x.toFixed(3), y = +st.y.toFixed(3);
      if (x !== st.sx || y !== st.sy) { st.sx = x; st.sy = y; send({ t: 's', k: it.pad, x, y }); }
    }
  });
}
function bindSteer(el, it) {
  const knob = document.createElement('div'); knob.className = 'knob'; el.appendChild(knob);
  let pid = null, x = 0, sx = null;
  const upd = e => {
    const r = el.getBoundingClientRect();
    x = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2 * 0.85 / S.gain), -1, 1);
    knob.style.left = (50 + x * 42) + '%';
  };
  el.addEventListener('pointerdown', e => { e.preventDefault(); if (pid !== null) return; pid = e.pointerId; try { el.setPointerCapture(pid); } catch (z) {} buzz(); upd(e); });
  el.addEventListener('pointermove', e => { if (e.pointerId === pid) upd(e); });
  const end = e => { if (e.pointerId !== pid) return; pid = null; x = 0; knob.style.left = '50%'; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  ticks.push(() => { const v = +x.toFixed(3); if (v !== sx) { sx = v; send({ t: 's', k: it.pad, x: v, y: 0 }); } });
}
function bindPedal(el, it) {
  const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = it.label;
  const fill = document.createElement('div'); fill.className = 'fill';
  el.textContent = ''; el.appendChild(fill); el.appendChild(lbl);
  let pid = null, v = 0, sv = 0;
  const upd = e => {
    const r = el.getBoundingClientRect(), rel = clamp((e.clientY - r.top) / r.height, 0, 1);
    v = +(0.3 + 0.7 * (1 - rel)).toFixed(2); fill.style.height = (v * 100) + '%';
  };
  el.addEventListener('pointerdown', e => { e.preventDefault(); if (pid !== null) return; pid = e.pointerId; try { el.setPointerCapture(pid); } catch (z) {} buzz(); upd(e); });
  el.addEventListener('pointermove', e => { if (e.pointerId === pid) upd(e); });
  const end = e => { if (e.pointerId !== pid) return; pid = null; v = 0; fill.style.height = '0'; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  ticks.push(() => { if (v !== sv) { sv = v; send({ t: 'tr', k: it.pad, v }); } });
}
function bindLook(el, it) {
  const useTap = it.tap && S.tap;
  let pid = null, lx = 0, ly = 0, px = 0, py = 0, rx = 0, ry = 0, t0 = 0, dist = 0, holding = false, timer = 0;
  el.addEventListener('pointerdown', e => {
    if (pid !== null) return;
    pid = e.pointerId; try { el.setPointerCapture(pid); } catch (z) {}
    lx = e.clientX; ly = e.clientY; dist = 0; t0 = performance.now(); holding = false;
    if (useTap) timer = setTimeout(() => { if (pid !== null && dist < 10) { holding = true; send({ t: 'mb', k: 'left', v: 1 }); buzz(); } }, 320);
  });
  el.addEventListener('pointermove', e => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    dist += Math.abs(dx) + Math.abs(dy); px += dx; py += dy;
  });
  const end = e => {
    if (e.pointerId !== pid) return;
    pid = null; clearTimeout(timer);
    if (holding) { holding = false; send({ t: 'mb', k: 'left', v: 0 }); }
    else if (useTap && dist < 10 && performance.now() - t0 < 250) {
      send({ t: 'mb', k: 'left', v: 1 }); setTimeout(() => send({ t: 'mb', k: 'left', v: 0 }), 40);
    }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  ticks.push(() => {
    if (!px && !py) return;
    const mx = px * S.sens + rx, my = py * S.sens + ry, ix = Math.trunc(mx), iy = Math.trunc(my);
    rx = mx - ix; ry = my - iy; px = 0; py = 0;
    if (ix || iy) send({ t: 'm', dx: ix, dy: iy });
  });
}
async function goFullscreen() {
  try { await document.documentElement.requestFullscreen(); if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) {}
  try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) {}
}

// ---------- build the current layout ----------
function build() {
  releaseAll();
  padEl.innerHTML = ''; els = {}; ticks = [];
  padEl.className = '';
  if (LAYOUTS[S.layout].out === 'pad') padEl.innerHTML = BODY_SVG;
  for (const it of buildLayout(S.layout, innerWidth, innerHeight)) {
    const el = document.createElement('div');
    el.className = 'it ' + (it.cls || ''); el.dataset.id = it.id;
    const tx = document.createElement('span'); tx.className = 't';
    if (it.icon === 'car') tx.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 19l2-7a3 3 0 0 1 3-2h12a3 3 0 0 1 3 2l2 7v6h-3v-3H8v3H5z"/><path d="M8 17h16M11 10l2-4h6l2 4"/><circle cx="10" cy="19" r="1.5"/><circle cx="22" cy="19" r="1.5"/></svg>';
    else if (it.icon === 'gamepad') tx.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 11h14a5 5 0 0 1 4.8 6.4l-1.2 4a3 3 0 0 1-4.8 1.4l-3-2.4h-4l-3 2.4A3 3 0 0 1 7 21.4l-1.8-4A5 5 0 0 1 9 11z"/><path d="M11 14v6M8 17h6"/><circle cx="21" cy="16" r="1"/><circle cx="24" cy="18" r="1"/></svg>';
    else tx.textContent = it.label || '';
    if (it.sub) { const sm = document.createElement('small'); sm.textContent = it.sub; tx.appendChild(sm); }
    el.appendChild(tx);
    if (it.cap) el.dataset.cap = it.cap;
    Object.assign(el.style, { left: it.x + 'px', top: it.y + 'px', width: it.w + 'px', height: it.h + 'px' });
    el.style.fontSize = clamp(Math.min(it.w, it.h) * (it.fs || 0.36), 9, 20) + 'px';
    padEl.appendChild(el); els[it.id] = el;
    if (it.kind === 'btn') bindHold(el, it);
    else if (it.kind === 'toggle') bindToggle(el, it);
    else if (it.kind === 'stick') bindStick(el, it);
    else if (it.kind === 'steer') bindSteer(el, it);
    else if (it.kind === 'pedal') bindPedal(el, it);
    else if (it.kind === 'look') bindLook(el, it);
    else if (it.ui === 'menu') el.addEventListener('click', openMenu);
    else if (it.ui === 'fs') el.addEventListener('click', goFullscreen);
    else if (it.ui === 'drive') el.addEventListener('click', () => { S.layout = S.layout === 'driving' ? 'gamepad' : 'driving'; store.set('layout', S.layout); build(); });
    else if (it.ui === 'status') el.addEventListener('click', () => { if (!authed && askPin()) sendAuth(); });
  }
  applyGamepadPositions();
  setStatus(statusText, statusOk);
  refreshStatus();
}
(function loop() { for (const f of ticks) f(); requestAnimationFrame(loop); })();

// ---------- menu ----------
function renderLayouts() {
  const box = $('layouts'); box.innerHTML = '';
  for (const name in LAYOUTS) {
    const b = document.createElement('button');
    b.className = 'lay' + (name === S.layout ? ' sel' : '');
    b.innerHTML = '';
    b.appendChild(document.createTextNode(LAYOUTS[name].title));
    const s = document.createElement('small'); s.textContent = LAYOUTS[name].note; b.appendChild(s);
    b.onclick = () => { S.layout = name; store.set('layout', name); renderLayouts(); };
    box.appendChild(b);
  }
}
function openMenu() {
  releaseAll(); renderLayouts(); renderTheme();
  $('sens').value = S.sens; $('sensv').textContent = S.sens.toFixed(1) + 'x';
  $('gain').value = S.gain; $('gainv').textContent = S.gain.toFixed(1) + 'x';
  $('vib').checked = S.vib; $('tap').checked = S.tap;
  $('info').textContent = 'Skin ' + SKIN + '. ' + (authed ? ('PC output - controller: ' + (caps.pad || 'not available') + '; keyboard/mouse: ' + (caps.kbm || 'not available')) : 'Not connected to the PC yet');
  $('menu').classList.remove('hide');
}
function closeMenu() { $('menu').classList.add('hide'); build(); }
$('sens').oninput = e => { S.sens = parseFloat(e.target.value); $('sensv').textContent = S.sens.toFixed(1) + 'x'; store.set('sens', S.sens); };
function renderTheme() { $('thDark').classList.toggle('pri', S.theme === 'dark'); $('thLight').classList.toggle('pri', S.theme === 'light'); }
$('thDark').onclick = () => { S.theme = 'dark'; store.set('theme', 'dark'); applyTheme(); renderTheme(); };
$('thLight').onclick = () => { S.theme = 'light'; store.set('theme', 'light'); applyTheme(); renderTheme(); };
$('gain').oninput = e => { S.gain = parseFloat(e.target.value); $('gainv').textContent = S.gain.toFixed(1) + 'x'; store.set('gain', S.gain); };
$('vib').onchange = e => { S.vib = e.target.checked; store.set('vib', S.vib ? '1' : '0'); };
$('tap').onchange = e => { S.tap = e.target.checked; store.set('tap', S.tap ? '1' : '0'); };
$('close').onclick = closeMenu;
$('forget').onclick = () => { pin = ''; store.set('pin', ''); $('info').textContent = 'PIN forgotten - reload the page to enter it again'; };

// ---------- misc ----------
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
window.addEventListener('blur', releaseAll);
let gamepadEditMode = false;
const GAMEPAD_POS_KEY = 'gp.gamepad.positions.v1';
function readGamepadPositions(){ try { return JSON.parse(localStorage.getItem(GAMEPAD_POS_KEY) || '{}'); } catch(e){ return {}; } }
function applyGamepadPositions(){
  if (S.layout !== 'gamepad') return;
  const saved = readGamepadPositions();
  for (const [id,p] of Object.entries(saved)) {
    const el = els[id]; if (!el || !p) continue;
    if (Number.isFinite(p.x)) el.style.left = (p.x * innerWidth) + 'px';
    if (Number.isFinite(p.y)) el.style.top = (p.y * innerHeight) + 'px';
    if (Number.isFinite(p.w)) el.style.width = (p.w * innerWidth) + 'px';
    if (Number.isFinite(p.h)) el.style.height = (p.h * innerHeight) + 'px';
    if (Number.isFinite(p.fsr)) el.style.fontSize = (Math.min(el.offsetWidth,el.offsetHeight) * p.fsr) + 'px';
  }
}
function addResizeHandles(){
  padEl.querySelectorAll('.it').forEach(el=>{
    if (['status','menu','fs'].includes(el.dataset.id)) return;
    if (!el.querySelector('.resize-grip')) {
      const grip=document.createElement('span'); grip.className='resize-grip'; grip.setAttribute('aria-label','Drag to resize');
      el.appendChild(grip);
    }
  });
}

let selectedResizeId = null;
function selectResizeTarget(el){
  if (!el || ['status','menu','fs'].includes(el.dataset.id)) return;
  padEl.querySelectorAll('.edit-selected').forEach(n=>n.classList.remove('edit-selected'));
  selectedResizeId = el.dataset.id;
  el.classList.add('edit-selected');
  $('sizeLabel').textContent = selectedResizeId + ' • ' + Math.round(el.offsetWidth) + '×' + Math.round(el.offsetHeight);
}
function persistControlSize(el){
  const p=readGamepadPositions(), id=el.dataset.id, rect=el.getBoundingClientRect();
  const fs=parseFloat(el.style.fontSize)||parseFloat(getComputedStyle(el).fontSize)||12;
  p[id]={...(p[id]||{}),x:rect.left/innerWidth,y:rect.top/innerHeight,
    w:rect.width/innerWidth,h:rect.height/innerHeight,
    fsr:fs/Math.max(1,Math.min(rect.width,rect.height))};
  try{localStorage.setItem(GAMEPAD_POS_KEY,JSON.stringify(p));}catch(e){}
  $('sizeLabel').textContent=id+' • '+Math.round(rect.width)+'×'+Math.round(rect.height);
}
function changeSelectedSize(factor){
  if(!gamepadEditMode || !selectedResizeId || !els[selectedResizeId]) {
    $('sizeLabel').textContent='Tap a control first'; return;
  }
  const el=els[selectedResizeId], r=padEl.getBoundingClientRect();
  const oldW=el.offsetWidth, oldH=el.offsetHeight;
  const min=34, maxW=Math.max(min,r.width*.42), maxH=Math.max(min,r.height*.78);
  const w=Math.max(min,Math.min(maxW,oldW*factor));
  const h=Math.max(min,Math.min(maxH,oldH*factor));
  el.style.width=w+'px'; el.style.height=h+'px';
  const fs=parseFloat(getComputedStyle(el).fontSize)||12;
  el.style.fontSize=Math.max(8,Math.min(34,fs*Math.min(w/oldW,h/oldH)))+'px';
  // Keep the resized control inside the screen.
  el.style.left=Math.max(0,Math.min(r.width-w,el.offsetLeft))+'px';
  el.style.top=Math.max(0,Math.min(r.height-h,el.offsetTop))+'px';
  persistControlSize(el);
}
$('sizeDown').addEventListener('click',()=>changeSelectedSize(.90));
$('sizeUp').addEventListener('click',()=>changeSelectedSize(1.10));

function setGamepadEditMode(on){
  gamepadEditMode = !!on && S.layout === 'gamepad';
  padEl.classList.toggle('editing-layout', gamepadEditMode);
  if (gamepadEditMode) addResizeHandles();
  else { padEl.querySelectorAll('.resize-grip').forEach(g=>g.remove()); padEl.querySelectorAll('.edit-selected').forEach(n=>n.classList.remove('edit-selected')); selectedResizeId=null; $('sizeLabel').textContent='Select a control'; }
  $('editGamepad').textContent = gamepadEditMode ? 'Finish editing' : 'Edit Gamepad layout';
  $('info').textContent = gamepadEditMode
    ? 'EDIT MODE: drag the centre to move; drag the bottom-right corner or right/bottom edge to resize. Use − / + for fine sizing. D-pad and red ABXY clusters move together.'
    : 'Gamepad layout editor ready.';
}
$('editGamepad').onclick = () => {
  if (S.layout !== 'gamepad') { $('info').textContent = 'Select Gamepad layout first, then edit it.'; return; }
  setGamepadEditMode(!gamepadEditMode);
};
$('resetGamepad').onclick = () => {
  try { localStorage.removeItem(GAMEPAD_POS_KEY); } catch(e) {}
  if (S.layout === 'gamepad') { build(); setGamepadEditMode(false); }
  $('info').textContent = 'Gamepad positions reset to defaults.';
};
let editDrag = null;
padEl.addEventListener('pointerdown', e => {
  if (!gamepadEditMode) return;
  const el = e.target.closest('.it');
  if (!el || ['status','menu','fs'].includes(el.dataset.id)) return;

  const rect = el.getBoundingClientRect();
  const edge = 30; // generous touch target for phone fingers
  const inResizeZone =
    (e.clientX >= rect.right-edge && e.clientY >= rect.bottom-edge) ||
    (e.clientX >= rect.right-edge && e.clientY >= rect.top+edge) ||
    (e.clientY >= rect.bottom-edge && e.clientX >= rect.left+edge);
  const grip = e.target.closest('.resize-grip');
  const mode = (grip || inResizeZone) ? 'resize' : 'move';

  e.preventDefault(); e.stopPropagation();
  const id=el.dataset.id;
  selectResizeTarget(el);
  const leftGroup=['UP','LEFT','RIGHT','DOWN'];
  const rightGroup=['Y','X','B','A'];
  const group = mode==='move' && leftGroup.includes(id) ? leftGroup :
                (mode==='move' && rightGroup.includes(id) ? rightGroup : [id]);
  const members=group.map(k=>els[k]).filter(Boolean);
  const snapshots=members.map(node=>({el:node,id:node.dataset.id,left:node.offsetLeft,top:node.offsetTop,width:node.offsetWidth,height:node.offsetHeight}));
  editDrag = {el, id, pid:e.pointerId, mode, group:snapshots,
    dx:e.clientX-rect.left, dy:e.clientY-rect.top, startX:e.clientX, startY:e.clientY,
    startW:rect.width, startH:rect.height, startFont:parseFloat(getComputedStyle(el).fontSize)||12,
    square: Math.abs(rect.width-rect.height) < Math.max(rect.width,rect.height)*.18};
  el.classList.add('resize-active');
  if (mode==='resize') el.classList.add('resizing');
  try { el.setPointerCapture(e.pointerId); } catch(_){}
}, true);
padEl.addEventListener('pointermove', e => {
  if (!gamepadEditMode || !editDrag || e.pointerId!==editDrag.pid) return;
  e.preventDefault(); e.stopPropagation();
  const r = padEl.getBoundingClientRect(), d=editDrag;
  if (d.mode === 'resize') {
    // Resize from the bottom-right handle. Square controls stay square; wide surfaces can resize freely.
    const dx=e.clientX-d.startX, dy=e.clientY-d.startY;
    const min=34, maxW=Math.max(min,r.width*.42), maxH=Math.max(min,r.height*.78);
    let w=d.startW+dx, h=d.startH+dy;
    if (d.square) {
      const delta=(dx+dy)/2;
      w=d.startW+delta; h=d.startH+delta;
    }
    w=Math.max(min,Math.min(maxW,w)); h=Math.max(min,Math.min(maxH,h));
    d.el.style.width=w+'px'; d.el.style.height=h+'px';
    const scale=Math.min(w/d.startW,h/d.startH);
    d.el.style.fontSize=Math.max(8,Math.min(34,d.startFont*scale))+'px';
    $('sizeLabel').textContent=d.id+' • '+Math.round(w)+'×'+Math.round(h);
  } else {
    const x = Math.max(0, Math.min(r.width-d.el.offsetWidth, e.clientX-r.left-d.dx));
    const y = Math.max(0, Math.min(r.height-d.el.offsetHeight, e.clientY-r.top-d.dy));
    const dx=x-d.group[0].left, dy=y-d.group[0].top;
    for (const m of d.group) {
      m.el.style.left=Math.max(0,Math.min(r.width-m.width,m.left+dx))+'px';
      m.el.style.top=Math.max(0,Math.min(r.height-m.height,m.top+dy))+'px';
    }
  }
}, true);
const finishEditDrag = (e) => {
  if (!editDrag || (e && e.pointerId!==undefined && e.pointerId!==editDrag.pid)) return;
  const p=readGamepadPositions(), d=editDrag;
  const saveNode=(node,id)=>{const rect=node.getBoundingClientRect(),fs=parseFloat(node.style.fontSize)||parseFloat(getComputedStyle(node).fontSize)||12;p[id]={x:rect.left/innerWidth,y:rect.top/innerHeight,w:rect.width/innerWidth,h:rect.height/innerHeight,fsr:fs/Math.max(1,Math.min(rect.width,rect.height))};};
  if(d.mode==='resize') saveNode(d.el,d.id); else for(const m of d.group) saveNode(m.el,m.id);
  try { localStorage.setItem(GAMEPAD_POS_KEY, JSON.stringify(p)); } catch(e) {}
  d.el.classList.remove('resizing','resize-active');
  $('sizeLabel').textContent=d.id+' • '+Math.round(d.el.offsetWidth)+'×'+Math.round(d.el.offsetHeight);
  editDrag=null;
};
padEl.addEventListener('pointerup', finishEditDrag, true);
padEl.addEventListener('pointercancel', finishEditDrag, true);
padEl.addEventListener('lostpointercapture', finishEditDrag, true);
let rz = 0;
addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if ($('menu').classList.contains('hide')) build(); }, 150); });
document.addEventListener('contextmenu', e => e.preventDefault());
build();
connect();
</script>
</body>
</html>

"""

# ----------------------------------------------------------------------------
# Key table (whitelist: only these keys can ever be pressed from the phone)
# ----------------------------------------------------------------------------
KEY_VK = {c: ord(c.upper()) for c in "abcdefghijklmnopqrstuvwxyz0123456789"}
KEY_VK.update({"space": 0x20, "shift": 0xA0, "ctrl": 0xA2, "tab": 0x09, "esc": 0x1B, "enter": 0x0D,
               "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27})
KEY_VK.update({f"f{i}": 0x6F + i for i in range(1, 13)})        # F1..F12
EXTENDED_VK = {0x26, 0x28, 0x25, 0x27}

MOUSE_FLAGS = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010), "middle": (0x0020, 0x0040)}


# ----------------------------------------------------------------------------
# Output backends
# ----------------------------------------------------------------------------
class DryPad:
    name = "dry run (prints only)"

    def __init__(self):
        self._last = 0.0

    def button(self, k, down):
        print(f"  pad button {k} {'down' if down else 'up'}", flush=True)

    def stick(self, k, x, y):
        now = time.time()
        if (x == 0 and y == 0) or now - self._last > 0.2:
            self._last = now
            print(f"  pad stick {k} x={x:+.2f} y={y:+.2f}", flush=True)

    def trigger(self, k, v):
        print(f"  pad trigger {k} {v:.2f}", flush=True)

    def reset(self):
        print("  pad reset", flush=True)


class DryKbm:
    name = "dry run (prints only)"

    def __init__(self):
        self._last = 0.0

    def key(self, name, down):
        print(f"  key {name} {'down' if down else 'up'}", flush=True)

    def move(self, dx, dy):
        now = time.time()
        if now - self._last > 0.2:
            self._last = now
            print(f"  mouse move dx={dx} dy={dy}", flush=True)

    def button(self, name, down):
        print(f"  mouse {name} {'down' if down else 'up'}", flush=True)

    def reset(self):
        print("  kbm reset", flush=True)


class XboxPad:
    """Virtual Xbox 360 controller via vgamepad + ViGEmBus (Windows)."""
    name = "virtual Xbox 360 controller (vgamepad)"

    def __init__(self):
        import vgamepad as vg  # raises if missing
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
        self.pad = vg.VX360Gamepad()  # raises if the ViGEmBus driver is missing

    def button(self, k, down):
        b = self.map.get(k)
        if b is None:
            return
        (self.pad.press_button if down else self.pad.release_button)(button=b)
        self.pad.update()

    def stick(self, k, x, y):
        fn = self.pad.left_joystick_float if k == "L" else self.pad.right_joystick_float
        fn(x_value_float=x, y_value_float=-y)          # screen y points down, gamepad y points up
        self.pad.update()

    def trigger(self, k, v):
        fn = self.pad.left_trigger_float if k == "LT" else self.pad.right_trigger_float
        fn(value_float=v)
        self.pad.update()

    def reset(self):
        self.pad.reset()
        self.pad.update()


def make_input_types():
    """Windows INPUT structures for SendInput. Fixed-width types, so sizes can be checked on any OS."""
    import ctypes
    WORD, DWORD, LONG, ULONG_PTR = ctypes.c_uint16, ctypes.c_uint32, ctypes.c_int32, ctypes.c_size_t

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", WORD), ("wScan", WORD), ("dwFlags", DWORD),
                    ("time", DWORD), ("dwExtraInfo", ULONG_PTR)]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", LONG), ("dy", LONG), ("mouseData", DWORD),
                    ("dwFlags", DWORD), ("time", DWORD), ("dwExtraInfo", ULONG_PTR)]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", DWORD), ("wParamL", WORD), ("wParamH", WORD)]

    class _U(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", DWORD), ("u", _U)]

    return INPUT, KEYBDINPUT, MOUSEINPUT


class WinKbm:
    """Keyboard + mouse through Windows SendInput. No extra software needed."""
    name = "keyboard + mouse (Windows SendInput)"

    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("keyboard/mouse output works on Windows only")
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
        flags = 0x0008 | (0 if down else 0x0002) | (0x0001 if vk in EXTENDED_VK else 0)   # SCANCODE | KEYUP | EXTENDED
        inp = self.INPUT(type=1)
        inp.u.ki = self.KI(0, scan, flags, 0, 0)
        self._send(inp)

    def move(self, dx, dy):
        inp = self.INPUT(type=0)
        inp.u.mi = self.MI(dx, dy, 0, 0x0001, 0, 0)                                          # MOVE (relative)
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


# ----------------------------------------------------------------------------
# State shared by all connections
# ----------------------------------------------------------------------------
PAD = None
KBM = None
PIN = ""
CLIENTS = 0
FAILS = {}


def pick_backends(dry):
    problems = []
    if dry:
        return DryPad(), DryKbm(), problems
    pad = kbm = None
    try:
        pad = XboxPad()
    except Exception as e:
        problems.append(f"Xbox controller output NOT available ({e}). Needs: pip install vgamepad "
                        "and the ViGEmBus driver (https://github.com/nefarius/ViGEmBus/releases).")
    try:
        kbm = WinKbm()
    except Exception as e:
        problems.append(f"Keyboard/mouse output NOT available ({e}).")
    if pad is None and kbm is None:
        problems.append("Nothing can be controlled on this PC, so input will only be printed (dry run).")
        return DryPad(), DryKbm(), problems
    return pad, kbm, problems


def load_pin(cli_pin):
    if cli_pin:
        return cli_pin
    try:
        p = PIN_FILE.read_text().strip()
        if p.isdigit() and 4 <= len(p) <= 12:
            return p
    except OSError:
        pass
    p = "".join(secrets.choice("0123456789") for _ in range(6))
    try:
        PIN_FILE.write_text(p + "\n")
    except OSError:
        pass
    return p


def pin_locked(ip):
    now = time.time()
    FAILS[ip] = [t for t in FAILS.get(ip, []) if now - t < 60]
    return len(FAILS[ip]) >= 5


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


# ----------------------------------------------------------------------------
# Tiny HTTP + WebSocket server (standard library only)
# ----------------------------------------------------------------------------
def http_response(status, body, ctype="text/html; charset=utf-8"):
    if isinstance(body, str):
        body = body.encode("utf-8")
    head = (f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n")
    return head.encode("latin1") + body


async def read_frame(reader):
    b1, b2 = await reader.readexactly(2)
    fin, op = bool(b1 & 0x80), b1 & 0x0F
    masked, ln = bool(b2 & 0x80), b2 & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", await reader.readexactly(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", await reader.readexactly(8))[0]
    if ln > 1_000_000:
        raise ValueError("frame too large")
    mask = await reader.readexactly(4) if masked else b""
    data = await reader.readexactly(ln) if ln else b""
    if masked:
        data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
    return fin, op, data


def frame(op, payload=b""):
    n = len(payload)
    if n < 126:
        head = bytes([0x80 | op, n])
    elif n < 65536:
        head = bytes([0x80 | op, 126]) + struct.pack(">H", n)
    else:
        head = bytes([0x80 | op, 127]) + struct.pack(">Q", n)
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
    writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                  f"Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").encode())
    await writer.drain()
    CLIENTS += 1
    authed = False
    buf = b""
    print(f"[+] phone connected: {ip}", flush=True)
    try:
        while True:
            fin, op, data = await asyncio.wait_for(read_frame(reader), 20)
            if op == 0x8:                           # close
                writer.write(frame(0x8))
                break
            if op == 0x9:                           # ping
                writer.write(frame(0xA, data))
                continue
            if op in (0x1, 0x0):                    # text / continuation
                buf += data
                if not fin:
                    continue
                msg, buf = buf, b""
                try:
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
                            print(f"[ok] {ip} logged in", flush=True)
                        else:
                            FAILS.setdefault(ip, []).append(time.time())
                            send_json(writer, {"t": "auth", "ok": False})
                            print(f"[!] wrong PIN from {ip}", flush=True)
                    elif authed:
                        dispatch(d)
                except Exception as e:
                    print("bad message:", e, flush=True)
            await writer.drain()
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, ValueError):
        pass
    finally:
        CLIENTS -= 1
        if CLIENTS <= 0:
            reset_all()                             # never leave keys / buttons stuck down
        print(f"[-] phone disconnected: {ip}", flush=True)


async def handle(reader, writer):
    peer = writer.get_extra_info("peername") or ("?", 0)
    sock = writer.get_extra_info("socket")
    try:
        if sock is not None:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        lines = head.decode("latin1").split("\r\n")
        _method, path, _ver = lines[0].split(" ", 2)
        headers = {}
        for ln in lines[1:]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        path = path.split("?", 1)[0]
        if path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
            await ws_session(reader, writer, headers, peer)
        elif path in ("/", "/index.html"):
            print(f"[page] served to {peer[0]}", flush=True)
            writer.write(http_response("200 OK", page_html()[0]))
        elif path == "/ping":
            writer.write(http_response("200 OK", "ok", "text/plain"))
        else:
            writer.write(http_response("404 Not Found", "not found", "text/plain"))
        await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


def page_html():
    """The phone page is the file gamepad.html next to this program (re-read on every request, so edits show
    after a refresh). Files named like gamepad*.html (e.g. 'gamepad (1).html' from a browser download) are
    considered too; the newest compatible one wins and old incompatible ones are ignored.
    Returns (html, description, ignored_files)."""
    ok, ignored = [], []
    for d in dict.fromkeys([HERE, pathlib.Path.cwd()]):
        try:
            files = sorted(d.glob("gamepad*.html"))
        except OSError:
            continue
        for f in files:
            try:
                txt = f.read_text(encoding="utf-8")
                mt = f.stat().st_mtime
            except (OSError, UnicodeDecodeError):
                continue
            (ok if ("LAYOUT-BEGIN" in txt and "const SKIN" in txt) else ignored).append((mt, f, txt))
    ign = [str(x[1]) for x in ignored]
    if ok:
        mt, f, txt = max(ok, key=lambda t: t[0])
        return txt.replace("__SKIN__", SKIN), f"{f}  (edited {time.strftime('%H:%M', time.localtime(mt))})", ign
    html = PAGE.replace("__SKIN__", SKIN)
    target = HERE / ("gamepad.html" if not (HERE / "gamepad.html").exists() else "gamepad_new.html")
    try:                                    # no usable file: create one so the link exists and can be edited
        target.write_text(html, encoding="utf-8")
        return html, f"{target}  (gamepad.html was missing or old - created a fresh one)", ign
    except OSError:
        return html, "built-in copy (could not create gamepad.html here)", ign


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


async def serve():
    try:
        server = await asyncio.start_server(handle, "0.0.0.0", PORT)
    except OSError as e:
        raise SystemExit(f"Cannot use port {PORT}: {e}\nClose the other copy of this program, "
                         "or set GAMEPAD_PORT to another number.")
    print(f"Phone Gamepad - skin {SKIN}")
    _html, _desc, _ign = page_html()
    print(f"Phone page (HTML) : {_desc}")
    for _f in _ign:
        print(f"                    ignored incompatible old file: {_f}")
    print(f"Controller output : {PAD.name if PAD else 'NOT AVAILABLE'}")
    print(f"Keyboard + mouse  : {KBM.name if KBM else 'NOT AVAILABLE'}")
    print("\nOn your phone, open Chrome and type ONE of these addresses")
    print("(phone and PC on the same Wi-Fi, or the PC joined to the phone's hotspot):\n")
    for ip in local_ips() or ["<your-pc-ip>"]:
        print(f"      http://{ip}:{PORT}")
    print(f"\n      PIN: {PIN}      (the phone asks for it once)")
    print("\nWaiting for the phone... (Ctrl+C to stop)\n", flush=True)
    async with server:
        await server.serve_forever()


def main():
    global PAD, KBM, PIN
    ap = argparse.ArgumentParser(description="Phone Gamepad PC receiver")
    ap.add_argument("--dry", action="store_true", help="only print input, control nothing")
    ap.add_argument("--pin", help="use this PIN (digits) instead of the saved one")
    a = ap.parse_args()
    PAD, KBM, problems = pick_backends(a.dry)
    PIN = load_pin(a.pin)
    for p in problems:
        print("[!]", p)
    if problems:
        print()
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        reset_all()


if __name__ == "__main__":
    main()
