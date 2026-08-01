import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------- constants

const ARENA = 52;          // half-extent of the playable floor
const WALL_H = 11;
const EYE_H = 1.7;
const PLAYER_R = 0.45;
const GRAVITY = 24;
const JUMP_V = 8.4;        // clears a 1.15 m crate in a single hop
const STEP_UP = 0.65;      // ledges up to this are walked over, no jump needed
const WALK = 7.4;
const SPRINT = 11.6;

// The pistol is the permanent sidearm: weak but never runs dry. Everything else
// is scavenged off the map with barely any rounds, so it burns fast and drops you
// back to the pistol.
const WEAPONS = {
  pistol: {
    name: 'PISTOLA', dmg: 15, rate: 0.20, auto: false, mag: 12,
    spread: 0.011, pellets: 1, reload: 1.0, infinite: true,
    tracer: 0xbff7ff, flash: 0xfff0a0, kick: 0.85, shakeAmt: 0.022,
  },
  shotgun: {
    name: 'ESCOPETA', dmg: 15, rate: 0.72, auto: false, mag: 5,
    spread: 0.085, pellets: 9,
    tracer: 0xffb0e6, flash: 0xffd0f0, kick: 2.2, shakeAmt: 0.075,
  },
  railgun: {
    name: 'RAILGUN', dmg: 130, rate: 0.95, auto: false, mag: 3,
    spread: 0, pellets: 1, pierce: true, beam: 0.07,
    tracer: 0xd8a0ff, flash: 0xe8c8ff, kick: 2.6, shakeAmt: 0.085,
  },
  plasma: {
    name: 'PLASMA', dmg: 19, rate: 0.062, auto: true, mag: 22,
    spread: 0.030, pellets: 1,
    tracer: 0xdcff9f, flash: 0xeaffb8, kick: 0.7, shakeAmt: 0.020,
  },
};
const SPECIALS = ['shotgun', 'railgun', 'plasma'];
const RANGE = 200;
const HEADSHOT_MULT = 2;

const ENEMY_TYPES = {
  thug: {
    hp: 45, speed: 3.4, dmg: 12, height: 1.78, radius: 0.42, score: 100,
    jacket: 0x2a0a24, trim: 0xff3fb0, accent: 0xff3fb0, ranged: false,
  },
  runner: {
    hp: 22, speed: 6.5, dmg: 8, height: 1.62, radius: 0.34, score: 150,
    jacket: 0x07222a, trim: 0x4dfcff, accent: 0x4dfcff, ranged: false,
  },
  gunner: {
    hp: 34, speed: 3.0, dmg: 14, height: 1.72, radius: 0.40, score: 220,
    jacket: 0x2a2205, trim: 0xb6ff4d, accent: 0xb6ff4d, ranged: true,
    keepDist: 15, fireEvery: 2.1, projSpeed: 15,
  },
  brute: {
    hp: 125, speed: 2.2, dmg: 26, height: 2.45, radius: 0.72, score: 320,
    jacket: 0x2e1403, trim: 0xffa23f, accent: 0xffa23f, ranged: false, bulk: 1.5,
  },
};

const SLOW = { world: 0.30, player: 0.62, drain: 1 / 3.2, recharge: 1 / 12, minToStart: 0.22 };

// ---------------------------------------------------------------- utilities

let seed = 1337;
function rand() {                       // deterministic RNG for the arena layout
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let glowTexture = null;
function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.42)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.09)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);

  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

function glowSprite(color, size, opacity = 0.75) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(), color, opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, fog: true,
  }));
  sprite.scale.setScalar(size);
  return sprite;
}

function textSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 36px Orbitron, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 128, 34);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, color, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  }));
  s.scale.set(2.4, 0.6, 1);
  return s;
}

// ---------------------------------------------------------------- audio

const Sfx = {
  ctx: null,
  noise: null,
  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const len = this.ctx.sampleRate * 0.5;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  },
  env(node, peak, attack, decay) {
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g).connect(this.ctx.destination);
    return t + attack + decay;
  },
  tone(type, from, to, peak, dur) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const end = this.env(o, peak, 0.005, dur);
    o.start(t); o.stop(end + 0.02);
  },
  burst(peak, dur, filterFrom, filterTo) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(filterFrom, t);
    f.frequency.exponentialRampToValueAtTime(filterTo, t + dur);
    src.connect(f);
    const end = this.env(f, peak, 0.005, dur);
    src.start(t); src.stop(end + 0.02);
  },
  pistol()  { this.tone('square', 700, 110, 0.09, 0.07); this.burst(0.05, 0.05, 5000, 800); },
  shotgun() { this.burst(0.22, 0.28, 4200, 240); this.tone('sawtooth', 240, 60, 0.10, 0.22); },
  railgun() { this.tone('sawtooth', 1600, 120, 0.12, 0.32); this.tone('sine', 300, 1800, 0.07, 0.16); },
  plasma()  { this.tone('triangle', 1150, 340, 0.07, 0.06); },
  hit()     { this.tone('sine', 1500, 900, 0.07, 0.05); },
  headshot(){ this.tone('sine', 2400, 1500, 0.10, 0.09); },
  kill()    { this.burst(0.15, 0.34, 3200, 110); this.tone('square', 280, 55, 0.06, 0.28); },
  hurt()    { this.tone('square', 140, 55, 0.16, 0.28); },
  reload()  { this.tone('square', 260, 200, 0.05, 0.04); setTimeout(() => this.tone('square', 400, 320, 0.05, 0.05), 170); },
  pickup()  { this.tone('sine', 700, 1400, 0.09, 0.16); },
  weapon()  { this.tone('sawtooth', 420, 900, 0.10, 0.2); setTimeout(() => this.tone('square', 900, 1300, 0.07, 0.12), 110); },
  dryFire() { this.tone('square', 180, 140, 0.05, 0.03); },
  enemyShot(){ this.tone('sawtooth', 420, 150, 0.05, 0.14); },
  slowOn()  { this.tone('sine', 800, 200, 0.09, 0.5); },
  slowOff() { this.tone('sine', 220, 800, 0.08, 0.35); },
  wave()    { this.tone('triangle', 300, 600, 0.10, 0.25); setTimeout(() => this.tone('triangle', 500, 900, 0.10, 0.35), 200); },
};

// ---------------------------------------------------------------- renderer / scene

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0a0316, 0.013);   // thinner, the arena is large

const BASE_FOV = 78;
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.01, 500);
scene.add(camera);

// The weapon is rendered by its own camera on a dedicated layer: a narrower FOV
// keeps it from distorting the way anything held this close to a 78° lens does,
// and clearing depth first stops your own torso — or a wall you back into — from
// slicing through the gun.
const VIEWMODEL_LAYER = 1;
const vmCamera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 5);
vmCamera.layers.set(VIEWMODEL_LAYER);
scene.add(vmCamera);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const vmPass = new RenderPass(scene, vmCamera);
vmPass.clear = false;
vmPass.clearDepth = true;
composer.addPass(vmPass);

