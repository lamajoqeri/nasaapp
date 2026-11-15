import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PsrField } from './psr';

const DATA = new URL('../../public/data/', import.meta.url);

describe('distance to the nearest permanently shadowed region', () => {
  it('matches known places and returns null outside the data', async () => {
    const meta = JSON.parse(await readFile(new URL('psr_dist.json', DATA), 'utf8'));
    const b = await readFile(new URL('psr_dist.bin', DATA));
    const f = new PsrField(meta, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    expect(b.byteLength).toBe(meta.w * meta.h * 2);
    expect(f.distance(-89.66, 129.2)).toBe(0);                 // floor of Shackleton crater
    const ridge = f.distance(-89.474, -137.414)!;              // Connecting Ridge site: sunlit, a few km from shadow
    expect(ridge).toBeGreaterThan(2500); expect(ridge).toBeLessThan(3900);
    const rim = f.distance(-89.6861, -162.815)!;               // Shackleton Rim site
    expect(rim).toBeGreaterThan(1300); expect(rim).toBeLessThan(2500);
    expect(f.distance(-80.13, 1.44)).toBeNull();               // IM-1: north of the 85°S data
    expect(f.distance(0.6741, 23.473)).toBeNull();             // Apollo 11
    expect(f.distance(-85.2, 45)).not.toBeNull();              // near the edge but inside
  });
});
