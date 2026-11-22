import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../script.js', import.meta.url), 'utf8'), ctx);
const src = vm.runInContext('({ SKY_FS, SHEET_FS, BODY_FS, GLOW_FS, DOWN_FS, COMPOSITE_FS, GLSL_FINITE })', ctx);

// A single NaN pixel turns into a black octagon once the bloom spreads it, so these guard the
// shader sources against the patterns that produced one.
test('no shader relies on isnan or isinf, which some drivers compile away', () => {
	for (const [name, s] of Object.entries(src)) assert.doesNotMatch(s, /\bis(nan|inf)\s*\(/, name);
});

test('the bloom input and the final composite pass every sample through finite()', () => {
	assert.match(src.GLSL_FINITE, /lessThan\(abs\(c\), vec3\(6\.0e4\)\)/);
	assert.match(src.DOWN_FS, /finite\(texture\(uTex, uv\)\.rgb\)/);
	assert.match(src.COMPOSITE_FS, /finite\(col\)/);
	assert.match(src.COMPOSITE_FS, /finite\(texture\(uBloom, uv\)\.rgb\)/);
});

test('pow never gets a base that can go negative', () => {
	assert.match(src.BODY_FS, /float mu = clamp\(dot\(n, -rd\), 0\.0, 1\.0\);/);
	assert.match(src.SHEET_FS, /pow\(clamp\(1\.0 - dot\(n, v\), 0\.0, 1\.0\), 3\.0\)/);
	for (const [name, s] of Object.entries(src)) {
		assert.doesNotMatch(s, /pow\(\(/, `${name}: square a signed term instead of pow((...), 2.0)`);
		assert.doesNotMatch(s, /pow\(dot\(/, `${name}: a dot product can be negative`);
	}
});

test('the sheet normal falls back instead of normalizing a zero vector', () => {
	assert.doesNotMatch(src.SHEET_FS, /normalize\(cross\(/);
	assert.match(src.SHEET_FS, /cc > 1e-24 \? c \* inversesqrt\(cc\) : vec3\(0\.0, 1\.0, 0\.0\)/);
});
