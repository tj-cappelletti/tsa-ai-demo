import * as THREE from "/node_modules/three/build/three.module.js";
import RAPIER from "/node_modules/@dimforge/rapier3d-compat/rapier.mjs";

const video = document.getElementById("webcam");
const webcamOverlay = document.getElementById("webcam-overlay");
const gameCanvas = document.getElementById("game-canvas");
const statusEl = document.getElementById("status");
const leftScoreEl = document.getElementById("left-score");
const rightScoreEl = document.getElementById("right-score");
const volumeSlider = document.getElementById("music-volume");
const hostBtn = document.getElementById("host-btn");
const joinBtn = document.getElementById("join-btn");
const peerInput = document.getElementById("peer-id");

const TABLE = { x: 7.2, z: 4.2, y: 0.25, goalHalf: 0.9, wall: 0.15 };
const MALLET_RADIUS = 0.26;
const PUCK_RADIUS = 0.13;
const MARGIN = 0.3;
const HALF_X = TABLE.x / 2;
const HALF_Z = TABLE.z / 2;

let role = "solo";
let peer = null;
let conn = null;
let world;
let puckBody;
let leftBody;
let rightBody;
let controlTarget = { left: { x: -HALF_X / 2, z: 0 }, right: { x: HALF_X / 2, z: 0 } };
let remoteTarget = { x: HALF_X / 2, z: 0 };
let score = { left: 0, right: 0 };
let syncTimer = 0;
let lastJoinScore = { left: 0, right: 0 };
const particles = [];

let audioCtx;
let audioGain;
let musicStarted = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color("#03040c");
scene.fog = new THREE.Fog("#03040c", 7, 18);

const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
camera.position.set(0, 7, 6.2);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ canvas: gameCanvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

scene.add(new THREE.AmbientLight("#7b8bcf", 0.65));
const keyLight = new THREE.PointLight("#45f6ff", 1.2, 25);
keyLight.position.set(-2, 4.5, 1);
scene.add(keyLight);
const rimLight = new THREE.PointLight("#ff36cf", 0.9, 22);
rimLight.position.set(2.5, 3.5, -1);
scene.add(rimLight);

const table = new THREE.Mesh(
  new THREE.BoxGeometry(TABLE.x, TABLE.y, TABLE.z),
  new THREE.MeshStandardMaterial({ color: "#0d1230", emissive: "#12275e", metalness: 0.3, roughness: 0.35 })
);
table.position.y = -TABLE.y / 2;
scene.add(table);

const edge = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(TABLE.x, TABLE.y + 0.02, TABLE.z)),
  new THREE.LineBasicMaterial({ color: "#37f0ff" })
);
edge.position.y = -TABLE.y / 2;
scene.add(edge);

const centerLine = new THREE.Mesh(
  new THREE.PlaneGeometry(0.06, TABLE.z - 0.4),
  new THREE.MeshBasicMaterial({ color: "#1be8ff", transparent: true, opacity: 0.6 })
);
centerLine.rotation.x = -Math.PI / 2;
centerLine.position.set(0, 0.005, 0);
scene.add(centerLine);

const goalGlowMat = new THREE.MeshBasicMaterial({ color: "#ff4fd8", transparent: true, opacity: 0.6 });
const goalGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.06, TABLE.goalHalf * 2), goalGlowMat);
goalGlow.rotation.x = -Math.PI / 2;
goalGlow.position.set(HALF_X - 0.02, 0.01, 0);
scene.add(goalGlow);
const goalGlow2 = goalGlow.clone();
goalGlow2.position.x = -HALF_X + 0.02;
scene.add(goalGlow2);

const puck = new THREE.Mesh(
  new THREE.CylinderGeometry(PUCK_RADIUS, PUCK_RADIUS, 0.08, 32),
  new THREE.MeshStandardMaterial({ color: "#f8fbff", emissive: "#6befff", emissiveIntensity: 1, metalness: 0.35, roughness: 0.2 })
);
puck.position.y = 0.08;
scene.add(puck);

