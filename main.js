import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------- constants

const ARENA = 34;          // half-extent of the playable floor
const WALL_H = 9;
const EYE_H = 1.7;
const PLAYER_R = 0.45;
const GRAVITY = 24;
const JUMP_V = 8.2;
const WALK = 7.4;
const SPRINT = 11.6;

const WEAPON = {
  damage: 26,
  fireRate: 0.085,
  magSize: 30,
  reserveMax: 180,
  reloadTime: 1.35,
  spread: 0.012,
  range: 200,
};

const ENEMY_TYPES = {
  grunt: { hp: 40,  speed: 3.5, dmg: 12, size: 0.85, color: 0xff3fb0, score: 100 },
  swift: { hp: 22,  speed: 6.4, dmg: 8,  size: 0.55, color: 0x4dfcff, score: 150 },
  brute: { hp: 150, speed: 2.3, dmg: 26, size: 1.5,  color: 0xffa23f, score: 320 },
};

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
  shoot()  { this.tone('sawtooth', 880, 90, 0.10, 0.09); this.burst(0.05, 0.06, 6000, 900); },
  hit()    { this.tone('sine', 1500, 900, 0.07, 0.05); },
  kill()   { this.burst(0.16, 0.35, 3500, 120); this.tone('square', 300, 60, 0.06, 0.3); },
  hurt()   { this.tone('square', 140, 55, 0.16, 0.28); },
  reload() { this.tone('square', 260, 200, 0.05, 0.04); setTimeout(() => this.tone('square', 400, 320, 0.05, 0.05), 180); },
  pickup() { this.tone('sine', 700, 1400, 0.09, 0.16); },
  wave()   { this.tone('triangle', 300, 600, 0.10, 0.25); setTimeout(() => this.tone('triangle', 500, 900, 0.10, 0.35), 200); },
};

// ---------------------------------------------------------------- renderer / scene

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0a0316, 0.019);

const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.01, 500);
scene.add(camera);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), 0.62, 0.5, 0.35
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- world

// sky gradient dome
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

// floor with a glowing grid
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

// solid geometry the player, enemies and bullets collide with
const obstacles = [];   // { box: THREE.Box3 }
const solids = [];      // meshes for bullet raycasts

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

  const box = new THREE.Box3().setFromCenterAndSize(
    mesh.position, new THREE.Vector3(w, h, d)
  );
  obstacles.push({ box });
  return mesh;
}

// perimeter walls
addBlock(0,  WALL_H / 2, -ARENA - 0.5, ARENA * 2 + 2, WALL_H, 1, 0x4dfcff);
addBlock(0,  WALL_H / 2,  ARENA + 0.5, ARENA * 2 + 2, WALL_H, 1, 0x4dfcff);
addBlock(-ARENA - 0.5, WALL_H / 2, 0, 1, WALL_H, ARENA * 2 + 2, 0xff3fb0);
addBlock( ARENA + 0.5, WALL_H / 2, 0, 1, WALL_H, ARENA * 2 + 2, 0xff3fb0);

// scattered cover
for (let i = 0; i < 18; i++) {
  const a = rand() * Math.PI * 2;
  const r = 7 + rand() * (ARENA - 11);
  const w = 2 + rand() * 4;
  const h = 1.6 + rand() * 5;
  const d = 2 + rand() * 4;
  addBlock(
    Math.cos(a) * r, h / 2, Math.sin(a) * r,
    w, h, d, NEON[(rand() * NEON.length) | 0]
  );
}

// central pillar landmark
addBlock(0, 4, 0, 3, 8, 3, 0xb6ff4d);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));

// ---------------------------------------------------------------- particles

const MAX_P = 1400;
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
const tracerGeo = new THREE.CylinderGeometry(0.022, 0.022, 1, 6, 1, true);
tracerGeo.translate(0, 0.5, 0);
tracerGeo.rotateX(Math.PI / 2);   // aligned down -Z so lookAt() works

for (let i = 0; i < 20; i++) {
  const m = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({
    color: 0xbff7ff, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, fog: false,
  }));
  m.visible = false;
  scene.add(m);
  tracers.push({ mesh: m, life: 0 });
}
let tracerCursor = 0;

