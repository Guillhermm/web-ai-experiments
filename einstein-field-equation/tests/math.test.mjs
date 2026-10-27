import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

// script.js is a plain browser script; its top-level consts live in the context's
// global lexical scope, so a second script in the same context can read them.
const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../script.js', import.meta.url), 'utf8'), ctx);
const api = vm.runInContext(
	`({ wellHeight, gravityAt, stepFade, MOON_FADE_IN, MOON_FADE_OUT, clampMass, farFieldLevel, KINDS, bounceInSquare, restingHeight, sheetDrawOrder, QUALITY_TIERS, SLOW_FRAME_MS, adaptQuality, SHEET_BAND, circularSpeed, mergeBodies, stepWaves, sampleWave, perspective, lookAt,
		multiply, invert, transform, rayFromNdc, raySphere, rayPlaneY, pickSurface, isTap, isDoubleTap,
		TAP_MS, DOUBLE_TAP_MS, DEPTH, HALF, WAVE_N, G, WELL_SCALE, HOLE_MERGER_LOSS })`,
	ctx,
);

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const star = (x, z, mass, soften = 2.4) => ({ x, z, mass, soften, vx: 0, vz: 0 });

test('well is deepest at the body and sums across bodies', () => {
	const a = star(2, -1, 1.5);
	close(api.wellHeight([a], 2, -1), -api.DEPTH * 1.5);
	assert.ok(api.wellHeight([a], 6, -1) > api.wellHeight([a], 3, -1));
	const b = star(-3, 0, 0.5, 1);
	close(api.wellHeight([a, b], 0, 0), api.wellHeight([a], 0, 0) + api.wellHeight([b], 0, 0));
});

test('every kind draws its well at one scale: compact bodies dig deeper, all look alike far away', () => {
	const wide = star(0, 0, 1, 2.4);
	const narrow = star(0, 0, 1, 1.25);
	assert.ok(api.wellHeight([narrow], 0, 0) < api.wellHeight([wide], 0, 0));
	close(api.wellHeight([narrow], 200, 0), api.wellHeight([wide], 200, 0), 1e-3);
});

test('the slope of the sheet is the pull, for every softening', () => {
	const e = 1e-4;
	for (const s of [2.4, 1.6, 1.25]) {
		const b = star(1, -2, 1.7, s);
		for (const [x, z] of [[4, 1], [-3, 0.5], [1.5, -2]]) {
			const [ax, az] = api.gravityAt([b], x, z);
			const gx = (api.wellHeight([b], x + e, z) - api.wellHeight([b], x - e, z)) / (2 * e);
			const gz = (api.wellHeight([b], x, z + e) - api.wellHeight([b], x, z - e)) / (2 * e);
			close(ax, -gx * (api.G / api.WELL_SCALE), 1e-4);
			close(az, -gz * (api.G / api.WELL_SCALE), 1e-4);
		}
	}
});

test('gravity points toward the body and skips itself', () => {
	const b = star(0, 0, 1);
	const [ax, az] = api.gravityAt([b], 4, 0);
	assert.ok(ax < 0);
	close(az, 0);
	const self = api.gravityAt([b], 0, 0, b);
	close(self[0], 0);
	close(self[1], 0);
});

test('circular speed balances the pull', () => {
	for (const r of [2, 5, 9]) {
		const v = api.circularSpeed(1.3, 2.4, r);
		const [ax] = api.gravityAt([star(0, 0, 1.3)], r, 0);
		close((v * v) / r, -ax, 1e-6);
	}
});

test('merging conserves mass and momentum, and a black hole wins', () => {
	const a = { ...star(0, 0, 2), vx: 1, vz: 0, kind: 'hole', hue: [0, 0, 0] };
	const b = { ...star(4, 2, 1), vx: -2, vz: 3, kind: 'star', hue: [1, 1, 1] };
	const m = api.mergeBodies(a, b);
	close(m.mass, 3);
	close(m.vx * m.mass, a.vx * a.mass + b.vx * b.mass);
	close(m.vz * m.mass, a.vz * a.mass + b.vz * b.mass);
	close(m.x, 4 / 3);
	assert.equal(m.kind, 'hole');
	assert.equal(m.hue, a.hue);
});

test('two merging black holes radiate part of their mass, and the remnant moves with their center of mass', () => {
	const a = { ...star(0, 0, 4), vx: 1, vz: 0, kind: 'hole', hue: [0, 0, 0] };
	const b = { ...star(2, 0, 2), vx: -1, vz: 2, kind: 'hole', hue: [0, 0, 0] };
	const m = api.mergeBodies(a, b);
	close(m.mass, 6 * (1 - api.HOLE_MERGER_LOSS));
	close(m.vx, (4 - 2) / 6);
	close(m.vz, 4 / 6);
	close(m.x, 4 / 6);
});

test('waves stay flat when flat and decay when disturbed', () => {
	const n = 9;
	const h = new Float32Array(n * n);
	const v = new Float32Array(n * n);
	assert.equal(api.stepWaves(h, v, n), 0);
	v[4 * n + 4] = 1;
	let peak = Infinity;
	for (let s = 0; s < 2000; s++) peak = api.stepWaves(h, v, n);
	assert.ok(peak < 0.05, `peak ${peak}`);
});

