// ─── Sky dome: vertical gradient, Civ V warm-afternoon horizon ───────────────
//
// The scene.background Color gave a single flat tone; Civ V skies grade from
// a clear blue zenith to a warm bright haze at the horizon. A camera-centered
// BackSide sphere with a tiny gradient shader does this for one draw call —
// no post-processing. (Bloom was evaluated for iter7 and skipped: an
// EffectComposer pass re-renders the frame off-screen — measurable cost,
// golden churn — for a subtle gain at this painterly art style.)
import {
  BackSide,
  Color,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';

/** Zenith blue — slightly deeper than the old flat SKY_TOP so the gradient
 *  has somewhere to go. */
const SKY_ZENITH = new Color(0x6fa3cf);
/** Horizon haze — warm cream-gold, matches the warmed FogExp2 tone so
 *  distant terrain dissolves into the sky instead of against it. */
const SKY_HAZE = new Color(0xddd0aa);

// Radius must stay inside the camera far plane (4000 in ThreeMapRenderer);
// the dome is re-centered on the camera every frame so it never clips.
const DOME_RADIUS = 3200;

let dome: Mesh | null = null;

export function createSkyDome(): Mesh {
  const geom = new SphereGeometry(DOME_RADIUS, 24, 16);
  const mat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: SKY_ZENITH },
      uHaze: { value: SKY_HAZE },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uZenith;
      uniform vec3 uHaze;
      varying vec3 vDir;
      void main() {
        float h = normalize(vDir).y;
        // Haze hugs the horizon, blue wins by ~35° up. Below the horizon the
        // dome stays haze-toned (only visible past the world rim).
        float t = smoothstep(0.02, 0.42, h);
        vec3 sky = mix(uHaze, uZenith, t);
        // Soft warm glow band right at the horizon line.
        float glow = 1.0 - smoothstep(0.0, 0.12, abs(h - 0.03));
        sky += vec3(0.06, 0.04, 0.01) * glow;
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  dome = new Mesh(geom, mat);
  dome.name = 'sky-dome';
  // Render first, never write depth, never cull (it surrounds the camera).
  dome.renderOrder = -100;
  dome.frustumCulled = false;
  return dome;
}

/** Re-center the dome on the camera so the horizon never clips or shifts. */
export function updateSkyDome(cameraPosition: Vector3): void {
  if (dome) dome.position.copy(cameraPosition);
}

export function disposeSkyDome(): void {
  if (!dome) return;
  dome.geometry.dispose();
  (dome.material as ShaderMaterial).dispose();
  dome = null;
}
