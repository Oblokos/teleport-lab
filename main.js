"use strict";

const INVENTORY_PATH = "asset_inventory_full.json";
const MODELS_PATH = "models/";
const IMAGES_PATH = "images/";

const FALLBACK_SIZE = { w: 1, h: 1 };
const MODEL_CONCURRENCY = 1;
const IMAGE_CONCURRENCY = 8;
const STATUS_UPDATE_EVERY = 10;
const YIELD_TO_UI_EVERY = 12;
const MAX_PIXEL_RATIO = 2;

const VIEWER_CONFIG = {
  // Spatial export currently appears mirrored in this viewer; keep this on.
  // If source transforms are later exported in native Three.js convention, set to false.
  mirrorXAxisOnImport: true,
  enableShadows: true,
  shadowCasterLimit: 80
};

const statusEl = document.querySelector("#status");
const canvas = document.querySelector("#c");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.physicallyCorrectLights = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = VIEWER_CONFIG.enableShadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a12);
scene.fog = new THREE.FogExp2(0x0a0a12, 0.0016);

const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 5000);
camera.position.set(0, 10, 45);

const controls = new THREE.OrbitControls(camera, canvas);
controls.target.set(0, 0, 0);
controls.update();

const world = new THREE.Group();
scene.add(world);

const textureLoader = new THREE.TextureLoader();
const gltfLoader = new THREE.GLTFLoader();
const clock = new THREE.Clock();

const mixers = [];
let hasAnimatedModels = false;
let renderLoopActive = false;
let frameRequested = true;
let shadowCasterBudget = VIEWER_CONFIG.shadowCasterLimit;

const texturePromiseCache = new Map();
const modelTemplateCache = new Map();
const imageMaterialCache = new Map();
const imageGeometryCache = new Map();

const fallbackMaterial = new THREE.MeshStandardMaterial({
  map: buildFallbackTexture(),
  transparent: true,
  opacity: 0.78,
  roughness: 0.92,
  metalness: 0.05,
  emissive: new THREE.Color(0x1a140a),
  emissiveIntensity: 0.2,
  side: THREE.DoubleSide,
  depthTest: true,
  depthWrite: true
});

const tmpPosition = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpBox = new THREE.Box3();
const tmpCenter = new THREE.Vector3();
const tmpSize = new THREE.Vector3();

const atmosphere = createAtmosphereDome(scene);
createLightingRig(scene);
const ground = createGroundReference(scene);

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isFiniteVec3(v) {
  return !!v &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z);
}

function isFiniteBox(box) {
  return !!box &&
    isFiniteVec3(box.min) &&
    isFiniteVec3(box.max);
}

function getVector3(source, fallback) {
  const ref = source || {};
  return {
    x: asNumber(ref.x, fallback.x),
    y: asNumber(ref.y, fallback.y),
    z: asNumber(ref.z, fallback.z)
  };
}

function getQuaternion(source, targetQuaternion) {
  const q = targetQuaternion || new THREE.Quaternion();
  const r = source;

  if (Array.isArray(r) && r.length === 4) {
    q.set(
      asNumber(r[0], 0),
      asNumber(r[1], 0),
      asNumber(r[2], 0),
      asNumber(r[3], 1)
    );
    q.normalize();
    return q;
  }

  if (r && typeof r === "object" && "x" in r && "y" in r && "z" in r && "w" in r) {
    q.set(
      asNumber(r.x, 0),
      asNumber(r.y, 0),
      asNumber(r.z, 0),
      asNumber(r.w, 1)
    );
    q.normalize();
    return q;
  }

  if (r && typeof r === "object") {
    q.setFromEuler(
      new THREE.Euler(
        asNumber(r.x, 0),
        asNumber(r.y, 0),
        asNumber(r.z, 0)
      )
    );
    return q;
  }

  q.identity();
  return q;
}

function applyTransform(object3D, transform) {
  const t = transform || {};

  const p = getVector3(t.position, { x: 0, y: 0, z: 0 });
  const s = getVector3(t.scale, { x: 1, y: 1, z: 1 });
  getQuaternion(t.rotation, tmpQuat);

  tmpPosition.set(p.x, p.y, p.z);
  tmpScale.set(s.x, s.y, s.z);

  if (VIEWER_CONFIG.mirrorXAxisOnImport) {
    // Axis-conversion without matrix decomposition to avoid NaN with degenerate scales.
    object3D.position.set(-tmpPosition.x, tmpPosition.y, tmpPosition.z);
    object3D.quaternion.set(tmpQuat.x, -tmpQuat.y, -tmpQuat.z, tmpQuat.w).normalize();
    object3D.scale.copy(tmpScale);
    return;
  }

  object3D.position.copy(tmpPosition);
  object3D.quaternion.copy(tmpQuat);
  object3D.scale.copy(tmpScale);
}

