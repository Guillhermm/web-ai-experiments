const EULER = 0.5772156649015329;
// Root of li(τ) − ln 2 + I(τ) = 0, from mpmath. J(y) is 0 for y < 2, so any cutoff in (1, 2] gives the
// same formula in the limit; this one makes the zero-free part continuous where x^(1/n) crosses it.
const TAU = 1.611574399783227;
const LN_TAU = Math.log(TAU);
const MAX_SAMPLES = 16000;
const CHECKPOINT = 10;
const ASYMPTOTIC_FROM = 40;
const RESYNC = 256;
const MIN_SAMPLES = 2400;

const mobius = (n) => {
	let m = 1;
	for (let p = 2; p * p <= n; p++) {
		if (n % p === 0) {
			n /= p;
			if (n % p === 0) return 0;
			m = -m;
		}
	}
	return n > 1 ? -m : m;
};

// Ei(v) for real v > 0, by its power series; the terms stay below e^v, so double precision holds to v ≈ 9.
const eiReal = (v) => {
	let term = 1;
	let sum = 0;
	for (let k = 1; k < 200; k++) {
		term *= v / k;
		sum += term / k;
		if (term < 1e-17 * sum) break;
	}
	return EULER + Math.log(v) + sum;
};

// E1(w) for complex w off the negative real axis: power series near 0, Lentz's continued fraction elsewhere.
const e1 = (wr, wi) => {
	if (Math.hypot(wr, wi) < 1.5) {
		let tr = 1;
		let ti = 0;
		let sr = 0;
		let si = 0;
		for (let k = 1; k < 80; k++) {
			const nr = (-wr * tr + wi * ti) / k;
			ti = (-wr * ti - wi * tr) / k;
			tr = nr;
			sr += tr / k;
			si += ti / k;
			if (Math.hypot(tr, ti) < 1e-18) break;
		}
		return [-EULER - 0.5 * Math.log(wr * wr + wi * wi) - sr, -Math.atan2(wi, wr) - si];
	}
	const div = (ar, ai, br, bi) => {
		const d = br * br + bi * bi;
		return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
	};
	let fr = wr + 1;
	let fi = wi;
	let cr = fr;
	let ci = fi;
	let dr = 0;
	let di = 0;
	for (let k = 1; k < 2000; k++) {
		const a = -k * k;
		const br = wr + 2 * k + 1;
		[dr, di] = div(1, 0, br + a * dr, wi + a * di);
		const [qr, qi] = div(a, 0, cr, ci);
		cr = br + qr;
		ci = wi + qi;
		const xr = cr * dr - ci * di;
		const xi = cr * di + ci * dr;
		const nr = fr * xr - fi * xi;
		fi = fr * xi + fi * xr;
		fr = nr;
		if (Math.hypot(xr - 1, xi) < 1e-16) break;
	}
	const m = Math.exp(-wr);
	return div(m * Math.cos(wi), -m * Math.sin(wi), fr, fi);
};

// Ei(z) = −E1(−z) + iπ for Im z > 0.
const ei = (zr, zi) => {
	const [r, i] = e1(-zr, -zi);
	return [-r, -i + Math.sign(zi) * Math.PI];
};

// ∫_y^∞ dt / (t (t² − 1) ln t) with v = ln y: the sum over k of E1(2kv). It carries the trivial zeros.
const trivialPart = (v) => {
	let sum = 0;
	for (let k = 1; k < 400; k++) {
		const term = e1(2 * k * v, 0)[0];
		sum += term;
		if (term < 1e-17) break;
	}
	return sum;
};

// Riemann's J(y) with no zeros, v = ln y: li(y) − ln 2 + ∫_y^∞ dt / (t (t² − 1) ln t).
const smoothJ = (v) => eiReal(v) - Math.LN2 + trivialPart(v);

const sieve = (n) => {
	const composite = new Uint8Array(n + 1);
	const primes = [];
	for (let i = 2; i <= n; i++) {
		if (composite[i]) continue;
		primes.push(i);
		for (let j = i * i; j <= n; j += i) composite[j] = 1;
	}
	return primes;
};

