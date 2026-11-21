import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

// zeros.js, math.js and script.js share one global scope on the page; load them the same way.
const ctx = vm.createContext({});
for (const file of ['../zeros.js', '../math.js', '../script.js']) vm.runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), ctx);
const api = vm.runInContext(
	`({ ZEROS, TAU, buildGrid, createBuilder, reconstructAt, sieve, primePi, RISE, RANGES, zerosAtClock, riseTimeFor, advanceClock, shiftRange, easeRange,
		resolutionLimit, waveAt, offLineShift, normalizedWave, canAdvance, overlapsAny, sharpSpan,
		spiralPoint, buildStairMesh, createResampler, heightAt, stepSharpness, fitDistance, clampZoom, zerosForPosition, positionForZeros, fillFraction,
		ANGLE_PER_X, R_OUT })`,
	ctx,
);

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg ?? ''} ${a} vs ${b}`);
const build = (xMax, n) => {
	const grid = api.buildGrid(0, xMax, api.ZEROS[api.ZEROS.length - 1]);
	const builder = api.createBuilder(grid, api.ZEROS);
	builder.target = n;
	while (builder.advance());
	return { grid, builder };
};

test('π_N(x) still matches the mpmath reference after the copy', () => {
	const { builder } = build(100, 100);
	close(api.reconstructAt(builder, 97.5), 24.843449073879217, 5e-4);
	close(api.reconstructAt(build(30, 10).builder, 10.5), 3.94451531747506, 5e-4);
});

test('playing runs either way and stops at the ends', () => {
	assert.equal(api.zerosAtClock(0, 1000), 0);
	assert.equal(api.zerosAtClock(api.RISE, 1000), 1000);
	for (const n of [1, 10, 137, 999]) assert.equal(api.zerosAtClock(api.riseTimeFor(n, 1000), 1000), n);
	assert.deepEqual({ ...api.advanceClock(5, 1, 0.5) }, { clock: 5.5, dir: 1 });
	assert.deepEqual({ ...api.advanceClock(5, -1, 0.5) }, { clock: 4.5, dir: -1 });
	assert.deepEqual({ ...api.advanceClock(api.RISE - 0.1, 1, 0.5) }, { clock: api.RISE, dir: 0 });
	assert.deepEqual({ ...api.advanceClock(0.1, -1, 0.5) }, { clock: 0, dir: 0 });
	assert.deepEqual({ ...api.advanceClock(0, 1, 0) }, { clock: 0, dir: 1 }, 'a zero-length first frame does not stop it');
});

test('the range reel doubles from 25 to 200 and stops at its ends', () => {
	assert.deepEqual([...api.RANGES], [25, 50, 100, 200]);
	api.RANGES.slice(1).forEach((r, i) => assert.equal(r, 2 * api.RANGES[i], 'each range doubles the last'));
	assert.equal(api.shiftRange(0, -1), 0);
	assert.equal(api.shiftRange(1, 1), 2);
	assert.equal(api.shiftRange(api.RANGES.length - 1, 1), api.RANGES.length - 1);
});

test('the panel marks where the zeros stop resolving the steps, and its wave is what a zero adds', () => {
	assert.equal(api.resolutionLimit(api.ZEROS[0]), null);
	close(api.resolutionLimit(api.ZEROS[99]), 83.2, 0.1);
	close(api.resolutionLimit(api.ZEROS[999]), 747.4, 0.1);
	const { builder } = build(100, 5);
	const before = api.reconstructAt(builder, 61.5);
	builder.target = 6;
	while (builder.advance());
	close(api.reconstructAt(builder, 61.5) - before, api.waveAt(api.ZEROS[5], 61.5), 2e-3);
});

test('the mesh has four strips and an end cap, all indices in range', () => {
	const { verts, indices } = api.buildStairMesh(16);
	assert.equal(verts.length / 4, 4 * 2 * 16 + 4);
	assert.equal(indices.length, 4 * 15 * 6 + 6);
	for (const i of indices) assert.ok(i < verts.length / 4);
	const faces = new Set();
	for (let v = 0; v < verts.length; v += 4) faces.add(verts[v + 3]);
	assert.deepEqual([...faces].sort(), [0, 1, 2, 3, 4]);
});

test('the spiral turns once every 50 units of x', () => {
	const a = api.spiralPoint(0, api.R_OUT, 0);
	const b = api.spiralPoint(50, api.R_OUT, 0);
	close(a[0], b[0], 1e-9);
	close(a[2], b[2], 1e-9);
	close(Math.hypot(...api.spiralPoint(12.3, 4, 0)), 4, 1e-12);
});

test('resampling onto the mesh agrees with the formula and is flat below the cutoff', () => {
	const { grid, builder } = build(100, 200);
	const heights = new Float32Array(4096);
	api.createResampler(grid, 100, 4096)(builder, heights);
	assert.equal(heights[0], 0);
	for (const x of [3.3, 17.5, 50, 88.8]) close(api.heightAt(heights, 100, x), api.reconstructAt(builder, x), 0.03, `x=${x}`);
});

test('steps are sharp at the primes with 1000 zeros and soft with none', () => {
	const sharpAt = (n) => {
		const { grid, builder } = build(100, n);
		const heights = new Float32Array(4096);
		api.createResampler(grid, 100, 4096)(builder, heights);
		const ps = api.sieve(100);
		return (p) => {
			const k = ps.indexOf(p);
			const gap = k < 0 ? 0 : Math.min(p - (ps[k - 1] ?? p - 1), (ps[k + 1] ?? 101) - p);
			return api.stepSharpness(heights, 100, p, gap);
		};
	};
	const full = sharpAt(1000);
	const bare = sharpAt(0);
	for (const p of api.sieve(100).filter((p) => p > 3)) {
		assert.ok(full(p) > 0.85, `p=${p} full ${full(p)}`);
		assert.ok(bare(p) < 0.5, `p=${p} bare ${bare(p)}`);
	}
	assert.ok(Math.abs(full(25)) < 0.15, 'no step at a composite');
	// At 2 a narrower window keeps the steep start of the bare ramp from reading as a step.
	assert.ok(bare(2) < 0.5, `bare ramp at 2 ${bare(2)}`);
	assert.ok(full(2) > 0.85, `2 with 1000 zeros ${full(2)}`);
	assert.ok(sharpAt(1)(2) > 0.6, 'one zero already resolves 2');
	assert.equal(api.sharpSpan(2), 0.5);
	assert.equal(api.sharpSpan(1), 0.35);
	assert.equal(api.sharpSpan(14), 0.6);
});

test('below the resolution limit every step is sharp, and well above it most are not', () => {
	const { grid, builder } = build(200, 100);
	const heights = new Float32Array(4096);
	api.createResampler(grid, 200, 4096)(builder, heights);
	const ps = api.sieve(200);
	const sharp = ps.map((p, k) => api.stepSharpness(heights, 200, p, Math.min(p - (ps[k - 1] ?? p - 1), (ps[k + 1] ?? 201) - p)));
	const limit = api.resolutionLimit(api.ZEROS[99]);
	ps.forEach((p, k) => {
		if (p < limit) assert.ok(sharp[k] > 0.6, `p=${p} ${sharp[k]}`);
	});
	const above = ps.filter((p) => p > 2 * limit);
	assert.ok(above.filter((p) => sharp[ps.indexOf(p)] > 0.6).length < above.length / 3, 'most steps far above the limit have merged');
});

test('a zero moved off the line brings its partner, and its wave outgrows √x', () => {
	const g = api.ZEROS[0];
	assert.equal(api.offLineShift(g, 120, 0.5), 0);
	close(api.waveAt(g, 120, 0.5), api.waveAt(g, 120), 1e-15);
	// The pair at β and 1 − β is symmetric: moving to β or to 1 − β is the same configuration.
	close(api.offLineShift(g, 120, 0.8), api.offLineShift(g, 120, 0.2), 1e-12);
	const peak = (beta, a, b) => {
		let m = 0;
		for (let x = a; x < b; x += 0.25) m = Math.max(m, Math.abs(api.normalizedWave(g, x, beta)));
		return m;
	};
	const onLine = 2 / Math.hypot(0.5, g);
	close(peak(0.5, 100, 300), onLine, 0.03 * onLine, 'on the line the scaled main wave has height 2/|ρ|');
	close(peak(0.5, 30, 60), onLine, 0.03 * onLine, 'at every height');
	let high = 0;
	for (let x = 100; x < 300; x += 0.05) high = Math.max(high, Math.abs(api.normalizedWave(api.ZEROS[499], x)));
	close((high * Math.hypot(0.5, api.ZEROS[499])) / 2, 1, 0.03, 'whatever the zero');
	assert.ok(peak(0.8, 200, 300) > 1.4 * peak(0.8, 30, 60), 'off the line it keeps growing');
	let worst = 0;
	for (let x = 2; x <= 200; x += 0.5) worst = Math.max(worst, Math.abs(api.offLineShift(g, x, 0.9)));
	assert.ok(worst > 2, `at β = 0.9 the staircase is off by several steps (${worst})`);
});

test('playing waits for the formula to catch up', () => {
	assert.ok(api.canAdvance(100, 102));
	assert.ok(!api.canAdvance(400, 1000));
	assert.ok(api.canAdvance(0, 3));
});

test('labels that would overlap on screen are detected', () => {
	const placed = [{ x: 100, y: 100 }];
	assert.ok(api.overlapsAny(placed, 110, 105));
	assert.ok(!api.overlapsAny(placed, 140, 100));
	assert.ok(!api.overlapsAny(placed, 100, 130));
});

test('narrow labels may sit closer than wide ones', () => {
	const placed = [{ x: 100, y: 100, w: 12 }];
	assert.ok(!api.overlapsAny(placed, 114, 100, 12), 'two single digits side by side');
	assert.ok(api.overlapsAny(placed, 114, 100, 26), 'a wide label there would overlap');
});

test('framing backs off for tall stairs and narrow screens', () => {
	assert.ok(api.fitDistance(25 * 0.6, 0.46) > api.fitDistance(25 * 0.6, 1.6));
	assert.ok(api.fitDistance(46 * 0.6, 1.6) > api.fitDistance(10 * 0.6, 1.6));
	assert.ok(api.fitDistance(46 * 0.6, 1.6, 0.7) > api.fitDistance(46 * 0.6, 1.6), 'less free height backs off further');
});

test('slider mapping reaches every count up to 250 and both ends', () => {
	assert.equal(api.zerosForPosition(1000, 1000), 1000);
	for (let n = 0; n <= 250; n++) assert.equal(api.zerosForPosition(api.positionForZeros(n, 1000), 1000), n);
});

test('zoom stays between a close look and a little floor around the stairs', () => {
	assert.equal(api.clampZoom(1), 1);
	assert.equal(api.clampZoom(0.1), 0.35);
	assert.equal(api.clampZoom(5), 1.4);
});

test('fillFraction maps a range value to the share of track left of the thumb', () => {
	assert.equal(api.fillFraction(0.5, 0.5, 0.95), 0);
	close(api.fillFraction(0.725, 0.5, 0.95), 0.5, 1e-9);
	assert.equal(api.fillFraction(1000, 0, 1000), 1);
	assert.equal(api.fillFraction(2, 0, 1), 1);
	assert.equal(api.fillFraction(-1, 0, 1), 0);
	assert.equal(api.fillFraction(3, 5, 5), 0);
});

test('changing the range eases the drawn end in ln x and lands on the target', () => {
	const grow = api.easeRange(50, 100, 0.1);
	const shrink = api.easeRange(100, 50, 0.1);
	assert.ok(grow > 50 && grow < 100);
	close(Math.log(grow / 50), Math.log(100 / shrink), 1e-12, 'doubling and halving move alike');
	let x = 25;
	let frames = 0;
	while (x !== 200 && frames < 1000) {
		x = api.easeRange(x, 200, 1 / 60);
		frames++;
	}
	assert.equal(x, 200);
	// Under 0.9 s at 60 frames a second, even for the largest jump.
	assert.ok(frames > 30 && frames < 54, `${frames} frames`);
	assert.equal(api.easeRange(100, 100, 0.016), 100);
});
