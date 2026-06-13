"use client";

/**
 * Scene — the hero centerpiece.
 *
 * A weathered, moss-topped stone wrapped in interlocking rings of clear glass
 * that refract the rock behind them with chromatic dispersion (the rainbow
 * fringing). Lit by a self-contained bright studio environment (Lightformers —
 * no external HDR fetch, works fully offline). The whole glass armature turns
 * to follow the cursor. A faithful rebuild of the "Autonomous Finances"
 * reference hero (whose own stone is a proprietary asset we can't ship).
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Environment,
  Lightformer,
  MeshTransmissionMaterial,
  Float,
  AdaptiveDpr,
  useGLTF,
} from "@react-three/drei";
import { useRef, useMemo, Suspense } from "react";
import * as THREE from "three";

const TEAL = "#2596be";
const BOULDER = "/models/boulder_01/boulder_01_1k.gltf";

/**
 * The real, photogrammetry-scanned boulder (Poly Haven, CC0) — moss-topped
 * granite. We clone it, recentre on the origin and normalise its scale so the
 * glass armature wraps it regardless of the asset's native units.
 */
function Rock() {
  const { scene } = useGLTF(BOULDER);
  const model = useMemo(() => {
    const root = scene.clone(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    root.position.sub(center); // recentre geometry on the origin
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat) mat.envMapIntensity = 0.9;
      }
    });
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const wrap = new THREE.Group();
    wrap.add(root);
    wrap.scale.setScalar(2.7 / maxDim);
    return wrap;
  }, [scene]);

  return <primitive object={model} />;
}
useGLTF.preload(BOULDER);

/** One slender glass ring (thin band, like a finger ring), shared by every
 *  ring instance (read-only). */
function useRibbonGeometry() {
  return useMemo(() => {
    // wide tube = ribbon width; flatten only Z (depth) so it's a thin, broad
    // band while the ring circle (X/Y) stays perfectly round.
    const g = new THREE.TorusGeometry(1.95, 0.06, 24, 240);
    g.scale(1, 1, 2.5);
    g.computeVertexNormals();
    return g;
  }, []);
}

// Each ring gets its own resting tilt, spin axis, speed (sign = direction) and
// scale, so they drift freely at different angles instead of moving as one.
type RingCfg = {
  tilt: [number, number, number];
  axis: "x" | "y" | "z";
  speed: number;
  scale: number;
};
const RINGS: RingCfg[] = [
  { tilt: [0, 0, 0], axis: "y", speed: 0.22, scale: 1.0 },
  { tilt: [Math.PI / 2.1, 0.5, 0], axis: "z", speed: -0.17, scale: 0.85 },
  { tilt: [-0.7, 0.2, Math.PI / 2.4], axis: "x", speed: 0.31, scale: 1.14 },
  { tilt: [0.5, 1.0, 0.3], axis: "y", speed: -0.25, scale: 0.7 },
];

/** A single glass ring that spins freely on its own axis. */
function Ring({
  cfg,
  geometry,
  background,
}: {
  cfg: RingCfg;
  geometry: THREE.BufferGeometry;
  background: THREE.Color;
}) {
  const spin = useRef<THREE.Mesh>(null);
  useFrame((_, delta) => {
    if (spin.current) spin.current.rotation[cfg.axis] += delta * cfg.speed;
  });
  return (
    <group rotation={cfg.tilt} scale={cfg.scale}>
      <mesh ref={spin} geometry={geometry}>
        <MeshTransmissionMaterial
          background={background}
          transmission={1}
          thickness={0.14}
          roughness={0.05}
          ior={1.33}
          chromaticAberration={0.04}
          anisotropy={0.1}
          distortion={0}
          distortionScale={0}
          temporalDistortion={0}
          samples={6}
          resolution={512}
          clearcoat={1}
          clearcoatRoughness={0}
          attenuationDistance={20}
          attenuationColor="#ffffff"
          color="#ffffff"
        />
      </mesh>
    </group>
  );
}

function Centerpiece() {
  const rig = useRef<THREE.Group>(null);
  const rockSpin = useRef<THREE.Group>(null);
  const { pointer } = useThree();
  const ribbon = useRibbonGeometry();
  // light backdrop for the glass to refract — without this the transmission
  // samples the empty (black) scene and the rings read as black instead of
  // clear white glass.
  const glassBg = useMemo(() => new THREE.Color("#eef3f6"), []);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    if (rockSpin.current) {
      rockSpin.current.rotation.y += delta * 0.08;
    }
    if (rig.current) {
      // CURSOR TRACKING — the glass armature turns to follow the cursor
      const targetY = pointer.x * 1.1;
      const targetX = -pointer.y * 0.75;
      const idle = Math.sin(t * 0.2) * 0.06;
      rig.current.rotation.y += (targetY + idle - rig.current.rotation.y) * 0.06;
      rig.current.rotation.x += (targetX - rig.current.rotation.x) * 0.06;
    }
  });

  return (
    <Float speed={0.9} rotationIntensity={0.12} floatIntensity={0.4} floatingRange={[-0.06, 0.06]}>
      <group ref={rig} scale={1.0}>
        {/* moss-topped stone — the real scanned boulder */}
        <group ref={rockSpin}>
          <Rock />
        </group>

        {/* free-floating dispersion rings — each spins on its own axis, all
            carried along by the cursor-tracked rig */}
        {RINGS.map((cfg, i) => (
          <Ring key={i} cfg={cfg} geometry={ribbon} background={glassBg} />
        ))}
      </group>
    </Float>
  );
}

function Rig() {
  // very slow camera drift to keep the frame alive
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    state.camera.position.x = Math.sin(t * 0.08) * 0.25;
    state.camera.position.y = Math.cos(t * 0.1) * 0.16;
    state.camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function Scene() {
  return (
    <Canvas
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      dpr={[1, 2]}
      camera={{ position: [0, 0, 6.4], fov: 38 }}
      // the canvas is a fixed, pointer-events:none backdrop — listen for
      // pointer moves on the document so cursor tracking still works
      eventSource={typeof document !== "undefined" ? document.documentElement : undefined}
      eventPrefix="client"
    >
      <AdaptiveDpr pixelated={false} />
      <Suspense fallback={null}>
        {/* bright key + soft fill — a studio look against the light page */}
        <ambientLight intensity={0.6} />
        <directionalLight position={[4, 6, 5]} intensity={2.2} color="#ffffff" />
        <directionalLight position={[-5, 2, -3]} intensity={0.8} color="#cfe0ee" />
        <pointLight position={[2, -3, 4]} intensity={1.2} color={TEAL} />

        <Centerpiece />

        {/* self-contained studio environment — drives glass reflections +
            the coloured edges that become chromatic dispersion. No network. */}
        <Environment resolution={256} frames={1}>
          <Lightformer intensity={3} position={[0, 5, 3]} scale={[12, 12, 1]} color="#ffffff" />
          <Lightformer intensity={2} position={[-6, 1, 2]} scale={[12, 3, 1]} color="#eef4f9" />
          <Lightformer intensity={1.6} form="ring" position={[5, 2, 3]} scale={[3, 3, 1]} color="#9fd6ff" />
          <Lightformer intensity={1.4} form="ring" position={[-4, -2, 2]} scale={[3, 3, 1]} color="#d9a8ff" />
          <Lightformer intensity={1.2} position={[3, -3, 1]} scale={[8, 3, 1]} color="#bfe6ff" />
        </Environment>

        <Rig />
      </Suspense>
    </Canvas>
  );
}
