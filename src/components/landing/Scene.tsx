"use client";

/**
 * Scene — the hero centerpiece.
 *
 * A faceted "weathered mineral" crystal in dark chrome, lit by a self-contained
 * environment (Lightformers — no external HDR fetch, works fully offline), with
 * a counter-rotating wireframe shell, drifting sparkles, gentle float, and a
 * pointer-driven parallax tilt. Homage to the rotating mineral centerpiece on
 * the "Autonomous Finances" reference site.
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Environment,
  Lightformer,
  Float,
  Sparkles,
  AdaptiveDpr,
} from "@react-three/drei";
import { useRef, useMemo, Suspense } from "react";
import * as THREE from "three";

const TEAL = "#2596be";
const TEAL_BRIGHT = "#5fd0f0";

function Mineral() {
  const group = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const shell = useRef<THREE.Mesh>(null);
  const { pointer } = useThree();

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    if (core.current) {
      core.current.rotation.y += delta * 0.18;
      core.current.rotation.x = Math.sin(t * 0.15) * 0.12;
    }
    if (shell.current) {
      shell.current.rotation.y -= delta * 0.32;
      shell.current.rotation.z += delta * 0.04;
    }
    if (group.current) {
      // pointer parallax — lerp toward the cursor for a weighty, premium feel
      const targetX = pointer.y * 0.25;
      const targetY = pointer.x * 0.4;
      group.current.rotation.x += (targetX - group.current.rotation.x) * 0.04;
      group.current.rotation.y += (targetY - group.current.rotation.y) * 0.04;
    }
  });

  return (
    <Float speed={1.1} rotationIntensity={0.25} floatIntensity={0.6} floatingRange={[-0.08, 0.08]}>
      <group ref={group} scale={1.35}>
        {/* faceted mineral core — flat shading carves the crystal facets */}
        <mesh ref={core} castShadow>
          <icosahedronGeometry args={[1.15, 0]} />
          <meshStandardMaterial
            color="#0c0e12"
            metalness={1}
            roughness={0.22}
            flatShading
            envMapIntensity={1.4}
          />
        </mesh>

        {/* inner emissive seed — gives the crystal an internal teal glow */}
        <mesh scale={0.55}>
          <icosahedronGeometry args={[1.15, 0]} />
          <meshStandardMaterial
            color={TEAL}
            emissive={TEAL}
            emissiveIntensity={0.8}
            metalness={0.4}
            roughness={0.4}
            flatShading
            transparent
            opacity={0.65}
          />
        </mesh>

        {/* counter-rotating wireframe shell — the "scanned" techy halo */}
        <mesh ref={shell} scale={1.42}>
          <icosahedronGeometry args={[1.15, 1]} />
          <meshBasicMaterial color={TEAL} wireframe transparent opacity={0.12} />
        </mesh>
      </group>
    </Float>
  );
}

function Rig() {
  // very slow camera drift to keep the frame alive
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    state.camera.position.x = Math.sin(t * 0.1) * 0.3;
    state.camera.position.y = Math.cos(t * 0.12) * 0.2;
    state.camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function Scene() {
  const sparkleColors = useMemo(() => [TEAL_BRIGHT], []);
  return (
    <Canvas
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      dpr={[1, 2]}
      camera={{ position: [0, 0, 5], fov: 38 }}
    >
      <AdaptiveDpr pixelated={false} />
      <Suspense fallback={null}>
        <ambientLight intensity={0.15} />
        <directionalLight position={[4, 6, 4]} intensity={1.1} color="#cfe8f5" />
        <pointLight position={[-5, -2, -3]} intensity={2.2} color={TEAL} />
        <pointLight position={[3, -3, 4]} intensity={0.8} color={TEAL_BRIGHT} />

        <Mineral />

        <Sparkles
          count={45}
          scale={9}
          size={1.6}
          speed={0.25}
          opacity={0.5}
          color={sparkleColors[0]}
        />

        {/* self-contained reflection environment — no network assets */}
        <Environment resolution={256} frames={1}>
          <Lightformer
            intensity={2.2}
            position={[0, 3, 2]}
            scale={[8, 3, 1]}
            color="#ffffff"
          />
          <Lightformer
            intensity={3}
            position={[-4, 0, 1]}
            scale={[3, 6, 1]}
            color={TEAL}
          />
          <Lightformer
            intensity={1.6}
            position={[4, -1, 2]}
            scale={[3, 4, 1]}
            color={TEAL_BRIGHT}
          />
          <Lightformer
            intensity={0.8}
            position={[0, -3, -2]}
            scale={[8, 3, 1]}
            color="#1a2230"
          />
        </Environment>

        <Rig />
      </Suspense>
    </Canvas>
  );
}