const malletGeo = new THREE.CylinderGeometry(MALLET_RADIUS, MALLET_RADIUS * 0.88, 0.24, 28);
const leftMallet = new THREE.Mesh(
  malletGeo,
  new THREE.MeshStandardMaterial({ color: "#5cd4ff", emissive: "#00d5ff", emissiveIntensity: 0.8 })
);
const rightMallet = new THREE.Mesh(
  malletGeo,
  new THREE.MeshStandardMaterial({ color: "#ff6bde", emissive: "#ff33d1", emissiveIntensity: 0.8 })
);
leftMallet.position.y = rightMallet.position.y = 0.12;
scene.add(leftMallet, rightMallet);

const overlayCtx = webcamOverlay.getContext("2d");

function setStatus(message, append = false) {
  statusEl.textContent = append ? `${statusEl.textContent}\n${message}` : message;
}

function updateScoreboard() {
  leftScoreEl.textContent = String(score.left);
  rightScoreEl.textContent = String(score.right);
}

function clampTarget(side, x, z) {
  const zClamped = THREE.MathUtils.clamp(z, -HALF_Z + MARGIN, HALF_Z - MARGIN);
  if (side === "left") {
    return {
      x: THREE.MathUtils.clamp(x, -HALF_X + MARGIN, -MALLET_RADIUS),
      z: zClamped,
    };
  }
  return {
    x: THREE.MathUtils.clamp(x, MALLET_RADIUS, HALF_X - MARGIN),
    z: zClamped,
  };
}

function mapHandToTable(nx, nz, side) {
  const xRange = side === "left" ? [-HALF_X + MARGIN, -MALLET_RADIUS] : [MALLET_RADIUS, HALF_X - MARGIN];
  const x = THREE.MathUtils.lerp(xRange[0], xRange[1], nx);
  const z = THREE.MathUtils.lerp(HALF_Z - MARGIN, -HALF_Z + MARGIN, nz);
  return clampTarget(side, x, z);
}

function spawnBurst(x, z, color) {
  for (let i = 0; i < 28; i += 1) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 8, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })
    );
    mesh.position.set(x, 0.11, z);
    const speed = 1.4 + Math.random() * 3;
    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
    particles.push({ mesh, velocity: dir.multiplyScalar(speed), life: 0.75 + Math.random() * 0.35 });
    scene.add(mesh);
  }
}

function resetPuck(direction = 1) {
  puckBody.setTranslation({ x: 0, y: 0.08, z: 0 }, true);
  const kick = 3.2;
  puckBody.setLinvel({ x: kick * direction, y: 0, z: (Math.random() - 0.5) * 1.8 }, true);
}

function scoreGoal(side) {
  score[side] += 1;
  updateScoreboard();
  const goalX = side === "left" ? HALF_X - 0.1 : -HALF_X + 0.1;
  spawnBurst(goalX, 0, side === "left" ? "#4ce6ff" : "#ff4ed8");
  resetPuck(side === "left" ? -1 : 1);
}

function initAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    audioGain = audioCtx.createGain();
    audioGain.gain.value = Number(volumeSlider.value);
    audioGain.connect(audioCtx.destination);
  }
}

function startMusic() {
  if (musicStarted) return;
  initAudio();
  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 920;

  osc1.type = "sawtooth";
  osc1.frequency.value = 94;
  osc2.type = "triangle";
  osc2.frequency.value = 188;

  const g1 = audioCtx.createGain();
  const g2 = audioCtx.createGain();
  g1.gain.value = 0.045;
  g2.gain.value = 0.024;

  osc1.connect(g1).connect(filter);
  osc2.connect(g2).connect(filter);
  filter.connect(audioGain);

  osc1.start();
  osc2.start();
  musicStarted = true;
}

async function unlockAudio() {
  initAudio();
  try {
    if (audioCtx.state !== "running") await audioCtx.resume();
    startMusic();
    setStatus("Audio unlocked. Game ready.");
  } catch {
    setStatus("Tap/click the page once to unlock audio.");
  }
}

volumeSlider.addEventListener("input", () => {
  if (audioGain) audioGain.gain.value = Number(volumeSlider.value);
});

window.addEventListener("pointerdown", unlockAudio, { once: true });
window.addEventListener("keydown", unlockAudio, { once: true });
unlockAudio();

