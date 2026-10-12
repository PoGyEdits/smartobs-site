/* ============================================================
   The agent: a GLB that turns to face whatever section you are
   reading. Each <section> carries data-agent-yaw / -label / -value;
   scrolling into one sets the target and the model eases toward it.
   ============================================================ */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL = 'assets/model/agent.glb';

// Framing. The model ships in a wide A-pose standing at full height; on the
// page we want a bust: head and torso filling the panel, legs out of shot.
// showFrac is how much of the figure's total height stays visible, measured
// down from the crown.
const FRAME = {
  showFrac: 0.56,   // crown down past the belt, so the hands stay in frame
  topPad: 0.10,     // headroom above the crown, keeping it clear of the nav bar
  lift: 0.02        // nudge the framing down so the head is not dead centre
};

// Pose, in radians, applied to named bones after load. The GLB carries a
// skeleton but no animation clips, so the resting A-pose is whatever the
// exporter left. These bring the arms down and in, put a bend in the elbows
// and add a little asymmetry so the figure reads as a person rather than a
// mannequin.
// Note both arms take the SAME values. The left and right bones are not
// mirrored in this rig: probing them showed an identical local axis pair, so
// opposite signs swing one arm down and the other straight out.
// z swings the arm forward, which is what lifts the hands clear of the hips
// and into shot: without it they hide behind the body and read as missing.
const ARM_UPPER = { y: -0.60, x: 0.10, z: 0.30 };
const ARM_LOWER = { y: -0.80 };

const POSE = {
  'arm_upper_l_014': ARM_UPPER,
  'arm_upper_r_044': ARM_UPPER,
  'arm_lower_l_015': ARM_LOWER,
  'arm_lower_r_045': ARM_LOWER,
  // A little counter-twist through the spine and head, so the figure is not
  // perfectly square to the camera.
  'spine_2_05':      { y:  0.05, x: 0.02 },
  'spine_3_06':      { y:  0.04 },
  'neck_0_07':       { y: -0.05 },
  'head_0_08':       { y: -0.09, x: -0.03 }
};

const root = document.getElementById('agent');
const canvas = document.getElementById('agent-canvas');

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Below this width the panel is display:none, so there is nothing to draw.
// Watch the query rather than testing it once: a visitor who loads the page
// in a narrow window and then maximises should still get the agent, without
// having to reload.
const mq = window.matchMedia('(min-width: 1181px)');
let started = false;

function maybeInit() {
  if (started || !mq.matches) return;
  started = true;
  try {
    init();
  } catch (err) {
    // No WebGL, or the context was refused. The page is complete without
    // the agent, so drop the panel rather than leaving a dead box.
    console.warn('[agent] disabled:', err);
    root.remove();
  }
}

maybeInit();
if (mq.addEventListener) mq.addEventListener('change', maybeInit);
else if (mq.addListener) mq.addListener(maybeInit);

