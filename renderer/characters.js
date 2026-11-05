// Bonequinhos dos agentes, montados com formas simples do three.js.
// look = { color, body: 'caixa'|'gota'|'orbe', eyes: 'pontos'|'visor'|'sorriso', antenna: bool }
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const DARK = 0x1a1626;

function mat(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.04, ...extra });
}

function lighter(hex, amt = 0.35) {
  const c = new THREE.Color(hex);
  return c.lerp(new THREE.Color(0xffffff), amt);
}

export function buildCharacter(look = {}) {
  const color = look.color || '#e8795a';
  const body = look.body || 'caixa';
  const eyes = look.eyes || 'pontos';
  const root = new THREE.Group();
  const bob = new THREE.Group(); // parte que balança/pula
  root.add(bob);
  const m = mat(color);
  const parts = { arms: [], legs: [] };

  let faceY, faceZ, topY, faceW;
  if (body === 'gota') {
    const g = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.42, 8, 20), m);
    g.position.y = 0.78; bob.add(g);
    for (const s of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), m);
      foot.scale.set(1, 0.55, 1.25); foot.position.set(0.17 * s, 0.09, 0.04); root.add(foot); parts.legs.push(foot);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.16, 4, 10), m);
      arm.position.set(0.43 * s, 0.72, 0); arm.rotation.z = 0.35 * s; bob.add(arm); parts.arms.push(arm);
    }
    faceY = 0.86; faceZ = 0.355; topY = 1.38; faceW = 0.44;
  } else if (body === 'orbe') {
    const g = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 24), m);
    g.position.y = 0.98; bob.add(g);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.035, 10, 48), mat(lighter(color, 0.45), { emissive: lighter(color, 0.2), emissiveIntensity: 0.35 }));
    ring.position.y = 0.95; ring.rotation.x = Math.PI / 2.25; bob.add(ring); parts.ring = ring;
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.32, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01; root.add(shadow); parts.shadow = shadow;
    faceY = 1.0; faceZ = 0.405; topY = 1.4; faceW = 0.42;
  } else {
    const g = new THREE.Mesh(new RoundedBoxGeometry(0.86, 0.7, 0.62, 4, 0.12), m);
    g.position.y = 0.78; bob.add(g);
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.16, 0.14, 2, 0.04), m);
      ear.position.set(0.24 * s, 1.18, 0); bob.add(ear);
      const arm = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.12, 0.13, 2, 0.04), m);
      arm.position.set(0.5 * s, 0.74, 0.02); bob.add(arm); parts.arms.push(arm);
    }
    for (const x of [-0.27, -0.09, 0.09, 0.27]) {
      const leg = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.32, 0.12, 2, 0.03), m);
      leg.position.set(x, 0.2, 0.02); root.add(leg); parts.legs.push(leg);
    }
    faceY = 0.8; faceZ = 0.312; topY = 1.13; faceW = 0.6;
  }

  const face = new THREE.Group();
  face.position.set(0, faceY, faceZ);
  bob.add(face);
  const dark = mat(DARK, { roughness: 0.3 });
  if (eyes === 'visor') {
    const screen = new THREE.Mesh(new RoundedBoxGeometry(faceW * 0.85, 0.27, 0.05, 2, 0.04), mat(0x10162b, { roughness: 0.2, metalness: 0.2 }));
    face.add(screen);
    const glow = new THREE.MeshStandardMaterial({ color: 0xbff4ff, emissive: 0x7fe7ff, emissiveIntensity: 1.2 });
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.02), glow);
      e.position.set(0.09 * s, 0.01, 0.03); face.add(e); (parts.eyes = parts.eyes || []).push(e);
    }
  } else if (eyes === 'sorriso') {
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), dark);
      e.scale.z = 0.5; e.position.set(0.13 * s, 0.06, 0.005); face.add(e); (parts.eyes = parts.eyes || []).push(e);
    }
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.018, 6, 16, Math.PI), dark);
    smile.rotation.z = Math.PI; smile.position.set(0, -0.04, 0.005); face.add(smile);
  } else {
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.15, 0.04, 2, 0.02), dark);
      e.position.set(0.12 * s, 0.02, 0); face.add(e); (parts.eyes = parts.eyes || []).push(e);
    }
  }

  if (look.antenna) {
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.22, 8), dark);
    stick.position.set(0, topY + 0.1, 0); bob.add(stick);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), new THREE.MeshStandardMaterial({ color: lighter(color, 0.5), emissive: color, emissiveIntensity: 0.9 }));
    ball.position.set(0, topY + 0.23, 0); bob.add(ball); parts.antenna = ball;
  }

  root.traverse((o) => { if (o.isMesh && o !== parts.shadow) { o.castShadow = true; o.receiveShadow = true; } });
  root.userData = { bob, parts, look, headY: topY + (look.antenna ? 0.35 : 0.12), floats: body === 'orbe' };
  return root;
}

/* ------------------------- miniaturas para os cards ------------------------- */
let thumbRenderer = null;
const thumbCache = new Map();

export function renderThumb(look, size = 256) {
  const key = JSON.stringify([look.color, look.body, look.eyes, !!look.antenna, size]);
  if (thumbCache.has(key)) return thumbCache.get(key);
  try {
    if (!thumbRenderer) {
      thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
      thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    }
    thumbRenderer.setSize(size, size, false);
    thumbRenderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff4e8, 0x2a2030, 1.6));
    const key1 = new THREE.DirectionalLight(0xffffff, 2.2); key1.position.set(2, 3, 4); scene.add(key1);
    const rim = new THREE.DirectionalLight(0xffd9b8, 1.2); rim.position.set(-3, 2, -2); scene.add(rim);
    const ch = buildCharacter(look);
    ch.rotation.y = -0.38;
    scene.add(ch);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    cam.position.set(0.9, 1.35, 3.6);
    cam.lookAt(0, 0.78, 0);
    thumbRenderer.render(scene, cam);
    const url = thumbRenderer.domElement.toDataURL('image/png');
    thumbCache.set(key, url);
    scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    return url;
  } catch (e) {
    return '';
  }
}
