/* ============================================================
   The agent: a GLB that turns to face whatever section you are
   reading. Each <section> carries data-agent-yaw / -label / -value;
   scrolling into one sets the target and the model eases toward it.
   ============================================================ */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL = 'assets/model/agent.glb';

// Extra turn so the exported model faces the viewer at yaw 0 (radians).
const MODEL_YAW = -Math.PI / 2 + 0.75;

// Framing. The model stands at full height; on the page we want a bust: head and torso filling the panel, legs out of shot.
// showFrac is how much of the figure's total height stays visible, measured
// down from the crown.
const FRAME = {
  showFrac: 0.46,   // crown down past the belt, so the hands stay in frame
  topPad: 0.10,     // headroom above the crown, keeping it clear of the nav bar
  lift: 0.02        // nudge the framing down so the head is not dead centre
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
  let mixer = null;
  let targetYaw = 0;
  let currentYaw = 0;
  let loaded = false;
  let focusY = 0;
  let heightDist = 4;   // camera distance that frames the bust vertically
  let reach = null;
  let centreNdc = 0;    // where the panel's centre sits across the stage, -1..1
  let stageW = 1, stageH = 1;
  let lastFit = null;
  let shiftByYaw = [];     // sampled points of the figure, [x, z] pairs, for the width fit

  /* ---------- framing ----------
     Aim the camera at the upper body instead of the whole figure, so the
     panel holds a bust. Everything is derived from the posed bounding box,
     so changing FRAME or the animation does not need the numbers re-tuned. */

  function frameBust() {
    model.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(model);
    const h = b.max.y - b.min.y;

    const top = b.max.y + h * FRAME.topPad;
    const bottom = b.max.y - h * FRAME.showFrac;
    const span = top - bottom;

    focusY = (top + bottom) / 2 - h * FRAME.lift;

    const vFov = THREE.MathUtils.degToRad(camera.fov);
    heightDist = span / (2 * Math.tan(vFov / 2));
    camera.position.set(0, focusY, heightDist);
    camera.lookAt(0, focusY, 0);
    camera.updateProjectionMatrix();
  }

  /* ---------- size ---------- */

  function resize() {
    const r = root.getBoundingClientRect();
    const stage = root.querySelector('.agent-stage').getBoundingClientRect();
    const w = Math.max(1, Math.round(stage.width));
    const h = Math.max(1, Math.round(stage.height));
    // Browser zoom changes devicePixelRatio and fires resize, so re-read it
    // here; otherwise zooming in leaves the figure rendered blurry.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // The stage is wider than the panel (it bleeds left over the gutter).
    // Shift the view so the figure still stands centred on the panel.
    const bleed = Math.max(0, w - r.width);
    stageW = w; stageH = h;
    centreNdc = bleed / w;
    fitWidth();
    camera.updateProjectionMatrix();
    return r;
  }

  /* ---------- width fit ----------
     The rifle reaches well past the shoulders, and at some section angles
     the stock or the muzzle ran off the edge of the stage and was cut. The
     stage bleeds left for the stock; if anything still would not fit at
     some section angle, pull the camera back just enough that it does. Measured once from the actual
     skinned vertices, so it follows the pose, not a loose bounding box. */

  // Share of the half-width the figure may use; the rest is breathing room
  // for the idle sway.
  const WIDTH_FILL = 0.94;
  // How far (in stage widths, -1..1 space) he may slide either way off the
  // panel centre to fit the rifle. Kept small so he stays put on the right.
  const SHIFT_MAX = 0.06;

  function measureReach() {
    const pts = [];
    const v = new THREE.Vector3();
    const bottom = focusY - heightDist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      if (!o.isMesh) return;
      const n = o.geometry.attributes.position.count;
      for (let i = 0; i < n; i += 3) {
        o.getVertexPosition(i, v);
        v.applyMatrix4(o.matrixWorld);
        // Only what can be on screen: the bust, not the legs out of shot.
        if (v.y >= bottom) pts.push(v.x, v.z);
      }
    });
    reach = pts;
  }

  function fitWidth() {
    if (!reach) { applyShift(centreNdc); return; }
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect;
    const yaws = sections.map((s) => parseFloat(s.dataset.agentYaw) || 0);
    const rots = yaws.map((yaw) => {
      const c = Math.cos(yaw), sn = Math.sin(yaw), r = [];
      for (let i = 0; i < reach.length; i += 2) {
        const x = reach[i], z = reach[i + 1];
        r.push(x * c + z * sn, -x * sn + z * c);
      }
      return r;
    });
    // Try the bust distance first and back off in small steps until the
    // figure fits at every section angle. Each angle gets its own sideways
    // slide (eased with the turn in frame()), since the rifle sticks out to
    // a different side depending on which way he faces.
    let dist = heightDist, slides = [];
    for (let step = 0; step < 80; step++) {
      let ok = true;
      slides = rots.map((r) => {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < r.length; i += 2) {
          const n = r[i] / ((dist - r[i + 1]) * t);
          if (n < lo) lo = n;
          if (n > hi) hi = n;
        }
        const sh = Math.min(centreNdc + SHIFT_MAX, Math.max(centreNdc - SHIFT_MAX, -(hi + lo) / 2));
        if (lo + sh < -WIDTH_FILL || hi + sh > WIDTH_FILL) ok = false;
        return sh;
      });
      if (ok) break;
      dist *= 1.01;
    }
    shiftByYaw = yaws.map((y, i) => [y, slides[i]]).sort((p, q) => p[0] - q[0]);
    lastFit = { dist, heightDist, shiftByYaw };
    camera.position.z = dist;
    applyShift(shiftAt(currentYaw));
  }

  function shiftAt(yaw) {
    const tbl = shiftByYaw;
    if (!tbl.length) return centreNdc;
    if (yaw <= tbl[0][0]) return tbl[0][1];
    for (let i = 1; i < tbl.length; i++) {
      if (yaw <= tbl[i][0]) {
        const [y0, s0] = tbl[i - 1], [y1, s1] = tbl[i];
        return s0 + (s1 - s0) * ((yaw - y0) / (y1 - y0 || 1));
      }
    }
    return tbl[tbl.length - 1][1];
  }

  function applyShift(sh) {
    camera.setViewOffset(stageW, stageH, -sh * stageW / 2, 0, stageW, stageH);
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

    // The idle comes from CS2 itself: the T rifle idle the agents play in the
    // game's main menu, with the AK-47 riding in his hands. It loops forever;
    // the section turning below is applied on top, to the pivot.
    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model);
      const action = mixer.clipAction(gltf.animations[0]);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      mixer.update(0);
    }
    model.updateMatrixWorld(true);

    // The CS2 export faces a different way from the old model; turn it so
    // yaw 0 looks straight out of the page.
    model.rotation.y += MODEL_YAW;
    model.updateMatrixWorld(true);

    // Centre again on the posed figure. The first centring measured the bind
    // pose, and the idle stands him somewhere else, so without this he drifts
    // off the side of the panel. Height comes from the whole figure, but the
    // sideways centre from the body alone: the rifle sticks out to one side
    // and would otherwise push him off centre.
    {
      const posedBox = new THREE.Box3().setFromObject(model);
      const bodyBox = new THREE.Box3();
      model.traverse((o) => { if (o.isMesh && !/ak47/i.test(o.name)) bodyBox.expandByObject(o); });
      const c = (bodyBox.isEmpty() ? posedBox : bodyBox).getCenter(new THREE.Vector3());
      model.position.x -= c.x;
      model.position.z -= c.z;
      model.position.y -= posedBox.getCenter(new THREE.Vector3()).y;
      model.updateMatrixWorld(true);
    }

    frameBust();
    pivot.add(model);
    measureReach();
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
    if (mixer && !reduced) mixer.update(dt);

    // Ease toward the target angle. Framerate-independent so a slow frame
    // does not overshoot.
    const k = 1 - Math.pow(0.0015, dt);
    currentYaw += (targetYaw - currentYaw) * k;

    if (model) {
      pivot.rotation.y = currentYaw;
      if (shiftByYaw.length) applyShift(shiftAt(currentYaw));
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
    mixer: () => mixer,
    fit: () => lastFit,
    reframe: () => { frameBust(); renderer.render(scene, camera); },
    snapshot: () => { renderer.render(scene, camera); return canvas.toDataURL('image/png'); },
    // snap=true jumps straight to the angle and draws it, without waiting for
    // the easing loop, used to inspect a pose in environments where
    // requestAnimationFrame is throttled or suspended.
    setYaw: (y, snap) => {
      targetYaw = y;
      if (snap) {
        currentYaw = y;
        pivot.rotation.y = y;
        if (shiftByYaw.length) applyShift(shiftAt(y));
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
