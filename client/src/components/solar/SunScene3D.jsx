// 3D site view with live shadow casting and a draggable sun.
//
// Frames: the analysis works in ENU metres (+x East, +y North, +z up); three.js
// is Y-up with -Z conventionally "away". Everything crossing the boundary goes
// through enu() / sunDir() below, so the mapping lives in exactly two places.
//
// Shadows are the GPU's, not the analyser's: a DirectionalLight aimed down the
// sun vector with a PCF-soft shadow map. That gives an instant, honest picture
// of what falls where at any moment. The *numbers* (annual shade-free %, panel
// efficiency) always come from lib/solar/shadow.js — the render is the
// illustration, never the evidence.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { sunPath, dateToDoy, doyToDate } from '../../lib/solar/sun';
import { panelCorners, perfColor, surfaceZ, polyCentroid, polyBounds } from '../../lib/solar/shadow';

const RAD = Math.PI / 180;

/**
 * Radius of the sun/sky dome, in metres, sized to the site.
 *
 * The sun is a control, not a celestial body: OrbitControls always points the
 * camera AT the site, so anything parked at an astronomical distance sits
 * outside the frustum at every angle the user can reach — un-seeable and
 * un-grabbable. Keeping the dome at roughly 2.4× the site's reach puts the sun
 * and its path arcs in frame from any orbit position, which is what every
 * shading tool does. Shadow direction is unaffected: the light is directional.
 */
function domeRadius(site) {
  let reach = 18;
  for (const s of [...(site?.surfaces || []), ...(site?.obstructions || [])]) {
    for (const [x, y] of s.polygon || []) reach = Math.max(reach, Math.abs(x), Math.abs(y));
  }
  return Math.max(reach * 2.4, 55);
}

// ENU metres → three.js world.
const enu = (x, y, z) => new THREE.Vector3(x, z, -y);
/** Unit vector pointing at the sun, in three.js world space. */
function sunDir(azDeg, elDeg) {
  const el = elDeg * RAD, az = azDeg * RAD, c = Math.cos(el);
  return new THREE.Vector3(c * Math.sin(az), Math.sin(el), -c * Math.cos(az));
}

const KIND_COLOR = {
  parapet: 0x9ca3af, tank: 0x60a5fa, stair: 0xa78bfa, chimney: 0x94a3b8,
  ac: 0xcbd5e1, pole: 0x64748b, tree: 0x3f8f4f, building: 0x8b8b8b,
};

// Sky gradient that warms as the sun drops — reads as "this is late afternoon"
// before you've looked at the clock.
const SKY_VERT = `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const SKY_FRAG = `
  uniform vec3 top; uniform vec3 bottom; uniform float horizonMix;
  varying vec3 vP;
  void main(){
    float h = clamp(normalize(vP).y * 0.5 + 0.5, 0.0, 1.0);
    vec3 c = mix(bottom, top, pow(h, 0.8 + horizonMix));
    gl_FragColor = vec4(c, 1.0);
  }`;

// Shared cell-grid texture for every panel instance, generated once. Cell
// boundaries and busbars are drawn slightly BRIGHTER than the cell body on a
// near-white base — under multiply blending with the per-instance efficiency
// vertex color, busbars come out as bright highlight lines and cell bodies a
// touch darker, so the module reads as a real glazed panel instead of a flat
// rectangle, without ever shifting the hue that encodes the efficiency data.
let _panelTexture = null;
function getPanelTexture() {
  if (_panelTexture) return _panelTexture;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#c7cdd3';
  g.fillRect(0, 0, size, size);
  const cols = 12, rows = 6;
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 1.4;
  for (let i = 1; i < cols; i++) {
    const x = (i / cols) * size;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, size); g.stroke();
  }
  for (let j = 1; j < rows; j++) {
    const y = (j / rows) * size;
    g.beginPath(); g.moveTo(0, y); g.lineTo(size, y); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 2.6;
  for (let k = 1; k <= 3; k++) {
    const x = (k / 4) * size;
    g.beginPath(); g.moveTo(x, 2); g.lineTo(x, size - 2); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 5;
  g.strokeRect(2.5, 2.5, size - 5, size - 5);
  _panelTexture = new THREE.CanvasTexture(c);
  return _panelTexture;
}

/** A lumpy sphere reads as foliage; a perfect one reads as a beach ball. */
function canopyGeometry(radius) {
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).multiplyScalar(0.85 + Math.random() * 0.3);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Animate the camera between two framings instead of an instant jump. */
function tweenCamera(camera, controls, toPos, toTarget, duration = 650) {
  const fromPos = camera.position.clone();
  const fromTarget = controls.target.clone();
  if (fromPos.distanceTo(toPos) < 0.01 && fromTarget.distanceTo(toTarget) < 0.01) return;
  const t0 = performance.now();
  const step = () => {
    const k = easeInOutQuad(Math.min(1, (performance.now() - t0) / duration));
    camera.position.lerpVectors(fromPos, toPos, k);
    controls.target.lerpVectors(fromTarget, toTarget, k);
    controls.update();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function labelSprite(text, color = '#e2e8f0', size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.font = `bold ${size * 0.5}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(15,23,42,0.55)';
  g.beginPath(); g.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2); g.fill();
  g.fillStyle = color;
  g.fillText(text, size / 2, size / 2 + size * 0.03);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.renderOrder = 999;
  return s;
}

