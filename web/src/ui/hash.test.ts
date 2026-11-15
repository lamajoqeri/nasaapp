import { describe, expect, it } from 'vitest';
import { okLatLon, readStageHash, writeStageHash } from './hash';

describe('stage hash', () => {
  it('round-trips camera, map layer, region, centre and zoom', () => {
    const p = new URLSearchParams('c=x');
    writeStageHash(p, { cam: { preset: 'stand-at-site', scenario: 'B' }, map: { mode: 'global', overlay: 'slope', center: [0.674123456, 23.473], kmAcross: 1234.567 } });
    expect(p.toString()).toBe('c=x&cam=site%3AB&ov=slope&mr=g&mc=0.6741%2C23.473%2C1230');
    expect(readStageHash(new URLSearchParams(p.toString()))).toEqual({
      cam: { preset: 'stand-at-site', scenario: 'B' }, map: { mode: 'global', overlay: 'slope', center: [0.6741, 23.473], kmAcross: 1230 },
    });
  });
  it('writes nothing for the defaults and reads nothing back', () => {
    const p = new URLSearchParams();
    writeStageHash(p, { cam: { preset: 'overview', scenario: null }, map: { mode: 'polar', overlay: 'none' } });
    expect(p.toString()).toBe('');
    expect(readStageHash(p)).toEqual({});
  });
  it('ignores junk', () => {
    expect(readStageHash(new URLSearchParams('cam=site:Z&ov=lava&mc=95,0,10'))).toEqual({ map: { mode: 'polar', overlay: 'none' } });
    expect(readStageHash(new URLSearchParams('cam=site'))).toEqual({ cam: { preset: 'stand-at-site', scenario: null } });
  });
  it('accepts the same coordinates as the editor', () => {
    expect(okLatLon(-89.5, -137)).toBe(true);
    expect(okLatLon(-89.5, 359)).toBe(true);
    expect(okLatLon(-89.5, -200)).toBe(false);
    expect(okLatLon(91, 0)).toBe(false);
    expect(okLatLon(NaN, 0)).toBe(false);
  });
});
