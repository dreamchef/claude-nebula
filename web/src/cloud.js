import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

export const KIND_COLORS = [
  [1.0, 0.72, 0.34], // user
  [0.42, 0.86, 1.0], // assistant
  [0.72, 0.55, 1.0], // thinking
  [0.42, 0.95, 0.66], // tool
  [0.53, 0.6, 0.72], // result
]

const VERT = /* glsl */ `
attribute vec3 aPosTime;
attribute vec3 aPosProj;
attribute float aKind;
attribute float aRel;
attribute float aHue;
attribute float aAge;
attribute float aWeight;
attribute float aSession;
attribute float aVisible; // 0 when filtered out of the view entirely
attribute float aBorn;   // when this turn arrived, for the arrival flare
attribute float aLive;   // 1 if its conversation is running right now

uniform vec3 uWeights;       // blend across the three layouts
uniform vec3 uFocus;
uniform float uLensRadius;
uniform float uLensStrength;
uniform float uRelPull;      // how hard relevant points migrate toward focus
uniform float uRelActive;    // 0 = nothing sought, 1 = a query/focus is driving the cloud
uniform float uSizeScale;
uniform float uPixelRatio;
uniform float uColorMode;
uniform float uSelSession;
uniform float uTime;
uniform float uNow;
uniform vec3 uFilterCenter;
uniform float uFilterScale;
uniform vec3 uKindColors[5];

varying vec3 vColor;
varying float vAlpha;
varying float vGlow;

vec3 hue2rgb(float h) {
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + h * 6.0, 6.0);
  return 0.18 + 0.82 * clamp(min(k, 4.0 - k), 0.0, 1.0);
}

void main() {
  if (aVisible < 0.5) {
    // Filtered out: collapse it rather than paying for a hidden fragment.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  vec3 p = position * uWeights.x + aPosTime * uWeights.y + aPosProj * uWeights.z;
  // With most of the archive filtered away, what remains is scaled up about
  // its own centre so it fills the view. A uniform scale, so the distances
  // between conversations still mean what they meant.
  p = uFilterCenter + (p - uFilterCenter) * uFilterScale;

  // Semantic gravity: whatever matches what you are looking for drifts in
  // toward the focus, so the cloud reshapes itself around the question.
  float rel = clamp(aRel, 0.0, 1.0);
  float pull = uRelPull * uRelActive * smoothstep(0.30, 0.92, rel);
  p = mix(p, uFocus, pull * 0.22);

  // Fisheye lens at the cursor: near points spread apart so a dense cluster
  // unpacks into readable structure exactly where you are looking.
  vec3 d = p - uFocus;
  float dist = length(d);
  float f = exp(-(dist * dist) / max(uLensRadius * uLensRadius, 0.001));
  p += normalize(d + vec3(1e-4)) * f * uLensStrength * uLensRadius * 0.75;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  int k = int(aKind + 0.5);
  vec3 kindCol = uKindColors[0];
  if (k == 1) kindCol = uKindColors[1];
  else if (k == 2) kindCol = uKindColors[2];
  else if (k == 3) kindCol = uKindColors[3];
  else if (k == 4) kindCol = uKindColors[4];

  vec3 col = kindCol;
  if (uColorMode > 1.5) col = mix(vec3(0.16, 0.22, 0.34), vec3(1.0, 0.55, 0.42), pow(aAge, 2.2));
  else if (uColorMode > 0.5) col = hue2rgb(aHue);

  float sel = uSelSession < 0.0 ? 1.0 : (abs(aSession - uSelSession) < 0.5 ? 1.0 : 0.22);

  // A turn that just landed flares and settles over about twelve seconds, so
  // motion in the view means work happening right now.
  float age = max(uNow - aBorn, 0.0);
  float flare = aBorn > 0.0 ? exp(-age / 12.0) : 0.0;
  // Running conversations sit brighter than the archive around them.
  float liveLift = aLive * 0.55;

  // With a query live, matches burn bright and the rest sinks into the dark.
  float relLight = mix(1.0, 0.30 + 1.35 * pow(rel, 1.7), uRelActive);
  vColor = mix(col, vec3(1.0), flare * 0.55) * (0.40 + 0.55 * f + 0.42 * relLight + liveLift + flare * 1.6);
  vAlpha = clamp((0.17 + 0.24 * aWeight + 0.52 * f + liveLift * 0.5 + flare * 0.6) * relLight * sel, 0.025, 1.0);
  vGlow = max(f, flare);

  float size = (0.8 + 1.5 * aWeight) * (0.7 + 2.2 * f + 3.0 * flare) * (0.85 + 0.55 * relLight * uRelActive + liveLift);
  gl_PointSize = clamp(size * uSizeScale * uPixelRatio * (170.0 / max(-mv.z, 0.6)), 1.0, 46.0);
}
`

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vGlow;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r = length(uv) * 2.0;
  if (r > 1.0) discard;
  float core = smoothstep(1.0, 0.0, r);
  float halo = pow(1.0 - r, 2.4);
  vec3 c = vColor * (core * 0.7 + halo * (0.28 + 0.6 * vGlow));
  gl_FragColor = vec4(c, vAlpha * (core * 0.6 + halo * 0.4));
}
`

export class Cloud {
  constructor(canvas) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false })
    this.renderer.setClearColor(0x05060a, 1)
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    // Additive points stack fast; tone mapping keeps dense regions from
    // flattening into a white sheet.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.0055)
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 1200)
    this.camera.position.set(0, 14, 84)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    // Total coast after release scales as 1/dampingFactor. At 0.14 the camera
    // glided ~7x the last frame's delta, which reads as sloppy on a tool you
    // aim with; this tracks the pointer closely and stops when you stop.
    this.controls.dampingFactor = 0.35
    this.controls.rotateSpeed = 0.75
    this.controls.zoomSpeed = 1.1
    this.controls.panSpeed = 0.9
    this.controls.screenSpacePanning = true
    // Scroll zooms toward the pointer, so you close in on the cluster you are
    // actually looking at instead of the centre of the screen.
    this.controls.zoomToCursor = true
    this.controls.minDistance = 3
    this.controls.maxDistance = 400

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.55, 0.7)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.uniforms = {
      uWeights: { value: new THREE.Vector3(1, 0, 0) },
      uFocus: { value: new THREE.Vector3(0, 0, 0) },
      uLensRadius: { value: 11 },
      uLensStrength: { value: 0.85 },
      uRelPull: { value: 1 },
      uRelActive: { value: 0 },
      uSizeScale: { value: 1 },
      uPixelRatio: { value: Math.min(devicePixelRatio, 2) },
      uColorMode: { value: 0 },
      uSelSession: { value: -1 },
      uTime: { value: 0 },
      uNow: { value: 0 },
      uFilterCenter: { value: new THREE.Vector3() },
      uFilterScale: { value: 1 },
      uKindColors: { value: KIND_COLORS.map((c) => new THREE.Vector3(...c)) },
    }

    this.onResize()
    addEventListener('resize', () => this.onResize())
  }

  onResize() {
    const w = innerWidth, h = innerHeight
    this.renderer.setSize(w, h, false)
    // EffectComposer sizes its render targets in drawing-buffer pixels, not CSS
    // pixels — passing CSS pixels leaves the post chain at 1/pixelRatio scale.
    const pr = this.renderer.getPixelRatio()
    this.composer.setSize(w * pr, h * pr)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /**
   * Builds the geometry once with room to grow: live turns are appended into
   * the spare capacity, so arriving conversation never rebuilds the buffers.
   */
  setData(attrs, count, capacity) {
    const g = new THREE.BufferGeometry()
    this.attrs = attrs
    for (const [name, { array, size }] of Object.entries(attrs))
      g.setAttribute(name, new THREE.BufferAttribute(array, size))
    this.rel = new Float32Array(capacity)
    g.setAttribute('aRel', new THREE.BufferAttribute(this.rel, 1))
    g.setDrawRange(0, count)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 400)

    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    )
    this.points.frustumCulled = false
    this.scene.add(this.points)
    this.geometry = g
    this.n = count
    this.capacity = capacity
  }

  /** Publishes newly written slots to the GPU and extends the draw range. */
  grow(count) {
    for (const name of Object.keys(this.attrs)) {
      const a = this.geometry.getAttribute(name)
      a.needsUpdate = true
    }
    this.geometry.getAttribute('aRel').needsUpdate = true
    this.geometry.setDrawRange(0, count)
    this.n = count
  }

  /** Faint filaments joining consecutive points of one conversation. */
  setThreads(segments) {
    if (this.threads) {
      this.threads.geometry.dispose()
      this.threads.geometry = new THREE.BufferGeometry()
      this.threads.geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3))
      this.threads.geometry.computeBoundingSphere()
      return
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(segments, 3))
    this.threads = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({
        color: 0x2e4d68,
        transparent: true,
        opacity: 0.085,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    )
    this.threads.frustumCulled = false
    this.scene.add(this.threads)
  }

  relevanceChanged() {
    this.geometry.getAttribute('aRel').needsUpdate = true
  }

  /**
   * The filter's scale-about-a-centre is exactly an object transform, so the
   * thread lines can follow it without a shader of their own.
   */
  syncFilterTransform() {
    if (!this.threads) return
    const s = this.uniforms.uFilterScale.value
    const c = this.uniforms.uFilterCenter.value
    this.threads.scale.setScalar(s)
    this.threads.position.copy(c).multiplyScalar(1 - s)
  }

  render(dt) {
    this.uniforms.uTime.value += dt
    this.uniforms.uNow.value = Date.now() / 1000
    this.controls.update()
    this.composer.render()
  }
}
