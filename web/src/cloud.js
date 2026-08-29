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
uniform vec3 uKindColors[5];

varying vec3 vColor;
varying float vAlpha;
varying float vGlow;

vec3 hue2rgb(float h) {
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + h * 6.0, 6.0);
  return 0.18 + 0.82 * clamp(min(k, 4.0 - k), 0.0, 1.0);
}

void main() {
  vec3 p = position * uWeights.x + aPosTime * uWeights.y + aPosProj * uWeights.z;

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

  float sel = uSelSession < 0.0 ? 1.0 : (abs(aSession - uSelSession) < 0.5 ? 1.0 : 0.16);

  // With a query live, matches burn bright and the rest sinks into the dark.
  float relLight = mix(1.0, 0.10 + 1.7 * pow(rel, 2.5), uRelActive);
  vColor = col * (0.55 + 0.9 * f + 0.55 * relLight);
  vAlpha = clamp((0.30 + 0.55 * aWeight + 0.75 * f) * relLight * sel, 0.02, 1.0);
  vGlow = f;

  float size = (1.6 + 3.4 * aWeight) * (0.75 + 2.6 * f) * (0.6 + 0.9 * relLight * uRelActive + 0.4);
  gl_PointSize = size * uSizeScale * uPixelRatio * (260.0 / max(-mv.z, 0.6));
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
  vec3 c = vColor * (core * 0.85 + halo * (0.5 + vGlow));
  gl_FragColor = vec4(c, vAlpha * (core * 0.75 + halo * 0.55));
}
`

export class Cloud {
  constructor(canvas) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false })
    this.renderer.setClearColor(0x05060a, 1)
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.0042)
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 1200)
    this.camera.position.set(0, 22, 132)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.07
    this.controls.rotateSpeed = 0.5
    this.controls.zoomSpeed = 0.9

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.62, 0.02)
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
      uKindColors: { value: KIND_COLORS.map((c) => new THREE.Vector3(...c)) },
    }

    this.onResize()
    addEventListener('resize', () => this.onResize())
  }

  onResize() {
    const w = innerWidth, h = innerHeight
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.bloom.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** Builds the geometry once; per-frame changes only touch uniforms or aRel. */
  setData({ pos, posTime, posProj, kind, hue, age, weight, session }) {
    const n = kind.length
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aPosTime', new THREE.BufferAttribute(posTime, 3))
    g.setAttribute('aPosProj', new THREE.BufferAttribute(posProj, 3))
    g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1))
    g.setAttribute('aHue', new THREE.BufferAttribute(hue, 1))
    g.setAttribute('aAge', new THREE.BufferAttribute(age, 1))
    g.setAttribute('aWeight', new THREE.BufferAttribute(weight, 1))
    g.setAttribute('aSession', new THREE.BufferAttribute(session, 1))
    this.rel = new Float32Array(n)
    g.setAttribute('aRel', new THREE.BufferAttribute(this.rel, 1))
    g.computeBoundingSphere()

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
    this.n = n
  }

  /** Faint filaments joining consecutive points of one conversation. */
  setThreads(segments) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(segments, 3))
    this.threads = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({
        color: 0x2e4d68,
        transparent: true,
        opacity: 0.16,
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

  render(dt) {
    this.uniforms.uTime.value += dt
    this.controls.update()
    this.composer.render()
  }
}