test('sampleWave reads texel centers like the GPU does', () => {
	const n = api.WAVE_N;
	const h = new Float32Array(n * n).map((_, k) => k % n);
	const cell = (2 * api.HALF) / n;
	close(api.sampleWave(h, -api.HALF + 0.5 * cell, 0), 0, 1e-4);
	close(api.sampleWave(h, -api.HALF + 10.5 * cell, 0), 10, 1e-4);
	close(api.sampleWave(h, -api.HALF + 11 * cell, 0), 10.5, 1e-4);
});

const camera = () => {
	const p = api.perspective(0.8, 1.6, 0.1, 400);
	const v = api.lookAt([10, 12, 30], [0, -2, 0], [0, 1, 0]);
	return { vp: api.multiply(p, v), eye: [10, 12, 30] };
};

test('invert gives the identity back', () => {
	const { vp } = camera();
	const id = api.multiply(vp, api.invert(vp));
	for (let i = 0; i < 16; i++) close(id[i], i % 5 === 0 ? 1 : 0, 1e-4);
});

test('lookAt puts the target straight ahead', () => {
	const { vp } = camera();
	const c = api.transform(vp, [0, -2, 0]);
	close(c[0] / c[3], 0, 1e-5);
	close(c[1] / c[3], 0, 1e-5);
	assert.ok(c[3] > 0);
});

