import assert from 'node:assert/strict';
import { formatLabel } from '@exhibit/format-label';

const label = await formatLabel('  Garnet Exhibit  ');
assert.equal(label, 'garnet exhibit');
console.log(label);
