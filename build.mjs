import assert from 'node:assert/strict';
import { buildLabel, formatLabel } from '@exhibit/format-label';

const label = await formatLabel(buildLabel);
assert.equal(label, 'garnet exhibit');
console.log(label);