test('a ray through a projected point passes through that point', () => {
	const { vp, eye } = camera();
	const inv = api.invert(vp);
	const target = [3, -1, -4];
	const c = api.transform(vp, target);
	const ray = api.rayFromNdc(inv, c[0] / c[3], c[1] / c[3]);
	const t = Math.hypot(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
	const toTarget = [(target[0] - eye[0]) / t, (target[1] - eye[1]) / t, (target[2] - eye[2]) / t];
	for (let i = 0; i < 3; i++) close(ray.dir[i], toTarget[i], 1e-3);
});

test('raySphere and rayPlaneY hit where expected', () => {
	close(api.raySphere([0, 0, 10], [0, 0, -1], [0, 0, 0], 2), 8);
	assert.equal(api.raySphere([0, 5, 10], [0, 0, -1], [0, 0, 0], 2), null);
	const p = api.rayPlaneY([0, 10, 0], [0.6, -0.8, 0], 2);
	close(p[0], 6);
	close(p[1], 2);
});

test('pickSurface lands on the curved sheet', () => {
	const bodies = [star(0, 0, 1.5)];
	const height = (x, z) => api.wellHeight(bodies, x, z);
	const dir = [-0.3, -0.7, -0.5];
	const l = Math.hypot(...dir);
	const p = api.pickSurface([4, 15, 6], dir.map((d) => d / l), height);
	assert.ok(p);
	close(p[1], height(p[0], p[2]), 1e-4);
});

test('a short, still press is a tap; a drag or a slow press is not', () => {
	const down = { x: 100, y: 100, t: 0, moved: false };
	assert.ok(api.isTap(down, { x: 103, y: 98, t: 120 }));
	assert.ok(!api.isTap(down, { x: 140, y: 100, t: 120 }));
	assert.ok(!api.isTap(down, { x: 100, y: 100, t: api.TAP_MS + 50 }));
	assert.ok(!api.isTap({ ...down, moved: true }, { x: 100, y: 100, t: 120 }));
});

test('two taps close in time and space make a double tap', () => {
	const first = { x: 200, y: 300, t: 1000 };
	assert.ok(api.isDoubleTap(first, { x: 210, y: 295, t: 1200 }));
	assert.ok(!api.isDoubleTap(first, { x: 210, y: 295, t: 1000 + api.DOUBLE_TAP_MS + 10 }));
	assert.ok(!api.isDoubleTap(first, { x: 400, y: 300, t: 1200 }));
	assert.ok(!api.isDoubleTap(null, first));
});

test('bodies bounce off the square edge and stay inside', () => {
	const b = { x: 15, z: -3, vx: 10, vz: -2 };
	api.bounceInSquare(b, 14);
	close(b.x, 14);
	close(b.vx, -6);
	close(b.z, -3);
	close(b.vz, -2);
	const corner = { x: -20, z: 20, vx: -5, vz: 5 };
	api.bounceInSquare(corner, 14);
	assert.deepEqual([corner.x, corner.z], [-14, 14]);
	assert.ok(corner.vx > 0 && corner.vz < 0);
	const leaving = { x: 14.5, z: 0, vx: -3, vz: 0 };
	api.bounceInSquare(leaving, 14);
	close(leaving.vx, -3);
});

test('a sphere rests on a flat sheet one radius up', () => {
	close(api.restingHeight(() => -2, 3, 4, 0.8), -2 + 0.8);
});

test('a sphere in a narrow well rests above the bottom without cutting the walls', () => {
	const bodies = [star(0, 0, 1.5)];
	const height = (x, z) => api.wellHeight(bodies, x, z);
	const R = 1.2;
	const y = api.restingHeight(height, 0, 0, R);
	assert.ok(y > height(0, 0) + R, 'it should sit higher than bottom + radius');
	for (let r = 0; r <= R; r += 0.05) {
		for (let a = 0; a < Math.PI * 2; a += 0.3) {
			const below = y - Math.sqrt(R * R - r * r);
			assert.ok(below >= height(Math.cos(a) * r, Math.sin(a) * r) - 0.02, `cuts the sheet at r=${r.toFixed(2)}`);
		}
	}
});

test('the sheet is walked from the side away from the camera', () => {
	const target = [0, -2, 0];
	assert.deepEqual({ ...api.sheetDrawOrder([3, 10, 30], target) }, { axis: 'z', ascending: true });
	assert.deepEqual({ ...api.sheetDrawOrder([3, 10, -30], target) }, { axis: 'z', ascending: false });
	assert.deepEqual({ ...api.sheetDrawOrder([-30, 10, 4], target) }, { axis: 'x', ascending: false });
	assert.deepEqual({ ...api.sheetDrawOrder([30, 10, 4], target) }, { axis: 'x', ascending: true });
});

test('the sheet splits evenly into draw bands', () => {
	for (const t of api.QUALITY_TIERS) assert.equal(t.mesh % api.SHEET_BAND, 0, `mesh ${t.mesh}`);
});

test('each kind has its own mass cap, and black holes go highest', () => {
	assert.equal(api.clampMass('star', 100), api.KINDS.star.maxMass);
	assert.equal(api.clampMass('planet', 100), api.KINDS.planet.maxMass);
	assert.equal(api.clampMass('hole', 100), api.KINDS.hole.maxMass);
	assert.equal(api.clampMass('star', 0), 0.2);
	assert.equal(api.clampMass('star', 2.5), 2.5);
	assert.ok(api.KINDS.hole.maxMass > api.KINDS.star.maxMass);
	assert.ok(api.KINDS.star.maxMass > api.KINDS.planet.maxMass);
});

test('far-field level is zero with no mass and grows with mass', () => {
	assert.equal(api.farFieldLevel([]), 0);
	const light = api.farFieldLevel([star(0, 0, 1)]);
	const heavy = api.farFieldLevel([star(0, 0, 5)]);
	assert.ok(light < 0 && heavy < light);
	close(heavy, 5 * light, 1e-9);
	close(light, api.wellHeight([star(0, 0, 1)], api.HALF, 0), 1e-9);
});

test('a moon fades in over MOON_FADE_IN and out over MOON_FADE_OUT, clamped', () => {
	close(api.stepFade(0, false, api.MOON_FADE_IN / 2), 0.5);
	assert.equal(api.stepFade(0.9, false, 10), 1);
	close(api.stepFade(1, true, api.MOON_FADE_OUT / 2), 0.5);
	assert.equal(api.stepFade(0.1, true, 10), 0);
});

test('full quality is what the scene always had: 1.75x pixels, 4x MSAA, a 400 mesh', () => {
	assert.deepEqual({ ...api.QUALITY_TIERS[0] }, { dpr: 1.75, msaa: 4, mesh: 400 });
	for (let i = 1; i < api.QUALITY_TIERS.length; i++) {
		const [a, b] = [api.QUALITY_TIERS[i - 1], api.QUALITY_TIERS[i]];
		assert.ok(b.dpr <= a.dpr && b.msaa <= a.msaa && b.mesh <= a.mesh, `tier ${i} is not cheaper`);
	}
});

test('quality stays put while frames are fast', () => {
	let q = { tier: 0 };
	for (const ms of [16.7, 8.3, 20, api.SLOW_FRAME_MS]) q = api.adaptQuality(q, ms);
	assert.equal(q.tier, 0);
	assert.ok(!q.settled);
});

test('quality steps down while frames are slow and the steps help', () => {
	let q = { tier: 0 };
	for (const ms of [70, 45, 30, 24]) q = api.adaptQuality(q, ms);
	assert.equal(q.tier, 4);
	q = api.adaptQuality(q, 20);
	q = api.adaptQuality(q, 40);
	assert.equal(q.tier, 4, 'no tier below the last');
	assert.ok(!q.settled);
});

test('a display capped at 30 fps gets its quality back and is left alone', () => {
	let q = api.adaptQuality({ tier: 0 }, 33.3);
	assert.equal(q.tier, 1);
	q = api.adaptQuality(q, 33.3);
	assert.deepEqual({ ...q }, { tier: 0, settled: true });
	assert.equal(api.adaptQuality(q, 60).tier, 0);
});

test('a step that helps, then fast frames, keeps the lower tier and keeps watching', () => {
	let q = api.adaptQuality({ tier: 0 }, 40);
	q = api.adaptQuality(q, 16.7);
	assert.equal(q.tier, 1);
	assert.ok(!q.settled);
	assert.equal(api.adaptQuality(q, 16.7).tier, 1);
});