function spawnTracer(from, to) {
  const t = tracers[tracerCursor];
  tracerCursor = (tracerCursor + 1) % tracers.length;
  t.mesh.position.copy(from);
  t.mesh.lookAt(to);
  t.mesh.scale.set(1, 1, from.distanceTo(to));
  t.mesh.visible = true;
  t.life = 0.06;
}

// ---------------------------------------------------------------- weapon viewmodel

// a wide FOV distorts anything held close to the lens, so the viewmodel is kept
// small and pushed out; the yaw angles it inward so it reads as a gun, not a slab
const GUN_HOME = new THREE.Vector3(0.155, -0.135, -0.42);
const GUN_YAW = 0.075;

const gun = new THREE.Group();
gun.position.copy(GUN_HOME);
gun.rotation.y = GUN_YAW;
gun.scale.setScalar(0.52);
camera.add(gun);

// solid dark shells with neon edge outlines — the outlines are what the bloom catches
const gunShellMat = new THREE.MeshBasicMaterial({ color: 0x120a24 });

function gunPart(w, h, d, x, y, z, edgeColor) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, gunShellMat);
  mesh.position.set(x, y, z);
  gun.add(mesh);

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: edgeColor, fog: false })
  );
  edges.position.copy(mesh.position);
  gun.add(edges);
  return mesh;
}

gunPart(0.058, 0.070, 0.28, 0, 0, -0.07, 0x4dfcff);        // receiver
gunPart(0.028, 0.028, 0.20, 0, 0.010, -0.29, 0x4dfcff);    // barrel shroud
gunPart(0.036, 0.075, 0.045, 0, -0.055, -0.08, 0xff3fb0);  // magazine
gunPart(0.044, 0.090, 0.055, 0, -0.058, 0.055, 0x9d4dff);  // grip
gunPart(0.011, 0.020, 0.011, 0, 0.046, -0.20, 0xb6ff4d);   // front sight

const muzzleFlash = glowSprite(0xfff0a0, 0.5);
muzzleFlash.position.set(0, 0.012, -0.42);
muzzleFlash.visible = false;
gun.add(muzzleFlash);

const muzzleLight = new THREE.PointLight(0xffd27a, 0, 12, 2);
muzzleLight.position.copy(muzzleFlash.position);
gun.add(muzzleLight);

let gunRecoil = 0;
let bobPhase = 0;
let flashTimer = 0;

// ---------------------------------------------------------------- player

const controls = new PointerLockControls(camera, document.body);

const player = {
  pos: new THREE.Vector3(0, EYE_H, ARENA - 8),
  vel: new THREE.Vector3(),
  onGround: true,
  hp: 100,
  maxHp: 100,
  score: 0,
  alive: true,
};

const weapon = { ammo: WEAPON.magSize, reserve: 90, cooldown: 0, reloading: 0 };

const keys = Object.create(null);
let shake = 0;

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyR') startReload();
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

let firing = false;
addEventListener('mousedown', (e) => { if (e.button === 0) firing = true; });
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });

// Slide a body out of any obstacle it overlaps, and report whether it ended up
// standing on one. `pos` is the reference point; the body spans `hDown` below it
// and `hUp` above — the player's reference point is their eye (hUp 0), an enemy's
// is its centre. Expanding the box by those amounts turns the test into a point
// check, so the forbidden y range is [min.y - hUp, max.y + hDown].
const _min = new THREE.Vector3(), _max = new THREE.Vector3();
function resolveCollisions(pos, radius, hDown, hUp) {
  let grounded = false;
  for (const { box } of obstacles) {
    _min.set(box.min.x - radius, box.min.y - hUp, box.min.z - radius);
    _max.set(box.max.x + radius, box.max.y + hDown, box.max.z + radius);
    if (pos.x < _min.x || pos.x > _max.x || pos.y < _min.y ||
        pos.y > _max.y || pos.z < _min.z || pos.z > _max.z) continue;

    // push out along the axis with the smallest penetration
    const px = Math.min(pos.x - _min.x, _max.x - pos.x);
    const py = Math.min(pos.y - _min.y, _max.y - pos.y);
    const pz = Math.min(pos.z - _min.z, _max.z - pos.z);

    if (py <= px && py <= pz) {
      if (pos.y - _min.y < _max.y - pos.y) {
        pos.y = _min.y;               // clipped the underside
      } else {
        pos.y = _max.y;               // landed on top
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

const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _wish = new THREE.Vector3();

function updatePlayer(dt) {
  camera.getWorldDirection(_fwd);
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

  // horizontal acceleration with friction
  const accel = player.onGround ? 14 : 4;
  player.vel.x += (_wish.x - player.vel.x) * clamp(accel * dt, 0, 1);
  player.vel.z += (_wish.z - player.vel.z) * clamp(accel * dt, 0, 1);

  if (keys.Space && player.onGround) {
    player.vel.y = JUMP_V;
    player.onGround = false;
  }
  player.vel.y -= GRAVITY * dt;

  player.pos.addScaledVector(player.vel, dt);

  // floor + arena bounds
  player.onGround = false;
  if (player.pos.y <= EYE_H) { player.pos.y = EYE_H; player.vel.y = 0; player.onGround = true; }
  player.pos.x = clamp(player.pos.x, -ARENA + PLAYER_R, ARENA - PLAYER_R);
  player.pos.z = clamp(player.pos.z, -ARENA + PLAYER_R, ARENA - PLAYER_R);

  // the player's reference point is the eye, so the body hangs EYE_H below it
  if (resolveCollisions(player.pos, PLAYER_R, EYE_H, 0)) {
    if (player.vel.y < 0) player.vel.y = 0;
    player.onGround = true;
  }

  // view bob
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  bobPhase += dt * hSpeed * 1.5;
  const bobY = player.onGround ? Math.sin(bobPhase * 2) * 0.022 * (hSpeed / WALK) : 0;
  const bobX = player.onGround ? Math.cos(bobPhase) * 0.03 * (hSpeed / WALK) : 0;

  camera.position.copy(player.pos);
  camera.position.y += bobY;

  if (shake > 0) {
    shake = Math.max(0, shake - dt * 3.2);
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.position.z += (Math.random() - 0.5) * shake;
  }

  // weapon sway follows the bob, recoil kicks back and up
  gunRecoil = Math.max(0, gunRecoil - dt * 7);
  gun.position.set(
    GUN_HOME.x + bobX * 0.5,
    GUN_HOME.y + bobY * 1.4 - gunRecoil * 0.008,
    GUN_HOME.z + gunRecoil * 0.035
  );
  gun.rotation.set(-gunRecoil * 0.13, GUN_YAW + bobX * 0.1, 0);

  if (weapon.reloading > 0) {
    const t = 1 - weapon.reloading / WEAPON.reloadTime;
    gun.rotation.x -= Math.sin(t * Math.PI) * 0.9;
    gun.position.y -= Math.sin(t * Math.PI) * 0.14;
  }
}

// ---------------------------------------------------------------- shooting

const raycaster = new THREE.Raycaster();
raycaster.far = WEAPON.range;
const _dir = new THREE.Vector3();
const _muzzleWorld = new THREE.Vector3();

function startReload() {
  if (!running || weapon.reloading > 0) return;
  if (weapon.ammo >= WEAPON.magSize || weapon.reserve <= 0) return;
  weapon.reloading = WEAPON.reloadTime;
  Sfx.reload();
}

function fire() {
  if (weapon.reloading > 0 || weapon.cooldown > 0) return;
  if (weapon.ammo <= 0) { startReload(); return; }

  weapon.ammo--;
  weapon.cooldown = WEAPON.fireRate;
  gunRecoil = 1;
  shake = Math.min(0.09, shake + 0.035);
  flashTimer = 0.045;
  muzzleFlash.visible = true;
  muzzleFlash.material.rotation = Math.random() * Math.PI;
  muzzleLight.intensity = 6;
  Sfx.shoot();

  camera.getWorldDirection(_dir);
  _dir.x += (Math.random() - 0.5) * WEAPON.spread;
  _dir.y += (Math.random() - 0.5) * WEAPON.spread;
  _dir.z += (Math.random() - 0.5) * WEAPON.spread;
  _dir.normalize();

  raycaster.set(camera.position, _dir);
  muzzleFlash.getWorldPosition(_muzzleWorld);

  const hits = raycaster.intersectObjects([...enemies.map(e => e.hitbox), ...solids], false);
  const hit = hits[0];
  const end = hit
    ? hit.point.clone()
    : camera.position.clone().addScaledVector(_dir, WEAPON.range);

  spawnTracer(_muzzleWorld, end);

  if (hit && hit.object.userData.enemy) {
    const enemy = hit.object.userData.enemy;
    damageEnemy(enemy, WEAPON.damage, end);
  } else if (hit) {
    spawnParticles(end, 0x9fd8ff, 8, 3.5, 0.35);
  }
  updateHUD();
}

// ---------------------------------------------------------------- enemies

const enemies = [];
const enemyGeoCache = {};

function enemyMeshes(type) {
  if (!enemyGeoCache[type]) {
    const s = ENEMY_TYPES[type].size;
    enemyGeoCache[type] = {
      core: new THREE.IcosahedronGeometry(s * 0.5, 0),
      shell: new THREE.IcosahedronGeometry(s, 1),
      hit: new THREE.SphereGeometry(s * 1.05, 10, 8),
    };
  }
  return enemyGeoCache[type];
}

function spawnEnemy(type) {
  const def = ENEMY_TYPES[type];
  const geo = enemyMeshes(type);
  const group = new THREE.Group();

  const coreMat = new THREE.MeshBasicMaterial({ color: def.color });
  const core = new THREE.Mesh(geo.core, coreMat);
  group.add(core);

  const shellMat = new THREE.MeshBasicMaterial({
    color: def.color, wireframe: true, transparent: true, opacity: 0.55,
  });
  const shell = new THREE.Mesh(geo.shell, shellMat);
  group.add(shell);

  group.add(glowSprite(def.color, def.size * 2.4, 0.5));

  const hitbox = new THREE.Mesh(geo.hit, new THREE.MeshBasicMaterial({ visible: false }));
  group.add(hitbox);

  // spawn on a ring, away from the player
  let x, z, tries = 0;
  do {
    const a = Math.random() * Math.PI * 2;
    const r = ARENA - 4 - Math.random() * 8;
    x = Math.cos(a) * r; z = Math.sin(a) * r;
    tries++;
  } while (tries < 24 && Math.hypot(x - player.pos.x, z - player.pos.z) < 18);

  const baseY = 1.1 + Math.random() * 1.4;
  group.position.set(x, baseY, z);
  scene.add(group);

  const enemy = {
    type, group, core, shell, hitbox, coreMat, shellMat,
    hp: def.hp, maxHp: def.hp, def,
    baseY, phase: Math.random() * Math.PI * 2,
    attackCd: 0, flash: 0, spawnT: 0.55,
  };
  hitbox.userData.enemy = enemy;
  enemies.push(enemy);

  // spawn telegraph
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(def.size * 1.6, 0.05, 6, 24),
    new THREE.MeshBasicMaterial({ color: def.color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  ring.position.copy(group.position);
  ring.rotation.x = Math.PI / 2;
  scene.add(ring);
  enemy.ring = ring;

  group.scale.setScalar(0.01);
  return enemy;
}

function damageEnemy(enemy, amount, at) {
  if (enemy.hp <= 0) return;
  enemy.hp -= amount;
  enemy.flash = 0.1;
  spawnParticles(at, enemy.def.color, 10, 4.5, 0.4);
  hitmarker();

  if (enemy.hp <= 0) {
    killEnemy(enemy);
  } else {
    Sfx.hit();
  }
}

function killEnemy(enemy) {
  Sfx.kill();
  spawnParticles(enemy.group.position, enemy.def.color, 46, 8, 1.0);
  spawnParticles(enemy.group.position, 0xffffff, 14, 5, 0.5);

  player.score += enemy.def.score;
  scene.remove(enemy.group);
  if (enemy.ring) scene.remove(enemy.ring);
  enemies.splice(enemies.indexOf(enemy), 1);

  if (Math.random() < 0.22) spawnPickup(enemy.group.position, 'health');
  else if (Math.random() < 0.3) spawnPickup(enemy.group.position, 'ammo');

  updateHUD();
}

const _toPlayer = new THREE.Vector3();
const _sep = new THREE.Vector3();

function updateEnemies(dt, time) {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];

    // spawn-in animation
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

    _toPlayer.set(
      player.pos.x - e.group.position.x, 0,
      player.pos.z - e.group.position.z
    );
    const dist = _toPlayer.length();
    _toPlayer.normalize();

    // keep enemies from stacking on top of each other
    _sep.set(0, 0, 0);
    for (const o of enemies) {
      if (o === e) continue;
      const dx = e.group.position.x - o.group.position.x;
      const dz = e.group.position.z - o.group.position.z;
      const d2 = dx * dx + dz * dz;
      const minD = e.def.size + o.def.size + 0.4;
      if (d2 < minD * minD && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        _sep.x += (dx / d) * (1 - d / minD);
        _sep.z += (dz / d) * (1 - d / minD);
      }
    }

    const strafe = Math.sin(time * 1.4 + e.phase) * 0.35;
    const speed = e.def.speed * (dist < 2.5 ? 0.35 : 1);
    e.group.position.x += (_toPlayer.x * speed + -_toPlayer.z * strafe * speed + _sep.x * 4) * dt;
    e.group.position.z += (_toPlayer.z * speed + _toPlayer.x * strafe * speed + _sep.z * 4) * dt;

    e.group.position.y = e.baseY + Math.sin(time * 2.2 + e.phase) * 0.28;
    e.group.position.x = clamp(e.group.position.x, -ARENA + 1, ARENA - 1);
    e.group.position.z = clamp(e.group.position.z, -ARENA + 1, ARENA - 1);
    resolveCollisions(e.group.position, e.def.size, e.def.size, e.def.size);

    e.core.rotation.x += dt * 1.6;
    e.core.rotation.y += dt * 2.1;
    e.shell.rotation.y -= dt * 0.9;
    e.shell.rotation.z += dt * 0.5;

    // hit flash
    if (e.flash > 0) {
      e.flash -= dt;
      const on = e.flash > 0;
      e.coreMat.color.set(on ? 0xffffff : e.def.color);
      e.shellMat.opacity = on ? 1 : 0.55;
    }

    // contact damage
    e.attackCd -= dt;
    const reach = e.def.size + 1.1;
    if (dist < reach && e.attackCd <= 0 && player.alive) {
      e.attackCd = 0.9;
      damagePlayer(e.def.dmg);
      e.group.position.x -= _toPlayer.x * 1.4;
      e.group.position.z -= _toPlayer.z * 1.4;
      spawnParticles(e.group.position, e.def.color, 12, 4, 0.4);
    }
  }
}

// ---------------------------------------------------------------- pickups

const pickups = [];

function spawnPickup(at, kind) {
  const color = kind === 'health' ? 0x4dff8f : 0x4dfcff;
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
      if (p.kind === 'health') player.hp = Math.min(player.maxHp, player.hp + 25);
      else weapon.reserve = Math.min(WEAPON.reserveMax, weapon.reserve + 45);
      Sfx.pickup();
      spawnParticles(p.group.position, p.kind === 'health' ? 0x4dff8f : 0x4dfcff, 18, 4, 0.5);
      scene.remove(p.group);
      pickups.splice(i, 1);
      updateHUD();
    }
  }
}

// ---------------------------------------------------------------- waves

let wave = 0;
let queue = [];
let spawnTimer = 0;
let waveBreak = 0;

function buildWave(n) {
  const list = [];
  const total = 4 + Math.round(n * 2.2);
  for (let i = 0; i < total; i++) {
    const r = Math.random();
    if (n >= 4 && r < 0.12 + n * 0.012) list.push('brute');
    else if (n >= 2 && r < 0.45) list.push('swift');
    else list.push('grunt');
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

function updateWaves(dt) {
  if (queue.length > 0) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnEnemy(queue.pop());
      spawnTimer = 0.35;
    }
  } else if (enemies.length === 0) {
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
  ammo: document.getElementById('ammo'),
  reserve: document.getElementById('ammoReserve'),
  score: document.getElementById('score'),
  wave: document.getElementById('wave'),
  hitFlash: document.getElementById('hitFlash'),
  vignette: document.getElementById('lowHealthVignette'),
  crosshair: document.getElementById('crosshair'),
  banner: document.getElementById('waveBanner'),
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
  el.ammo.textContent = weapon.ammo;
  el.reserve.textContent = weapon.reserve;
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
  shake = Math.min(0.28, shake + 0.12);
  Sfx.hurt();
  if (player.hp <= 0) {
    player.hp = 0;
    gameOver();
  }
  updateHUD();
}

let hitmarkerT = 0;
function hitmarker() {
  hitmarkerT = 0.09;
  el.crosshair.style.transform = 'translate(-50%, -50%) scale(1.5)';
}

function showWaveBanner(text) {
  el.banner.textContent = text;
  el.banner.classList.remove('show');
  void el.banner.offsetWidth;   // restart the animation
  el.banner.classList.add('show');
}

// ---------------------------------------------------------------- game flow

let running = false;
let runActive = false;      // a run is underway (possibly paused)
let freshStart = false;     // the next lock should snap the view to the spawn
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
  for (const e of [...enemies]) {
    scene.remove(e.group);
    if (e.ring) scene.remove(e.ring);
  }
  enemies.length = 0;
  for (const p of pickups) scene.remove(p.group);
  pickups.length = 0;
  pLife.fill(0);

  player.pos.set(0, EYE_H, ARENA - 8);
  player.vel.set(0, 0, 0);
  camera.position.copy(player.pos);   // so the first frame raycasts from the right spot
  player.hp = player.maxHp;
  player.score = 0;
  player.alive = true;

  weapon.ammo = WEAPON.magSize;
  weapon.reserve = 90;
  weapon.reloading = 0;
  weapon.cooldown = 0;

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
  if (player.alive) {
    el.startTitle.textContent = runActive ? 'PAUSA' : 'NEON BREACH';
    el.startBtn.textContent = runActive ? 'CONTINUAR' : 'CLICK PARA JUGAR';
    el.start.classList.remove('hidden');
  }
});

// the start overlay doubles as the pause screen once a run is underway
el.startBtn.addEventListener('click', () => (runActive ? resumeGame() : startGame()));
el.start.addEventListener('click', (e) => {
  if (e.target !== el.startBtn) (runActive ? resumeGame() : startGame());
});
document.getElementById('restartBtn').addEventListener('click', startGame);

// ---------------------------------------------------------------- loop

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.setSize(window.innerWidth, window.innerHeight);
});