const primePi = (primes, x) => {
	let lo = 0;
	let hi = primes.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (primes[mid] <= x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
};

// Samples uniform in u = ln x, fine enough for the fastest wave in play: 8 per period of the highest zero.
const buildGrid = (a, b, gammaMax) => {
	const u0 = Math.log(Math.max(a, TAU));
	const u1 = Math.log(b);
	const want = (2 * Math.PI) / (8 * gammaMax);
	const count = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.ceil((u1 - u0) / want) + 1));
	const du = (u1 - u0) / (count - 1);
	const u = new Float64Array(count);
	const x = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		u[i] = u0 + i * du;
		x[i] = Math.exp(u[i]);
	}
	const terms = [];
	for (let n = 1; n * LN_TAU <= u1 + 1e-12; n++) {
		const mu = mobius(n);
		if (!mu) continue;
		const iStart = Math.max(0, Math.ceil((n * LN_TAU - u0) / du - 1e-9));
		if (iStart < count) terms.push({ n, mu, iStart });
	}
	const base = new Float64Array(count);
	for (const { n, mu, iStart } of terms) {
		for (let i = iStart; i < count; i++) base[i] += (mu / n) * smoothJ(u[i] / n);
	}
	return { a, b, u0, du, count, u, x, terms, base };
};

// What one pair of zeros ½ ± iγ adds to π(x) on the grid: −Σ_n μ(n)/n · 2 Re Ei(ρ ln x / n).
// Large |z| uses Ei(z) ~ (e^z / z) Σ k!/z^k, with e^z advanced by a fixed rotation per sample.
const zeroWave = (grid, gamma, out) => {
	out.fill(0);
	const { u, du, count, terms } = grid;
	const rho2 = 0.25 + gamma * gamma;
	const absRho = Math.sqrt(rho2);
	const cr = 0.5 / rho2;
	const ci = -gamma / rho2;
	for (const { n, mu, iStart } of terms) {
		const scale = (-2 * mu) / n;
		const zMin = Math.max(ASYMPTOTIC_FROM, (absRho * u[iStart]) / n);
		let order = 1;
		for (let t = 1 / zMin; order < 40 && t > 1e-13; order++) t *= (order + 1) / zMin;
		const stepCos = Math.cos((gamma * du) / n);
		const stepSin = Math.sin((gamma * du) / n);
		const stepAmp = Math.exp(du / (2 * n));
		let er = 0;
		let ej = 0;
		for (let i = iStart; i < count; i++) {
			const w = u[i] / n;
			if ((i - iStart) % RESYNC === 0) {
				const amp = Math.exp(w / 2);
				er = amp * Math.cos(gamma * w);
				ej = amp * Math.sin(gamma * w);
			}
			let re;
			if (absRho * w < ASYMPTOTIC_FROM) {
				re = -e1(-0.5 * w, -gamma * w)[0];
			} else {
				const qr = cr / w;
				const qi = ci / w;
				let sr = 1;
				let si = 0;
				for (let k = order; k >= 1; k--) {
					const tr = qr * sr - qi * si;
					const ti = qr * si + qi * sr;
					sr = 1 + k * tr;
					si = k * ti;
				}
				const pr = er * qr - ej * qi;
				const pi = er * qi + ej * qr;
				re = pr * sr - pi * si;
			}
			out[i] += scale * re;
			const nr = (er * stepCos - ej * stepSin) * stepAmp;
			ej = (er * stepSin + ej * stepCos) * stepAmp;
			er = nr;
		}
	}
	return out;
};

// Adds zeros one at a time toward a target count. Going down restores the nearest checkpoint below
// and adds forward again, so the sum never accumulates subtraction error.
const createBuilder = (grid, zeros) => {
	const sum = new Float64Array(grid.count);
	const wave = new Float64Array(grid.count);
	const checkpoints = new Map();
	const state = { grid, sum, wave, count: 0, target: 0, waveIndex: -1 };
	state.advance = () => {
		if (state.count > state.target) {
			const c = Math.floor(state.target / CHECKPOINT) * CHECKPOINT;
			if (c === 0) sum.fill(0);
			else sum.set(checkpoints.get(c));
			state.count = c;
			return true;
		}
		if (state.count < state.target) {
			zeroWave(grid, zeros[state.count], wave);
			for (let i = 0; i < grid.count; i++) sum[i] += wave[i];
			state.waveIndex = state.count;
			state.count++;
			if (state.count % CHECKPOINT === 0 && !checkpoints.has(state.count)) checkpoints.set(state.count, sum.slice());
			return true;
		}
		if (state.target > 0 && state.waveIndex !== state.target - 1) {
			zeroWave(grid, zeros[state.target - 1], wave);
			state.waveIndex = state.target - 1;
			return true;
		}
		return false;
	};
	return state;
};

const valueAt = (builder, i) => builder.grid.base[i] + builder.sum[i];

// π_N(x) by interpolation on the grid; 0 below the cutoff, where every term has dropped out.
const reconstructAt = (builder, x) => {
	const { u0, du, count } = builder.grid;
	if (x < TAU) return 0;
	const f = Math.min(count - 1, Math.max(0, (Math.log(x) - u0) / du));
	const i = Math.min(count - 2, Math.floor(f));
	const t = f - i;
	return valueAt(builder, i) * (1 - t) + valueAt(builder, i + 1) * t;
};

