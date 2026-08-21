/**
 * Renderer, camera, lighting and post-processing.
 *
 * Lighting had to be rebuilt rather than ported: three switched to physically
 * correct lights in r155, so the old `SpotLight(0xAAAAAA)` at intensity 1 sitting
 * 70 units away now renders essentially black. The rig here is a three-point
 * studio setup lit against an image-based environment generated at runtime from
 * RoomEnvironment, so there is no HDR file to download.
 *
 * Quality is a tier rather than a set of toggles, and the tier can step itself
 * down: a phone that cannot hold 60fps gets fewer passes rather than a
 * slideshow.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HalfFloatType,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  PointLight,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const QUALITY_TIERS = Object.freeze({
  low: { shadows: false, shadowMapSize: 512, bloom: false, smaa: false, maxPixelRatio: 1, textures: 'low' },
  medium: { shadows: true, shadowMapSize: 1024, bloom: true, smaa: false, maxPixelRatio: 1.5, textures: 'medium' },
  high: { shadows: true, shadowMapSize: 2048, bloom: true, smaa: true, maxPixelRatio: 2, textures: 'high' },
  ultra: { shadows: true, shadowMapSize: 4096, bloom: true, smaa: true, maxPixelRatio: 2, textures: 'ultra' },
});

export const QUALITY_ORDER = Object.freeze(['low', 'medium', 'high', 'ultra']);

/** Camera framing, carried over from the original and then tightened. */
export const CAMERA_DISTANCE = 19.5;
export const CAMERA_POLAR_ANGLE = Math.PI / 4.4;
export const CAMERA_TARGET = new Vector3(0, -1.2, 0);

/**
 * A first guess at what this device can handle. Deliberately conservative —
 * `FrameBudget` promotes upward once it has measured real frames.
 */
export function detectQuality() {
  if (typeof navigator === 'undefined') return 'high';
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = navigator.deviceMemory ?? 4;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (coarse && (cores <= 4 || memory <= 4)) return 'low';
  if (coarse) return 'medium';
  if (cores >= 8 && memory >= 8) return 'high';
  return 'medium';
}

/** True when this browser can give us a WebGL context at all. */
export function webGLEnabled() {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * Watches frame times and reports when the current tier is too expensive.
 * Only ever steps down, and only after sustained trouble, so a single hitch
 * (a texture upload, a tab regaining focus) does not degrade the scene.
 */
export class FrameBudget {
  constructor({ targetFps = 55, window: sampleWindow = 90, onDowngrade } = {}) {
    this.targetMs = 1000 / targetFps;
    this.sampleWindow = sampleWindow;
    this.onDowngrade = onDowngrade;
    this.samples = [];
    this.lastTime = null;
    this.cooldownUntil = 0;
  }

  sample(now) {
    if (this.lastTime !== null) {
      const delta = now - this.lastTime;
      // Ignore anything long enough to be a stall rather than a slow frame.
      if (delta < 500) this.samples.push(delta);
      if (this.samples.length > this.sampleWindow) this.samples.shift();
    }
    this.lastTime = now;

    if (this.samples.length < this.sampleWindow || now < this.cooldownUntil) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > this.targetMs * 1.35) {
      this.samples = [];
      this.cooldownUntil = now + 5000;
      this.onDowngrade?.(median);
      return median;
    }
    return null;
  }

  reset() {
    this.samples = [];
    this.lastTime = null;
  }
}

/**
 * Builds the renderer, scene, camera, lights and composer.
 *
 * @param {HTMLElement} container
 * @param {object} theme
 * @param {{ quality?: keyof QUALITY_TIERS, antialias?: boolean }} [options]
 */