function init() {
  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: true, powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 3 / 4, 0.1, 100);
  camera.position.set(0, 0, 4);

  // Key light warm from the front-left, a red rim from behind-right to pick
  // out the silhouette against a dark page, and a soft fill so the shadow
  // side does not go to pure black.
  scene.add(new THREE.HemisphereLight(0xbfc7d6, 0x1a1412, 1.1));

  const key = new THREE.DirectionalLight(0xfff2e8, 2.6);
  key.position.set(-2.4, 2.6, 3.2);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xff3b2f, 3.4);
  rim.position.set(2.8, 1.4, -2.6);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0x6f7d99, 0.9);
  fill.position.set(2.2, -1.2, 2.0);
  scene.add(fill);

  const pivot = new THREE.Group();
  scene.add(pivot);

  let model = null;
  let targetYaw = 0;
  let currentYaw = 0;
  let loaded = false;
  let focusY = 0;
  const posed = [];
  const eyes = [];

  /* ---------- framing ----------
     Aim the camera at the upper body instead of the whole figure, so the
     panel holds a bust. Everything is derived from the posed bounding box,
     so changing FRAME or the pose does not need the numbers re-tuned. */

  function frameBust() {
    model.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(model);
    const h = b.max.y - b.min.y;

    const top = b.max.y + h * FRAME.topPad;
    const bottom = b.max.y - h * FRAME.showFrac;
    const span = top - bottom;

    focusY = (top + bottom) / 2 - h * FRAME.lift;

    const vFov = THREE.MathUtils.degToRad(camera.fov);
    camera.position.set(0, focusY, span / (2 * Math.tan(vFov / 2)));
    camera.lookAt(0, focusY, 0);
    camera.updateProjectionMatrix();
  }



  // How the ball sits in the socket, in multiples of its own radius. The
  // eyeball bones sit a little high and proud of this balaclava, so the ball
  // needs pushing back into the head and down behind the eye hole.
  const EYE_SET = { back: 0.20, down: 0.00 };

  function placeEye(eye) {
    const r = eye.userData.local;
    eye.position.set(0, 0, 0);
    eye.quaternion.copy(eye.userData.aim);
    eye.translateZ(-r * EYE_SET.back);
    eye.translateY(-r * EYE_SET.down);
  }

  /* ---------- eyes ----------
     The Sketchfab model has no face geometry at all: its five meshes are arms,
     balaclava, body, legs and gloves. Through the balaclava's eye holes you see
     straight into an empty head, which reads as eerie rather than masked.
     The rig does carry eyeball_l / eyeball_r / eye_target bones though, so the
     sockets can be filled at exactly the right place without touching the asset.
     Sizes derive from the measured body height, so they survive a rescale. */

  function addEyes() {
    const L = model.getObjectByName('eyeball_l_09');
    const R = model.getObjectByName('eyeball_r_010');
    if (!L || !R) { console.warn('[agent] no eyeball bones'); return false; }

    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const bodyH = box.max.y - box.min.y;
    const rWorld = bodyH * 0.0082;         // small: they read as eyes in shadow, not marbles

    const geo = new THREE.SphereGeometry(1, 24, 18);
    const sclera = new THREE.MeshStandardMaterial({ color: 0x8d857c, roughness: 0.42, metalness: 0 });
    const iris   = new THREE.MeshStandardMaterial({ color: 0x1c120b, roughness: 0.18, metalness: 0 });

    // eye_target sits above the head, so aiming at it rolls the eyes upward.
    // Point them along the model's own forward axis instead. At this moment the
    // model is not yet parented to the pivot, so its world +Z is model forward.
    const fwd = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(model.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();

    const scale = new THREE.Vector3();
    for (const bone of [L, R]) {
      bone.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      const local = rWorld / Math.max(scale.x, 1e-6);   // undo the bone's world scale

      const eye = new THREE.Group();
      const ball = new THREE.Mesh(geo, sclera);
      ball.scale.setScalar(local);
      eye.add(ball);

      const pupil = new THREE.Mesh(geo, iris);
      pupil.scale.setScalar(local * 0.62);
      pupil.position.z = local * 0.60;
      eye.add(pupil);

      eye.renderOrder = 1;
      bone.add(eye);
      model.updateMatrixWorld(true);
      const here = bone.getWorldPosition(new THREE.Vector3());
      eye.lookAt(here.add(fwd.clone().multiplyScalar(bodyH)));
      eye.userData.local = local;
      eye.userData.aim = eye.quaternion.clone();
      placeEye(eye);
      eyes.push(eye);
    }
    return true;
  }

  /* ---------- size ---------- */

  function resize() {
    const r = root.getBoundingClientRect();
    const stage = root.querySelector('.agent-stage').getBoundingClientRect();
    const w = Math.max(1, Math.round(stage.width));
    const h = Math.max(1, Math.round(stage.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    return r;
  }

  /* ---------- load ---------- */

  new GLTFLoader().load(MODEL, (gltf) => {
    model = gltf.scene;

    // Sketchfab exports arrive at arbitrary scale and offset. Normalise:
    // centre on the origin, then scale so the model is a fixed height.
    //
    // updateMatrixWorld is not optional here. Box3.setFromObject reads each
    // child's world matrix, and on a freshly parsed glTF those are still
    // stale, measuring without it returns a wildly wrong box and the model
    // ends up scaled and offset to nonsense.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    // 2.0 against a ~2.45-unit visible height leaves headroom for the idle
    // float and for the arms swinging wide as the figure turns.
    const scale = 2.00 / Math.max(size.y, 0.0001);

    model.position.sub(centre);
    model.scale.setScalar(scale);

    // Re-measure after scaling and recentre, so the figure sits on the
    // stage's vertical midpoint regardless of where its origin was.
    model.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(model);
    const c2 = box2.getCenter(new THREE.Vector3());
    model.position.sub(c2);

    model.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.frustumCulled = false;
        if (o.material) o.material.envMapIntensity = 0.8;
      }
    });

    // Pose the skeleton. Bones are ordinary Object3Ds, so rotating them and
    // letting three.js rebuild the skinning matrices is all that is needed.
    for (const [name, r] of Object.entries(POSE)) {
      const bone = model.getObjectByName(name);
      if (!bone) { console.warn('[agent] no bone', name); continue; }
      bone.rotation.x += r.x || 0;
      bone.rotation.y += r.y || 0;
      bone.rotation.z += r.z || 0;
      posed.push(name);
    }
    model.updateMatrixWorld(true);

    addEyes();
    frameBust();
    pivot.add(model);
    loaded = true;
    resize();
    renderer.render(scene, camera);
    root.classList.add('ready');
    sync();
  }, undefined, (err) => {
    console.error('[agent] failed to load model', err);
    root.remove();
  });

  /* ---------- which section are we in ---------- */

  const sections = Array.from(document.querySelectorAll('[data-agent-yaw]'));
  let active = null;

  function sync() {
    const mid = window.innerHeight * 0.42;
    let best = sections[0];
    for (const s of sections) {
      const r = s.getBoundingClientRect();
      if (r.top <= mid) best = s;
    }
    if (!best || best === active) return;
    active = best;
    targetYaw = parseFloat(best.dataset.agentYaw) || 0;
  }

  window.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', () => { resize(); sync(); });

  /* ---------- animate ---------- */

  const clock = new THREE.Clock();

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);

    // Ease toward the target angle. Framerate-independent so a slow frame
    // does not overshoot.
    const k = 1 - Math.pow(0.0015, dt);
    currentYaw += (targetYaw - currentYaw) * k;

    if (model) {
      pivot.rotation.y = currentYaw;
      // A slow idle drift, so the figure never looks frozen between sections.
      // Kept small: at bust framing the view is only ~1.3 units tall, so what
      // read as a gentle float on the full figure would be a bob here.
      if (!reduced) {
        const t = clock.elapsedTime;
        pivot.position.y = Math.sin(t * 0.6) * 0.014;
        pivot.rotation.x = Math.sin(t * 0.42) * 0.012;
      }
    }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  resize();
  requestAnimationFrame(frame);

  // Exposed so the page can be inspected without screenshots.
  window.__agent = {
    get loaded() { return loaded; },
    get yaw() { return currentYaw; },
    get target() { return targetYaw; },
    get section() { return active && active.id; },
    render: () => renderer.render(scene, camera),
    // Live handles, for posing experiments in the console.
    model: () => model,
    reframe: () => { frameBust(); renderer.render(scene, camera); },
    posedBones: () => posed.slice(),
    eyeCount: () => eyes.length,
    tuneEyes: (back, down) => {
      EYE_SET.back = back; EYE_SET.down = down;
      eyes.forEach(placeEye);
      renderer.render(scene, camera);
    },
    snapshot: () => { renderer.render(scene, camera); return canvas.toDataURL('image/png'); },
    // snap=true jumps straight to the angle and draws it, without waiting for
    // the easing loop, used to inspect a pose in environments where
    // requestAnimationFrame is throttled or suspended.
    setYaw: (y, snap) => {
      targetYaw = y;
      if (snap) {
        currentYaw = y;
        pivot.rotation.y = y;
        renderer.render(scene, camera);
      }
    },
    info: () => {
      if (!model) return { loaded: false };
      const b = new THREE.Box3().setFromObject(model);
      let meshes = 0;
      model.traverse((o) => { if (o.isMesh) meshes++; });
      return {
        loaded: true, meshes,
        size: b.getSize(new THREE.Vector3()).toArray().map(n => +n.toFixed(3)),
        centre: b.getCenter(new THREE.Vector3()).toArray().map(n => +n.toFixed(3)),
        canvas: [canvas.width, canvas.height]
      };
    }
  };
}
