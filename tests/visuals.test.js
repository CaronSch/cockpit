import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { unstackLogScales } from '../src/omp/visuals.js';

describe('vega-lite specs', () => {
  test('a channel on a log scale is not stacked, at any depth, unless the spec says how', () => {
    const log = { field: 'ips', type: 'quantitative', scale: { type: 'log' } };
    const spec = unstackLogScales({
      mark: 'bar',
      encoding: { x: { ...log }, y: { field: 'n', type: 'nominal' } },
      vconcat: [{ layer: [{ mark: 'bar', encoding: { y: { ...log } } }] }, { mark: 'bar', encoding: { x: { ...log, stack: 'normalize' } } }],
    });
    assert.equal(spec.encoding.x.stack, false);
    assert.equal('stack' in spec.encoding.y, false, 'not on a log scale');
    assert.equal(spec.vconcat[0].layer[0].encoding.y.stack, false);
    assert.equal(spec.vconcat[1].encoding.x.stack, 'normalize', 'said by the spec');
  });
});
