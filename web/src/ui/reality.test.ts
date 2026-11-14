import { expect, test } from 'vitest';
import { paras } from './reality';

test('paras reflows hard-wrapped method text', () => {
  expect(paras('A. one\n   two\n\nB. three\n\n\n')).toEqual(['A. one two', 'B. three']);
});
