import assert from 'node:assert/strict';
import { formatLabel } from '@exhibit/format-label';
import { buildLabel } from '@garnet-labs/build-canary';

const label = await formatLabel(buildLabel);
assert.equal(label, 'garnet exhibit');
console.log(label);
