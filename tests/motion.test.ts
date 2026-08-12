import { describe, expect, it } from 'vitest';
import { SPRING, STAGGER_MS, modalVariants, transition } from '../src/renderer/src/lib/motion-prefs';

/**
 * The pure half of the motion layer.
 *
 * The hook itself needs a DOM and is verified by running the app, but the
 * decision it feeds — "collapse to instant when motion is unwanted" — is plain
 * data and is exactly the part that must not regress. Section 10 makes
 * respecting reduced motion a hard requirement, not a nicety.
 */
describe('reduced motion', () => {
  it('collapses every transition to instant', () => {
    expect(transition(true)).toEqual({ duration: 0 });
  });

  it('uses the spring from the brief when motion is wanted', () => {
    expect(transition(false)).toEqual(SPRING);
    expect(SPRING.stiffness).toBe(300);
    expect(SPRING.damping).toBe(30);
  });

  it('staggers rows at roughly 30ms, as the brief specifies', () => {
    expect(STAGGER_MS).toBe(30);
  });

  it('gives the modal its pop-up entrance only when motion is wanted', () => {
    const animated = modalVariants(false);
    // "scale in from 0.94 with a slight upward drift" (section 10)
    expect(animated.initial['scale']).toBe(0.94);
    expect(animated.initial['y']).toBeGreaterThan(0);
    expect(animated.animate).toEqual({ opacity: 1, scale: 1, y: 0 });
  });

  it('shows the modal already in place when motion is reduced', () => {
    const still = modalVariants(true);
    // No scale-in, no drift: it is simply there.
    expect(still.initial).toEqual({ opacity: 1, scale: 1, y: 0 });
    expect(still.animate).toEqual({ opacity: 1, scale: 1, y: 0 });
  });

  it('never leaves an element mid-animation when reduced', () => {
    const still = modalVariants(true);
    for (const [key, value] of Object.entries(still.animate)) {
      // Every animated property ends at its resting value.
      expect(value, key).toBe(key === 'opacity' ? 1 : key === 'scale' ? 1 : 0);
    }
  });
});
