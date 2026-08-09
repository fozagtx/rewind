import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExport } from '../snapshot.ts';

test('nested verticalAutoscaling is flattened, found by a live run', () => {
  // Regression: the real export nests scale fields. Leaving them nested made a
  // routine scale-up classify as CANNOT_UNDO, which is the one verdict the tool
  // must never get wrong.
  const services = parseExport(`
services:
  - hostname: api
    type: nodejs@22
    verticalAutoscaling:
      cpuMode: DEDICATED
      minCpu: 2
      maxCpu: 4
      minRam: 0.5
    minContainers: 1
    maxContainers: 3
`);

  const api = services.api;
  assert.equal(api?.cpuMode, 'DEDICATED');
  assert.equal(api?.minCpu, 2);
  assert.equal(api?.maxCpu, 4);
  assert.equal(api?.minRam, 0.5);
  assert.equal(
    (api as Record<string, unknown>).verticalAutoscaling,
    undefined,
    'the nested object must not survive, or the diff walks it as opaque',
  );
});

test('customAutoscaling nesting is flattened too', () => {
  const services = parseExport(`
services:
  - hostname: api
    type: nodejs@22
    customAutoscaling:
      verticalAutoscaling:
        cpuMode: SHARED
        minCpu: 1
`);

  assert.equal(services.api?.cpuMode, 'SHARED');
  assert.equal(services.api?.minCpu, 1);
  assert.equal((services.api as Record<string, unknown>).customAutoscaling, undefined);
});
