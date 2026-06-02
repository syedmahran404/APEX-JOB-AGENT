import { describe, it, expect } from 'vitest';
import {
  makeRng,
  jitterClickPoint,
  bezierMousePath,
  keyDistance,
  keystrokeDelays,
  planScroll,
} from './behavior.js';

describe('anti-detection/behavior', () => {
  it('makeRng is deterministic for a given seed and produces [0,1)', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('jitterClickPoint stays within the central safe region of the box', () => {
    const rng = makeRng(1);
    const box = { x: 100, y: 200, width: 50, height: 20 };
    for (let i = 0; i < 100; i++) {
      const p = jitterClickPoint(rng, box);
      expect(p.x).toBeGreaterThanOrEqual(box.x + 0.2 * box.width);
      expect(p.x).toBeLessThanOrEqual(box.x + 0.8 * box.width);
      expect(p.y).toBeGreaterThanOrEqual(box.y + 0.2 * box.height);
      expect(p.y).toBeLessThanOrEqual(box.y + 0.8 * box.height);
    }
  });

  it('bezierMousePath starts at from, ends at to, with steps+1 points', () => {
    const rng = makeRng(7);
    const from = { x: 0, y: 0 };
    const to = { x: 300, y: 120 };
    const path = bezierMousePath(rng, from, to, 24);
    expect(path).toHaveLength(25);
    expect(path[0]).toEqual(from);
    const last = path[path.length - 1]!;
    expect(last.x).toBeCloseTo(to.x, 5);
    expect(last.y).toBeCloseTo(to.y, 5);
  });

  it('keyDistance: adjacent keys closer than far keys', () => {
    expect(keyDistance('a', 's')).toBeLessThan(keyDistance('a', 'p'));
    expect(keyDistance('q', 'w')).toBe(1);
  });

  it('keystrokeDelays: one delay per char, all within the human band', () => {
    const rng = makeRng(3);
    const delays = keystrokeDelays(rng, 'hello world');
    expect(delays).toHaveLength('hello world'.length);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(40);
      expect(d).toBeLessThanOrEqual(400);
    }
  });

  it('planScroll covers the requested total viewports and pauses in 200–600ms band', () => {
    const rng = makeRng(9);
    const segments = planScroll(rng, 5);
    const total = segments.reduce((s, seg) => s + seg.viewportFraction, 0);
    expect(total).toBeCloseTo(5, 2);
    for (const seg of segments) {
      expect(seg.pauseMs).toBeGreaterThanOrEqual(200);
      expect(seg.pauseMs).toBeLessThanOrEqual(600);
      expect(seg.viewportFraction).toBeGreaterThan(0);
    }
  });
});