let elapsed = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (!running) {
    // slow orbit of the arena behind the title screen (a paused run holds its view)
    if (!runActive) {
      elapsed += dt;
      camera.position.set(Math.cos(elapsed * 0.12) * 22, 6.5, Math.sin(elapsed * 0.12) * 22);
      camera.lookAt(0, 3.5, 0);
    }
  } else {
    elapsed += dt;

    updatePlayer(dt);
    updateWaves(dt);
    updateEnemies(dt, elapsed);
    updatePickups(dt, elapsed);

    weapon.cooldown -= dt;
    if (weapon.reloading > 0) {
      weapon.reloading -= dt;
      if (weapon.reloading <= 0) {
        const need = WEAPON.magSize - weapon.ammo;
        const take = Math.min(need, weapon.reserve);
        weapon.ammo += take;
        weapon.reserve -= take;
        updateHUD();
      }
    }
    if (firing) fire();

    // muzzle flash decay
    if (flashTimer > 0) {
      flashTimer -= dt;
      if (flashTimer <= 0) { muzzleFlash.visible = false; muzzleLight.intensity = 0; }
    }

    // screen effects
    if (hitFlashT > 0) {
      hitFlashT -= dt;
      el.hitFlash.style.opacity = Math.max(0, hitFlashT / 0.35);
    }
    if (hitmarkerT > 0) {
      hitmarkerT -= dt;
      if (hitmarkerT <= 0) el.crosshair.style.transform = 'translate(-50%, -50%) scale(1)';
    }

    for (const t of tracers) {
      if (t.life > 0) {
        t.life -= dt;
        t.mesh.material.opacity = clamp(t.life / 0.06, 0, 1);
        if (t.life <= 0) t.mesh.visible = false;
      }
    }
  }

  updateParticles(dt);
  composer.render();
}

updateHUD();
animate();
