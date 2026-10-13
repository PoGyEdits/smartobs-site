/* Decorative CS2 weapon showcase. Keep the existing panel hooks so the
   layout and static-site packaging continue to work. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const root = document.getElementById('agent');
const canvas = document.getElementById('agent-canvas');
const desktop = window.matchMedia('(min-width: 1181px)');
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
const WEAPONS = [
  { id: 'ak47-asiimov', name: 'AK-47 | Asiimov', model: 'assets/model/ak47-asiimov.glb' },
  { id: 'awp-neo-noir', name: 'AWP | Neo-Noir', model: 'assets/model/awp-neo-noir.glb' },
  { id: 'm4a4-howl', name: 'M4A4 | Howl', model: 'assets/model/m4a4-howl.glb' },
  { id: 'deagle-printstream', name: 'Desert Eagle | Printstream', model: 'assets/model/deagle-printstream.glb' }
];
const LAST_WEAPON_KEY = 'smartobs:last-weapon';

function chooseWeapon() {
  let previous = null;
  // Session storage keeps reloads in this tab from showing the same gun twice.
  try { previous = window.sessionStorage.getItem(LAST_WEAPON_KEY); } catch (_) {}
  const choices = WEAPONS.filter(weapon => weapon.id !== previous);
  return choices[Math.floor(Math.random() * choices.length)];
}

let started = false;

function maybeInit() {
  if (started || !desktop.matches) return;
  started = true;
  try { init(); }
  catch (error) {
    console.warn('[weapon] disabled:', error);
    root.remove();
  }
}
maybeInit();
desktop.addEventListener('change', maybeInit);

function init() {
  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: true, powerPreference: 'low-power'
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new THREE.Scene();
  const environment = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(environment, 0.04).texture;
  environment.dispose();
  pmrem.dispose();

  // A fixed, orthographic view keeps the gun the same size as it turns.
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 20);
  camera.position.set(0, 0, 6);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xdce6ef, 0x473326, 1.1));
  const key = new THREE.DirectionalLight(0xfff0df, 2);
  key.position.set(-2, 3, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff4d42, 1.2);
  rim.position.set(1, 2, -3);
  scene.add(rim);

  // Keep the guns level. Scroll progress drives a complete turn around Y.
  const turntable = new THREE.Group();
  scene.add(turntable);
  let model = null, loaded = false;
  let frameRadius = 1.5;
  let elapsed = 0, currentYaw = 0, targetYaw = 0;
  let previousTime = 0, frameId = 0;
  const sections = Array.from(document.querySelectorAll('[data-agent-yaw]'));

  function resize() {
    if (!desktop.matches) return;
    const stage = root.querySelector('.agent-stage').getBoundingClientRect();
    const width = Math.max(1, Math.round(stage.width));
    const height = Math.max(1, Math.round(stage.height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    const aspect = width / height;
    // Fit the full silhouette at every angle, leaving room at both ends.
    const halfHeight = Math.max(frameRadius, frameRadius / aspect);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
    draw();
  }

  function sync() {
    const line = window.innerHeight * 0.42;
    let active = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= line) active = section;
    }
    // Rotate continuously while scrolling, from 0° at the top to 360° at
    // the bottom. Keep the angle unwrapped so easing never reverses at 180°.
    const scrollRange = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    // Browser scroll offsets can be fractional while scrollHeight is rounded.
    const atBottom = window.scrollY > 0 && scrollRange - window.scrollY <= 1;
    const progress = atBottom ? 1 : THREE.MathUtils.clamp(window.scrollY / scrollRange, 0, 1);
    targetYaw = progress * Math.PI * 2;
    root.dataset.weaponScrollProgress = progress.toFixed(4);
    root.dataset.weaponSection = active?.id || '';
    if (motion.matches) {
      currentYaw = targetYaw;
      draw();
    }
  }

  function draw() {
    if (!loaded) return;
    turntable.rotation.y = currentYaw;
    root.dataset.weaponYaw = turntable.rotation.y.toFixed(3);
    turntable.position.y = motion.matches ? 0 : Math.sin(elapsed * 0.7) * 0.025;
    renderer.render(scene, camera);
  }

  function frame(time) {
    frameId = 0;
    if (document.hidden || !desktop.matches || motion.matches) return;
    const dt = previousTime ? Math.min((time - previousTime) / 1000, 0.05) : 0;
    previousTime = time;
    elapsed += dt;
    currentYaw += (targetYaw - currentYaw) * (1 - Math.pow(0.0015, dt));
    draw();
    frameId = requestAnimationFrame(frame);
  }

  function resume() {
    cancelAnimationFrame(frameId);
    previousTime = 0;
    if (motion.matches) {
      currentYaw = targetYaw;
      draw();
    } else if (loaded && desktop.matches && !document.hidden) {
      frameId = requestAnimationFrame(frame);
    }
  }

  window.addEventListener('resize', () => { sync(); resize(); resume(); });
  window.addEventListener('scroll', sync, { passive: true });
  document.addEventListener('visibilitychange', resume);
  motion.addEventListener('change', resume);

  const loader = new GLTFLoader();
  const selected = chooseWeapon();
  const fallback = { id: 'ak47-default', name: 'AK-47', model: 'assets/model/ak47.glb' };
  async function loadWeapon() {
    let weapon = selected;
    let gltf;
    try { gltf = await loader.loadAsync(weapon.model); }
    catch (error) {
      console.warn('[weapon] using default AK:', error);
      weapon = fallback;
      gltf = await loader.loadAsync(weapon.model);
    }
    model = gltf.scene;
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    model.position.sub(center);
    const normalized = new THREE.Group();
    normalized.add(model);
    const scale = 2.8 / Math.max(size.x, size.y, size.z);
    normalized.scale.setScalar(scale);
    // Pistols have a taller silhouette than rifles. Fit their enclosing sphere
    // at every angle throughout the full turn.
    frameRadius = Math.max(1.5, size.length() * scale * 0.54);
    normalized.rotation.y = Math.PI / 2; // Barrel points right in the opening view.
    model.traverse((object) => {
      if (object.isMesh) object.material.envMapIntensity = 0.85;
    });
    turntable.add(normalized);
    loaded = true;
    sync();
    currentYaw = targetYaw;
    root.dataset.weapon = weapon.id;
    try { window.sessionStorage.setItem(LAST_WEAPON_KEY, weapon.id); } catch (_) {}
    resize();
    root.classList.add('ready');
    draw();
    resume();
  }
  loadWeapon().catch((error) => {
    console.error('[weapon] failed to load:', error);
    root.remove();
  });
}