const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), 0.62, 0.5, 0.35
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- world

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(280, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x140833) },
      uHorizon: { value: new THREE.Color(0x4a0d5c) },
      uBottom: { value: new THREE.Color(0x05010a) },
    },
    vertexShader: `
      varying float vH;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vH = normalize(wp.xyz - cameraPosition).y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      varying float vH;
      uniform vec3 uTop, uHorizon, uBottom;
      void main() {
        float t = clamp(vH * 1.3 + 0.25, 0.0, 1.0);
        vec3 c = mix(uHorizon, uTop, smoothstep(0.22, 1.0, t));
        c = mix(uBottom, c, smoothstep(0.0, 0.26, t));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
);
sky.renderOrder = -999;
scene.add(sky);

function gridTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#0a0418';
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#1b6f8c';
  g.lineWidth = 3;
  g.strokeRect(0, 0, S, S);
  g.strokeStyle = '#123a52';
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const p = (S / 4) * i;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(ARENA, ARENA);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(ARENA * 2, ARENA * 2),
  new THREE.MeshBasicMaterial({ map: gridTexture() })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const obstacles = [];   // { box: THREE.Box3 }
const solids = [];      // meshes bullets can stop against

const wallMat = new THREE.MeshBasicMaterial({ color: 0x0d0524 });
const NEON = [0x4dfcff, 0xff3fb0, 0xb6ff4d, 0xffd24d, 0x9d4dff];

function addBlock(x, y, z, w, h, d, neon) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  mesh.position.set(x, y, z);
  scene.add(mesh);
  solids.push(mesh);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: neon, fog: true })
  );
  edges.position.copy(mesh.position);
  scene.add(edges);

  obstacles.push({
    box: new THREE.Box3().setFromCenterAndSize(mesh.position, new THREE.Vector3(w, h, d)),
  });
  return mesh;
}

addBlock(0,  WALL_H / 2, -ARENA - 0.5, ARENA * 2 + 2, WALL_H, 1, 0x4dfcff);
addBlock(0,  WALL_H / 2,  ARENA + 0.5, ARENA * 2 + 2, WALL_H, 1, 0x4dfcff);
addBlock(-ARENA - 0.5, WALL_H / 2, 0, 1, WALL_H, ARENA * 2 + 2, 0xff3fb0);
addBlock( ARENA + 0.5, WALL_H / 2, 0, 1, WALL_H, ARENA * 2 + 2, 0xff3fb0);

// A ramp is a thin box rotated about X. It gets no collision volume of its own —
// the stepper below walks the player up it, which keeps the collision model to
// pure axis-aligned boxes.
function addRamp(x, y, z, w, len, rise, rotY, neon) {
  const angle = Math.atan2(rise, len);
  const geo = new THREE.BoxGeometry(w, 0.25, Math.hypot(len, rise));
  const mesh = new THREE.Mesh(geo, wallMat);
  mesh.position.set(x, y, z);
  mesh.rotation.order = 'YXZ';
  mesh.rotation.y = rotY;
  // +angle drops the far (+Z) end and lifts the near one, so the slope climbs
  // toward whatever the ramp is leaning against
  mesh.rotation.x = angle;
  scene.add(mesh);
  solids.push(mesh);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: neon })
  );
  edges.position.copy(mesh.position);
  edges.rotation.copy(mesh.rotation);
  scene.add(edges);

  // Approximate the slope with a stack of steps for collision, each one shorter
  // than STEP_UP so both the player and the enemies walk up without jumping. The
  // tallest step is the one nearest the structure the ramp serves.
  const steps = Math.max(2, Math.round(rise / 0.42));
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const h = (rise * (steps - i)) / steps;
    const along = (t - 0.5) * len;
    obstacles.push({
      box: new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x + Math.sin(rotY) * along, h / 2, z + Math.cos(rotY) * along),
        new THREE.Vector3(
          Math.abs(Math.cos(rotY)) * w + Math.abs(Math.sin(rotY)) * (len / steps),
          h,
          Math.abs(Math.cos(rotY)) * (len / steps) + Math.abs(Math.sin(rotY)) * w
        )
      ),
    });
  }
}

// Hand-built layout. Heights come in tiers the player can actually work up:
// STEP is a single hop, and everything taller is reachable by chaining crates
// or taking a ramp, so no piece of cover is a dead end.
const STEP = 1.15;

// four corner strongholds: a low crate you can hop onto, feeding a taller one
for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
  const cx = sx * 30, cz = sz * 30;
  addBlock(cx, STEP / 2, cz, 7, STEP, 7, 0x4dfcff);
  addBlock(cx + sx * 5.5, STEP * 1.6, cz + sz * 5.5, 5, STEP * 3.2, 5, 0xff3fb0);
  addBlock(cx - sx * 6, STEP * 0.35, cz - sz * 6, 4, STEP * 0.7, 4, 0xb6ff4d);
}

// central raised platform with ramps up two opposite sides
const PLAT_H = 2.6;
addBlock(0, PLAT_H / 2, 0, 16, PLAT_H, 16, 0xb6ff4d);
addRamp(0, PLAT_H / 2 - 0.1, 13.5, 6, 11, PLAT_H, 0, 0xb6ff4d);
addRamp(0, PLAT_H / 2 - 0.1, -13.5, 6, 11, PLAT_H, Math.PI, 0xb6ff4d);
// a tower on the platform for long sightlines
addBlock(0, PLAT_H + 2.4, 0, 4, 4.8, 4, 0xffd24d);

// mid-field cover: staircases of three crates so every roof is reachable
const STAIRS = [
  [-17, 6, 0], [17, -6, Math.PI], [7, 19, Math.PI / 2], [-7, -19, -Math.PI / 2],
];
for (const [x, z, rot] of STAIRS) {
  for (let i = 0; i < 3; i++) {
    const h = STEP * (i + 1);
    const ox = Math.cos(rot) * i * 3.2;
    const oz = Math.sin(rot) * i * 3.2;
    addBlock(x + ox, h / 2, z + oz, 3, h, 3, NEON[i % NEON.length]);
  }
}

// scattered low blocks for quick cover, placed off the fixed layout
for (let i = 0; i < 14; i++) {
  const a = rand() * Math.PI * 2;
  const r = 13 + rand() * (ARENA - 20);
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  if (Math.abs(x) < 11 && Math.abs(z) < 11) continue;    // keep the platform clear
  const h = STEP * (0.6 + rand() * 1.6);
  addBlock(x, h / 2, z, 2.5 + rand() * 3, h, 2.5 + rand() * 3, NEON[(rand() * NEON.length) | 0]);
}

// tall pillars purely to break sightlines
for (const [x, z] of [[-24, -8], [24, 8], [9, -25], [-9, 25]]) {
  addBlock(x, 3.5, z, 2.4, 7, 2.4, 0x9d4dff);
}

// ---------------------------------------------------------------- humanoid rig

// Every character in the game — the player's own body and all four enemy types —
// comes out of this one rig: a tapered torso, spherical head and joints, and
// two-segment arms and legs that bend at the elbow and knee. Shapes are kept
// low-poly on purpose and outlined with EdgesGeometry above a 24° threshold, so
// only the silhouette-defining facets light up and the characters still read as
// part of the same neon-wireframe world as the arena.
//
// Geometry is cached per silhouette and shared across every instance of a type;
// only the three materials are per-character, so a hit flash can recolour one
// enemy without touching the rest.
const rigGeoCache = new Map();

function getRigGeometry(key, build) {
  let geo = rigGeoCache.get(key);
  if (!geo) { geo = build(); rigGeoCache.set(key, geo); }
  return geo;
}

function buildHumanoid(cfg) {
  const { height: H, jacket, trim, accent, bulk = 1, key = 'x' } = cfg;
  const B = bulk;

  const mats = {
    body: new THREE.MeshBasicMaterial({ color: jacket }),
    edge: new THREE.LineBasicMaterial({ color: trim }),
    accent: new THREE.MeshBasicMaterial({ color: accent }),
  };

  const cache = (name, build) => getRigGeometry(`${key}:${name}`, build);

  // a solid dark shape wearing a neon outline
  function piece(geo, mat) {
    const mesh = new THREE.Mesh(geo, mat || mats.body);
    mesh.add(new THREE.LineSegments(
      getRigGeometry(`edges:${geo.uuid}`, () => new THREE.EdgesGeometry(geo, 24)),
      mats.edge
    ));
    return mesh;
  }

  const capsule = (name, r, len) =>
    cache(name, () => new THREE.CapsuleGeometry(r, len, 2, 6));
  const ball = (name, r) =>
    cache(name, () => new THREE.IcosahedronGeometry(r, 0));

  const root = new THREE.Group();

  // anchored so the model genuinely reaches H: hips at half, top of skull at 1.0
  const hipY = 0.50 * H;
  const chestTopY = 0.80 * H;
  const shoulderY = 0.78 * H;
  const headR = 0.075 * H;
  const headY = H - headR;
  const headSize = headR * 2;

  const shoulderX = 0.115 * H * B;
  const hipX = 0.068 * H * B;
  const upperArm = 0.155 * H, foreArm = 0.155 * H, armR = 0.035 * H * B;
  const thigh = 0.245 * H, shin = 0.245 * H, legR = 0.050 * H * B;

  // ---- torso: a tapered barrel, squashed front-to-back so it isn't a tube
  const torsoH = chestTopY - hipY;
  const torso = piece(cache('torso', () => {
    const g = new THREE.CylinderGeometry(0.135 * H * B, 0.100 * H * B, torsoH, 8, 1);
    g.scale(1, 1, 0.66);
    return g;
  }));
  torso.position.y = hipY + torsoH / 2;
  root.add(torso);

  const pelvis = piece(cache('pelvis', () => {
    const g = new THREE.IcosahedronGeometry(0.098 * H * B, 0);
    g.scale(1, 0.78, 0.72);
    return g;
  }));
  pelvis.position.y = hipY;
  root.add(pelvis);

  // ---- head on a short neck, with a lit visor across the face (-Z is forward)
  const neck = piece(capsule('neck', 0.035 * H, 0.05 * H));
  neck.position.y = chestTopY + 0.025 * H;
  root.add(neck);

  const head = piece(cache('head', () => {
    const g = new THREE.IcosahedronGeometry(headR, 1);
    g.scale(0.92, 1, 0.92);
    return g;
  }));
  head.position.y = headY;
  root.add(head);

  const visor = new THREE.Mesh(
    cache('visor', () => {
      const g = new THREE.SphereGeometry(headR * 0.94, 10, 6, 0, Math.PI, 1.15, 0.62);
      g.rotateY(Math.PI / 2);
      return g;
    }),
    mats.accent
  );
  head.add(visor);

  // ---- limbs: pivot at the joint, segment hanging below it, joint ball on top
  function segment(parent, r, len, name) {
    const pivot = new THREE.Group();
    const mesh = piece(capsule(name, r, len));
    mesh.position.y = -len / 2;
    pivot.add(mesh);
    pivot.add(piece(ball(name + 'Joint', r * 1.15)));
    parent.add(pivot);
    return pivot;
  }

  function arm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * shoulderX, shoulderY, 0);
    root.add(shoulder);

    const upper = segment(shoulder, armR, upperArm, 'upperArm');
    const elbow = new THREE.Group();
    elbow.position.y = -upperArm;
    upper.add(elbow);
    segment(elbow, armR * 0.88, foreArm, 'foreArm');

    const hand = piece(ball('hand', armR * 1.5));
    hand.position.y = -foreArm - armR * 0.5;
    elbow.add(hand);

    return { shoulder, elbow, hand };
  }

  function leg(side) {
    const hip = new THREE.Group();
    hip.position.set(side * hipX, hipY, 0);
    root.add(hip);

    const upper = segment(hip, legR, thigh, 'thigh');
    const knee = new THREE.Group();
    knee.position.y = -thigh;
    upper.add(knee);
    segment(knee, legR * 0.82, shin, 'shin');

    const foot = piece(cache('foot', () =>
      new THREE.BoxGeometry(0.062 * H * B, 0.032 * H, 0.135 * H)));
    foot.position.set(0, -shin - 0.014 * H, -0.028 * H);
    knee.add(foot);

    return { hip, knee, foot };
  }

  const armL = arm(-1), armR_ = arm(1);
  const legL = leg(-1), legR_ = leg(1);

  // ---- jacket detail, all on the -Z front face
  const collar = new THREE.Mesh(
    cache('collar', () => {
      const g = new THREE.TorusGeometry(0.10 * H * B, 0.016 * H, 5, 10);
      g.rotateX(Math.PI / 2);
      g.scale(1, 1, 0.7);
      return g;
    }),
    mats.accent
  );
  collar.position.y = chestTopY - 0.012 * H;
  root.add(collar);

  for (const side of [-1, 1]) {
    const stripe = new THREE.Mesh(
      cache('stripe', () => new THREE.BoxGeometry(0.018 * H, torsoH * 0.55, 0.014 * H)),
      mats.accent
    );
    stripe.position.set(side * 0.055 * H * B, hipY + torsoH * 0.52, -0.088 * H * B);
    root.add(stripe);
  }

  return {
    root, mats, torso, head, pelvis, visor,
    shoulderL: armL.shoulder, elbowL: armL.elbow, handL: armL.hand,
    shoulderR: armR_.shoulder, elbowR: armR_.elbow, handR: armR_.hand,
    hipL: legL.hip, kneeL: legL.knee,
    hipR: legR_.hip, kneeR: legR_.knee,
    headY, headSize, shoulderY, height: H,
  };
}

// A two-segment walk cycle: thighs swing opposite each other, the knee folds on
// the back half of the stride, and the arms counter-swing. `aim` overrides the
// right arm so a character can hold a weapon out while still walking.
function animateHumanoid(rig, phase, amount, aim = 0, swingArc = 0) {
  const s = Math.sin(phase);

  rig.hipL.rotation.x = s * amount;
  rig.hipR.rotation.x = -s * amount;
  rig.kneeL.rotation.x = -Math.max(0, -s) * amount * 1.1;
  rig.kneeR.rotation.x = -Math.max(0, s) * amount * 1.1;

  rig.shoulderL.rotation.x = -s * amount * 0.6;
  rig.elbowL.rotation.x = -0.25 - Math.abs(s) * 0.25;

  if (swingArc > 0) {
    // melee arc: wind up over the shoulder, then chop down
    rig.shoulderR.rotation.x = 2.2 - swingArc * 7.5;
    rig.elbowR.rotation.x = -0.5;
  } else if (aim > 0) {
    rig.shoulderR.rotation.x = aim;
    rig.elbowR.rotation.x = -0.35;
    rig.shoulderL.rotation.x = aim * 0.82;
    rig.elbowL.rotation.x = -0.55;
  } else {
    rig.shoulderR.rotation.x = s * amount * 0.6;
    rig.elbowR.rotation.x = -0.25 - Math.abs(s) * 0.25;
  }
}

// ---------------------------------------------------------------- particles

const MAX_P = 1600;
const pPos = new Float32Array(MAX_P * 3);
const pCol = new Float32Array(MAX_P * 3);
const pVel = new Float32Array(MAX_P * 3);
const pLife = new Float32Array(MAX_P);
const pMax = new Float32Array(MAX_P);
const pBase = new Float32Array(MAX_P * 3);
let pCursor = 0;

const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
scene.add(new THREE.Points(pGeo, new THREE.PointsMaterial({
  size: 0.16, vertexColors: true, blending: THREE.AdditiveBlending,
  depthWrite: false, transparent: true, sizeAttenuation: true, fog: false,
})));

const _c = new THREE.Color();
function spawnParticles(origin, color, count, speed, life = 0.7) {
  _c.set(color);
  for (let i = 0; i < count; i++) {
    const k = pCursor;
    pCursor = (pCursor + 1) % MAX_P;
    pPos[k * 3] = origin.x; pPos[k * 3 + 1] = origin.y; pPos[k * 3 + 2] = origin.z;

    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(Math.random() * 2 - 1);
    const s = speed * (0.35 + Math.random() * 0.85);
    pVel[k * 3] = Math.sin(ph) * Math.cos(th) * s;
    pVel[k * 3 + 1] = Math.cos(ph) * s + 1.2;
    pVel[k * 3 + 2] = Math.sin(ph) * Math.sin(th) * s;

    pBase[k * 3] = _c.r; pBase[k * 3 + 1] = _c.g; pBase[k * 3 + 2] = _c.b;
    pLife[k] = pMax[k] = life * (0.6 + Math.random() * 0.7);
  }
}

function updateParticles(dt) {
  for (let k = 0; k < MAX_P; k++) {
    if (pLife[k] <= 0) { pCol[k * 3] = pCol[k * 3 + 1] = pCol[k * 3 + 2] = 0; continue; }
    pLife[k] -= dt;
    const i = k * 3;
    pVel[i + 1] -= 11 * dt;
    pPos[i] += pVel[i] * dt;
    pPos[i + 1] += pVel[i + 1] * dt;
    pPos[i + 2] += pVel[i + 2] * dt;
    if (pPos[i + 1] < 0.05) { pPos[i + 1] = 0.05; pVel[i + 1] *= -0.35; pVel[i] *= 0.7; pVel[i + 2] *= 0.7; }
    const f = clamp(pLife[k] / pMax[k], 0, 1);
    pCol[i] = pBase[i] * f; pCol[i + 1] = pBase[i + 1] * f; pCol[i + 2] = pBase[i + 2] * f;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- tracers

const tracers = [];
const tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
tracerGeo.translate(0, 0.5, 0);
tracerGeo.rotateX(Math.PI / 2);   // aligned down -Z so lookAt() works

for (let i = 0; i < 28; i++) {
  const m = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({
    color: 0xbff7ff, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, fog: false,
  }));
  m.visible = false;
  scene.add(m);
  tracers.push({ mesh: m, life: 0, max: 0.06 });
}
let tracerCursor = 0;

function spawnTracer(from, to, color, thickness = 0.022, life = 0.06) {
  const t = tracers[tracerCursor];
  tracerCursor = (tracerCursor + 1) % tracers.length;
  t.mesh.position.copy(from);
  t.mesh.lookAt(to);
  t.mesh.scale.set(thickness, thickness, from.distanceTo(to));
  t.mesh.material.color.set(color);
  t.mesh.visible = true;
  t.life = t.max = life;
}

// ---------------------------------------------------------------- player body

// A first-person body: torso and legs only. The head would sit inside the camera
// and the arms belong to the weapon viewmodel, so both are left off. The body
// tracks the camera's yaw but never its pitch, so looking down shows your chest
// and boots rather than swinging the whole model.
// Anatomically the chest sits behind the eyes, but then you only glimpse it at
// near-vertical angles. Nudging the body forward instead brings the jacket and
// boots into view at ordinary look-down angles — the usual first-person cheat.
const BODY_FWD = 0.13;

// The accent colour is deliberately muted here. On an enemy across the arena a
// solid neon panel reads beautifully; 30 cm from the lens the same panel is a
// white blob once bloom hits it, so the player's jacket is dark with lit seams.
const playerRig = buildHumanoid({
  key: 'player',
  height: 1.75, jacket: 0x0d1430, trim: 0x64b5ff, accent: 0x1d4f7a,
});
// the head would sit inside the camera and the arms belong to the weapon rig
playerRig.head.visible = false;
playerRig.shoulderL.visible = false;
playerRig.shoulderR.visible = false;
playerRig.torso.scale.z = 0.82;   // slimmer front-to-back so you can see past it

// Police detail. Looking straight down mostly shows the TOP of the torso, so the
// jacket needs shoulder pads and a raised collar up there — otherwise it reads as
// a blank slab. The badge and belt are for the view at shallower angles.
{
  const add = (geo, color, x, y, z) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    m.position.set(x, y, z);
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), playerRig.mats.edge));
    playerRig.root.add(m);
    return m;
  };

  for (const side of [-1, 1]) {   // shoulder pads, the part you see looking down
    add(new THREE.BoxGeometry(0.115, 0.05, 0.185), 0x1c2c60, side * 0.145, 1.365, 0);
  }

  add(new THREE.CylinderGeometry(0.145, 0.145, 0.055, 8), 0x1c2c60, 0, 0.875, 0);  // duty belt

  const badge = add(new THREE.BoxGeometry(0.055, 0.055, 0.02), 0x8a6a10, -0.10, 1.25, -0.10);
  badge.rotation.z = Math.PI / 4;
}
scene.add(playerRig.root);

// ---------------------------------------------------------------- weapon viewmodel

const GUN_HOME = new THREE.Vector3(0.128, -0.112, -0.46);
const GUN_YAW = 0.075;

const gun = new THREE.Group();
gun.position.copy(GUN_HOME);
gun.rotation.y = GUN_YAW;
gun.scale.setScalar(0.56);
vmCamera.add(gun);

const gunShellMat = new THREE.MeshBasicMaterial({ color: 0x120a24 });
const gunAccentMat = new THREE.MeshBasicMaterial({ color: 0x4dfcff });
const gunEdgeMat = new THREE.LineBasicMaterial({ color: 0x4dfcff });
const gloveMat = new THREE.MeshBasicMaterial({ color: 0x101a3a });

// each weapon gets its own silhouette, swapped in when equipped
const gunModels = {};
function buildGunModel(key) {
  const g = new THREE.Group();
  const edge = new THREE.LineBasicMaterial({ color: WEAPONS[key].tracer });

  const part = (w, h, d, x, y, z, mat) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, mat || gunShellMat);
    m.position.set(x, y, z);
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge));
    g.add(m);
    return m;
  };

  if (key === 'pistol') {
    part(0.052, 0.062, 0.20, 0, 0, -0.05);
    part(0.024, 0.024, 0.10, 0, 0.006, -0.19);
    part(0.046, 0.095, 0.055, 0, -0.070, 0.020);
    part(0.010, 0.016, 0.010, 0, 0.040, -0.13, gunAccentMat);
  } else if (key === 'shotgun') {
    part(0.062, 0.072, 0.34, 0, 0, -0.10);
    part(0.030, 0.055, 0.30, 0, -0.030, -0.20);
    part(0.048, 0.100, 0.060, 0, -0.070, 0.055);
    part(0.070, 0.020, 0.10, 0, 0.042, -0.02, gunAccentMat);
  } else if (key === 'railgun') {
    part(0.056, 0.066, 0.30, 0, 0, -0.06);
    part(0.020, 0.020, 0.40, 0, 0.020, -0.34);
    part(0.044, 0.098, 0.058, 0, -0.070, 0.050);
    for (const s of [-1, 1]) {
      part(0.012, 0.070, 0.10, s * 0.042, 0.030, -0.20, gunAccentMat);
    }
  } else {  // plasma
    part(0.060, 0.074, 0.26, 0, 0, -0.07);
    part(0.034, 0.034, 0.16, 0, 0.010, -0.26);
    part(0.046, 0.092, 0.056, 0, -0.068, 0.048);
    part(0.030, 0.030, 0.030, 0, 0.056, -0.10, gunAccentMat);
    part(0.038, 0.048, 0.038, 0, -0.052, -0.13, gunAccentMat);
  }

  // gloved hands, so the body's missing arms are never noticed. Kept small and
  // dim-edged: they sit nearest the lens and would otherwise dominate the frame.
  const hand = (x, y, z, rot) => {
    const geo = new THREE.BoxGeometry(0.055, 0.055, 0.085);
    const m = new THREE.Mesh(geo, gloveMat);
    m.position.set(x, y, z);
    m.rotation.x = rot;
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), gunEdgeMat));
    g.add(m);
  };
  hand(0, -0.050, 0.020, 0.25);
  if (key !== 'pistol') hand(-0.015, -0.055, -0.175, 0.1);

  g.visible = false;
  gun.add(g);
  return g;
}
for (const key of Object.keys(WEAPONS)) gunModels[key] = buildGunModel(key);

const muzzleFlash = glowSprite(0xfff0a0, 0.5);
muzzleFlash.position.set(0, 0.012, -0.42);
muzzleFlash.visible = false;
gun.add(muzzleFlash);

// the whole weapon rig belongs to the viewmodel layer, so the world camera skips it
gun.traverse((o) => o.layers.set(VIEWMODEL_LAYER));

let gunRecoil = 0;
let bobPhase = 0;
let flashTimer = 0;

// ---------------------------------------------------------------- player state

const controls = new PointerLockControls(camera, document.body);

// PointerLockControls rebuilds its YXZ euler from the camera quaternion on every
// mouse move, and by default lets the pitch reach exactly ±90°. That is the
// gimbal singularity: at straight up or straight down the yaw is no longer
// recoverable from the quaternion, so the view snaps to a random heading. Keeping
// the pitch a few degrees short of vertical avoids it entirely.
const PITCH_MARGIN = 0.10;
controls.minPolarAngle = PITCH_MARGIN;
controls.maxPolarAngle = Math.PI - PITCH_MARGIN;

const player = {
  pos: new THREE.Vector3(0, EYE_H, ARENA - 8),
  vel: new THREE.Vector3(),
  onGround: true,
  hp: 100,
  maxHp: 100,
  score: 0,
  alive: true,
  yaw: 0,
};

// slot 1 is always the pistol; slot 2 holds whatever was scavenged last
const loadout = {
  pistol: { key: 'pistol', ammo: WEAPONS.pistol.mag },
  special: null,
  equipped: 'pistol',
  cooldown: 0,
  reloading: 0,
};

const slowmo = { active: false, energy: 1 };

const keys = Object.create(null);
let shake = 0;
let triggerHeld = false;
let triggerConsumed = false;

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys[e.code] = true;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'Digit1') equip('pistol');
  if (e.code === 'Digit2') equip('special');
  if (e.code === 'KeyF') toggleSlowmo();
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

addEventListener('mousedown', (e) => {
  if (e.button === 0) { triggerHeld = true; triggerConsumed = false; }
});
addEventListener('mouseup', (e) => { if (e.button === 0) triggerHeld = false; });

// Slide a body out of any obstacle it overlaps, and report whether it ended up
// standing on one. `pos` is the reference point; the body spans `hDown` below it
// and `hUp` above — the player's reference point is their eye, an enemy's is its
// feet. Expanding the box by those amounts turns the test into a point check.
const _min = new THREE.Vector3(), _max = new THREE.Vector3();
function resolveCollisions(pos, radius, hDown, hUp) {
  let grounded = false;
  for (const { box } of obstacles) {
    _min.set(box.min.x - radius, box.min.y - hUp, box.min.z - radius);
    _max.set(box.max.x + radius, box.max.y + hDown, box.max.z + radius);
    if (pos.x < _min.x || pos.x > _max.x || pos.y < _min.y ||
        pos.y > _max.y || pos.z < _min.z || pos.z > _max.z) continue;

    const px = Math.min(pos.x - _min.x, _max.x - pos.x);
    const py = Math.min(pos.y - _min.y, _max.y - pos.y);
    const pz = Math.min(pos.z - _min.z, _max.z - pos.z);

    if (py <= px && py <= pz) {
      // Pushing under the box is only valid if the body still ends up above the
      // arena floor. Deep inside a wide block — the middle of the 16 m platform,
      // say — the shallowest axis is straight down, and taking it would post the
      // body underground instead of standing it on the roof.
      const canGoUnder = _min.y - hDown >= 0;
      if (pos.y - _min.y < _max.y - pos.y && canGoUnder) {
        pos.y = _min.y;
      } else {
        pos.y = _max.y;
        grounded = true;
      }
    } else if (px <= pz) {
      pos.x = pos.x - _min.x < _max.x - pos.x ? _min.x : _max.x;
    } else {
      pos.z = pos.z - _min.z < _max.z - pos.z ? _min.z : _max.z;
    }
  }
  return grounded;
}

function overlapsObstacle(pos, radius, hDown, hUp) {
  for (const { box } of obstacles) {
    if (pos.x > box.min.x - radius && pos.x < box.max.x + radius &&
        pos.y > box.min.y - hUp && pos.y < box.max.y + hDown &&
        pos.z > box.min.z - radius && pos.z < box.max.z + radius) return true;
  }
  return false;
}

// Walking into a ledge no taller than `maxStep` lifts the body onto it instead of
// stopping dead. This is what makes the stacked crates and the ramps climbable
// without giving the collision model anything but axis-aligned boxes to chew on.
const _probe = new THREE.Vector3();
function tryStepUp(pos, radius, hDown, hUp, wantX, wantZ, maxStep) {
  const feetY = pos.y - hDown;
  let ledge = -Infinity;
  for (const { box } of obstacles) {
    if (wantX > box.min.x - radius && wantX < box.max.x + radius &&
        wantZ > box.min.z - radius && wantZ < box.max.z + radius &&
        box.max.y > feetY + 0.02 && box.max.y <= feetY + maxStep) {
      ledge = Math.max(ledge, box.max.y);
    }
  }
  if (ledge === -Infinity) return false;

  const y = ledge + hDown + 0.002;
  if (overlapsObstacle(_probe.set(wantX, y, wantZ), radius, hDown, hUp)) return false;
  pos.set(wantX, y, wantZ);
  return true;
}

function pointInObstacle(p, pad = 0) {
  for (const { box } of obstacles) {
    if (p.x > box.min.x - pad && p.x < box.max.x + pad &&
        p.y > box.min.y - pad && p.y < box.max.y + pad &&
        p.z > box.min.z - pad && p.z < box.max.z + pad) return true;
  }
  return false;
}

const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _wish = new THREE.Vector3();

function updatePlayer(dt) {
  camera.getWorldDirection(_fwd);
  // read yaw off the direction vector: PointerLockControls writes the camera
  // quaternion in YXZ order, so camera.rotation.y is not the yaw once pitched
  player.yaw = Math.atan2(-_fwd.x, -_fwd.z);

  _fwd.y = 0; _fwd.normalize();
  _right.crossVectors(_fwd, THREE.Object3D.DEFAULT_UP).normalize();

  _wish.set(0, 0, 0);
  if (keys.KeyW) _wish.add(_fwd);
  if (keys.KeyS) _wish.sub(_fwd);
  if (keys.KeyD) _wish.add(_right);
  if (keys.KeyA) _wish.sub(_right);

  const moving = _wish.lengthSq() > 0;
  const speed = (keys.ShiftLeft || keys.ShiftRight) ? SPRINT : WALK;
  if (moving) _wish.normalize().multiplyScalar(speed);

  const accel = player.onGround ? 14 : 4;
  player.vel.x += (_wish.x - player.vel.x) * clamp(accel * dt, 0, 1);
  player.vel.z += (_wish.z - player.vel.z) * clamp(accel * dt, 0, 1);

  if (keys.Space && player.onGround) {
    player.vel.y = JUMP_V;
    player.onGround = false;
  }
  player.vel.y -= GRAVITY * dt;

  player.pos.addScaledVector(player.vel, dt);

  player.onGround = false;
  if (player.pos.y <= EYE_H) { player.pos.y = EYE_H; player.vel.y = 0; player.onGround = true; }
  player.pos.x = clamp(player.pos.x, -ARENA + PLAYER_R, ARENA - PLAYER_R);
  player.pos.z = clamp(player.pos.z, -ARENA + PLAYER_R, ARENA - PLAYER_R);

  const wantX = player.pos.x, wantZ = player.pos.z;
  if (resolveCollisions(player.pos, PLAYER_R, EYE_H, 0)) {
    if (player.vel.y < 0) player.vel.y = 0;
    player.onGround = true;
  }

  // pushed back horizontally? see if it was just a kerb we can walk up
  const blocked = Math.abs(player.pos.x - wantX) > 1e-4 || Math.abs(player.pos.z - wantZ) > 1e-4;
  if (blocked && player.vel.y <= 0 &&
      tryStepUp(player.pos, PLAYER_R, EYE_H, 0, wantX, wantZ, STEP_UP)) {
    player.vel.y = 0;
    player.onGround = true;
  }

  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  bobPhase += dt * hSpeed * 1.5;
  const bobY = player.onGround ? Math.sin(bobPhase * 2) * 0.022 * (hSpeed / WALK) : 0;
  const bobX = player.onGround ? Math.cos(bobPhase) * 0.03 * (hSpeed / WALK) : 0;

  camera.position.copy(player.pos);
  camera.position.y += bobY;

  if (shake > 0) {
    shake = Math.max(0, shake - dt * 4.5);
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.position.z += (Math.random() - 0.5) * shake;
  }

  // the viewmodel camera rides along with the real one
  vmCamera.position.copy(camera.position);
  vmCamera.quaternion.copy(camera.quaternion);

  // Body follows position and yaw only, and strides in time with the head bob.
  // It sits slightly behind the eye — the camera represents the front of the
  // head, so without the offset the chest crowds the bottom of the screen.
  playerRig.root.position.set(
    player.pos.x - Math.sin(player.yaw) * BODY_FWD,
    player.pos.y - EYE_H,
    player.pos.z - Math.cos(player.yaw) * BODY_FWD
  );
  playerRig.root.rotation.y = player.yaw;
  animateHumanoid(playerRig, bobPhase, player.onGround ? clamp(hSpeed / WALK, 0, 1.2) * 0.55 : 0.18);

  gunRecoil = Math.max(0, gunRecoil - dt * 7);
  gun.position.set(
    GUN_HOME.x + bobX * 0.5,
    GUN_HOME.y + bobY * 1.4 - gunRecoil * 0.008,
    GUN_HOME.z + gunRecoil * 0.035
  );
  gun.rotation.set(-gunRecoil * 0.13, GUN_YAW + bobX * 0.1, 0);

  if (loadout.reloading > 0) {
    const t = 1 - loadout.reloading / WEAPONS.pistol.reload;
    gun.rotation.x -= Math.sin(t * Math.PI) * 0.9;
    gun.position.y -= Math.sin(t * Math.PI) * 0.14;
  }
}

// ---------------------------------------------------------------- weapons

function activeSlot() {
  return loadout.equipped === 'pistol' ? loadout.pistol : loadout.special;
}
function activeWeapon() {
  const slot = activeSlot();
  return slot ? WEAPONS[slot.key] : WEAPONS.pistol;
}

function equip(which) {
  if (which === 'special' && !loadout.special) return;
  if (loadout.equipped === which) return;
  loadout.equipped = which;
  loadout.reloading = 0;
  loadout.cooldown = Math.max(loadout.cooldown, 0.22);
  gunRecoil = 0.6;
  refreshGunModel();
  Sfx.weapon();
  updateHUD();
}

function refreshGunModel() {
  const key = activeSlot() ? activeSlot().key : 'pistol';
  for (const k of Object.keys(gunModels)) gunModels[k].visible = (k === key);
  muzzleFlash.material.color.set(WEAPONS[key].flash);
}

function givePickupWeapon(key) {
  loadout.special = { key, ammo: WEAPONS[key].mag };
  loadout.equipped = 'special';
  loadout.reloading = 0;
  loadout.cooldown = 0.25;
  refreshGunModel();
  Sfx.weapon();
  showToast(`${WEAPONS[key].name}  ×${WEAPONS[key].mag}`);
  updateHUD();
}

function startReload() {
  if (!running || loadout.reloading > 0) return;
  if (loadout.equipped !== 'pistol') return;      // scavenged guns have no spare mags
  if (loadout.pistol.ammo >= WEAPONS.pistol.mag) return;
  loadout.reloading = WEAPONS.pistol.reload;
  Sfx.reload();
}

const raycaster = new THREE.Raycaster();
raycaster.far = RANGE;
const _dir = new THREE.Vector3();
const _muzzleWorld = new THREE.Vector3();

function liveHitboxes() {
  const list = [];
  for (const e of enemies) {
    if (e.dying || e.spawnT > 0) continue;
    list.push(e.hitBody, e.hitHead);
  }
  return list;
}

function fire() {
  const w = activeWeapon();
  const slot = activeSlot();
  if (loadout.reloading > 0 || loadout.cooldown > 0) return;

  if (slot.ammo <= 0) {
    if (loadout.equipped === 'pistol') startReload();
    else Sfx.dryFire();
    return;
  }

  slot.ammo--;
  loadout.cooldown = w.rate;
  gunRecoil = w.kick;
  shake = Math.min(0.055, shake + w.shakeAmt * 0.5);
  flashTimer = 0.05;
  muzzleFlash.visible = true;
  muzzleFlash.material.rotation = Math.random() * Math.PI;

  if (w === WEAPONS.pistol) Sfx.pistol();
  else if (w === WEAPONS.shotgun) Sfx.shotgun();
  else if (w === WEAPONS.railgun) Sfx.railgun();
  else Sfx.plasma();

  muzzleFlash.getWorldPosition(_muzzleWorld);
  const targets = [...liveHitboxes(), ...solids];

  for (let p = 0; p < w.pellets; p++) {
    camera.getWorldDirection(_dir);
    _dir.x += (Math.random() - 0.5) * w.spread;
    _dir.y += (Math.random() - 0.5) * w.spread;
    _dir.z += (Math.random() - 0.5) * w.spread;
    _dir.normalize();

    raycaster.set(camera.position, _dir);
    const hits = raycaster.intersectObjects(targets, false);

    let end = null;
    if (w.pierce) {
      // the railgun punches through every enemy until it meets solid geometry
      const struck = new Set();
      for (const h of hits) {
        const enemy = h.object.userData.enemy;
        if (!enemy) { end = h.point.clone(); break; }
        if (!struck.has(enemy)) {
          struck.add(enemy);
          damageEnemy(enemy, w.dmg * (h.object.userData.head ? HEADSHOT_MULT : 1),
                      h.point, h.object.userData.head);
        }
      }
      if (!end) end = camera.position.clone().addScaledVector(_dir, RANGE);
    } else {
      const hit = hits[0];
      end = hit ? hit.point.clone() : camera.position.clone().addScaledVector(_dir, RANGE);
      if (hit && hit.object.userData.enemy) {
        damageEnemy(hit.object.userData.enemy,
                    w.dmg * (hit.object.userData.head ? HEADSHOT_MULT : 1),
                    end, hit.object.userData.head);
      } else if (hit) {
        spawnParticles(end, 0x9fd8ff, 6, 3.5, 0.3);
      }
    }
    spawnTracer(_muzzleWorld, end, w.tracer, w.beam || 0.022, w.beam ? 0.16 : 0.06);
  }

  // a scavenged gun that runs dry is dropped and the pistol comes back up
  if (slot.ammo <= 0 && loadout.equipped === 'special') {
    loadout.special = null;
    loadout.equipped = 'pistol';
    loadout.cooldown = Math.max(loadout.cooldown, 0.45);
    refreshGunModel();
    showToast('SIN MUNICIÓN — PISTOLA');
  }
  updateHUD();
}

// ---------------------------------------------------------------- enemies

const enemies = [];

// Each criminal carries something, modelled into the right hand so it swings with
// the arm: baton, blade, rifle or sledgehammer. Parts point down -Y from the grip
// because that is how the hand hangs.
function buildEnemyWeapon(type, def) {
  const g = new THREE.Group();
  const dark = new THREE.MeshBasicMaterial({ color: 0x0f0a1c });
  const edge = new THREE.LineBasicMaterial({ color: def.accent });
  const hot = new THREE.MeshBasicMaterial({ color: def.accent });

  const part = (geo, mat, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    if (mat === dark) {
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 24), edge));
    }
    g.add(m);
    return m;
  };

  const S = def.height / 1.75;

  if (type === 'thug') {                       // stun baton, held along the forearm
    part(new THREE.CylinderGeometry(0.022 * S, 0.026 * S, 0.62 * S, 6), dark, 0, -0.24 * S, 0);
    part(new THREE.CylinderGeometry(0.030 * S, 0.030 * S, 0.10 * S, 6), hot, 0, -0.53 * S, 0);
  } else if (type === 'runner') {              // short blade angled forward
    const blade = new THREE.BoxGeometry(0.014 * S, 0.42 * S, 0.055 * S);
    part(blade, hot, 0, -0.24 * S, -0.05 * S, -0.35);
    part(new THREE.BoxGeometry(0.036 * S, 0.10 * S, 0.05 * S), dark, 0, -0.05 * S, 0);
  } else if (type === 'gunner') {
    // Built along -Y like the melee weapons. The hand's local down axis is what
    // swings forward when the shoulder pitches up to aim, so a rifle modelled
    // along Z would end up pointing at the floor.
    part(new THREE.BoxGeometry(0.075 * S, 0.46 * S, 0.10 * S), dark, 0, -0.26 * S, 0);
    part(new THREE.CylinderGeometry(0.021 * S, 0.021 * S, 0.34 * S, 6), dark, 0, -0.62 * S, 0);
    part(new THREE.BoxGeometry(0.055 * S, 0.13 * S, 0.055 * S), dark, 0, -0.10 * S, 0.09 * S);
    part(new THREE.BoxGeometry(0.05 * S, 0.05 * S, 0.05 * S), hot, 0, -0.40 * S, -0.06 * S);
  } else {                                     // brute: sledgehammer
    part(new THREE.CylinderGeometry(0.030 * S, 0.034 * S, 0.95 * S, 6), dark, 0, -0.42 * S, 0);
    part(new THREE.BoxGeometry(0.30 * S, 0.16 * S, 0.16 * S), dark, 0, -0.88 * S, 0);
    part(new THREE.BoxGeometry(0.05 * S, 0.17 * S, 0.17 * S), hot, 0.15 * S, -0.88 * S, 0);
  }

  return g;
}

function spawnEnemy(type) {
  const def = ENEMY_TYPES[type];
  const rig = buildHumanoid({
    key: type,
    height: def.height, jacket: def.jacket, trim: def.trim,
    accent: def.accent, bulk: def.bulk || 1,
  });

  const group = new THREE.Group();
  group.add(rig.root);
  group.add(glowSprite(def.accent, def.height * 1.5, 0.32));

  rig.handR.add(buildEnemyWeapon(type, def));

  // Two hitboxes: a generous body covering feet to shoulders, and a tight head
  // worth double. The head is deliberately no bigger than the skull so landing
  // one still takes aim. Both geometries are cached per type.
  const bodyTop = rig.headY - rig.headSize * 0.5;
  const hitBody = new THREE.Mesh(
    getRigGeometry(`${type}:hitBody`,
      () => new THREE.BoxGeometry(def.radius * 2.1, bodyTop, def.radius * 1.7)),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hitBody.position.y = bodyTop / 2;
  group.add(hitBody);

  const hitHead = new THREE.Mesh(
    getRigGeometry(`${type}:hitHead`,
      () => new THREE.BoxGeometry(rig.headSize, rig.headSize, rig.headSize)),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hitHead.position.y = rig.headY;
  group.add(hitHead);

  let x, z, tries = 0;
  do {
    const a = Math.random() * Math.PI * 2;
    const r = ARENA - 4 - Math.random() * 10;
    x = Math.cos(a) * r; z = Math.sin(a) * r;
    tries++;
  } while (tries < 24 && Math.hypot(x - player.pos.x, z - player.pos.z) < 20);

  // never drop one inside a block — the collision resolver would have to shove it
  // out, and from deep inside a wide block there is no good direction to shove
  [x, z] = clearSpot(x, z);

  group.position.set(x, 0, z);
  scene.add(group);

  const enemy = {
    type, def, group, rig, hitBody, hitHead,
    hp: def.hp, maxHp: def.hp,
    phase: Math.random() * Math.PI * 2,
    walkPhase: Math.random() * 6,
    velY: 0,
    attackCd: 0.6 + Math.random() * 0.8,
    flash: 0, spawnT: 0.55, dying: 0, swing: 0,
  };
  hitBody.userData.enemy = enemy;
  hitHead.userData.enemy = enemy;
  hitHead.userData.head = true;
  enemies.push(enemy);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(def.radius * 2.2, 0.05, 6, 24),
    new THREE.MeshBasicMaterial({
      color: def.accent, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  ring.position.set(x, 0.06, z);
  ring.rotation.x = Math.PI / 2;
  scene.add(ring);
  enemy.ring = ring;

  group.scale.setScalar(0.01);
  return enemy;
}

function damageEnemy(enemy, amount, at, isHead) {
  if (enemy.hp <= 0 || enemy.dying) return;
  enemy.hp -= amount;
  enemy.flash = 0.1;
  spawnParticles(at, isHead ? 0xffffff : enemy.def.accent, isHead ? 16 : 9, isHead ? 6 : 4.5, 0.4);
  hitmarker(isHead);

  if (enemy.hp <= 0) killEnemy(enemy, isHead);
  else if (isHead) Sfx.headshot();
  else Sfx.hit();
}

function killEnemy(enemy, isHead) {
  Sfx.kill();
  const centre = enemy.group.position.clone();
  centre.y += enemy.def.height * 0.5;
  spawnParticles(centre, enemy.def.accent, 40, 7, 0.9);
  spawnParticles(centre, 0xffffff, 12, 4.5, 0.45);

  player.score += enemy.def.score * (isHead ? 2 : 1);
  enemy.dying = 0.0001;                     // starts the collapse; AI stops here
  if (enemy.ring) { scene.remove(enemy.ring); enemy.ring = null; }

  for (const m of Object.values(enemy.rig.mats)) {
    m.transparent = true;
  }

  if (Math.random() < 0.22) spawnPickup(enemy.group.position, 'health');
  else if (Math.random() < 0.22) spawnPickup(enemy.group.position, 'energy');

  updateHUD();
}

function removeEnemy(enemy) {
  scene.remove(enemy.group);
  if (enemy.ring) {
    scene.remove(enemy.ring);
    enemy.ring.geometry.dispose();
    enemy.ring.material.dispose();
  }
  // Only materials are per-enemy now; every rig geometry is shared from the cache
  // across all instances of the type, so disposing one would blank out the rest.
  enemy.group.traverse((o) => {
    if (o.material) o.material.dispose();
  });

  const i = enemies.indexOf(enemy);
  if (i >= 0) enemies.splice(i, 1);
}

const _toPlayer = new THREE.Vector3();
const _sep = new THREE.Vector3();

function updateEnemies(dt, time) {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const def = e.def;

    if (e.dying > 0) {
      e.dying += dt;
      const t = clamp(e.dying / 0.55, 0, 1);
      e.rig.root.rotation.x = -t * Math.PI * 0.5;     // topple backwards
      e.group.position.y = -t * 0.35;
      for (const m of Object.values(e.rig.mats)) m.opacity = 1 - t;
      if (t >= 1) removeEnemy(e);
      continue;
    }

    if (e.spawnT > 0) {
      e.spawnT -= dt;
      const t = clamp(1 - e.spawnT / 0.55, 0, 1);
      e.group.scale.setScalar(t * t * (3 - 2 * t));
      if (e.ring) {
        e.ring.scale.setScalar(0.4 + t * 2.2);
        e.ring.material.opacity = 1 - t;
        if (e.spawnT <= 0) { scene.remove(e.ring); e.ring = null; }
      }
      continue;
    }

    _toPlayer.set(player.pos.x - e.group.position.x, 0, player.pos.z - e.group.position.z);
    const dist = _toPlayer.length();
    _toPlayer.normalize();

    _sep.set(0, 0, 0);
    for (const o of enemies) {
      if (o === e || o.dying) continue;
      const dx = e.group.position.x - o.group.position.x;
      const dz = e.group.position.z - o.group.position.z;
      const d2 = dx * dx + dz * dz;
      const minD = def.radius + o.def.radius + 0.5;
      if (d2 < minD * minD && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        _sep.x += (dx / d) * (1 - d / minD);
        _sep.z += (dz / d) * (1 - d / minD);
      }
    }

    // rushers close the gap; gunners hold a firing line and back off if crowded
    let advance;
    if (def.ranged) {
      const gap = dist - def.keepDist;
      advance = clamp(gap * 0.25, -1, 1);
    } else {
      advance = dist < 2.2 ? 0.25 : 1;
    }

    const strafe = Math.sin(time * 1.2 + e.phase) * (def.ranged ? 0.7 : 0.35);
    const vx = (_toPlayer.x * advance - _toPlayer.z * strafe) * def.speed + _sep.x * 4;
    const vz = (_toPlayer.z * advance + _toPlayer.x * strafe) * def.speed + _sep.z * 4;

    const pos = e.group.position;
    pos.x = clamp(pos.x + vx * dt, -ARENA + 1, ARENA - 1);
    pos.z = clamp(pos.z + vz * dt, -ARENA + 1, ARENA - 1);

    // Enemies get the same gravity and step assist as the player. Without it they
    // are stuck on the floor and anyone standing on the central platform is safe
    // from every melee type in the game.
    e.velY -= GRAVITY * dt;
    pos.y += e.velY * dt;
    if (pos.y <= 0) { pos.y = 0; e.velY = 0; }

    const wantX = pos.x, wantZ = pos.z;
    if (resolveCollisions(pos, def.radius, 0, def.height) || pos.y <= 0) e.velY = 0;

    if ((Math.abs(pos.x - wantX) > 1e-4 || Math.abs(pos.z - wantZ) > 1e-4) && e.velY <= 0 &&
        tryStepUp(pos, def.radius, 0, def.height, wantX, wantZ, STEP_UP)) {
      e.velY = 0;
    }

    // the rig faces -Z, so this turns that face toward the player
    e.group.rotation.y = Math.atan2(-_toPlayer.x, -_toPlayer.z);

    const moveSpeed = Math.hypot(vx, vz);
    e.walkPhase += dt * (2.2 + moveSpeed * 1.1);
    if (e.swing > 0) e.swing = Math.max(0, e.swing - dt);
    animateHumanoid(
      e.rig, e.walkPhase, clamp(moveSpeed / (def.speed || 1), 0.1, 1.1) * 0.42,
      def.ranged ? 1.35 : 0,      // gunners hold the rifle up
      e.swing                     // melee types chop when they connect
    );

    if (e.flash > 0) {
      e.flash -= dt;
      const on = e.flash > 0;
      e.rig.mats.accent.color.set(on ? 0xffffff : def.accent);
      e.rig.mats.edge.color.set(on ? 0xffffff : def.trim);
    }

    e.attackCd -= dt;

    if (def.ranged) {
      if (e.attackCd <= 0 && dist < 40 && player.alive) {
        e.attackCd = def.fireEvery * (0.75 + Math.random() * 0.5);
        fireEnemyShot(e);
      }
    } else if (dist < def.radius + 1.2 && e.attackCd <= 0 && player.alive &&
               Math.abs((player.pos.y - EYE_H) - pos.y) < def.height * 0.8) {
      e.attackCd = 0.9;
      e.swing = 0.35;                       // drives the melee arc on the weapon arm
      damagePlayer(def.dmg);
      pos.x -= _toPlayer.x * 1.2;
      pos.z -= _toPlayer.z * 1.2;
      spawnParticles(
        new THREE.Vector3(pos.x, pos.y + def.height * 0.6, pos.z),
        def.accent, 12, 4, 0.4
      );
    }
  }
}

// ---------------------------------------------------------------- enemy projectiles

const MAX_SHOTS = 60;
const shots = [];
const shotGeo = new THREE.SphereGeometry(0.16, 8, 6);

for (let i = 0; i < MAX_SHOTS; i++) {
  const mesh = new THREE.Mesh(shotGeo, new THREE.MeshBasicMaterial({ color: 0xb6ff4d }));
  const halo = glowSprite(0xb6ff4d, 1.1, 0.7);
  mesh.add(halo);
  mesh.visible = false;
  scene.add(mesh);
  shots.push({ mesh, halo, alive: false, vel: new THREE.Vector3(), life: 0, dmg: 0 });
}

const _shotDir = new THREE.Vector3();

function fireEnemyShot(e) {
  const s = shots.find(o => !o.alive);
  if (!s) return;

  const origin = new THREE.Vector3(
    e.group.position.x,
    e.group.position.y + e.def.height * 0.72,   // enemies can be up on a platform
    e.group.position.z
  );
  // aim at the chest, not the eye, and let the shot be slow enough to sidestep
  _shotDir.set(
    player.pos.x - origin.x,
    (player.pos.y - 0.35) - origin.y,
    player.pos.z - origin.z
  ).normalize();

  s.mesh.position.copy(origin).addScaledVector(_shotDir, e.def.radius + 0.4);
  s.vel.copy(_shotDir).multiplyScalar(e.def.projSpeed);
  s.dmg = e.def.dmg;
  s.life = 4;
  s.alive = true;
  s.mesh.visible = true;
  s.mesh.material.color.set(e.def.accent);
  s.halo.material.color.set(e.def.accent);

  spawnParticles(origin, e.def.accent, 6, 3, 0.25);
  Sfx.enemyShot();
}

function updateShots(dt) {
  for (const s of shots) {
    if (!s.alive) continue;
    s.life -= dt;
    s.mesh.position.addScaledVector(s.vel, dt);

    const p = s.mesh.position;
    const dx = p.x - player.pos.x;
    const dy = p.y - (player.pos.y - EYE_H * 0.45);
    const dz = p.z - player.pos.z;
    const hitPlayer = player.alive &&
      Math.hypot(dx, dz) < PLAYER_R + 0.3 && Math.abs(dy) < EYE_H * 0.62;

    if (hitPlayer) {
      damagePlayer(s.dmg);
      spawnParticles(p, 0xff4d6a, 14, 4, 0.4);
      s.alive = false; s.mesh.visible = false;
    } else if (s.life <= 0 || p.y < 0.05 || Math.abs(p.x) > ARENA || Math.abs(p.z) > ARENA ||
               pointInObstacle(p, 0.1)) {
      spawnParticles(p, s.mesh.material.color.getHex(), 8, 3, 0.3);
      s.alive = false; s.mesh.visible = false;
    }
  }
}

// ---------------------------------------------------------------- weapon pedestals

const pedestals = [];
const PEDESTAL_SPOTS = [
  [-30, -22], [32, -14], [-13, 33], [27, 29], [-38, 9], [7, -35], [40, 2], [-6, -12],
];

function buildWeaponIcon(key) {
  const g = new THREE.Group();
  const edge = new THREE.LineBasicMaterial({ color: WEAPONS[key].tracer });
  const body = new THREE.MeshBasicMaterial({ color: 0x140a28 });

  const part = (w, h, d, x, y, z) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, body);
    m.position.set(x, y, z);
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edge));
    g.add(m);
  };

  if (key === 'shotgun') { part(0.16, 0.18, 0.9, 0, 0, 0); part(0.1, 0.14, 0.8, 0, -0.1, -0.05); }
  else if (key === 'railgun') { part(0.15, 0.17, 0.8, 0, 0, 0); part(0.07, 0.07, 1.0, 0, 0.06, -0.5); }
  else { part(0.17, 0.2, 0.7, 0, 0, 0); part(0.1, 0.1, 0.4, 0, 0.03, -0.5); }

  g.add(glowSprite(WEAPONS[key].tracer, 2.6, 0.42));
  return g;
}

function createPedestal(x, z, key) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.1, 0.25, 12),
    new THREE.MeshBasicMaterial({ color: 0x0d0524 })
  );
  base.position.y = 0.125;
  base.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(base.geometry),
    new THREE.LineBasicMaterial({ color: 0x4dfcff })
  ));
  group.add(base);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.95, 0.04, 6, 28),
    new THREE.MeshBasicMaterial({
      color: WEAPONS[key].tracer, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.3;
  group.add(ring);

  const icon = buildWeaponIcon(key);
  icon.position.y = 1.25;
  group.add(icon);

  const label = textSprite(WEAPONS[key].name, WEAPONS[key].tracer);
  label.position.y = 2.15;
  group.add(label);

  scene.add(group);
  const ped = { group, icon, label, ring, key, ready: true, respawn: 0 };
  pedestals.push(ped);
  return ped;
}

// the cover blocks are placed by a seeded RNG, so a hand-picked pedestal spot can
// land inside one; spiral outwards until the pedestal stands in the open
function clearSpot(x, z) {
  const probe = new THREE.Vector3();
  for (let r = 0; r <= 10; r += 1.4) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      if (Math.abs(px) > ARENA - 3 || Math.abs(pz) > ARENA - 3) continue;
      probe.set(px, 1.2, pz);
      if (!pointInObstacle(probe, 1.6)) return [px, pz];
      if (r === 0) break;   // the centre is a single point, no need to sweep it
    }
  }
  return [x, z];
}

PEDESTAL_SPOTS.forEach(([x, z], i) => {
  const [px, pz] = clearSpot(x, z);
  createPedestal(px, pz, SPECIALS[i % SPECIALS.length]);
});

function updatePedestals(dt, time) {
  for (const ped of pedestals) {
    if (!ped.ready) {
      ped.respawn -= dt;
      if (ped.respawn <= 0) {
        ped.ready = true;
        ped.icon.visible = ped.label.visible = true;
        spawnParticles(ped.group.position, WEAPONS[ped.key].tracer, 20, 4, 0.6);
        Sfx.pickup();
      }
      ped.ring.material.opacity = 0.12;
      continue;
    }

    ped.ring.material.opacity = 0.55 + Math.sin(time * 3) * 0.25;
    ped.icon.rotation.y += dt * 1.4;
    ped.icon.position.y = 1.25 + Math.sin(time * 2 + ped.group.position.x) * 0.12;

    const dx = ped.group.position.x - player.pos.x;
    const dz = ped.group.position.z - player.pos.z;
    if (dx * dx + dz * dz < 2.6 * 2.6) {
      ped.ready = false;
      ped.respawn = 25;
      ped.icon.visible = ped.label.visible = false;
      spawnParticles(ped.group.position, WEAPONS[ped.key].tracer, 24, 5, 0.6);
      givePickupWeapon(ped.key);
    }
  }
}

// ---------------------------------------------------------------- drop pickups

const pickups = [];

function spawnPickup(at, kind) {
  const color = kind === 'health' ? 0x4dff8f : 0x9d4dff;
  const group = new THREE.Group();
  group.add(new THREE.Mesh(
    new THREE.OctahedronGeometry(0.3, 0),
    new THREE.MeshBasicMaterial({ color })
  ));
  group.add(glowSprite(color, 1.6));
  group.position.set(at.x, 0.7, at.z);
  scene.add(group);
  pickups.push({ group, kind, phase: Math.random() * 6 });
}

function updatePickups(dt, time) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.group.rotation.y += dt * 2;
    p.group.position.y = 0.7 + Math.sin(time * 2.5 + p.phase) * 0.18;

    // the orb floats near the ground while player.pos is the eye, so ~1m of the
    // radius is spent on the height difference alone
    if (p.group.position.distanceTo(player.pos) < 2.1) {
      if (p.kind === 'health') {
        player.hp = Math.min(player.maxHp, player.hp + 25);
        showToast('+25 VIDA');
      } else {
        slowmo.energy = Math.min(1, slowmo.energy + 0.5);
        showToast('+ENERGÍA');
      }
      Sfx.pickup();
      spawnParticles(p.group.position, p.kind === 'health' ? 0x4dff8f : 0x9d4dff, 18, 4, 0.5);
      scene.remove(p.group);
      pickups.splice(i, 1);
      updateHUD();
    }
  }
}

// ---------------------------------------------------------------- slow motion

function toggleSlowmo() {
  if (!running) return;
  if (slowmo.active) {
    slowmo.active = false;
    Sfx.slowOff();
  } else {
    if (slowmo.energy < SLOW.minToStart) { Sfx.dryFire(); return; }
    slowmo.active = true;
    Sfx.slowOn();
  }
  el.slowVignette.classList.toggle('active', slowmo.active);
}

function updateSlowmo(dt) {
  if (slowmo.active) {
    slowmo.energy -= SLOW.drain * dt;
    if (slowmo.energy <= 0) {
      slowmo.energy = 0;
      slowmo.active = false;
      el.slowVignette.classList.remove('active');
      Sfx.slowOff();
    }
  } else if (slowmo.energy < 1) {
    slowmo.energy = Math.min(1, slowmo.energy + SLOW.recharge * dt);
  }

  const targetFov = slowmo.active ? BASE_FOV + 6 : BASE_FOV;
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov += (targetFov - camera.fov) * clamp(dt * 6, 0, 1);
    camera.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------- waves

let wave = 0;
let queue = [];
let spawnTimer = 0;
let waveBreak = 0;

function buildWave(n) {
  const list = [];
  const total = 4 + Math.round(n * 2.0);
  for (let i = 0; i < total; i++) {
    const r = Math.random();
    if (n >= 4 && r < 0.10 + n * 0.010) list.push('brute');
    else if (n >= 2 && r < 0.36) list.push('gunner');
    else if (n >= 2 && r < 0.60) list.push('runner');
    else list.push('thug');
  }
  return list;
}

function nextWave() {
  wave++;
  queue = buildWave(wave);
  spawnTimer = 0;
  Sfx.wave();
  showWaveBanner(`OLEADA ${wave}`);
  updateHUD();
}

function livingEnemies() {
  let n = 0;
  for (const e of enemies) if (!e.dying) n++;
  return n;
}

function updateWaves(dt) {
  if (queue.length > 0) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnEnemy(queue.pop());
      spawnTimer = 0.35;
    }
  } else if (livingEnemies() === 0) {
    waveBreak -= dt;
    if (waveBreak <= 0) {
      waveBreak = 3.2;
      nextWave();
    }
  }
}

// ---------------------------------------------------------------- HUD

const el = {
  health: document.getElementById('healthFill'),
  healthNum: document.getElementById('healthNum'),
  slowFill: document.getElementById('slowFill'),
  weaponName: document.getElementById('weaponName'),
  ammoBlock: document.getElementById('ammoBlock'),
  ammo: document.getElementById('ammo'),
  ammoSep: document.getElementById('ammoSep'),
  ammoReserve: document.getElementById('ammoReserve'),
  score: document.getElementById('score'),
  wave: document.getElementById('wave'),
  hitFlash: document.getElementById('hitFlash'),
  vignette: document.getElementById('lowHealthVignette'),
  slowVignette: document.getElementById('slowVignette'),
  crosshair: document.getElementById('crosshair'),
  banner: document.getElementById('waveBanner'),
  toast: document.getElementById('pickupToast'),
  start: document.getElementById('startScreen'),
  startTitle: document.getElementById('startTitle'),
  startBtn: document.getElementById('startBtn'),
  startHint: document.getElementById('startHint'),
  gameOver: document.getElementById('gameOverScreen'),
  finalScore: document.getElementById('finalScore'),
  finalWave: document.getElementById('finalWave'),
};

function updateHUD() {
  const pct = clamp(player.hp / player.maxHp, 0, 1);
  el.health.style.width = `${pct * 100}%`;
  el.healthNum.textContent = Math.ceil(player.hp);

  const slot = activeSlot();
  const w = activeWeapon();
  const isSpecial = loadout.equipped === 'special';

  el.weaponName.textContent = w.name;
  el.weaponName.classList.toggle('special', isSpecial);
  el.ammoBlock.classList.toggle('special', isSpecial);
  el.ammo.textContent = slot ? slot.ammo : 0;
  el.ammoSep.style.display = isSpecial ? 'none' : '';
  el.ammoReserve.style.display = isSpecial ? 'none' : '';
  el.ammoBlock.classList.toggle('low', slot ? slot.ammo <= (isSpecial ? 1 : 3) : false);

  el.score.textContent = player.score;
  el.wave.textContent = Math.max(1, wave);
  el.vignette.style.boxShadow = pct < 0.4
    ? `inset 0 0 150px 40px rgba(255, 0, 40, ${(0.4 - pct) * 1.6})`
    : 'inset 0 0 150px 40px rgba(255, 0, 40, 0)';
}

let hitFlashT = 0;
function damagePlayer(amount) {
  if (!player.alive) return;
  player.hp -= amount;
  hitFlashT = 0.35;
  // kept small on purpose: a big positional jolt reads as the view being yanked
  shake = Math.min(0.10, shake + 0.045);
  Sfx.hurt();
  if (player.hp <= 0) {
    player.hp = 0;
    gameOver();
  }
  updateHUD();
}

let hitmarkerT = 0;
function hitmarker(isHead) {
  hitmarkerT = isHead ? 0.14 : 0.09;
  el.crosshair.style.transform = `translate(-50%, -50%) scale(${isHead ? 1.9 : 1.5})`;
}

function showWaveBanner(text) {
  el.banner.textContent = text;
  el.banner.classList.remove('show');
  void el.banner.offsetWidth;   // restart the animation
  el.banner.classList.add('show');
}

function showToast(text) {
  el.toast.textContent = text;
  el.toast.classList.remove('show');
  void el.toast.offsetWidth;
  el.toast.classList.add('show');
}

// ---------------------------------------------------------------- game flow

let running = false;
let runActive = false;
let freshStart = false;
const clock = new THREE.Clock();

function startGame() {
  Sfx.init();
  resetGame();
  runActive = true;
  freshStart = true;
  controls.lock();
}

function resumeGame() {
  Sfx.init();
  controls.lock();
}

function resetGame() {
  for (const e of [...enemies]) removeEnemy(e);
  for (const p of pickups) scene.remove(p.group);
  pickups.length = 0;
  for (const s of shots) { s.alive = false; s.mesh.visible = false; }
  for (const ped of pedestals) {
    ped.ready = true;
    ped.respawn = 0;
    ped.icon.visible = ped.label.visible = true;
  }
  pLife.fill(0);

  player.pos.set(0, EYE_H, ARENA - 8);
  player.vel.set(0, 0, 0);
  camera.position.copy(player.pos);   // so the first frame raycasts from the right spot
  player.hp = player.maxHp;
  player.score = 0;
  player.alive = true;

  loadout.pistol.ammo = WEAPONS.pistol.mag;
  loadout.special = null;
  loadout.equipped = 'pistol';
  loadout.reloading = 0;
  loadout.cooldown = 0;
  refreshGunModel();

  slowmo.active = false;
  slowmo.energy = 1;
  el.slowVignette.classList.remove('active');
  camera.fov = BASE_FOV;
  camera.updateProjectionMatrix();

  wave = 0;
  queue = [];
  waveBreak = 0.6;
  shake = 0;

  el.gameOver.classList.add('hidden');
  updateHUD();
}

function gameOver() {
  player.alive = false;
  running = false;
  runActive = false;
  slowmo.active = false;
  el.slowVignette.classList.remove('active');
  el.finalScore.textContent = player.score;
  el.finalWave.textContent = Math.max(1, wave);
  controls.unlock();
  el.gameOver.classList.remove('hidden');
}

// browsers refuse pointer lock for about a second after Esc releases it
document.addEventListener('pointerlockerror', () => {
  el.startHint.textContent = 'El navegador bloqueó el puntero — espera un segundo y vuelve a hacer click.';
});

controls.addEventListener('lock', () => {
  el.startHint.textContent = '';
  el.start.classList.add('hidden');
  el.gameOver.classList.add('hidden');
  if (freshStart) {
    camera.rotation.set(0, 0, 0);   // spawn is at +Z, so -Z faces the arena centre
    freshStart = false;
  }
  running = true;
  clock.getDelta();     // discard the time spent in the menu
});

controls.addEventListener('unlock', () => {
  running = false;
  triggerHeld = false;
  if (player.alive) {
    el.startTitle.textContent = runActive ? 'PAUSA' : 'NEON BREACH';
    el.startBtn.textContent = runActive ? 'CONTINUAR' : 'CLICK PARA JUGAR';
    el.start.classList.remove('hidden');
  }
});

el.startBtn.addEventListener('click', () => (runActive ? resumeGame() : startGame()));
el.start.addEventListener('click', (e) => {
  if (e.target !== el.startBtn) (runActive ? resumeGame() : startGame());
});
document.getElementById('restartBtn').addEventListener('click', startGame);

// ---------------------------------------------------------------- loop

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  vmCamera.aspect = camera.aspect;
  vmCamera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.setSize(window.innerWidth, window.innerHeight);
});

let elapsed = 0;

// One tick of simulation, kept separate from the render driver so it can also be
// stepped deterministically.
function step(dt) {
  // bullet time slows the world hard and the player only somewhat; aiming stays
  // at full speed because it is driven by raw mouse input
  updateSlowmo(dt);
  const wdt = slowmo.active ? dt * SLOW.world : dt;
  const pdt = slowmo.active ? dt * SLOW.player : dt;
  elapsed += wdt;

  updatePlayer(pdt);
  updateWaves(wdt);
  updateEnemies(wdt, elapsed);
  updateShots(wdt);
  updatePedestals(wdt, elapsed);
  updatePickups(wdt, elapsed);

  loadout.cooldown -= pdt;
  if (loadout.reloading > 0) {
    loadout.reloading -= pdt;
    if (loadout.reloading <= 0) {
      loadout.pistol.ammo = WEAPONS.pistol.mag;
      updateHUD();
    }
  }
  if (triggerHeld && (activeWeapon().auto || !triggerConsumed)) {
    triggerConsumed = true;
    fire();
  }

  if (flashTimer > 0) {
    flashTimer -= dt;
    if (flashTimer <= 0) muzzleFlash.visible = false;
  }
  if (hitFlashT > 0) {
    hitFlashT -= dt;
    el.hitFlash.style.opacity = Math.max(0, hitFlashT / 0.35);
  }
  if (hitmarkerT > 0) {
    hitmarkerT -= dt;
    if (hitmarkerT <= 0) el.crosshair.style.transform = 'translate(-50%, -50%) scale(1)';
  }

  el.slowFill.style.width = `${slowmo.energy * 100}%`;
  el.slowFill.classList.toggle('depleted', slowmo.energy < SLOW.minToStart);

  for (const t of tracers) {
    if (t.life > 0) {
      t.life -= dt;
      t.mesh.material.opacity = clamp(t.life / t.max, 0, 1);
      if (t.life <= 0) t.mesh.visible = false;
    }
  }

  updateParticles(wdt);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (running) {
    step(dt);
  } else {
    if (!runActive) {
      elapsed += dt;
      camera.position.set(Math.cos(elapsed * 0.12) * 22, 6.5, Math.sin(elapsed * 0.12) * 22);
      camera.lookAt(0, 3.5, 0);
    }
    updateParticles(dt);
  }
  composer.render();
}

// stand the body at the spawn point so it isn't left at the origin behind the menu
playerRig.root.position.set(player.pos.x, 0, player.pos.z);


refreshGunModel();
updateHUD();
animate();