function syncStateFromHost(data) {
  if (!data?.state) return;
  const s = data.state;
  score = s.score;
  updateScoreboard();
  if (score.left !== lastJoinScore.left || score.right !== lastJoinScore.right) {
    const side = score.left > lastJoinScore.left ? "left" : "right";
    spawnBurst(side === "left" ? HALF_X - 0.1 : -HALF_X + 0.1, 0, side === "left" ? "#4ce6ff" : "#ff4ed8");
    lastJoinScore = { ...score };
  }
  puck.position.set(s.puck.x, s.puck.y, s.puck.z);
  leftMallet.position.set(s.left.x, 0.12, s.left.z);
  rightMallet.position.set(s.right.x, 0.12, s.right.z);
}

function sendHostState() {
  if (!conn || !conn.open) return;
  conn.send({
    type: "state",
    state: {
      score,
      puck: puckBody.translation(),
      left: leftBody.translation(),
      right: rightBody.translation(),
    },
  });
}

function setupConnectionHandlers(connection) {
  conn = connection;
  conn.on("data", (data) => {
    if (data?.type === "input") {
      remoteTarget = clampTarget("right", data.x, data.z);
    }
    if (data?.type === "state") {
      syncStateFromHost(data);
    }
  });
  conn.on("close", () => setStatus("Peer disconnected."));
}

hostBtn.addEventListener("click", () => {
  if (peer) peer.destroy();
  peer = new Peer();
  role = "host";
  setStatus("Starting host…");
  peer.on("open", (id) => {
    setStatus(`Hosting. Share this ID: ${id}`);
  });
  peer.on("connection", (connection) => {
    setupConnectionHandlers(connection);
    setStatus("Opponent joined.");
  });
  peer.on("error", (err) => setStatus(`Peer error: ${err.type || err.message}`));
});

joinBtn.addEventListener("click", () => {
  const hostId = peerInput.value.trim();
  if (!hostId) {
    setStatus("Enter a host peer ID.");
    return;
  }
  if (peer) peer.destroy();
  role = "join";
  peer = new Peer();
  setStatus("Joining host…");
  peer.on("open", () => {
    const connection = peer.connect(hostId, { reliable: true });
    connection.on("open", () => {
      setupConnectionHandlers(connection);
      setStatus("Connected to host.");
    });
  });
  peer.on("error", (err) => setStatus(`Peer error: ${err.type || err.message}`));
});

async function initPhysics() {
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: 0, z: 0 });

  const puckRb = RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.08, 0).setLinvel(1.8, 0, 0.7).setLinearDamping(0.07);
  puckBody = world.createRigidBody(puckRb);
  world.createCollider(RAPIER.ColliderDesc.ball(PUCK_RADIUS).setRestitution(0.95).setFriction(0.01), puckBody);

  const leftRb = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(-HALF_X / 2, 0.12, 0);
  const rightRb = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(HALF_X / 2, 0.12, 0);
  leftBody = world.createRigidBody(leftRb);
  rightBody = world.createRigidBody(rightRb);
  const malletCollider = RAPIER.ColliderDesc.cylinder(0.12, MALLET_RADIUS).setRestitution(0.82).setFriction(0.04);
  world.createCollider(malletCollider, leftBody);
  world.createCollider(malletCollider, rightBody);

  const wallRb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const leftWall = RAPIER.ColliderDesc.cuboid(TABLE.wall / 2, 0.15, HALF_Z + 0.02).setRestitution(0.93);
  leftWall.setTranslation(-HALF_X - TABLE.wall / 2, 0.1, 0);
  const rightWall = RAPIER.ColliderDesc.cuboid(TABLE.wall / 2, 0.15, HALF_Z + 0.02).setRestitution(0.93);
  rightWall.setTranslation(HALF_X + TABLE.wall / 2, 0.1, 0);
  world.createCollider(leftWall, wallRb);
  world.createCollider(rightWall, wallRb);

  const top = RAPIER.ColliderDesc.cuboid(HALF_X - TABLE.goalHalf, 0.15, TABLE.wall / 2).setRestitution(0.93);
  top.setTranslation(0, 0.1, HALF_Z + TABLE.wall / 2);
  const bottom = RAPIER.ColliderDesc.cuboid(HALF_X - TABLE.goalHalf, 0.15, TABLE.wall / 2).setRestitution(0.93);
  bottom.setTranslation(0, 0.1, -HALF_Z - TABLE.wall / 2);
  world.createCollider(top, wallRb);
  world.createCollider(bottom, wallRb);
}

