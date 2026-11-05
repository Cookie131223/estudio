// Escritório 3D: mesas, monitores que mostram o que cada agente faz, telefone que toca
// quando alguém precisa de aprovação, mesa de reunião e cafeteira.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { buildCharacter } from './characters.js';

const CORRIDOR_X = -2.6;
const MEET = { x: -4.9, z: 0.9, r: 0.95, seatR: 1.42 };
const COFFEE = { x: -6.3, z: -3.75 };
const STATE_LABEL = { idle: 'Disponível', meeting: 'Reunião', assigned: 'Na fila', working: 'Trabalhando', waiting: 'Aprovação', done: 'Pronto', coffee: 'Café' };
const DESK_SLOTS = [
  [0.6, -2.6], [3.6, -2.6], [6.6, -2.6],
  [0.6, 1.4], [3.6, 1.4], [6.6, 1.4],
  [0.6, 4.6], [3.6, 4.6], [6.6, 4.6],
];
const MEET_ANGLES = [-100, -62, -24, 24, 62, 100, -138, 138, 180].map((d) => (d * Math.PI) / 180);

function canvasTex(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { canvas, ctx, tex };
}

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.02, ...o });

function box(w, h, d, material, r = 0) {
  const g = r ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(g, material);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

export function createOffice(container, { onAgentClick } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const labels = document.createElement('div');
  labels.className = 'office-labels';
  container.appendChild(labels);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15110e);
  scene.fog = new THREE.Fog(0x15110e, 26, 48);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(10.5, 10.5, 14.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0.6, 0.4, 0.2);
  controls.enableDamping = true;
  controls.minDistance = 6; controls.maxDistance = 30;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.minAzimuthAngle = -0.35; controls.maxAzimuthAngle = 1.25;
  controls.update();

  /* ------------------------------ luz ------------------------------ */
  scene.add(new THREE.HemisphereLight(0xffe9d2, 0x2a2018, 1.35));
  const sun = new THREE.DirectionalLight(0xfff1df, 1.6);
  sun.position.set(6, 14, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 10, bottom: -10, near: 1, far: 40 });
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  const lamp = new THREE.PointLight(0xffb070, 18, 9, 1.6); lamp.position.set(MEET.x, 3.2, MEET.z); scene.add(lamp);
  const windowLight = new THREE.PointLight(0x9cc8ff, 10, 10, 1.8); windowLight.position.set(-7.6, 2.5, -1); scene.add(windowLight);
  const signLight = new THREE.PointLight(0xffc89a, 12, 7, 1.8); signLight.position.set(3.4, 3.6, -4.2); scene.add(signLight);

  /* ------------------------------ sala ------------------------------ */
  const W = 8.6, D = 5.6;
  const floorTex = canvasTex(1024, 1024);
  {
    const c = floorTex.ctx;
    c.fillStyle = '#3a2a1f'; c.fillRect(0, 0, 1024, 1024);
    for (let y = 0; y < 1024; y += 64) {
      for (let x = (y / 64) % 2 ? -128 : 0; x < 1024; x += 256) {
        c.fillStyle = `hsl(24, 28%, ${17 + Math.random() * 5}%)`;
        c.fillRect(x + 2, y + 2, 252, 60);
      }
    }
    floorTex.tex.wrapS = floorTex.tex.wrapT = THREE.RepeatWrapping;
    floorTex.tex.repeat.set(3, 2);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, D * 2), std(0xffffff, { map: floorTex.tex, roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const wallM = std(0x2b241f, { roughness: 0.95 });
  const back = box(W * 2, 4.2, 0.2, wallM); back.position.set(0, 2.1, -D - 0.1); scene.add(back);
  const left = box(0.2, 4.2, D * 2, wallM); left.position.set(-W - 0.1, 2.1, 0); scene.add(left);
  const base1 = box(W * 2, 0.16, 0.06, std(0x1b1612)); base1.position.set(0, 0.08, -D + 0.02); scene.add(base1);

  // janelas
  const glass = new THREE.MeshStandardMaterial({ color: 0xc9defa, emissive: 0x9cc0ef, emissiveIntensity: 0.55, roughness: 0.2 });
  const frameM = std(0xe9e4dc);
  for (const z of [-3.2, -0.8]) {
    const fr = box(0.08, 1.9, 1.9, frameM); fr.position.set(-W + 0.02, 2.2, z); scene.add(fr);
    for (const [dy, dz] of [[-0.46, -0.46], [-0.46, 0.46], [0.46, -0.46], [0.46, 0.46]]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.84), glass);
      p.rotation.y = Math.PI / 2; p.position.set(-W + 0.07, 2.2 + dy, z + dz); scene.add(p);
    }
  }
  // quadros
  const poster = (z, draw) => {
    const t = canvasTex(256, 360); draw(t.ctx);
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.26), std(0xffffff, { map: t.tex, roughness: 0.9 }));
    p.rotation.y = Math.PI / 2; p.position.set(-W + 0.03, 2.3, z); scene.add(p);
  };
  poster(1.6, (c) => { c.fillStyle = '#efe6d8'; c.fillRect(0, 0, 256, 360); c.fillStyle = '#e8795a'; c.beginPath(); c.arc(128, 150, 70, 0, 7); c.fill(); c.fillStyle = '#2b241f'; c.fillRect(40, 270, 176, 10); });
  poster(2.9, (c) => { c.fillStyle = '#e4b54a'; c.fillRect(0, 0, 256, 360); c.fillStyle = '#3a6ff0'; c.fillRect(48, 50, 160, 22); c.fillStyle = '#2b241f'; c.fillRect(48, 110, 160, 190); });

  // placa com o nome do estúdio
  const sign = canvasTex(1024, 300);
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.05), new THREE.MeshBasicMaterial({ map: sign.tex }));
  signMesh.position.set(3.6, 3.0, -D + 0.02); scene.add(signMesh);
  const signBack = box(3.75, 1.2, 0.06, std(0x0f0d0c)); signBack.position.set(3.6, 3.0, -D - 0.01); scene.add(signBack);
  function drawSign(name) {
    const c = sign.ctx;
    c.fillStyle = '#100d0b'; c.fillRect(0, 0, 1024, 300);
    c.fillStyle = '#f4ece2'; c.textAlign = 'center'; c.textBaseline = 'middle';
    let size = 108; c.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
    while (c.measureText(name).width > 930 && size > 40) { size -= 6; c.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`; }
    c.fillText(name, 512, 125);
    c.fillStyle = '#b9a999'; c.font = '600 34px "Segoe UI", system-ui, sans-serif';
    c.fillText('E S T Ú D I O   D E   A G E N T E S', 512, 228);
    sign.tex.needsUpdate = true;
  }

  // TV com o quadro do time
  const board = canvasTex(640, 360);
  const tv = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.24), new THREE.MeshBasicMaterial({ map: board.tex }));
  tv.position.set(-0.6, 2.85, -D + 0.04); scene.add(tv);
  const tvFrame = box(2.32, 1.36, 0.07, std(0x0c0c0e)); tvFrame.position.set(-0.6, 2.85, -D + 0.0); scene.add(tvFrame);
  let boardData = { title: 'Time disponível', sub: 'Faça um pedido para começar', lines: [] };
  function drawBoard() {
    const c = board.ctx;
    c.fillStyle = '#0d1016'; c.fillRect(0, 0, 640, 360);
    c.fillStyle = '#7d8798'; c.font = '600 20px "Segoe UI", system-ui'; c.fillText('QUADRO DO TIME', 34, 50);
    c.fillStyle = '#eef2f7'; c.font = '700 40px "Segoe UI", system-ui'; c.fillText(boardData.title, 34, 112);
    c.fillStyle = '#9aa4b5'; c.font = '24px "Segoe UI", system-ui'; c.fillText(boardData.sub, 34, 152);
    (boardData.lines || []).slice(0, 4).forEach((l, i) => {
      c.fillStyle = l.color || '#e8795a'; c.fillRect(34, 192 + i * 40, 12, 12);
      c.fillStyle = '#d9dee6'; c.font = '22px "Segoe UI", system-ui'; c.fillText(l.text.slice(0, 44), 58, 204 + i * 40);
    });
    board.tex.needsUpdate = true;
  }

  // relógio
  const clockFace = canvasTex(256, 256);
  {
    const c = clockFace.ctx;
    c.fillStyle = '#f4efe7'; c.beginPath(); c.arc(128, 128, 124, 0, 7); c.fill();
    c.strokeStyle = '#2b241f'; c.lineWidth = 8; c.stroke();
    c.fillStyle = '#2b241f';
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; c.fillRect(128 + Math.sin(a) * 100 - 4, 128 - Math.cos(a) * 100 - 4, 8, 8); }
  }
  const clock = new THREE.Group();
  const cf = new THREE.Mesh(new THREE.CircleGeometry(0.5, 40), new THREE.MeshStandardMaterial({ map: clockFace.tex, roughness: 0.6 }));
  clock.add(cf);
  const handM = std(0x1e1915);
  const hourHand = box(0.05, 0.27, 0.02, handM); hourHand.geometry.translate(0, 0.12, 0);
  const minHand = box(0.035, 0.4, 0.02, handM); minHand.geometry.translate(0, 0.18, 0);
  hourHand.position.z = 0.02; minHand.position.z = 0.03;
  clock.add(hourHand, minHand);
  clock.position.set(7.1, 3.0, -D + 0.05); scene.add(clock);

  /* ---------------------------- mobília ---------------------------- */
  const wood = std(0x9a6a43, { roughness: 0.6 });
  const darkWood = std(0x5b3f2a, { roughness: 0.7 });
  const metal = std(0x2a2a30, { roughness: 0.4, metalness: 0.4 });

  // mesa de reunião redonda
  {
    const top = new THREE.Mesh(new THREE.CylinderGeometry(MEET.r, MEET.r, 0.08, 48), wood);
    top.position.set(MEET.x, 0.76, MEET.z); top.castShadow = top.receiveShadow = true; scene.add(top);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.32, 0.72, 20), darkWood);
    leg.position.set(MEET.x, 0.36, MEET.z); leg.castShadow = true; scene.add(leg);
    for (const [dx, dz, r] of [[-0.25, 0.1, 0.4], [0.3, -0.2, -0.3]]) {
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.24), std(0xf3efe8));
      paper.rotation.set(-Math.PI / 2, 0, r); paper.position.set(MEET.x + dx, 0.805, MEET.z + dz); scene.add(paper);
    }
  }
  // sofá + mesinha
  {
    const sofaM = std(0x3a4a66, { roughness: 0.9 });
    const seat = box(3.0, 0.42, 1.0, sofaM, 0.12); seat.position.set(-5.4, 0.32, 4.3); scene.add(seat);
    const backrest = box(3.0, 0.7, 0.3, sofaM, 0.12); backrest.position.set(-5.4, 0.7, 4.85); scene.add(backrest);
    for (const s of [-1, 1]) { const arm = box(0.3, 0.6, 1.0, sofaM, 0.1); arm.position.set(-5.4 + 1.55 * s, 0.45, 4.3); scene.add(arm); }
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 3.0), std(0x4a3426, { roughness: 1 }));
    rug.rotation.x = -Math.PI / 2; rug.position.set(-5.3, 0.005, 3.3); rug.receiveShadow = true; scene.add(rug);
    const ct = box(1.4, 0.06, 0.7, wood); ct.position.set(-5.4, 0.36, 3.15); scene.add(ct);
    for (const [x, z] of [[-6, 2.88], [-4.8, 2.88], [-6, 3.42], [-4.8, 3.42]]) { const l = box(0.06, 0.34, 0.06, darkWood); l.position.set(x, 0.17, z); scene.add(l); }
  }
  // cafeteira + bebedouro + planta
  {
    const counter = box(1.8, 0.9, 0.7, std(0xe9e3da)); counter.position.set(-6.3, 0.45, -4.85); scene.add(counter);
    const machine = box(0.45, 0.55, 0.4, std(0x1d1d22, { metalness: 0.3 }), 0.05); machine.position.set(-6.6, 1.18, -4.85); scene.add(machine);
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), new THREE.MeshBasicMaterial({ color: 0x64e08c })); light.position.set(-6.45, 1.3, -4.64); scene.add(light);
    for (const dx of [0.1, 0.32]) { const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.1, 12), std(0xffffff)); cup.position.set(-6.3 + dx, 0.95, -4.75); scene.add(cup); }
    const cooler = box(0.45, 1.1, 0.45, std(0xdfe3e6), 0.06); cooler.position.set(-7.75, 0.55, -2.2); scene.add(cooler);
    const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.45, 18), new THREE.MeshStandardMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.6, roughness: 0.1 }));
    bottle.position.set(-7.75, 1.33, -2.2); scene.add(bottle);
    const plant = (x, z, s = 1) => {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22 * s, 0.17 * s, 0.38 * s, 16), std(0xc8643c)); pot.position.set(x, 0.19 * s, z); pot.castShadow = true; scene.add(pot);
      for (let i = 0; i < 3; i++) {
        const leaf = new THREE.Mesh(new THREE.CapsuleGeometry(0.11 * s, 0.5 * s, 4, 10), std(0x3f8f4f, { roughness: 0.8 }));
        leaf.position.set(x + (i - 1) * 0.1 * s, 0.68 * s, z + ((i % 2) - 0.5) * 0.08); leaf.rotation.z = (i - 1) * 0.3; leaf.castShadow = true; scene.add(leaf);
      }
    };
    plant(-7.8, 5.0, 1.2); plant(8.0, -5.0, 1.1); plant(-4.6, -5.0, 0.9);
    const shelf = box(1.4, 2.2, 0.45, darkWood); shelf.position.set(-3.6, 1.1, -5.25); scene.add(shelf);
  }

  /* ----------------------------- mesas ----------------------------- */
  const desks = [];
  function makeDesk(i) {
    const [x, z] = DESK_SLOTS[i];
    const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
    const top = box(2.2, 0.08, 1.0, wood); top.position.y = 0.76; g.add(top);
    for (const [lx, lz] of [[-1.0, -0.42], [1.0, -0.42], [-1.0, 0.42], [1.0, 0.42]]) { const l = box(0.07, 0.72, 0.07, darkWood); l.position.set(lx, 0.36, lz); g.add(l); }
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 2.3), std(0x3b2c45, { roughness: 1 }));
    rug.rotation.x = -Math.PI / 2; rug.position.set(0, 0.004, -0.4); rug.receiveShadow = true; g.add(rug);
    // monitor
    const mon = new THREE.Group(); mon.position.set(-0.5, 0.8, -0.1); mon.rotation.y = 0.32; g.add(mon);
    const stand = box(0.06, 0.28, 0.06, metal); stand.position.y = 0.14; mon.add(stand);
    const foot = box(0.3, 0.02, 0.2, metal); foot.position.y = 0.01; mon.add(foot);
    const bezel = box(0.92, 0.58, 0.05, std(0x111114, { roughness: 0.3 })); bezel.position.y = 0.55; mon.add(bezel);
    const scr = canvasTex(384, 240);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.52), new THREE.MeshBasicMaterial({ map: scr.tex }));
    screen.position.set(0, 0.55, 0.027); mon.add(screen);
    // teclado, caneca, telefone
    const kb = box(0.5, 0.025, 0.16, std(0x2a2a30)); kb.position.set(0.3, 0.81, -0.05); g.add(kb);
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.13, 14), std(0xf2ede6)); mug.position.set(0.65, 0.865, 0.25); mug.castShadow = true; g.add(mug);
    const phone = new THREE.Group(); phone.position.set(0.85, 0.8, -0.15); g.add(phone);
    const pbase = box(0.26, 0.06, 0.2, std(0x22222a), 0.02); pbase.position.y = 0.03; phone.add(pbase);
    const handset = box(0.24, 0.05, 0.07, std(0x2c2c35), 0.02); handset.position.set(0, 0.085, -0.04); phone.add(handset);
    const ringLed = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), new THREE.MeshBasicMaterial({ color: 0x333333 }));
    ringLed.position.set(0.09, 0.07, 0.07); phone.add(ringLed);
    // cadeira
    const chairM = std(0x23232a);
    const cs = box(0.55, 0.08, 0.5, chairM, 0.03); cs.position.set(0.25, 0.45, -0.95); g.add(cs);
    const cp = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.4, 8), metal); cp.position.set(0.25, 0.22, -0.95); g.add(cp);
    const d = {
      i, x, z, group: g, screen: scr, phone, handset, ringLed,
      seat: { x: x + 0.25, z: z - 0.95 }, aisleZ: z - 1.7,
      lines: [], head: '', color: '#888', name: '', state: 'idle', caret: true,
    };
    desks.push(d);
    drawScreen(d);
    return d;
  }

  function drawScreen(d) {
    const c = d.screen.ctx;
    c.fillStyle = '#0b0e13'; c.fillRect(0, 0, 384, 240);
    if (!d.name) { d.screen.tex.needsUpdate = true; return; }
    c.fillStyle = d.color; c.fillRect(0, 0, 384, 30);
    c.fillStyle = '#0b0e13'; c.font = '700 17px "Segoe UI", system-ui'; c.fillText(d.name, 12, 21);
    c.textAlign = 'right'; c.font = '600 14px "Segoe UI", system-ui'; c.fillText(STATE_LABEL[d.state] || '', 372, 20); c.textAlign = 'left';
    c.font = '15px Consolas, "Cascadia Mono", monospace';
    const lines = d.lines.slice(-8);
    lines.forEach((l, i) => {
      c.fillStyle = l.type === 'error' ? '#ff8d7a' : l.type === 'tool' ? '#9fd6ff' : l.type === 'done' ? '#7be3a0' : '#c9d1dc';
      c.fillText(l.text.slice(0, 40), 12, 56 + i * 23);
    });
    if (d.state === 'working' && d.caret) {
      c.fillStyle = '#e8eef6'; c.fillRect(12 + (lines.length ? 0 : 0), 50 + lines.length * 23, 9, 16);
    }
    if (!lines.length && d.state !== 'working') {
      c.fillStyle = '#4b5361'; c.font = '600 16px "Segoe UI", system-ui'; c.fillText('Disponível', 12, 64);
    }
    d.screen.tex.needsUpdate = true;
  }

  /* ---------------------------- agentes ---------------------------- */
  const agents = new Map(); // id -> { ... }

  function meetingSpot(idx) {
    const a = MEET_ANGLES[idx % MEET_ANGLES.length];
    return { x: MEET.x + Math.cos(a) * MEET.seatR, z: MEET.z + Math.sin(a) * MEET.seatR, face: Math.atan2(MEET.x - (MEET.x + Math.cos(a)), MEET.z - (MEET.z + Math.sin(a))), entry: [], entryZ: MEET.z + Math.sin(a) * MEET.seatR, kind: 'meet' };
  }
  function deskSpot(d) { return { x: d.seat.x, z: d.seat.z, face: 0, entry: [{ x: d.seat.x, z: d.aisleZ }], entryZ: d.aisleZ, kind: 'desk' }; }
  function coffeeSpot(k) { return { x: COFFEE.x + (k % 3) * 0.55 - 0.5, z: COFFEE.z, face: Math.PI, entry: [], entryZ: COFFEE.z, kind: 'coffee' }; }

  function route(a, to) {
    const pts = [];
    const from = a.spot;
    if (from && from.entry.length) pts.push(...from.entry.slice().reverse().map((p) => ({ ...p })));
    const lastZ = pts.length ? pts[pts.length - 1].z : a.group.position.z;
    if (!(from && from.kind === to.kind && from.kind !== 'desk')) {
      pts.push({ x: CORRIDOR_X, z: lastZ });
      pts.push({ x: CORRIDOR_X, z: to.entryZ });
    }
    pts.push(...to.entry.map((p) => ({ ...p })));
    pts.push({ x: to.x, z: to.z });
    return pts;
  }

  function goTo(a, spot) {
    if (a.spot && a.spot.kind === spot.kind && Math.hypot(a.spot.x - spot.x, a.spot.z - spot.z) < 0.01 && !a.path.length) return;
    a.path = route(a, spot);
    a.spot = spot;
    a.arrived = false;
  }

  function addAgent(agent, idx) {
    const desk = desks[idx] || makeDesk(idx);
    const ch = buildCharacter(agent);
    const spot = deskSpot(desk);
    ch.position.set(spot.x, 0, spot.z);
    scene.add(ch);
    ch.traverse((o) => { o.userData.agentId = agent.id; });
    const tag = document.createElement('div');
    tag.className = 'otag';
    tag.innerHTML = `<i></i><span></span>`;
    tag.addEventListener('click', () => onAgentClick && onAgentClick(agent.id));
    const bubble = document.createElement('div');
    bubble.className = 'obubble';
    labels.append(tag, bubble);
    const a = {
      id: agent.id, agent, group: ch, desk, spot, path: [], arrived: true, state: 'idle', detail: '',
      tag, bubble, bubbleUntil: 0, idleSince: performance.now(), nextCoffee: performance.now() + 25000 + Math.random() * 60000,
      phase: Math.random() * 10, facing: 0, meetIdx: idx,
    };
    Object.assign(desk, { name: agent.name, color: agent.color, state: 'idle' });
    drawScreen(desk);
    agents.set(agent.id, a);
    updateTag(a);
    return a;
  }

  function removeAgent(id) {
    const a = agents.get(id);
    if (!a) return;
    scene.remove(a.group);
    a.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    a.tag.remove(); a.bubble.remove();
    Object.assign(a.desk, { name: '', lines: [], state: 'idle' });
    drawScreen(a.desk);
    agents.delete(id);
  }

  function updateTag(a) {
    a.tag.querySelector('span').textContent = a.agent.name;
    a.tag.querySelector('i').style.background = a.agent.color;
    a.tag.dataset.state = a.state;
  }

  function syncAgents(list) {
    const ids = new Set(list.map((x) => x.id));
    for (const id of [...agents.keys()]) if (!ids.has(id)) removeAgent(id);
    list.forEach((ag, idx) => {
      const a = agents.get(ag.id);
      const lookChanged = a && ['color', 'body', 'eyes', 'antenna'].some((k) => a.agent[k] !== ag[k]);
      if (!a || lookChanged || a.desk.i !== idx) {
        const prevState = a && a.state;
        if (a) removeAgent(ag.id);
        const n = addAgent(ag, idx);
        if (prevState) setState(ag.id, prevState);
      } else {
        a.agent = ag; a.desk.name = ag.name; drawScreen(a.desk); updateTag(a);
      }
    });
  }

  function say(id, text, ms = 3500) {
    const a = agents.get(id);
    if (!a) return;
    a.bubble.textContent = text;
    a.bubble.classList.add('show');
    a.bubbleUntil = ms ? performance.now() + ms : Infinity;
  }

  function setState(id, state, detail = '') {
    const a = agents.get(id);
    if (!a) return;
    const prev = a.state;
    a.state = state; a.detail = detail;
    a.desk.state = state;
    updateTag(a);
    if (state === 'meeting') {
      goTo(a, meetingSpot([...agents.keys()].indexOf(id)));
    } else if (state === 'coffee') {
      goTo(a, coffeeSpot([...agents.keys()].indexOf(id)));
    } else {
      goTo(a, deskSpot(a.desk));
    }
    if (state === 'waiting') say(id, '📞 Preciso da sua aprovação', 0);
    else if (prev === 'waiting') { a.bubble.classList.remove('show'); a.bubbleUntil = 0; }
    if (state === 'meeting' && prev !== 'meeting') say(id, detail || 'Indo pra reunião', 2500);
    if (state === 'done') say(id, detail || 'Pronto!', 2500);
    if (state === 'idle') a.idleSince = performance.now();
    if (state === 'working' && prev !== 'working') a.desk.lines.push({ text: '> ' + (detail || 'trabalhando'), type: 'status' });
    drawScreen(a.desk);
  }

  function pushMonitor(id, text, type = 'text') {
    const a = agents.get(id);
    if (!a) return;
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    // quebra em linhas de até 40 caracteres
    const chunks = clean.match(/.{1,40}(\s|$)/g) || [clean];
    for (const ch of chunks.slice(0, 3)) a.desk.lines.push({ text: ch.trim(), type });
    a.desk.lines = a.desk.lines.slice(-16);
    drawScreen(a.desk);
  }

  function setBoard(b) { boardData = { ...boardData, ...b }; drawBoard(); }
  function setStudioName(name) { drawSign(name || 'Meu Estúdio'); }

  /* ----------------------------- clique ----------------------------- */
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects([...agents.values()].map((a) => a.group), true);
    if (hits[0] && onAgentClick) onAgentClick(hits[0].object.userData.agentId);
  });

  /* ----------------------------- animação ----------------------------- */
  const tmp = new THREE.Vector3();
  let last = performance.now();
  let caretT = 0;
  let running = true;
  let teamBusy = false;

  function tick(now) {
    if (!running) return;
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    controls.update();

    const d = new Date();
    hourHand.rotation.z = -((d.getHours() % 12) + d.getMinutes() / 60) * (Math.PI / 6);
    minHand.rotation.z = -(d.getMinutes() + d.getSeconds() / 60) * (Math.PI / 30);

    caretT += dt;
    const blink = caretT > 0.5;
    if (blink) caretT = 0;

    for (const a of agents.values()) {
      const g = a.group;
      const { bob, parts, floats } = g.userData;
      let walking = false;
      if (a.path.length) {
        const p = a.path[0];
        const dx = p.x - g.position.x, dz = p.z - g.position.z;
        const dist = Math.hypot(dx, dz);
        const step = 2.4 * dt;
        if (dist <= step) { g.position.x = p.x; g.position.z = p.z; a.path.shift(); }
        else { g.position.x += (dx / dist) * step; g.position.z += (dz / dist) * step; }
        if (dist > 0.01) a.facing = Math.atan2(dx, dz);
        walking = true;
        if (!a.path.length) { a.arrived = true; a.facing = a.spot.face; }
      }
      // gira suavemente
      let diff = a.facing - g.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      g.rotation.y += diff * Math.min(1, dt * 8);

      const ph = t * (walking ? 9 : a.state === 'working' ? 14 : 2) + a.phase;
      if (walking) {
        bob.position.y = Math.abs(Math.sin(ph)) * 0.08 + (floats ? 0.12 : 0);
        parts.legs.forEach((l, i) => { l.position.y = (l.userData.y0 ??= l.position.y) + Math.max(0, Math.sin(ph + i * Math.PI)) * 0.05; });
      } else if (a.state === 'working') {
        bob.position.y = Math.abs(Math.sin(ph)) * 0.025 + (floats ? 0.1 + Math.sin(t * 2) * 0.04 : 0);
        parts.arms.forEach((arm, i) => { arm.position.y = (arm.userData.y0 ??= arm.position.y) + Math.sin(ph * 1.3 + i * Math.PI) * 0.03; });
      } else {
        parts.legs.forEach((l) => { if (l.userData.y0 != null) l.position.y = l.userData.y0; });
        bob.position.y = Math.sin(ph) * 0.015 + (floats ? 0.1 + Math.sin(t * 1.6 + a.phase) * 0.06 : 0);
      }
      if (parts.ring) parts.ring.rotation.z += dt * (a.state === 'working' ? 3 : 0.6);
      if (parts.antenna) parts.antenna.material.emissiveIntensity = a.state === 'working' ? 0.6 + Math.abs(Math.sin(t * 6)) : 0.8;

      // telefone tocando
      const ringing = a.state === 'waiting';
      a.desk.handset.position.y = 0.085 + (ringing ? Math.abs(Math.sin(t * 30)) * 0.03 : 0);
      a.desk.handset.rotation.z = ringing ? Math.sin(t * 40) * 0.15 : 0;
      a.desk.ringLed.material.color.set(ringing ? (Math.sin(t * 10) > 0 ? 0xff4d3a : 0x551511) : 0x333333);

      if (a.state === 'working' && blink) { a.desk.caret = !a.desk.caret; drawScreen(a.desk); }

      // café no tempo livre
      if (a.state === 'idle' && !teamBusy && a.arrived && now > a.nextCoffee) {
        a.nextCoffee = now + 60000 + Math.random() * 90000;
        a.coffeeUntil = now + 9000;
        a.state = 'coffee'; a.desk.state = 'coffee'; updateTag(a); drawScreen(a.desk);
        goTo(a, coffeeSpot([...agents.keys()].indexOf(a.id)));
        say(a.id, 'Pausa pro café ☕', 3000);
      }
      if (a.state === 'coffee' && a.arrived && a.coffeeUntil && now > a.coffeeUntil) {
        a.coffeeUntil = 0;
        setState(a.id, 'idle');
      }

      if (a.bubbleUntil && now > a.bubbleUntil) { a.bubble.classList.remove('show'); a.bubbleUntil = 0; }
    }

    renderer.render(scene, camera);

    // rótulos em HTML acompanhando os bonecos
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    for (const a of agents.values()) {
      tmp.set(a.group.position.x, a.group.userData.headY + 0.2, a.group.position.z).project(camera);
      const x = (tmp.x * 0.5 + 0.5) * w, y = (-tmp.y * 0.5 + 0.5) * h;
      const vis = tmp.z < 1;
      a.tag.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      a.tag.style.display = vis ? '' : 'none';
      a.bubble.style.transform = `translate(${x}px, ${y - 30}px) translate(-50%, -100%)`;
    }
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  drawSign('Meu Estúdio');
  drawBoard();
  requestAnimationFrame(tick);

  return {
    syncAgents, setState, pushMonitor, say, setBoard, setStudioName, resize,
    setBusy(b) { teamBusy = b; },
    focusAgent(id) {
      const a = agents.get(id); if (!a) return;
      controls.target.set(a.group.position.x, 0.6, a.group.position.z);
    },
    resetView() { controls.target.set(0.6, 0.4, 0.2); camera.position.set(10.5, 10.5, 14.5); },
    dispose() { running = false; ro.disconnect(); renderer.dispose(); },
  };
}