export function createScene(container, theme, { quality = 'high', antialias = true } = {}) {
  const tier = QUALITY_TIERS[quality] ?? QUALITY_TIERS.high;

  const renderer = new WebGLRenderer({
    antialias: antialias && !tier.smaa,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, tier.maxPixelRatio));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = tier.shadows;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.setAttribute('aria-hidden', 'true');

  const scene = new Scene();
  scene.background = new Color(theme.background);
  if (theme.fog) scene.fog = new Fog(theme.fog.color, theme.fog.near, theme.fog.far);

  // Image-based lighting from a procedurally generated room. Gives the physical
  // materials something to reflect, which is most of what makes them read as
  // marble or lacquer rather than coloured plastic.
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = theme.environment?.intensity ?? 0.6;
  pmrem.dispose();

  const camera = new PerspectiveCamera(42, 1, 0.1, 260);
  camera.position.set(
    0,
    CAMERA_DISTANCE * Math.cos(CAMERA_POLAR_ANGLE),
    CAMERA_DISTANCE * Math.sin(CAMERA_POLAR_ANGLE),
  );
  camera.lookAt(CAMERA_TARGET);

  // --- lights ---------------------------------------------------------------
  const lights = new Group();
  lights.name = 'lights';

  // Key: the only shadow caster. Directional rather than spot so the shadow
  // frustum is a simple box and the whole board stays inside it.
  const key = new DirectionalLight(0xfff4e6, 2.6);
  key.position.set(-11, 20, 9);
  key.castShadow = tier.shadows;
  if (tier.shadows) {
    key.shadow.mapSize.set(tier.shadowMapSize, tier.shadowMapSize);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 60;
    const extent = 15;
    key.shadow.camera.left = -extent;
    key.shadow.camera.right = extent;
    key.shadow.camera.top = extent;
    key.shadow.camera.bottom = -extent;
    // Normal bias handles the curved piece bodies; a plain bias would either
    // peter-pan the shadows or leave acne on the shafts.
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = 2;
  }
  lights.add(key, key.target);

  // Fill: opposite side, cool, no shadow — lifts the dark pieces off the board.
  const fill = new DirectionalLight(0xbcd4ff, 0.85);
  fill.position.set(13, 9, -11);
  lights.add(fill, fill.target);

  // Rim: low and behind, to separate silhouettes from the backdrop.
  const rim = new PointLight(0xffd9a0, 40, 60, 2);
  rim.position.set(0, 4, -16);
  lights.add(rim);

  const ambient = new AmbientLight(0xffffff, 0.25);
  lights.add(ambient);
  scene.add(lights);

  // --- post-processing ------------------------------------------------------
  const composer = new EffectComposer(renderer);
  composer.renderTarget1.texture.type = HalfFloatType;
  composer.renderTarget2.texture.type = HalfFloatType;
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  let bloomPass = null;
  if (tier.bloom && (theme.post?.bloom ?? 0) > 0) {
    bloomPass = new UnrealBloomPass(
      { x: 1, y: 1 },
      theme.post.bloom,
      0.5,
      theme.post.bloomThreshold ?? 0.8,
    );
    composer.addPass(bloomPass);
  }
  if (tier.smaa) composer.addPass(new SMAAPass());
  composer.addPass(new OutputPass());

  container.appendChild(renderer.domElement);

  const api = {
    renderer,
    scene,
    camera,
    composer,
    lights: { key, fill, rim, ambient, group: lights },
    bloomPass,
    quality,
    tier,

    /** Sizes everything from the container's real box, DPR included. */
    resize() {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      composer.setSize(width, height);
      bloomPass?.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      return { width, height };
    },

    render() {
      composer.render();
    },

    /** Applies a theme's background, fog, environment strength and bloom. */
    applyTheme(next) {
      scene.background = new Color(next.background);
      scene.fog = next.fog ? new Fog(next.fog.color, next.fog.near, next.fog.far) : null;
      scene.environmentIntensity = next.environment?.intensity ?? 0.6;
      if (bloomPass) {
        bloomPass.strength = next.post?.bloom ?? 0.2;
        bloomPass.threshold = next.post?.bloomThreshold ?? 0.8;
      }
    },

    setExposure(value) {
      renderer.toneMappingExposure = value;
    },

    dispose() {
      environment.texture.dispose();
      composer.dispose?.();
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
    },
  };

  api.resize();
  return api;
}