function buildFallbackTexture() {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");

  ctx.clearRect(0, 0, size, size);

  ctx.fillStyle = "rgba(42, 46, 55, 0.56)";
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = "rgba(255, 205, 67, 0.95)";
  ctx.lineWidth = 10;
  ctx.strokeRect(10, 10, size - 20, size - 20);

  ctx.fillStyle = "rgba(255, 213, 79, 0.98)";
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.18);
  ctx.lineTo(size * 0.82, size * 0.78);
  ctx.lineTo(size * 0.18, size * 0.78);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#1a1a1a";
  ctx.font = "bold 112px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", size * 0.5, size * 0.56);

  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  tex.needsUpdate = true;
  return tex;
}

function getPlaneSizeFromTexture(texture) {
  const img = texture && texture.image ? texture.image : null;
  const width = asNumber(img && (img.naturalWidth || img.videoWidth || img.width), 0);
  const height = asNumber(img && (img.naturalHeight || img.videoHeight || img.height), 0);

  if (width <= 0 || height <= 0) return { ...FALLBACK_SIZE };

  const maxDimension = Math.max(width, height);
  return {
    w: width / maxDimension,
    h: height / maxDimension
  };
}

function createImageLayer(texture) {
  const geo = getImageGeometry(texture);
  const mat = getImageMaterial(texture);

  const front = new THREE.Mesh(geo, mat);
  const back = new THREE.Mesh(geo, mat);
  back.rotation.y = Math.PI;
  back.scale.x = -1;
  if (VIEWER_CONFIG.enableShadows) {
    front.castShadow = false;
    front.receiveShadow = true;
    back.castShadow = false;
    back.receiveShadow = true;
  }

  const holder = new THREE.Group();
  holder.add(front);
  holder.add(back);
  return holder;
}

function getImageGeometry(texture) {
  const size = getPlaneSizeFromTexture(texture);
  const key = `${size.w.toFixed(5)}:${size.h.toFixed(5)}`;
  if (imageGeometryCache.has(key)) return imageGeometryCache.get(key);

  const geo = new THREE.PlaneBufferGeometry(size.w, size.h);
  imageGeometryCache.set(key, geo);
  return geo;
}

function getImageMaterial(texture) {
  const key = texture.uuid;
  if (imageMaterialCache.has(key)) return imageMaterialCache.get(key);

  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.02,
    roughness: 0.85,
    metalness: 0.06,
    emissive: new THREE.Color(0x0c0d14),
    emissiveIntensity: 0.08,
    depthTest: true,
    depthWrite: true,
    side: THREE.FrontSide
  });
  imageMaterialCache.set(key, mat);
  return mat;
}

function addFallbackPlane(asset, reason) {
  const holder = new THREE.Group();
  const plane = new THREE.Mesh(
    new THREE.PlaneBufferGeometry(FALLBACK_SIZE.w, FALLBACK_SIZE.h),
    fallbackMaterial
  );
  holder.add(plane);
  applyTransform(holder, asset && asset.transform ? asset.transform : null);
  holder.userData.asset = asset || null;
  holder.userData.error = reason || "load_error";
  world.add(holder);
}

function loadTextureByFile(fileName) {
  if (texturePromiseCache.has(fileName)) return texturePromiseCache.get(fileName);

  const p = new Promise((resolve, reject) => {
    textureLoader.load(
      `${IMAGES_PATH}${fileName}`,
      (tex) => {
        tex.encoding = THREE.sRGBEncoding;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
        tex.needsUpdate = true;
        resolve(tex);
      },
      undefined,
      (err) => reject(err || new Error("Texture load failed"))
    );
  });

  texturePromiseCache.set(fileName, p);
  return p;
}

function loadModelTemplate(fileName) {
  if (modelTemplateCache.has(fileName)) return modelTemplateCache.get(fileName);

  const p = new Promise((resolve, reject) => {
    gltfLoader.load(
      `${MODELS_PATH}${fileName}`,
      (gltf) => {
        const model = gltf && (gltf.scene || (gltf.scenes && gltf.scenes[0]));
        if (!model) {
          reject(new Error("Empty GLTF scene"));
          return;
        }
        const animations = Array.isArray(gltf.animations) ? gltf.animations : [];
        const unitScale = getModelUnitScale(model);
        resolve({ template: model, unitScale, animations });
      },
      undefined,
      (err) => reject(err || new Error("Model load failed"))
    );
  });

  modelTemplateCache.set(fileName, p);
  return p;
}

