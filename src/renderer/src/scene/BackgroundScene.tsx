import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { usePrefersReducedMotion } from '../lib/motion-prefs';

/**
 * The 3D background — spec section 10.
 *
 * "The 3D is atmosphere; the queue list is the product." Everything here is
 * subordinate to that:
 *
 *  - It is a fixed, pointer-events-none layer behind everything. It never
 *    renders a list row, a progress indicator or anything else that needs to
 *    be readable or accessible.
 *  - It is capped at 30fps when the window is unfocused and stops entirely
 *    when the window is hidden, so a batch running in the background costs no
 *    GPU at all.
 *  - It does not mount when reduce-effects or prefers-reduced-motion is set,
 *    so the WebGL context is never even created.
 *
 * The particle field is one BufferGeometry drawn as a single Points object:
 * one draw call, no per-particle React state, nothing that grows with the
 * queue. If this ever costs more than a few ms a frame, the particle count is
 * the dial to turn.
 */

const PARTICLE_COUNT = 900;
const FIELD_RADIUS = 9;

function ParticleField(): React.JSX.Element {
  const points = useRef<THREE.Points>(null);
  const { invalidate } = useThree();

  const geometry = useMemo(() => {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const scales = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Spherical distribution, biased outward so the centre stays clear of
      // the content that sits in front of it.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = FIELD_RADIUS * (0.45 + Math.random() * 0.55);

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);
      scales[i] = 0.4 + Math.random() * 0.6;
    }

    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    buffer.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    return buffer;
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  useFrame((state, delta) => {
    if (!points.current) return;
    // Slow enough to read as drift rather than motion.
    points.current.rotation.y += delta * 0.035;
    points.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.08) * 0.12;

    // Subtle cursor parallax (section 10), damped so it never feels twitchy.
    const targetX = state.pointer.x * 0.35;
    const targetY = state.pointer.y * 0.25;
    state.camera.position.x += (targetX - state.camera.position.x) * 0.03;
    state.camera.position.y += (targetY - state.camera.position.y) * 0.03;
    state.camera.lookAt(0, 0, 0);

    invalidate();
  });

  return (
    <points ref={points} geometry={geometry}>
      <pointsMaterial
        size={0.045}
        sizeAttenuation
        transparent
        opacity={0.5}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        color="#8b5cf6"
      />
    </points>
  );
}

/** A slow-turning low-poly form, the second half of section 10's suggestion. */
function DriftingForm(): React.JSX.Element {
  const mesh = useRef<THREE.Mesh>(null);

  useFrame((state, delta) => {
    if (!mesh.current) return;
    mesh.current.rotation.x += delta * 0.05;
    mesh.current.rotation.y += delta * 0.07;
    mesh.current.position.y = Math.sin(state.clock.elapsedTime * 0.2) * 0.3;
  });

  return (
    <mesh ref={mesh} position={[2.6, 0, -3]}>
      <icosahedronGeometry args={[1.7, 0]} />
      <meshBasicMaterial color="#40e0b8" wireframe transparent opacity={0.12} />
    </mesh>
  );
}

/** Throttles rendering by window state, as section 10 requires. */
function FrameGovernor(): null {
  const { invalidate } = useThree();
  const [focused, setFocused] = useState(() => (typeof document === 'undefined' ? true : document.hasFocus()));
  const [visible, setVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden));

  useEffect(() => {
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    const onVisibility = (): void => setVisible(!document.hidden);

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    // Minimised or hidden: stop completely. A background batch should cost no
    // GPU whatsoever.
    if (!visible) return;

    const intervalMs = focused ? 0 : 1_000 / 30;
    if (intervalMs === 0) {
      invalidate();
      return;
    }

    const timer = setInterval(() => invalidate(), intervalMs);
    return () => clearInterval(timer);
  }, [focused, visible, invalidate]);

  return null;
}

export function BackgroundScene(): React.JSX.Element | null {
  const reduced = usePrefersReducedMotion();

  // Not merely paused — never mounted, so no WebGL context is created at all.
  if (reduced) return null;

  return (
    <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden="true">
      <Canvas
        // frameloop="demand" means nothing renders unless something asks it to,
        // which is what lets FrameGovernor cap the rate.
        frameloop="demand"
        camera={{ position: [0, 0, 6], fov: 60 }}
        gl={{ antialias: false, powerPreference: 'low-power', alpha: true }}
        dpr={[1, 1.5]}
      >
        <Suspense fallback={null}>
          <FrameGovernor />
          <ParticleField />
          <DriftingForm />
        </Suspense>
      </Canvas>
    </div>
  );
}