function resize() {
  const bounds = gameCanvas.getBoundingClientRect();
  const w = Math.max(320, bounds.width);
  const h = Math.max(240, bounds.height);
  renderer.setSize(w, h, false);
  webcamOverlay.width = w;
  webcamOverlay.height = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function updateMallets() {
  const localSide = role === "join" ? "right" : "left";
  const localTarget = controlTarget[localSide];
  if (localSide === "left") {
    leftBody.setNextKinematicTranslation({ x: localTarget.x, y: 0.12, z: localTarget.z });
    rightBody.setNextKinematicTranslation({ x: remoteTarget.x, y: 0.12, z: remoteTarget.z });
  } else {
    leftBody.setNextKinematicTranslation({ x: controlTarget.left.x, y: 0.12, z: controlTarget.left.z });
    rightBody.setNextKinematicTranslation({ x: localTarget.x, y: 0.12, z: localTarget.z });
  }
}

function applyPhysicsVisuals() {
  const p = puckBody.translation();
  puck.position.set(p.x, p.y, p.z);
  const l = leftBody.translation();
  const r = rightBody.translation();
  leftMallet.position.set(l.x, l.y, l.z);
  rightMallet.position.set(r.x, r.y, r.z);
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.life -= dt;
    p.velocity.multiplyScalar(0.97);
    p.velocity.y -= dt * 1.9;
    p.mesh.position.addScaledVector(p.velocity, dt);
    p.mesh.material.opacity = Math.max(0, p.life);
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      particles.splice(i, 1);
    }
  }
}

function checkGoals() {
  const p = puckBody.translation();
  if (Math.abs(p.z) > TABLE.goalHalf) return;
  if (p.x > HALF_X + 0.08) scoreGoal("left");
  if (p.x < -HALF_X - 0.08) scoreGoal("right");
}

function setupHands() {
  const hands = new Hands({
    locateFile: (file) => `/node_modules/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.65,
    minTrackingConfidence: 0.65,
  });

  hands.onResults((results) => {
    overlayCtx.clearRect(0, 0, webcamOverlay.width, webcamOverlay.height);
    if (results.multiHandLandmarks?.length) {
      const landmarks = results.multiHandLandmarks[0];
      drawConnectors(overlayCtx, landmarks, HAND_CONNECTIONS, { color: "#00ecff", lineWidth: 3 });
      drawLandmarks(overlayCtx, landmarks, { color: "#ff4fd8", lineWidth: 1 });
      const tip = landmarks[8];
      const nx = THREE.MathUtils.clamp(1 - tip.x, 0, 1);
      const nz = THREE.MathUtils.clamp(tip.y, 0, 1);
      const localSide = role === "join" ? "right" : "left";
      controlTarget[localSide] = mapHandToTable(nx, nz, localSide);
      if (role === "join" && conn?.open) {
        conn.send({ type: "input", x: controlTarget.right.x, z: controlTarget.right.z });
      }
    }
  });

  navigator.mediaDevices
    .getUserMedia({ video: { width: 960, height: 540, facingMode: "user" }, audio: false })
    .then((stream) => {
      video.srcObject = stream;
      return video.play();
    })
    .then(() => {
      setStatus("Webcam + hand tracking ready.", true);
      const run = async () => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          await hands.send({ image: video });
        }
        requestAnimationFrame(run);
      };
      requestAnimationFrame(run);
    })
    .catch((err) => {
      setStatus(`Webcam access failed: ${err.message}`);
    });
}

let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (world && role !== "join") {
    updateMallets();
    world.step();
    checkGoals();
    applyPhysicsVisuals();
    syncTimer += dt;
    if (role === "host" && syncTimer > 1 / 30) {
      sendHostState();
      syncTimer = 0;
    }
  }

  updateParticles(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

async function init() {
  resize();
  window.addEventListener("resize", resize);
  await initPhysics();
  updateScoreboard();
  setupHands();
  setStatus("Solo mode active. Host or join to enable multiplayer.");
  requestAnimationFrame(loop);
}

init().catch((err) => {
  setStatus(`Startup failed: ${err.message}`);
});