function cloneModel(template) {
  if (
    THREE.SkeletonUtils &&
    typeof THREE.SkeletonUtils.clone === "function"
  ) {
    return THREE.SkeletonUtils.clone(template);
  }
  return template.clone(true);
}

async function addImageAsset(asset) {
  const fileName = asset.mapped_file;
  if (!fileName) throw new Error("missing mapped_file");

  const texture = await loadTextureByFile(fileName);
  const layer = createImageLayer(texture);
  applyTransform(layer, asset.transform);
  layer.userData.asset = asset;
  world.add(layer);
}

function configureModelForScene(root) {
  root.traverse((node) => {
    if (!node || !node.isMesh) return;

    node.frustumCulled = true;

    if (VIEWER_CONFIG.enableShadows) {
      const cast = shadowCasterBudget > 0;
      node.castShadow = cast;
      node.receiveShadow = false;
      if (cast) shadowCasterBudget -= 1;
    }
  });
}

function registerModelAnimations(root, clips) {
  if (!clips || clips.length === 0) return;

  const mixer = new THREE.AnimationMixer(root);
  for (let i = 0; i < clips.length; i += 1) {
    mixer.clipAction(clips[i]).play();
  }
  mixers.push(mixer);

  if (!hasAnimatedModels) {
    hasAnimatedModels = true;
    ensureRenderLoopState();
  }
}

async function addModelAsset(asset) {
  const fileName = asset.mapped_file;
  if (!fileName) throw new Error("missing mapped_file");

  const modelEntry = await loadModelTemplate(fileName);
  const template = modelEntry.template;
  const unitScale = modelEntry.unitScale;
  const instance = cloneModel(template);
  instance.scale.multiplyScalar(unitScale);
  configureModelForScene(instance);
  registerModelAnimations(instance, modelEntry.animations);

  const holder = new THREE.Group();
  holder.add(instance);
  applyTransform(holder, asset.transform);
  holder.userData.asset = asset;
  world.add(holder);
}

async function addAsset(asset) {
  if (asset.assetType === "model") {
    await addModelAsset(asset);
    return;
  }

  if (asset.assetType === "image") {
    await addImageAsset(asset);
    return;
  }

  throw new Error(`unsupported type: ${asset.assetType || "unknown"}`);
}

function centerObjectAtOrigin(object3D) {
  tmpBox.setFromObject(object3D);
  if (tmpBox.isEmpty() || !isFiniteBox(tmpBox)) return;
  tmpBox.getCenter(tmpCenter);
  if (!isFiniteVec3(tmpCenter)) return;
  object3D.position.sub(tmpCenter);
}

function getModelUnitScale(modelRoot) {
  tmpBox.setFromObject(modelRoot);
  if (tmpBox.isEmpty() || !isFiniteBox(tmpBox)) return 1;

  tmpBox.getSize(tmpSize);
  if (!isFiniteVec3(tmpSize)) return 1;
  const maxDim = Math.max(tmpSize.x, tmpSize.y, tmpSize.z);
  if (!Number.isFinite(maxDim) || maxDim <= 0) return 1;
  return 1 / maxDim;
}

function fitCameraToObject(cameraRef, object3D, controlsRef, offset) {
  tmpBox.setFromObject(object3D);
  if (tmpBox.isEmpty() || !isFiniteBox(tmpBox)) return;

  tmpBox.getSize(tmpSize);
  tmpBox.getCenter(tmpCenter);
  if (!isFiniteVec3(tmpSize) || !isFiniteVec3(tmpCenter)) return;

  const maxDim = Math.max(tmpSize.x, tmpSize.y, tmpSize.z);
  const safeMaxDim = Math.max(maxDim, 1);
  const fov = cameraRef.fov * (Math.PI / 180);
  let cameraZ = Math.abs((safeMaxDim / 2) / Math.tan(fov / 2));
  cameraZ *= asNumber(offset, 1.3);
  cameraZ = clamp(cameraZ, 10, 280);

  cameraRef.position.set(tmpCenter.x, tmpCenter.y + safeMaxDim * 0.08, tmpCenter.z + cameraZ);
  cameraRef.near = Math.max(Math.min(safeMaxDim / 1000, 0.2), 0.01);
  cameraRef.far = Math.max(safeMaxDim * 20, cameraZ * 8, 1200);
  cameraRef.updateProjectionMatrix();

  // Keep volumetric atmosphere without fully blacking out large reconstructions.
  if (scene.fog && scene.fog.isFogExp2) {
    const adaptiveDensity = 0.45 / Math.max(cameraZ, 1);
    scene.fog.density = clamp(adaptiveDensity, 0.00018, 0.0012);
  }

  if (controlsRef) {
    controlsRef.target.copy(tmpCenter);
    controlsRef.update();
  }
}