const SunScene3D = forwardRef(function SunScene3D({
  site, analysis, sun, groundTexture,
  showHeatmap = false, showSunPaths = true, showPanels = true, colorMode = 'perf',
  onSunDrag, onPickPanel, selectedPanelId, cameraPreset,
}, ref) {
  const hostRef = useRef(null);
  const R = useRef({});                    // long-lived three.js objects
  const dome = useMemo(() => domeRadius(site), [site]);
  const dragRef = useRef(null);
  // The pointer handlers are bound once at mount but need the *current* sun and
  // callbacks, so they read them through refs kept fresh after every render.
  const sunRef = useRef(sun);
  const cbRef = useRef({ onSunDrag, onPickPanel });
  useEffect(() => {
    sunRef.current = sun;
    cbRef.current = { onSunDrag, onPickPanel };
  });

  // ── mount ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.5, 4000);
    camera.position.set(45, 55, 75);

    // preserveDrawingBuffer costs a touch of perf (disables an implicit
    // double-buffer optimization) but is what makes captureSnapshot() below
    // reliable — without it, toDataURL() can race the browser's own clear.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:grab';

    // IBL environment for the PBR materials (panels especially) — generated
    // from a small self-contained room scene, not a fetched HDRI, so panels
    // get believable sky/ambient reflections with no network dependency or
    // asset-loading failure mode.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = envTexture;
    // The scene already has hemisphere + ambient + directional lights tuned
    // for a good look on their own — IBL is layered on TOP of that, not in
    // place of it, so it needs to stay a subtle reflection/fill contribution
    // (this one dial scales every material's envMapIntensity at once) rather
    // than a second full light source stacking on the first.
    scene.environmentIntensity = 0.35;

    // Distance fog: hides the ground plane's hard edge and adds depth cueing.
    // Density is re-tuned to the site's scale once geometry loads; color is
    // kept in sync with the sky's horizon tone every sun-position tick.
    scene.fog = new THREE.FogExp2(0xbfd8ef, 1.1 / 250);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;   // never dip below the ground
    controls.minDistance = 6;
    controls.maxDistance = 900;
    controls.target.set(0, 4, 0);

    // Sky dome (also the drag surface for the sun).
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x1e5fa8) },
        bottom: { value: new THREE.Color(0xbfd8ef) },
        horizonMix: { value: 0.4 },
      },
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1600, 32, 20), skyMat);
    scene.add(sky);

    const hemi = new THREE.HemisphereLight(0xbcd6f0, 0x6b6152, 1.0);
    scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xffffff, 0.25);
    scene.add(ambient);

    const sunLight = new THREE.DirectionalLight(0xfff3d6, 2.4);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.bias = -0.0006;
    sunLight.shadow.normalBias = 0.02;
    scene.add(sunLight);
    scene.add(sunLight.target);

    // The sun marker: a bright core, a soft halo, and an oversized invisible
    // sphere so it stays grabbable on a phone. Built at unit radius and scaled
    // to the dome, so it keeps the same apparent size on any size of site.
    const sunGroup = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff0b0, toneMapped: false }),
    );
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xffd257, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false }),
    );
    const grab = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    grab.userData.isSun = true;
    sunGroup.add(core, halo, grab);
    scene.add(sunGroup);

    // Ray from the sun to the site — makes the sun's bearing readable even when
    // it's off past the edge of the view.
    const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const sunRay = new THREE.Line(rayGeom, new THREE.LineDashedMaterial({ color: 0xffd257, dashSize: 6, gapSize: 4, transparent: true, opacity: 0.5 }));
    scene.add(sunRay);

    const groups = {
      site: new THREE.Group(), panels: new THREE.Group(),
      heat: new THREE.Group(), paths: new THREE.Group(), compass: new THREE.Group(),
    };
    Object.values(groups).forEach((g) => scene.add(g));

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    // ── sun dragging ──
    const ptr = (e) => {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      return r;
    };
    const onPointerDown = (e) => {
      const rect = ptr(e);
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.intersectObject(grab, false).length) {
        dragRef.current = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
        controls.enabled = false;
        renderer.domElement.style.cursor = 'grabbing';
        renderer.domElement.setPointerCapture?.(e.pointerId);
      }
    };
    const onPointerMove = (e) => {
      const d = dragRef.current;
      if (!d) {
        // Hover feedback so the sun reads as grabbable.
        ptr(e);
        raycaster.setFromCamera(pointer, camera);
        renderer.domElement.style.cursor = raycaster.intersectObject(grab, false).length ? 'grab' : 'default';
        return;
      }
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!dx && !dy) return;
      dragRef.current = { ...d, x: e.clientX, y: e.clientY };
      // Across the full canvas width ≈ 8 h of the day; full height ≈ 150 days.
      const dMinutes = (dx / d.w) * 480;
      // Up must always raise the sun, so the date step flips sign in the half of
      // the year when later dates mean a *lower* sun (after the June solstice).
      const s = sunRef.current || {};
      const doy = dateToDoy(s.month ?? 6, s.day ?? 21);
      const rising = doy <= 172 || doy >= 355;          // Dec solstice → Jun solstice
      const dDays = (-dy / d.h) * 150 * (rising ? 1 : -1);
      cbRef.current.onSunDrag?.({ dMinutes, dDays });
    };
    const endDrag = (e) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      controls.enabled = true;
      renderer.domElement.style.cursor = 'grab';
      renderer.domElement.releasePointerCapture?.(e.pointerId);
    };
    const onClick = (e) => {
      if (dragRef.current) return;
      ptr(e);
      raycaster.setFromCamera(pointer, camera);
      const inst = R.current.panelMesh;
      if (!inst) return;
      const hit = raycaster.intersectObject(inst, false)[0];
      if (hit && hit.instanceId != null) cbRef.current.onPickPanel?.(hit.instanceId);
    };

    const el = renderer.domElement;
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('click', onClick);

    // Post-processing: bloom on the sun only. Threshold sits just under the
    // sun core's raw (toneMapped:false) brightness so it glows while normal
    // tone-mapped scene geometry — even a bright sky or white wall — stays
    // under it and doesn't wash out.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // UnrealBloomPass thresholds against the scene's LINEAR pre-tonemap
    // radiance (it sits before OutputPass in the chain), not the final
    // display-referred image — so this threshold has to clear ordinary lit
    // geometry (sunlit white walls, panel grid highlights), not just look
    // high relative to the tone-mapped screenshot. Only the sun core/halo
    // (toneMapped:false, ~1.0-1.2 raw) should ever cross it.
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(host.clientWidth || 640, host.clientHeight || 420), 0.45, 0.35, 1.35);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    const resize = () => {
      const w = host.clientWidth || 640, h = host.clientHeight || 420;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      composer.setSize(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    let raf = 0;
    const loop = () => { raf = requestAnimationFrame(loop); controls.update(); composer.render(); };
    loop();

    R.current = { scene, camera, renderer, composer, controls, sunLight, sunGroup, sunRay, groups, skyMat, hemi, ambient, host, core, halo, grab };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endDrag);
      el.removeEventListener('pointercancel', endDrag);
      el.removeEventListener('click', onClick);
      controls.dispose();
      envTexture.dispose();
      composer.dispose?.();
      scene.traverse((o) => {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose?.()); else m?.dispose?.();
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      R.current = {};
    };
  }, []);

  // ── ground + site geometry ───────────────────────────────────────────────
  const clearGroup = useCallback((g) => {
    while (g.children.length) {
      const c = g.children.pop();
      c.geometry?.dispose?.();
      const m = c.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.()); else m?.dispose?.();
      g.remove(c);
    }
  }, []);

  useEffect(() => {
    const { scene, groups, controls, camera, sunLight } = R.current;
    if (!groups || !site) return;
    clearGroup(groups.site);

    // Ground — satellite imagery when we have it, flat tone when we don't.
    const span = groundTexture?.halfSpan ? groundTexture.halfSpan * 2 : 420;
    let groundMat;
    if (groundTexture?.canvas) {
      const tex = new THREE.CanvasTexture(groundTexture.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      groundMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
    } else {
      groundMat = new THREE.MeshStandardMaterial({ color: 0x6f7566, roughness: 1, metalness: 0 });
    }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(span, span), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    groups.site.add(ground);

    // Gentle — meant to fade only the far edge of the ground plane into the
    // sky, not haze up the buildings/array a camera is actually looking at.
    // (FogExp2 falls off with distance², so this needs a light touch: the
    // first version of this fogged out the whole midground at typical
    // viewing distances, not just the horizon.)
    if (scene?.fog) scene.fog.density = 1.1 / Math.max(span * 3, 250);

    // `extent` spans everything (it sizes the shadow camera); `surfExtent`
    // spans only the mounting surfaces, because that's what the viewer wants
    // filling the frame — a neighbouring tower 50 m away must not zoom the
    // array down to a postage stamp.
    let maxZ = 6, extent = 40, surfExtent = 0;

    // Mounting surfaces: the roof deck plus the walls down to grade, so the
    // building reads as a solid and casts a real shadow.
    for (const s of site.surfaces || []) {
      if (!s.polygon || s.polygon.length < 3) continue;
      const cent = polyCentroid(s.polygon);
      const shape = new THREE.Shape(s.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
      const deckGeom = new THREE.ShapeGeometry(shape);
      // ShapeGeometry lies in XY; lift each vertex onto the (possibly tilted) plane.
      const pos = deckGeom.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        pos.setZ(i, surfaceZ({ ...s, _centroid: cent }, pos.getX(i), pos.getY(i)));
      }
      deckGeom.computeVertexNormals();
      const deck = new THREE.Mesh(deckGeom, new THREE.MeshStandardMaterial({
        color: s.enabled === false ? 0x8a8f98 : 0xb9b2a6, side: THREE.DoubleSide, roughness: 0.92, metalness: 0,
      }));
      deck.rotation.x = -Math.PI / 2;   // XY-plane geometry → three's XZ ground plane
      deck.castShadow = true; deck.receiveShadow = true;
      groups.site.add(deck);

      // Walls.
      const base = s.groundHeight ?? 0;
      const wallPts = [];
      for (let i = 0; i < s.polygon.length; i++) {
        const a = s.polygon[i], b = s.polygon[(i + 1) % s.polygon.length];
        const za = surfaceZ({ ...s, _centroid: cent }, a[0], a[1]);
        const zb = surfaceZ({ ...s, _centroid: cent }, b[0], b[1]);
        wallPts.push(
          enu(a[0], a[1], base), enu(b[0], b[1], base), enu(b[0], b[1], zb),
          enu(a[0], a[1], base), enu(b[0], b[1], zb), enu(a[0], a[1], za),
        );
      }
      if (wallPts.length) {
        const wg = new THREE.BufferGeometry().setFromPoints(wallPts);
        wg.computeVertexNormals();
        const wall = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ color: 0xd8d2c6, side: THREE.DoubleSide, roughness: 0.88, metalness: 0 }));
        wall.castShadow = true; wall.receiveShadow = true;
        groups.site.add(wall);
      }

      const b = polyBounds(s.polygon);
      const reach = Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
      extent = Math.max(extent, reach);
      surfExtent = Math.max(surfExtent, reach);
      maxZ = Math.max(maxZ, s.baseHeight || 0);
    }

    // Obstructions.
    for (const o of site.obstructions || []) {
      if (!o.polygon || o.polygon.length < 3) continue;
      const h = Math.max(o.height || 0, 0.05), base = o.base || 0;
      const col = KIND_COLOR[o.kind] ?? 0x9ca3af;
      const b = polyBounds(o.polygon);
      const [cx, cy] = polyCentroid(o.polygon);

      if (o.kind === 'tree') {
        // A prism reads as a building; a canopy reads as a tree. The analyser
        // still treats it as its prism — this is presentation only. Two
        // jittered, offset lobes read as foliage far better than one perfect
        // sphere, at negligible extra cost.
        const rad = Math.max(1, Math.min(b.maxX - b.minX, b.maxY - b.minY) / 2);
        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(rad * 0.14, rad * 0.2, h * 0.45, 8),
          new THREE.MeshStandardMaterial({ color: 0x6b4f32, roughness: 1, metalness: 0 }),
        );
        trunk.position.copy(enu(cx, cy, base + h * 0.225));
        trunk.castShadow = true; trunk.receiveShadow = true;
        groups.site.add(trunk);

        const canopyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.88, metalness: 0, transparent: true, opacity: 0.94 });
        const lobes = [[0, 0, 1], [rad * 0.32, rad * 0.12, 0.62], [-rad * 0.28, -rad * 0.08, 0.68]];
        for (const [ox, oy, scale] of lobes) {
          const canopy = new THREE.Mesh(canopyGeometry(rad * scale), canopyMat);
          canopy.position.copy(enu(cx + ox, cy + oy, base + h - rad * 0.7 * scale));
          canopy.scale.y = Math.max(0.6, (h * 0.62) / rad);
          canopy.castShadow = true; canopy.receiveShadow = true;
          groups.site.add(canopy);
        }
      } else {
        const shape = new THREE.Shape(o.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
        const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: col, roughness: 0.72, metalness: 0.08 }));
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = base;
        mesh.castShadow = true; mesh.receiveShadow = true;
        groups.site.add(mesh);
      }
      extent = Math.max(extent, Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
      maxZ = Math.max(maxZ, base + h);
    }

    // Size the shadow camera to the site — too tight and shadows get clipped,
    // too loose and they go blocky.
    const r = Math.max(extent * 1.6, 40);
    const sc = sunLight.shadow.camera;
    sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
    sc.near = 1; sc.far = r * 6 + 400;
    sc.updateProjectionMatrix();

    R.current.extent = extent;
    R.current.surfExtent = surfExtent || extent;
    R.current.maxZ = maxZ;

    // Re-frame whenever the array's footprint changes materially — the first
    // traced surface, or a second building added later. A one-shot flag would
    // lock in the empty-site default and leave the array a dot on the horizon.
    const e = R.current.surfExtent;
    const prev = R.current.framedExtent;
    if (!prev || Math.abs(e - prev) / prev > 0.2) {
      const firstFrame = !prev;
      R.current.framedExtent = e;
      const toTarget = new THREE.Vector3(0, Math.min(maxZ * 0.6, 12), 0);
      const toPos = new THREE.Vector3(e * 0.9, e * 1.15 + maxZ, e * 1.7);
      if (firstFrame) { controls.target.copy(toTarget); camera.position.copy(toPos); controls.update(); }
      else tweenCamera(camera, controls, toPos, toTarget);
    }
  }, [site, groundTexture, clearGroup]);

  // ── panels ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const { groups } = R.current;
    if (!groups) return;
    clearGroup(groups.panels);
    R.current.panelMesh = null;
    const panels = analysis?.panels || [];
    if (!showPanels || !panels.length) return;

    // White base + a shared cell-grid texture, with vertexColors doing the
    // efficiency tinting on top — a real multiply, so a low-efficiency panel
    // stays exactly the analytical red/amber it needs to be, just rendered as
    // glossy tinted glass (clearcoat) instead of a flat rectangle.
    const geom = new THREE.BoxGeometry(1, 0.045, 1);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, map: getPanelTexture(), vertexColors: true,
      roughness: 0.26, metalness: 0.12, clearcoat: 0.55, clearcoatRoughness: 0.18, envMapIntensity: 1.1,
    });
    const mesh = new THREE.InstancedMesh(geom, mat, panels.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    panels.forEach((p, i) => {
      dummy.position.copy(enu(p.x, p.y, p.z));
      dummy.rotation.set(0, 0, 0);
      dummy.rotateY(-p.azi * RAD);     // yaw: local -Z now points down the azimuth
      dummy.rotateX(-p.tilt * RAD);    // pitch: normal leans toward the azimuth
      dummy.scale.set(p.w, 1, p.d);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      if (colorMode === 'perf') col.set(perfColor(p.perfPct));
      else if (colorMode === 'shade') col.set(perfColor(p.shadeFreePct));
      else col.set(0x14304f);          // "as built" — plain module blue
      if (selectedPanelId != null && p.index === selectedPanelId) col.set('#ffffff');
      mesh.setColorAt(i, col);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    groups.panels.add(mesh);
    R.current.panelMesh = mesh;

    // Thin outline around every module so rows stay legible from far out.
    const segs = [];
    for (const p of panels) {
      const c = panelCorners(p).map(([x, y, z]) => enu(x, y, z + 0.03));
      for (let i = 0; i < 4; i++) { segs.push(c[i], c[(i + 1) % 4]); }
    }
    const lg = new THREE.BufferGeometry().setFromPoints(segs);
    groups.panels.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x0b1f33, transparent: true, opacity: 0.55 })));
  }, [analysis, showPanels, colorMode, selectedPanelId, clearGroup]);

  // ── irradiance heat-map ──────────────────────────────────────────────────
  useEffect(() => {
    const { groups } = R.current;
    if (!groups) return;
    clearGroup(groups.heat);
    const heat = analysis?.heat || [];
    if (!showHeatmap || !heat.length) return;

    const cell = analysis.grid?.cell || 1;
    const geom = new THREE.PlaneGeometry(cell * 0.96, cell * 0.96);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.InstancedMesh(geom, mat, heat.length);
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    heat.forEach((h, i) => {
      dummy.position.copy(enu(h.x, h.y, h.z + 0.02));
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      col.set(perfColor(colorMode === 'shade' ? h.shadeFreePct : h.perfPct));
      mesh.setColorAt(i, col);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.renderOrder = 2;
    groups.heat.add(mesh);
  }, [analysis, showHeatmap, colorMode, clearGroup]);

  // ── compass ──────────────────────────────────────────────────────────────
  // A solar layout is meaningless without knowing where south is. Sized off the
  // dome so the letters ring the site rather than sitting on top of it.
  useEffect(() => {
    const { groups } = R.current;
    if (!groups) return;
    clearGroup(groups.compass);
    for (const [txt, az, col] of [['N', 0, '#e2e8f0'], ['E', 90, '#e2e8f0'], ['S', 180, '#fca5a5'], ['W', 270, '#e2e8f0']]) {
      const s = labelSprite(txt, col);
      const a = az * RAD;
      s.position.set(Math.sin(a) * dome * 0.72, 1.5, -Math.cos(a) * dome * 0.72);
      s.scale.setScalar(dome * 0.075);
      groups.compass.add(s);
    }
  }, [dome, clearGroup]);

  // ── sun-path ribbons ─────────────────────────────────────────────────────
  useEffect(() => {
    const { groups } = R.current;
    if (!groups || !site?.lat) return;
    clearGroup(groups.paths);
    if (!showSunPaths) return;

    // The two solstices bracket every shadow the site will ever see; the
    // equinox arc sits between them as the reference.
    const arcs = [
      { month: 6, day: 21, color: 0xfbbf24, tag: 'Jun' },
      { month: 3, day: 21, color: 0x93c5fd, tag: 'Mar' },
      { month: 12, day: 21, color: 0xf87171, tag: 'Dec' },
    ];
    for (const a of arcs) {
      const pts = sunPath({ month: a.month, day: a.day, lat: site.lat, lng: site.lng, stepMin: 6 })
        .map((p) => sunDir(p.azimuth, p.elevation).multiplyScalar(dome));
      if (pts.length < 2) continue;
      groups.paths.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: a.color, transparent: true, opacity: 0.75 }),
      ));
      const s = labelSprite(a.tag, '#f8fafc');
      s.position.copy(pts[Math.floor(pts.length / 2)]);
      s.scale.setScalar(dome * 0.065);
      groups.paths.add(s);
    }
    // Hour lines: where the sun stands at the same clock time through the year.
    for (let hr = 6; hr <= 18; hr += 2) {
      const pts = [];
      for (let doy = 1; doy <= 365; doy += 5) {
        const { month, day } = doyToDate(doy);
        const p = sunPath({ month, day, lat: site.lat, lng: site.lng, stepMin: 60 }).find((q) => Math.abs(q.minutes - hr * 60) < 31);
        if (p && p.elevation > 0) pts.push(sunDir(p.azimuth, p.elevation).multiplyScalar(dome));
      }
      if (pts.length > 2) {
        groups.paths.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28 }),
        ));
      }
    }
  }, [site?.lat, site?.lng, showSunPaths, dome, clearGroup]);

  // ── sun position (cheap; runs on every scrub tick) ───────────────────────
  useEffect(() => {
    const { scene, sunLight, sunGroup, sunRay, skyMat, hemi, ambient, core, halo, grab } = R.current;
    if (!sunLight || !sun) return;
    const dir = sunDir(sun.azimuth, sun.elevation);
    // The light sits well outside the dome — a DirectionalLight only cares
    // about direction, but its shadow camera has to clear the whole scene.
    const dist = Math.max((R.current.extent || 40) * 4, 260);
    sunLight.position.copy(dir).multiplyScalar(dist);
    sunLight.target.position.set(0, 0, 0);
    sunLight.target.updateMatrixWorld();

    const up = sun.elevation > 0;
    // Warm and dim the beam near the horizon; hand the difference to ambient so
    // the model never goes pitch black at dusk.
    const t = Math.max(0, Math.min(1, sun.elevation / 25));
    sunLight.intensity = up ? 0.35 + 2.15 * t : 0;
    sunLight.color.setHSL(0.09 + 0.035 * t, 0.75 - 0.35 * t, 0.55 + 0.20 * t);
    sunLight.castShadow = up;
    hemi.intensity = up ? 0.55 + 0.5 * t : 0.30;
    ambient.intensity = up ? 0.30 - 0.08 * t : 0.34;

    sunGroup.position.copy(dir).multiplyScalar(dome);
    sunGroup.visible = sun.elevation > -6;
    // Marker sizes as a fraction of the dome, so the sun looks the same on a
    // 20 m rooftop and a 5-acre ground-mount. `grab` is deliberately far larger
    // than what's drawn — it's the touch target.
    core.scale.setScalar(dome * 0.030);
    halo.scale.setScalar(dome * 0.062);
    grab.scale.setScalar(dome * 0.105);
    [core, halo].forEach((c) => c.material.color.setHSL(0.10 + 0.03 * t, 0.95 - 0.25 * t, 0.55 + 0.25 * t));

    const p = sunRay.geometry.attributes.position;
    const near = dir.clone().multiplyScalar(dome * 0.94);
    p.setXYZ(0, near.x, near.y, near.z);
    p.setXYZ(1, 0, 0, 0);
    p.needsUpdate = true;
    sunRay.computeLineDistances();
    sunRay.visible = up;

    // Sky: deep blue at noon → dusty orange at the horizon → navy after dark.
    const top = new THREE.Color().setHSL(0.58, 0.62 - 0.12 * (1 - t), up ? 0.20 + 0.30 * t : 0.10);
    const bottom = up
      ? new THREE.Color().setHSL(0.55 - 0.47 * (1 - t), 0.55, 0.55 + 0.25 * t)
      : new THREE.Color().setHSL(0.62, 0.45, 0.16);
    skyMat.uniforms.top.value.copy(top);
    skyMat.uniforms.bottom.value.copy(bottom);
    skyMat.uniforms.horizonMix.value = 0.25 + 1.2 * (1 - t);
    if (scene?.fog) scene.fog.color.copy(bottom);
  }, [sun, dome]);

  // ── camera presets ───────────────────────────────────────────────────────
  useEffect(() => {
    const { camera, controls } = R.current;
    if (!camera || !cameraPreset) return;
    const e = Math.max(R.current.surfExtent || R.current.extent || 40, 15);
    const z = R.current.maxZ || 8;
    const spots = {
      iso: [e * 0.9, e * 1.15 + z, e * 1.7],
      top: [0, e * 2.6 + z, 0.01],
      south: [0, e * 0.55 + z, e * 2.1],
      east: [e * 2.1, e * 0.55 + z, 0],
    };
    const to = spots[cameraPreset.key] || spots.iso;
    tweenCamera(camera, controls, new THREE.Vector3(to[0], to[1], to[2]), new THREE.Vector3(0, Math.min(z * 0.6, 12), 0));
  }, [cameraPreset]);

  // Lets a parent (e.g. the design-report save flow) pull a still image of
  // whatever the scene currently shows, downscaled and re-encoded as a JPEG
  // so a saved study stays a reasonable size in the database.
  useImperativeHandle(ref, () => ({
    captureSnapshot(maxWidth = 900) {
      const src = R.current.renderer?.domElement;
      if (!src || !src.width) return null;
      const scale = Math.min(1, maxWidth / src.width);
      const w = Math.round(src.width * scale), h = Math.round(src.height * scale);
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      out.getContext('2d').drawImage(src, 0, 0, w, h);
      return out.toDataURL('image/jpeg', 0.85);
    },
  }), []);

  return <div ref={hostRef} className="w-full h-full bg-slate-800 rounded-lg overflow-hidden" />;
});

export default SunScene3D;
