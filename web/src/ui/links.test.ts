import { expect, test } from 'vitest';
import { externalLinks } from './links';

// Both URLs below were loaded in the real tools and read back centred on the site.
test('equatorial site: degrees', () => {
  const l = externalLinks(0.674, 23.473);
  expect(l.quickmap).toBe('https://quickmap.lroc.im-ldi.com/?extent=23.373,0.574,23.573,0.774&proj=16');
  expect(l.trek).toBe('https://trek.nasa.gov/moon/#v=0.1&x=23.473&y=0.674&z=10&p=urn:ogc:def:crs:EPSG::104903');
});
test('south polar site: stereographic metres', () => {
  const l = externalLinks(-89.47, -137.4);
  expect(l.quickmap).toBe('https://quickmap.lroc.im-ldi.com/?prjExtent=-15878.4,-16830.2,-5878.4,-6830.2&proj=27');
  expect(l.trek).toBe('https://trek.nasa.gov/moon/#v=0.1&x=-10878.4&y=-11830.2&z=7&p=urn:ogc:def:crs:IAU2000::30120');
});