function resizeRendererToDisplaySize(rendererRef) {
  const width = canvas.clientWidth | 0;
  const height = canvas.clientHeight | 0;
  const needResize = canvas.width !== width || canvas.height !== height;
  if (needResize) rendererRef.setSize(width, height, false);
  return needResize;
}

function requestRender() {
  frameRequested = true;
  ensureRenderLoopState();
}

function ensureRenderLoopState() {
  const shouldRun = hasAnimatedModels || frameRequested;

  if (shouldRun && !renderLoopActive) {
    clock.start();
    renderer.setAnimationLoop(renderFrame);
    renderLoopActive = true;
    return;
  }

  if (!shouldRun && renderLoopActive) {
    renderer.setAnimationLoop(null);
    clock.stop();
    renderLoopActive = false;
  }
}

function renderFrame() {
  const delta = Math.min(clock.getDelta(), 0.05);

  if (resizeRendererToDisplaySize(renderer)) {
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    frameRequested = true;
  }

  if (hasAnimatedModels) {
    for (let i = 0; i < mixers.length; i += 1) {
      mixers[i].update(delta);
    }
    frameRequested = true;
  }

  if (!frameRequested) {
    if (!hasAnimatedModels) ensureRenderLoopState();
    return;
  }

  frameRequested = false;
  atmosphere.position.copy(camera.position);
  renderer.render(scene, camera);

  if (!hasAnimatedModels) {
    ensureRenderLoopState();
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function runWithConcurrency(items, concurrency, worker) {
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const current = index;
      index += 1;
      await worker(items[current]);
    }
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const runners = [];
  for (let i = 0; i < safeConcurrency; i += 1) {
    runners.push(runner());
  }
  await Promise.all(runners);
}

function createAtmosphereDome(sceneRef) {
  const geo = new THREE.SphereBufferGeometry(1600, 32, 18);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(0x1a2040) },
      uHorizon: { value: new THREE.Color(0x181225) },
      uBottom: { value: new THREE.Color(0x07070d) }
    },
    vertexShader: [
      "varying vec3 vWorld;",
      "void main() {",
      "  vec4 wp = modelMatrix * vec4(position, 1.0);",
      "  vWorld = wp.xyz;",
      "  gl_Position = projectionMatrix * viewMatrix * wp;",
      "}"
    ].join("\n"),
    fragmentShader: [
      "uniform vec3 uTop;",
      "uniform vec3 uHorizon;",
      "uniform vec3 uBottom;",
      "varying vec3 vWorld;",
      "void main() {",
      "  float h = clamp(normalize(vWorld).y * 0.5 + 0.5, 0.0, 1.0);",
      "  vec3 color = mix(uBottom, uHorizon, smoothstep(0.0, 0.4, h));",
      "  color = mix(color, uTop, smoothstep(0.38, 1.0, h));",
      "  gl_FragColor = vec4(color, 1.0);",
      "}"
    ].join("\n"),
    side: THREE.BackSide,
    depthWrite: false
  });

  const dome = new THREE.Mesh(geo, mat);
  dome.frustumCulled = false;
  sceneRef.add(dome);
  return dome;
}

function createLightingRig(sceneRef) {
  const ambient = new THREE.AmbientLight(0xc7d2ef, 0.8);
  const hemi = new THREE.HemisphereLight(0x222544, 0x110d14, 0.84);
  const directional = new THREE.DirectionalLight(0xd6ddff, 0.6);
  directional.position.set(24, 34, 16);

  if (VIEWER_CONFIG.enableShadows) {
    directional.castShadow = true;
    directional.shadow.mapSize.set(1024, 1024);
    directional.shadow.radius = 3;
    directional.shadow.bias = -0.0006;
    directional.shadow.camera.near = 0.5;
    directional.shadow.camera.far = 180;
    directional.shadow.camera.left = -70;
    directional.shadow.camera.right = 70;
    directional.shadow.camera.top = 70;
    directional.shadow.camera.bottom = -70;
  }

  const portalHint = new THREE.PointLight(0x5068ff, 0.17, 130, 2);
  portalHint.position.set(0, 10, 0);

  sceneRef.add(ambient);
  sceneRef.add(hemi);
  sceneRef.add(directional);
  sceneRef.add(portalHint);

  return { ambient, hemi, directional, portalHint };
}

function setMaterialOpacity(material, opacity) {
  if (!material) return;
  material.transparent = true;
  material.opacity = opacity;
  material.depthWrite = false;
}

function createGroundReference(sceneRef) {
  const root = new THREE.Group();

  const plane = new THREE.Mesh(
    new THREE.PlaneBufferGeometry(1, 1),
    new THREE.MeshStandardMaterial({
      color: 0x0c0d13,
      roughness: 0.95,
      metalness: 0.1,
      transparent: true,
      opacity: 0.52
    })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = VIEWER_CONFIG.enableShadows;
  root.add(plane);

  const grid = new THREE.GridHelper(1, 24, 0x2a3040, 0x1a1d28);
  if (Array.isArray(grid.material)) {
    for (let i = 0; i < grid.material.length; i += 1) {
      setMaterialOpacity(grid.material[i], 0.12);
    }
  } else {
    setMaterialOpacity(grid.material, 0.12);
  }
  grid.position.y = 0.015;
  root.add(grid);

  root.userData = { plane, grid };
  sceneRef.add(root);
  return root;
}

function updateGroundReference(root, target) {
  if (!root || !target) return;
  tmpBox.setFromObject(target);
  if (tmpBox.isEmpty() || !isFiniteBox(tmpBox)) return;

  tmpBox.getCenter(tmpCenter);
  tmpBox.getSize(tmpSize);
  if (!isFiniteVec3(tmpCenter) || !isFiniteVec3(tmpSize)) return;

  const minY = tmpBox.min.y;
  const extent = Math.max(8, tmpSize.x, tmpSize.z);

  root.position.set(tmpCenter.x, minY - 0.08, tmpCenter.z);
  root.userData.plane.scale.set(extent * 2.6, extent * 2.6, 1);
  root.userData.grid.scale.set(extent * 2.2, 1, extent * 2.2);
}

async function main() {
  setStatus("Cargando inventario...");

  const response = await fetch(INVENTORY_PATH);
  if (!response.ok) {
    throw new Error(`No se pudo cargar ${INVENTORY_PATH} (${response.status})`);
  }

  const inventory = await response.json();
  const assets = Array.isArray(inventory.assets) ? inventory.assets : [];

  const totals = {
    total: assets.length,
    ok: 0,
    fallback: 0,
    loaded: 0
  };

  const modelAssets = assets.filter((asset) => asset && asset.assetType === "model");
  const imageAssets = assets.filter((asset) => asset && asset.assetType === "image");
  const otherAssets = assets.filter(
    (asset) => !asset || (asset.assetType !== "model" && asset.assetType !== "image")
  );

  setStatus(`Cargando assets: 0/${totals.total}`);

  async function handleAsset(asset) {
    try {
      await addAsset(asset);
      totals.ok += 1;
    } catch (err) {
      totals.fallback += 1;
      addFallbackPlane(asset, err && err.message ? err.message : "load_error");
    } finally {
      totals.loaded += 1;

      if (totals.loaded % STATUS_UPDATE_EVERY === 0 || totals.loaded === totals.total) {
        setStatus(
          `Cargando assets: ${totals.loaded}/${totals.total} | OK: ${totals.ok} | Fallback: ${totals.fallback}`
        );
        requestRender();
      }

      if (totals.loaded % YIELD_TO_UI_EVERY === 0) {
        await nextFrame();
      }
    }
  }

  for (let i = 0; i < otherAssets.length; i += 1) {
    totals.fallback += 1;
    totals.loaded += 1;
    addFallbackPlane(otherAssets[i], "unsupported type");
  }

  await runWithConcurrency(modelAssets, MODEL_CONCURRENCY, handleAsset);
  await runWithConcurrency(imageAssets, IMAGE_CONCURRENCY, handleAsset);

  updateGroundReference(ground, world);
  fitCameraToObject(camera, world, controls, 1.4);
  requestRender();

  setStatus(
    `Listo. Total: ${totals.total} | Cargados: ${totals.ok} | Fallback: ${totals.fallback}`
  );
}

controls.addEventListener("change", requestRender);
window.addEventListener("resize", requestRender);

main().catch((err) => {
  console.error(err);
  setStatus(err && err.message ? err.message : "Error inesperado");
  requestRender();
});

requestRender();
