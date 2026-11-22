const RANGES = [25, 50, 100, 200];
const X_LIMIT = RANGES[RANGES.length - 1];
const MESH_SAMPLES = 4096;
const ANGLE_PER_X = (2 * Math.PI) / 50;
const R_IN = 4.0;
const R_OUT = 7.0;
const STEP_HEIGHT = 0.6;
const THICK = 0.28;
const FOV = 0.8;
// Zoom as a multiple of the fitted distance: in to a close look at the steps, out only far enough to see some
// floor around the stairs.
const ZOOM_IN = 0.35;
const ZOOM_OUT = 1.4;
const SHARP_SPAN = 0.35;
const SHARP_SPAN_MAX = 0.6;

// Playing runs a clock over [0, RISE] seconds, forward or backward, and the number of zeros follows it with
// ln(1 + N) linear in time, so the first few arrive slowly enough to watch. It stops at either end.
const RISE = 26;

const zerosAtClock = (clock, max) => Math.round(Math.exp((Math.log(max + 1) * clock) / RISE) - 1);

const riseTimeFor = (n, max) => (RISE * Math.log(n + 1)) / Math.log(max + 1);

const advanceClock = (clock, dir, dt) => {
	const next = clock + dir * dt;
	if (dir > 0 && next >= RISE) return { clock: RISE, dir: 0 };
	if (dir < 0 && next <= 0) return { clock: 0, dir: 0 };
	return { clock: next, dir };
};

const shiftRange = (index, delta) => Math.min(RANGES.length - 1, Math.max(0, index + delta));

// Changing the range grows or shrinks the stairs instead of swapping them. The drawn end approaches the
// chosen one in ln x, so doubling and halving take the same time, and snaps once it is close.
const RANGE_EASE = 8;
const easeRange = (x, target, dt) => {
	const lx = Math.log(x);
	const lt = Math.log(target);
	const next = lx + (lt - lx) * Math.min(1, dt * RANGE_EASE);
	return Math.abs(next - lt) < 2e-3 ? target : Math.exp(next);
};

// Where N zeros stop resolving the primes. The fastest wave in play has period 2π x / γ_N in x; the steps
// stay sharp while that is shorter than half of ln x, the average gap between primes. Returns the larger
// root of 2π x / γ = ½ ln x, or null when the wave is never short enough.
const resolutionLimit = (gamma) => {
	const peak = gamma / (4 * Math.PI);
	if (Math.log(peak) <= 1) return null;
	let a = peak;
	let b = peak * 400;
	for (let i = 0; i < 80; i++) {
		const m = (a + b) / 2;
		if (0.5 * Math.log(m) > (2 * Math.PI * m) / gamma) a = m;
		else b = m;
	}
	return a;
};

// The wave of one zero pair β ± iγ at x, evaluated directly. On the critical line β is ½.
const waveAt = (gamma, x, beta = 0.5) => {
	if (x < TAU) return 0;
	const lx = Math.log(x);
	let v = 0;
	for (let n = 1; n * LN_TAU <= lx; n++) {
		const mu = mobius(n);
		if (!mu) continue;
		const w = lx / n;
		v -= ((2 * mu) / n) * ei(beta * w, gamma * w)[0];
	}
	return v;
};

// A zero off the critical line never comes alone: the functional equation and conjugation pair β + iγ with 1 − β + iγ. Moving
// one zero to β replaces its wave on the line with the waves of both, and this is the difference.
const offLineShift = (gamma, x, beta) => (beta === 0.5 ? 0 : waveAt(gamma, x, beta) + waveAt(gamma, x, 1 - beta) - waveAt(gamma, x));

// The main term of a zero pair's wave, −2 Re li(x^ρ), has size about 2 x^β / (|ρ| ln x); on the line that is
// 2√x / (|ρ| ln x). Dividing √x / ln x out leaves a wave of steady height 2/|ρ| on the line, while a zero at
// β > ½ leaves one that keeps growing like x^(β − ½). The terms from x^(1/n), n ≥ 2, are left out here: they
// are smaller and fade relative to this one.
const mainWave = (gamma, x, beta) => -2 * ei(beta * Math.log(x), gamma * Math.log(x))[0];
const normalizedWave = (gamma, x, beta = 0.5) => {
	if (x < 3) return 0;
	const total = beta === 0.5 ? mainWave(gamma, x, 0.5) : mainWave(gamma, x, beta) + mainWave(gamma, x, 1 - beta);
	return (total * Math.log(x)) / Math.sqrt(x);
};

// Playing waits for the formula to catch up, so on a slow machine the count shown never trails far behind.
const canAdvance = (count, target) => Math.abs(count - target) <= Math.max(3, 0.04 * target);

// Two labels closer than this on screen, in pixels, would overlap; the fainter one is skipped.
const LABEL_GAP = { x: 26, y: 13.5 };
// Widths are the labels' own, so two single digits can sit closer than two-digit numbers.
const overlapsAny = (placed, x, y, w = LABEL_GAP.x) =>
	placed.some((q) => Math.abs(q.x - x) < ((q.w ?? LABEL_GAP.x) + w) / 2 && Math.abs(q.y - y) < LABEL_GAP.y);

const formatX = (x) => x.toFixed(0);

// Slider position 0..1000 to a zero count, quadratic so the first hundred get most of the travel.
const zerosForPosition = (p, max) => Math.round(max * (p / 1000) ** 2);
const positionForZeros = (n, max) => Math.round(1000 * Math.sqrt(n / max));

// Share of a range input's track that lies left of its thumb, for the filled part of the custom track.
const fillFraction = (value, min, max) => (max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0);
const syncFill = (input) => {
	const f = fillFraction(Number(input.value), Number(input.min), Number(input.max));
	input.style.setProperty('--fill', `${(f * 100).toFixed(2)}%`);
};

// Mirrors --hypo in styles.css: the color of anything that exists only if a zero leaves the line.
const HYPO = '#ff8fa6';

const spiralPoint = (x, r, y) => {
	const a = x * ANGLE_PER_X;
	return [r * Math.cos(a), y, r * Math.sin(a)];
};

// Four strips (tread, underside, outer wall, inner wall) and an end cap, as (sample, outer?, lowered?, face).
// The vertex shader lifts each sample to its height, so the mesh never changes, only the height texture.
const buildStairMesh = (samples) => {
	const strips = [
		[[0, 0], [1, 0]],
		[[0, 1], [1, 1]],
		[[1, 0], [1, 1]],
		[[0, 0], [0, 1]],
	];
	const verts = new Float32Array((strips.length * 2 * samples + 4) * 4);
	const indices = new Uint32Array(strips.length * (samples - 1) * 6 + 6);
	let v = 0;
	let w = 0;
	strips.forEach(([a, b], face) => {
		const first = v / 4;
		for (let s = 0; s < samples; s++) {
			verts.set([s, a[0], a[1], face, s, b[0], b[1], face], v);
			v += 8;
		}
		for (let s = 0; s < samples - 1; s++) {
			const p = first + s * 2;
			indices.set([p, p + 1, p + 2, p + 2, p + 1, p + 3], w);
			w += 6;
		}
	});
	const cap = v / 4;
	const last = samples - 1;
	verts.set([last, 0, 0, 4, last, 1, 0, 4, last, 0, 1, 4, last, 1, 1, 4], v);
	indices.set([cap, cap + 1, cap + 2, cap + 2, cap + 1, cap + 3], w);
	return { verts, indices };
};

// Precomputed interpolation from the log-spaced formula grid onto the evenly spaced mesh samples.
const createResampler = (grid, xMax, samples) => {
	const index = new Int32Array(samples);
	const frac = new Float32Array(samples);
	const below = new Uint8Array(samples);
	const dx = xMax / (samples - 1);
	for (let i = 0; i < samples; i++) {
		const x = i * dx;
		if (x < TAU) {
			below[i] = 1;
			continue;
		}
		const f = Math.min(grid.count - 1, Math.max(0, (Math.log(x) - grid.u0) / grid.du));
		index[i] = Math.min(grid.count - 2, Math.floor(f));
		frac[i] = f - index[i];
	}
	return (builder, out) => {
		const { base } = grid;
		const { sum } = builder;
		for (let i = 0; i < samples; i++) {
			if (below[i]) {
				out[i] = 0;
				continue;
			}
			const j = index[i];
			const t = frac[i];
			out[i] = (base[j] + sum[j]) * (1 - t) + (base[j + 1] + sum[j + 1]) * t;
		}
		return out;
	};
};

const heightAt = (heights, xMax, x) => {
	const f = Math.min(heights.length - 1, Math.max(0, (x / xMax) * (heights.length - 1)));
	const i = Math.min(heights.length - 2, Math.floor(f));
	const t = f - i;
	return heights[i] * (1 - t) + heights[i + 1] * t;
};

// How much of a whole unit step the curve climbs across a prime, from about 0.2 on the bare ramp to 1. The
// window is a quarter of the nearer gap, so a step counts only if it rises before the next prime's does,
// clamped so a wide gap does not count the slope of the ramp itself as a step.
const sharpSpan = (gap) => Math.min(SHARP_SPAN_MAX, Math.max(SHARP_SPAN, gap / 4));
// Near 2 the bare ramp starts at the cutoff τ and climbs at about 1/ln x, steep enough that the usual window
// would read it as a step with no zeros at all (a rise of 0.84). A narrower window there reads 0.36 on the
// bare ramp and a full step from the first zero on.
const SHARP_SPAN_AT_2 = 0.15;
const stepSharpness = (heights, xMax, p, gap = 0) => {
	const span = p === 2 ? SHARP_SPAN_AT_2 : sharpSpan(gap);
	return heightAt(heights, xMax, p + span) - heightAt(heights, xMax, p - span);
};

const clampZoom = (d) => Math.min(ZOOM_OUT, Math.max(ZOOM_IN, d));

const smoothstep = (a, b, v) => {
	const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

// Camera distance that keeps the whole spiral in view: its width against the horizontal field of view,
// its height against the vertical one, whichever needs the camera farther away.
// free is the share of the screen's height left above the controls.
const fitDistance = (top, aspect, free = 1) => {
	const t = Math.tan(FOV / 2);
	return 1.2 * Math.max((R_OUT + 1.5) / (t * aspect), (top / 2 + 3) / (t * free), 18);
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => {
	const l = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
};

const perspective = (fovy, aspect, near, far) => {
	const f = 1 / Math.tan(fovy / 2);
	const nf = 1 / (near - far);
	return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
};

const lookAt = (eye, target, up) => {
	const z = normalize(sub(eye, target));
	const x = normalize(cross(up, z));
	const y = cross(z, x);
	return new Float32Array([
		x[0], y[0], z[0], 0,
		x[1], y[1], z[1], 0,
		x[2], y[2], z[2], 0,
		-dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
	]);
};

const multiply = (a, b) => {
	const out = new Float32Array(16);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
			out[c * 4 + r] = s;
		}
	}
	return out;
};

const transform = (m, p) => [
	m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
	m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
	m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
	m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
];

const GLSL_HEAD = `#version 300 es
precision highp float;
precision highp int;
const float R_IN = ${R_IN.toFixed(4)};
const float R_OUT = ${R_OUT.toFixed(4)};
const float THICK = ${THICK.toFixed(4)};
const float ANGLE_PER_X = ${ANGLE_PER_X.toFixed(8)};
const float STEP_HEIGHT = ${STEP_HEIGHT.toFixed(4)};
const float PI = 3.14159265;
const vec3 GOLD = vec3(1.0, 0.72, 0.36);
const vec3 SILVER = vec3(0.42, 0.46, 0.62);
const vec3 BG_TOP = vec3(0.004, 0.005, 0.011);
const vec3 BG_HORIZON = vec3(0.028, 0.022, 0.036);
`;

const FULLSCREEN_VS = `${GLSL_HEAD}
out vec2 vUv;
void main() {
	vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
	vUv = p;
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Sky and a dark polished floor, ray-cast per pixel: faint rings every two units and a warm pool of
// light under the stairs.
const BACKDROP_FS = `${GLSL_HEAD}
in vec2 vUv;
uniform mat4 uInvViewProj;
uniform vec3 uEye;
out vec4 outColor;
float ring(float v, float width) {
	float fw = fwidth(v);
	return 1.0 - clamp(abs(fract(v - 0.5) - 0.5) / max(fw * width, 1e-5), 0.0, 1.0);
}
void main() {
	vec2 ndc = vUv * 2.0 - 1.0;
	vec4 a = uInvViewProj * vec4(ndc, -1.0, 1.0);
	vec4 b = uInvViewProj * vec4(ndc, 1.0, 1.0);
	vec3 d = normalize(b.xyz / b.w - a.xyz / a.w);
	vec3 sky = mix(BG_HORIZON, BG_TOP, smoothstep(-0.05, 0.5, d.y));
	vec3 col = sky;
	if (d.y < 0.0) {
		float t = (-THICK - uEye.y) / d.y;
		vec3 p = uEye + d * t;
		float r = length(p.xz);
		float fade = exp(-r * 0.045);
		vec3 floorCol = vec3(0.006, 0.006, 0.01);
		floorCol += GOLD * 0.05 * exp(-pow((r - 5.5) / 2.2, 2.0));
		floorCol += vec3(0.75, 0.72, 0.85) * ring(r * 0.5, 1.0) * 0.018 * fade;
		col = mix(BG_HORIZON, floorCol, clamp(fade * 1.6, 0.0, 1.0));
		col = mix(BG_HORIZON, col, smoothstep(0.0, 0.08, -d.y));
	}
	outColor = vec4(col, 1.0);
}`;

const STAIR_VS = `${GLSL_HEAD}
layout(location = 0) in vec4 aVert;
uniform sampler2D uHeights;
uniform mat4 uViewProj;
uniform float uDx;
uniform int uCount;
uniform vec2 uRadii;
out vec3 vWorld;
out float vSlope;
out float vAcross;
out float vX;
out float vResolved;
out vec3 vNormal;
flat out int vFace;
float h(int s) {
	return texelFetch(uHeights, ivec2(clamp(s, 0, uCount - 1), 0), 0).r;
}
void main() {
	int s = int(aVert.x + 0.5);
	float x = aVert.x * uDx;
	float a = x * ANGLE_PER_X;
	float r = mix(uRadii.x, uRadii.y, aVert.y);
	vResolved = texelFetch(uHeights, ivec2(s, 0), 0).g;
	float y = h(s) * STEP_HEIGHT - aVert.z * THICK;
	vWorld = vec3(r * cos(a), y, r * sin(a));
	vSlope = (h(s + 1) - h(s - 1)) / (2.0 * uDx);
	vAcross = aVert.y;
	vX = x;
	vFace = int(aVert.w + 0.5);
	// Normals from the surface itself, not screen derivatives, so thousands of thin triangles shade smoothly.
	vec3 radial = vec3(cos(a), 0.0, sin(a));
	vec3 along = vec3(-sin(a) * r * ANGLE_PER_X, vSlope * STEP_HEIGHT, cos(a) * r * ANGLE_PER_X);
	vec3 up = cross(along, radial);
	vNormal = vFace == 0 ? up : vFace == 1 ? -up : vFace == 2 ? radial : vFace == 3 ? -radial : along;
	gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

// Stone lit from above; every steep stretch glows in proportion to its slope. As the zeros pile up, the
// slope of π_N(x) gathers into spikes at the primes, so the light gathers onto the risers. A riser the zeros
// in use resolve glows gold; one they cannot yet tell from its neighbor stays a cool silver.
// In ghost mode the same mesh draws the true π(x) as a translucent band just outside the stairs.
const STAIR_FS = `${GLSL_HEAD}
in vec3 vWorld;
in float vSlope;
in float vAcross;
in float vX;
in float vResolved;
in vec3 vNormal;
flat in int vFace;
uniform vec3 uEye;
uniform float uGlow;
uniform int uGhost;
out vec4 outColor;
void main() {
	if (uGhost == 1) {
		if (vFace == 1) discard;
		float edge = vFace == 0 ? 0.0 : 1.0;
		// Gold like the eye that turns it on: the band is the exact count the steps resolve to.
		vec3 ghost = vec3(1.0, 0.62, 0.25) * (0.012 + 0.045 * edge);
		float fade = 1.0 - smoothstep(40.0, 110.0, length(uEye - vWorld));
		outColor = vec4(ghost * fade, 1.0);
		return;
	}
	vec3 n = normalize(vNormal);
	vec3 v = normalize(uEye - vWorld);
	if (dot(n, v) < 0.0) n = -n;
	vec3 key = normalize(vec3(-0.35, 0.9, 0.25));
	float diff = max(dot(n, key), 0.0);
	float hemi = 0.5 + 0.5 * n.y;
	float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);

	vec3 stone = vFace == 0 ? vec3(0.034, 0.032, 0.045) : vec3(0.014, 0.013, 0.02);
	vec3 col = stone * (0.2 + 0.9 * diff) + vec3(0.006, 0.007, 0.014) * hemi;
	vec3 hv = normalize(key + v);
	col += vec3(0.75, 0.72, 0.9) * pow(max(dot(n, hv), 0.0), 90.0) * 0.5;
	vec3 r = reflect(-v, n);
	col += mix(BG_HORIZON, BG_TOP, smoothstep(-0.05, 0.5, r.y)) * 2.5 * (0.15 + 0.85 * fres);

	float rise = smoothstep(0.5, 6.0, vSlope);
	vec3 light = mix(SILVER, GOLD, vResolved);
	col += light * rise * uGlow * (vFace == 0 ? 1.15 : 0.6);

	if (vFace == 0) {
		float fw = fwidth(vAcross);
		float edge = 1.0 - clamp((1.0 - vAcross) / max(fw * 1.5, 1e-5), 0.0, 1.0);
		float inner = 1.0 - clamp(vAcross / max(fw * 1.2, 1e-5), 0.0, 1.0);
		col += GOLD * edge * 0.9 + vec3(0.8, 0.75, 0.9) * inner * 0.06;
	}

	float dist = length(uEye - vWorld);
	col = mix(col, BG_HORIZON, smoothstep(40.0, 110.0, dist));
	outColor = vec4(col, 1.0);
}`;

const PILLAR_VS = `${GLSL_HEAD}
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
uniform float uTop;
out vec3 vWorld;
out vec3 vNormal;
void main() {
	vWorld = vec3(aPos.x, aPos.y * (uTop + THICK) - THICK, aPos.z);
	vNormal = normalize(vec3(aPos.x, 0.0, aPos.z));
	gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

// The critical line as a glass column: additive, brightest at its silhouette.
const PILLAR_FS = `${GLSL_HEAD}
in vec3 vWorld;
in vec3 vNormal;
uniform vec3 uEye;
uniform float uTop;
out vec4 outColor;
void main() {
	vec3 v = normalize(uEye - vWorld);
	float edge = pow(1.0 - abs(dot(normalize(vNormal), v)), 2.0);
	float fadeTop = 1.0 - smoothstep(uTop * 0.85, uTop + THICK, vWorld.y);
	outColor = vec4(vec3(1.0, 0.86, 0.62) * (0.05 + edge * 0.35) * fadeTop, 1.0);
}`;

const POINTS_VS = `${GLSL_HEAD}
layout(location = 0) in vec4 aPoint;
uniform mat4 uViewProj;
uniform float uSize;
uniform float uPixels;
out float vValue;
void main() {
	vec4 clip = uViewProj * vec4(aPoint.xyz, 1.0);
	gl_Position = clip;
	gl_PointSize = clamp(uSize * uPixels / clip.w, 1.0, 96.0);
	vValue = aPoint.w;
}`;

const POINTS_FS = `${GLSL_HEAD}
in float vValue;
uniform vec3 uTint;
uniform float uGain;
uniform float uFalloff;
out vec4 outColor;
void main() {
	vec2 d = gl_PointCoord - 0.5;
	float r2 = dot(d, d) * 4.0;
	if (r2 > 1.0) discard;
	outColor = vec4(uTint * exp(-r2 * uFalloff) * uGain * vValue, 1.0);
}`;

const DOWN_FS = `${GLSL_HEAD}
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform int uPrefilter;
uniform float uThreshold;
out vec4 outColor;
vec3 tap(vec2 uv) {
	vec3 c = texture(uTex, uv).rgb;
	if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
	if (uPrefilter == 1) {
		float br = max(c.r, max(c.g, c.b));
		float soft = clamp(br - uThreshold + 0.5, 0.0, 1.0);
		soft = soft * soft * 0.5;
		c *= max(soft, br - uThreshold) / max(br, 1e-4);
	}
	return c;
}
void main() {
	vec2 h = uTexel;
	vec3 s = tap(vUv) * 4.0 + tap(vUv - h) + tap(vUv + h) + tap(vUv + vec2(h.x, -h.y)) + tap(vUv - vec2(h.x, -h.y));
	outColor = vec4(s / 8.0, 1.0);
}`;

const UP_FS = `${GLSL_HEAD}
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
out vec4 outColor;
void main() {
	vec2 h = uTexel;
	vec3 s = texture(uTex, vUv + vec2(-h.x * 2.0, 0.0)).rgb
		+ texture(uTex, vUv + vec2(-h.x, h.y)).rgb * 2.0
		+ texture(uTex, vUv + vec2(0.0, h.y * 2.0)).rgb
		+ texture(uTex, vUv + vec2(h.x, h.y)).rgb * 2.0
		+ texture(uTex, vUv + vec2(h.x * 2.0, 0.0)).rgb
		+ texture(uTex, vUv + vec2(h.x, -h.y)).rgb * 2.0
		+ texture(uTex, vUv + vec2(0.0, -h.y * 2.0)).rgb
		+ texture(uTex, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
	outColor = vec4(s / 12.0, 1.0);
}`;

const COMPOSITE_FS = `${GLSL_HEAD}
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform float uTime;
uniform float uBloomGain;
out vec4 outColor;
float hash12(vec2 p) {
	vec3 q = fract(vec3(p.xyx) * 0.1031);
	q += dot(q, q.yzx + 33.33);
	return fract((q.x + q.y) * q.z);
}
vec3 aces(vec3 x) {
	return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
	vec2 cd = vUv - 0.5;
	vec3 col = aces(texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uBloomGain);
	float vig = 1.0 - smoothstep(0.45, 1.2, length(cd * vec2(uRes.x / uRes.y, 1.0)));
	col *= mix(0.7, 1.0, vig);
	col = pow(col, vec3(1.0 / 2.2));
	col += (hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.012;
	outColor = vec4(col, 1.0);
}`;

const createGl = (canvas) => {
	const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
	if (!gl) return null;
	const compile = (type, src) => {
		const s = gl.createShader(type);
		gl.shaderSource(s, src);
		gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed:\n${gl.getShaderInfoLog(s)}`);
		return s;
	};
	const program = (vs, fs) => {
		const p = gl.createProgram();
		gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
		gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link failed:\n${gl.getProgramInfoLog(p)}`);
		const u = {};
		const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
		for (let i = 0; i < count; i++) {
			const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
			u[name] = gl.getUniformLocation(p, name);
		}
		return { p, u };
	};
	return { gl, program };
};

// The side panel: the newest zero's wave with x running upward like the stairs, divided by its expected size
// √x / ln x so that on the critical line it keeps a steady width, and the 1000 ordinates γ.
const createPanel = (canvas, zeros) => {
	const ctx = canvas.getContext('2d');
	const max = zeros.length;
	let size = { w: 0, h: 0 };
	const wave = new Float64Array(1200);
	const state = { key: '', lo: 0, hi: 0 };

	const resize = () => {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const r = canvas.getBoundingClientRect();
		canvas.width = Math.max(1, Math.round(r.width * dpr));
		canvas.height = Math.max(1, Math.round(r.height * dpr));
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		size = { w: r.width, h: r.height };
	};

	const refreshWave = (gamma, beta, lo, hi) => {
		const key = `${gamma}:${beta}:${lo}:${hi}`;
		if (key === state.key) return;
		state.key = key;
		for (let i = 0; i < wave.length; i++) wave[i] = normalizedWave(gamma, lo + ((hi - lo) * i) / (wave.length - 1), beta);
	};

	// shown: { index, beta, flash } for the zero whose wave is drawn; flash runs from 1 down to 0 after it arrives.
	const draw = (count, lo, hi, limitX, shown) => {
		const { w, h } = size;
		if (!w) return;
		ctx.clearRect(0, 0, w, h);
		const top = 34;
		const bottom = h - 26;
		const span = bottom - top;
		const split = Math.round(w * 0.56);
		const mid = split / 2;
		const narrow = w < 120;
		ctx.font = `${narrow ? 9 : 10}px ui-monospace, "SF Mono", Menlo, monospace`;
		ctx.textBaseline = 'alphabetic';
		ctx.textAlign = 'center';
		ctx.fillStyle = 'rgba(236, 232, 255, 0.75)';
		const moved = shown && shown.beta !== 0.5;
		ctx.fillText(narrow ? (moved ? 'moved' : 'wave') : moved ? 'zero 1 moved' : 'wave of x^ρ', mid, 16);
		ctx.fillText('zeros', split + (w - split) / 2, 16);
		ctx.fillStyle = 'rgba(236, 232, 255, 0.55)';
		ctx.fillText(narrow ? '÷√x/ln' : '÷ √x/ln x', mid, 28);
		ctx.fillText(narrow ? 'Re ½' : 'Re = ½', split + (w - split) / 2, 28);

		ctx.strokeStyle = 'rgba(236, 232, 255, 0.18)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(split + 0.5, top);
		ctx.lineTo(split + 0.5, bottom);
		ctx.stroke();

		// The guides mark 2/|ρ|, the size of a zero's scaled main wave on the line. The wave fills them at every
		// height; that steady width is the hypothesis at work. A wave off the line outgrows them, so it is scaled
		// down to fit and the guides narrow instead.
		const band = (mid - 8) * 0.7;
		let amp = 0;
		let guide = band;
		if (shown) {
			const size = 2 / Math.hypot(0.5, zeros[shown.index]);
			refreshWave(zeros[shown.index], shown.beta, lo, hi);
			let peak = 0;
			for (const v of wave) peak = Math.max(peak, Math.abs(v));
			amp = Math.min(band / size, (mid - 6) / (peak || 1));
			guide = amp * size;
		}
		ctx.setLineDash([2, 4]);
		ctx.strokeStyle = 'rgba(236, 232, 255, 0.3)';
		ctx.beginPath();
		ctx.moveTo(Math.round(mid - guide) + 0.5, top);
		ctx.lineTo(Math.round(mid - guide) + 0.5, bottom);
		ctx.moveTo(Math.round(mid + guide) + 0.5, top);
		ctx.lineTo(Math.round(mid + guide) + 0.5, bottom);
		ctx.stroke();
		ctx.setLineDash([]);

		if (shown) {
			ctx.save();
			ctx.beginPath();
			ctx.rect(2, top, split - 4, span);
			ctx.clip();
			ctx.strokeStyle = shown.beta !== 0.5 ? HYPO : '#ffc46b';
			ctx.lineWidth = 1.25 + shown.flash * 1.5;
			ctx.globalAlpha = 0.85 + 0.15 * shown.flash;
			ctx.beginPath();
			wave.forEach((v, i) => {
				const x = mid + v * amp;
				const y = bottom - (span * i) / (wave.length - 1);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			});
			ctx.stroke();
			ctx.restore();
		}

		if (limitX > lo && limitX < hi) {
			const y = Math.round(bottom - (span * (limitX - lo)) / (hi - lo)) + 0.5;
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
			ctx.setLineDash([3, 3]);
			ctx.beginPath();
			ctx.moveTo(4, y);
			ctx.lineTo(split - 4, y);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
			ctx.textAlign = 'left';
			ctx.fillText('limit', 4, y - 4);
		}

		const gTop = zeros[max - 1] * 1.01;
		const zx = split + (w - split) / 2;
		for (let k = 0; k < max; k++) {
			const y = Math.round(bottom - (zeros[k] / gTop) * span) + 0.5;
			const used = k < count;
			ctx.strokeStyle = used ? 'rgba(255, 196, 107, 0.45)' : 'rgba(236, 232, 255, 0.12)';
			ctx.beginPath();
			ctx.moveTo(zx - (used ? 8 : 4), y);
			ctx.lineTo(zx + (used ? 8 : 4), y);
			ctx.stroke();
		}
		if (count > 0) {
			const y = bottom - (zeros[count - 1] / gTop) * span;
			ctx.fillStyle = '#fff3dc';
			ctx.beginPath();
			ctx.arc(zx, y, 3 + (shown ? shown.flash * 3 : 0), 0, Math.PI * 2);
			ctx.fill();
		}

		ctx.fillStyle = 'rgba(236, 232, 255, 0.55)';
		ctx.textAlign = 'center';
		ctx.fillText(narrow ? `x≤${formatX(hi)}` : `x ${formatX(lo)}–${formatX(hi)}`, mid, h - 10);
		ctx.fillText(narrow ? `${max}` : `γ ≤ ${zeros[max - 1].toFixed(0)}`, zx, h - 10);
	};

	resize();
	return { resize, draw };
};

const boot = () => {
	const canvas = document.getElementById('scene');
	const hints = document.getElementById('hints');
	const ctx = createGl(canvas);
	if (!ctx) {
		document.getElementById('fallback').hidden = false;
		hints.hidden = true;
		return;
	}
	const { gl, program } = ctx;
	const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const hdr = !!gl.getExtension('EXT_color_buffer_float');
	const fmt = hdr ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };

	const progs = {
		backdrop: program(FULLSCREEN_VS, BACKDROP_FS),
		stair: program(STAIR_VS, STAIR_FS),
		pillar: program(PILLAR_VS, PILLAR_FS),
		points: program(POINTS_VS, POINTS_FS),
		down: program(FULLSCREEN_VS, DOWN_FS),
		up: program(FULLSCREEN_VS, UP_FS),
		composite: program(FULLSCREEN_VS, COMPOSITE_FS),
	};

	const forwardButton = document.getElementById('forward');
	const backButton = document.getElementById('back');
	const slider = document.getElementById('zeros');
	const zerosValue = document.getElementById('zeros-value');
	const rangeButtons = [...document.querySelectorAll('[data-range]')];
	const rangeStrip = document.getElementById('range-strip');
	const rangeLower = document.getElementById('range-lower');
	const rangeHigher = document.getElementById('range-higher');
	const labelLayer = document.getElementById('labels');
	const panelEl = document.getElementById('panel');
	const panelToggle = document.getElementById('panel-toggle');
	const controlsEl = document.querySelector('.controls');
	const captionEl = document.querySelector('.caption');
	const betaInput = document.getElementById('beta');
	const betaValue = document.getElementById('beta-value');
	const ghostToggle = document.getElementById('ghost');
	const columnLabel = document.getElementById('column-label');
	const limitLabel = document.getElementById('limit-label');
	const aboutDialog = document.getElementById('about');
	const narrowScreen = window.matchMedia('(max-width: 40rem)');
	const panel = createPanel(panelEl, ZEROS);

	const zeros = ZEROS;
	const max = zeros.length;
	const primes = sieve(X_LIMIT);

	const vertexArray = (data, size) => {
		const vao = gl.createVertexArray();
		const buf = gl.createBuffer();
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, size, gl.FLOAT, false, 0, 0);
		return { vao, buf };
	};

	const mesh = buildStairMesh(MESH_SAMPLES);
	const stair = vertexArray(mesh.verts, 4);
	const stairIdx = gl.createBuffer();
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, stairIdx);
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
	gl.bindVertexArray(null);

	const SEGMENTS = 40;
	const pillarData = new Float32Array((SEGMENTS + 1) * 6);
	for (let k = 0; k <= SEGMENTS; k++) {
		const a = (k / SEGMENTS) * Math.PI * 2;
		pillarData.set([Math.cos(a) * 0.16, 0, Math.sin(a) * 0.16, Math.cos(a) * 0.16, 1, Math.sin(a) * 0.16], k * 6);
	}
	const pillar = vertexArray(pillarData, 3);
	gl.bindVertexArray(null);

	const zeroData = new Float32Array(max * 4);
	// A zero moved off the line and the partner it brings, drawn apart from the column in their own color.
	const movedData = new Float32Array(8);
	const movedVao = gl.createVertexArray();
	const movedBuf = gl.createBuffer();
	gl.bindVertexArray(movedVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, movedBuf);
	gl.bufferData(gl.ARRAY_BUFFER, movedData, gl.DYNAMIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	const zeroVao = gl.createVertexArray();
	const zeroBuf = gl.createBuffer();
	gl.bindVertexArray(zeroVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, zeroBuf);
	gl.bufferData(gl.ARRAY_BUFFER, zeroData, gl.DYNAMIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
	const emptyVao = gl.createVertexArray();
	gl.bindVertexArray(null);

	// Heights in the red channel and, in green, how well the zeros in use resolve the nearest prime's step.
	const heights = new Float32Array(MESH_SAMPLES);
	const resolved = new Float32Array(MESH_SAMPLES);
	const texData = new Float32Array(MESH_SAMPLES * 2);
	const makeHeightTexture = () => {
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, MESH_SAMPLES, 1, 0, gl.RG, gl.FLOAT, texData);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return tex;
	};
	const heightTex = makeHeightTexture();
	const ghostTex = makeHeightTexture();
	const upload = (tex, h, g) => {
		for (let i = 0; i < MESH_SAMPLES; i++) {
			texData[i * 2] = h[i];
			texData[i * 2 + 1] = g ? g[i] : 1;
		}
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MESH_SAMPLES, 1, gl.RG, gl.FLOAT, texData);
	};

	const makeTarget = (w, h) => {
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, gl.RGBA, fmt.type, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const fbo = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		return { tex, fbo, w, h };
	};

	let targets = null;
	const buildTargets = (w, h) => {
		if (targets) {
			gl.deleteFramebuffer(targets.msaa);
			targets.renderbuffers.forEach((rb) => gl.deleteRenderbuffer(rb));
			[targets.scene, ...targets.bloom].forEach((t) => {
				gl.deleteFramebuffer(t.fbo);
				gl.deleteTexture(t.tex);
			});
		}
		const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
		const msaa = gl.createFramebuffer();
		const color = gl.createRenderbuffer();
		const depth = gl.createRenderbuffer();
		gl.bindRenderbuffer(gl.RENDERBUFFER, color);
		gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt.internal, w, h);
		gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
		gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
		gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
		const bloom = [];
		for (let i = 1, bw = w, bh = h; i <= 6; i++) {
			bw = Math.max(1, bw >> 1);
			bh = Math.max(1, bh >> 1);
			bloom.push(makeTarget(bw, bh));
		}
		targets = { msaa, renderbuffers: [color, depth], scene: makeTarget(w, h), bloom, w, h };
	};

	const resize = () => {
		panel.resize();
		const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
		const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
		if (targets && targets.w === w && targets.h === h) return;
		canvas.width = w;
		canvas.height = h;
		buildTargets(w, h);
	};

	const scene = {
		xMax: 0, xTarget: 0, top: 0, topTarget: 0, builder: null, resample: null, labels: [], shownCount: -1, rangeIndex: 0, labelFloor: 0,
		nearest: new Int32Array(MESH_SAMPLES), primesInRange: [], beta: 0.5, shift: new Float32Array(MESH_SAMPLES),
		shiftKey: '', dirty: true, pulseAt: -Infinity, ghost: false, limit: null,
	};

	// The shift a moved first zero adds, sampled evenly in ln x (its period in ln x is fixed) and interpolated.
	// About twenty samples per period of the first zero's wave; its wave on the line is cached per range.
	// Sampled once over the widest range, so growing or shrinking the stairs only re-reads it.
	const SHIFT_SAMPLES = 256;
	const u0 = Math.log(TAU);
	const u1 = Math.log(X_LIMIT);
	const xs = (k) => Math.exp(u0 + ((u1 - u0) * k) / (SHIFT_SAMPLES - 1));
	const onLine = Float64Array.from({ length: SHIFT_SAMPLES }, (_, k) => waveAt(zeros[0], xs(k)));
	const coarse = { beta: 0.5, values: new Float64Array(SHIFT_SAMPLES) };
	const updateShift = () => {
		const on = scene.beta !== 0.5 && scene.builder.count >= 1;
		const key = on ? `${scene.beta}:${scene.xMax}` : 'off';
		if (key === scene.shiftKey) return false;
		scene.shiftKey = key;
		scene.shift.fill(0);
		if (!on) return true;
		const { beta } = scene;
		if (coarse.beta !== beta) {
			coarse.beta = beta;
			for (let k = 0; k < SHIFT_SAMPLES; k++) coarse.values[k] = waveAt(zeros[0], xs(k), beta) + waveAt(zeros[0], xs(k), 1 - beta) - onLine[k];
		}
		const c = coarse.values;
		const dx = scene.xMax / (MESH_SAMPLES - 1);
		for (let i = 0; i < MESH_SAMPLES; i++) {
			const x = i * dx;
			if (x < TAU) continue;
			const f = Math.min(SHIFT_SAMPLES - 1, ((Math.log(x) - u0) / (u1 - u0)) * (SHIFT_SAMPLES - 1));
			const k = Math.min(SHIFT_SAMPLES - 2, Math.floor(f));
			scene.shift[i] = c[k] + (c[k + 1] - c[k]) * (f - k);
		}
		return true;
	};

	const refreshHeights = () => {
		scene.resample(scene.builder, heights);
		for (let i = 0; i < MESH_SAMPLES; i++) heights[i] += scene.shift[i];
		const { primesInRange: ps } = scene;
		const sharp = ps.map((p, k) => stepSharpness(heights, scene.xMax, p, Math.min(p - (ps[k - 1] ?? p - 1), (ps[k + 1] ?? scene.xMax + 1) - p)));
		scene.labels.forEach((l, k) => {
			l.sharp = sharp[k] ?? 0;
		});
		for (let i = 0; i < MESH_SAMPLES; i++) resolved[i] = smoothstep(0.6, 0.92, sharp[scene.nearest[i]] ?? 0);
		upload(heightTex, heights, resolved);
	};

	// The formula is built once over the widest range: its grid is uniform in ln x, so a smaller range would get
	// the same samples. Changing the range then only changes how much of it is drawn.
	scene.builder = createBuilder(buildGrid(0, X_LIMIT, zeros[max - 1]), zeros);
	scene.labels = primes.map((p, k) => {
		const el = document.createElement('span');
		el.className = 'prime-label';
		el.textContent = String(p);
		labelLayer.append(el);
		const next = primes[k + 1] ?? X_LIMIT;
		return { p, el, at: p + Math.min(1.2, (next - p) * 0.5), sharp: 0, alpha: 0, w: 0 };
	});

	// Points the mesh at [0, xMax] of the formula; called every frame while the stairs grow or shrink.
	const setExtent = (xMax) => {
		scene.xMax = xMax;
		scene.resample = createResampler(scene.builder.grid, xMax, MESH_SAMPLES);
		scene.shiftKey = '';
		scene.dirty = true;
		const ps = primes.filter((p) => p <= xMax);
		scene.primesInRange = ps;
		const dx = xMax / (MESH_SAMPLES - 1);
		const exact = new Float32Array(MESH_SAMPLES);
		for (let i = 0, k = 0; i < MESH_SAMPLES; i++) {
			const x = i * dx;
			while (k + 1 < ps.length && Math.abs(ps[k + 1] - x) < Math.abs(ps[k] - x)) k++;
			scene.nearest[i] = k;
			exact[i] = primePi(primes, x);
		}
		upload(ghostTex, exact, null);
	};

	const setRange = (xMax) => {
		scene.xTarget = xMax;
		scene.topTarget = primePi(primes, xMax) * STEP_HEIGHT;
		if (calm || !scene.xMax) {
			scene.top = scene.topTarget;
			setExtent(xMax);
		}
		const index = RANGES.indexOf(xMax);
		scene.rangeIndex = index;
		rangeButtons.forEach((el, i) => {
			el.setAttribute('aria-pressed', String(i === index));
			el.tabIndex = -1;
		});
		// The reel shows the chosen range in the middle with its neighbors either side.
		rangeStrip.style.transform = `translateX(${(1 - index) * 3.5}rem)`;
		rangeLower.disabled = index === 0;
		rangeHigher.disabled = index === RANGES.length - 1;
	};

	const cam = { yaw: -0.6, pitch: 0.42, dist: 1 };
	const view = { eye: [0, 0, 0], viewProj: null, invViewProj: null, pixels: 1 };

	const updateCamera = () => {
		const aspect = targets.w / targets.h;
		const rect = canvas.getBoundingClientRect();
		// On a wide screen the stairs stay centered under the controls, fitted to keep clear of the panel's column
		// on both sides whether the panel is open or not; on a narrow one the panel floats over the scene.
		const reserve = narrowScreen.matches ? null : panelToggle.getBoundingClientRect();
		const share = reserve ? Math.min(0.4, Math.max(0, (rect.right - reserve.left) / rect.width)) : 0;
		// The controls cover the bottom of the screen, and on a narrow screen the caption spans the top; frame the
		// stairs in the space left between them.
		const below = Math.min(0.4, Math.max(0, (rect.bottom - controlsEl.getBoundingClientRect().top) / rect.height));
		const captionRect = captionEl.getBoundingClientRect();
		const above = captionRect.width > rect.width * 0.6 ? Math.min(0.45, Math.max(0, (captionRect.bottom - rect.top) / rect.height)) : 0;
		const dist = cam.dist * fitDistance(scene.top, aspect * (1 - 2 * share), 1 - below - above);
		const target = [0, scene.top * 0.45, 0];
		const cp = Math.cos(cam.pitch);
		const eye = [
			target[0] + dist * cp * Math.sin(cam.yaw),
			target[1] + dist * Math.sin(cam.pitch),
			target[2] + dist * cp * Math.cos(cam.yaw),
		];
		const v = lookAt(eye, target, [0, 1, 0]);
		view.eye = eye;
		const proj = perspective(FOV, aspect, 0.1, 400);
		proj[9] = above - below;
		view.viewProj = multiply(proj, v);
		const inv = new Float32Array(16);
		invert4(view.viewProj, inv);
		view.invViewProj = inv;
		view.pixels = targets.h / 2 / Math.tan(FOV / 2);
		view.centerDepth = transform(view.viewProj, [0, target[1], 0])[3];
		view.right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
	};

	const project = (p, rect) => {
		const c = transform(view.viewProj, p);
		if (c[3] <= 0.1) return null;
		return { x: (c[0] / c[3] * 0.5 + 0.5) * rect.width, y: (1 - (c[1] / c[3] * 0.5 + 0.5)) * rect.height, depth: c[3] };
	};

	const pin = (el, at, opacity) => {
		if (!at || opacity <= 0.01) {
			el.style.opacity = '0';
			return;
		}
		el.style.opacity = opacity.toFixed(3);
		el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(-50%, -50%)`;
	};

	const placeLabels = (dt) => {
		// Labels come in as their steps sharpen. Once every zero is in and nothing is playing, the primes the
		// zeros cannot resolve fade in faintly too. Brighter labels claim their spot first; a fainter one that
		// would overlap is skipped.
		const rest = scene.builder.count >= max && play.dir === 0 ? 0.55 : 0;
		scene.labelFloor += (rest - scene.labelFloor) * Math.min(1, dt * 0.8);
		const rect = canvas.getBoundingClientRect();
		const order = scene.labels
			.map((l) => ({ l, show: Math.max(smoothstep(0.6, 0.92, l.sharp), scene.labelFloor) }))
			// A label already on screen gets a head start, so two contenders do not trade places as the camera turns.
			.sort((a, b) => b.show + 0.2 * b.l.alpha - (a.show + 0.2 * a.l.alpha));
		const column = project([0, scene.top + 2.2, 0], rect);
		const half = columnLabel.offsetWidth / 2 + 12;
		const placed = [];
		for (const { l, show } of order) {
			const y = heightAt(heights, scene.xMax, l.at) * STEP_HEIGHT + 0.35;
			const at = project(spiralPoint(l.at, R_OUT + 0.9, y), rect);
			const underColumn = (x, y) => column && Math.abs(y - column.y) < LABEL_GAP.y && Math.abs(x - column.x) < half;
			// A phone has no room for the faint labels of unresolved steps; they only crowd the resolved ones.
			const faint = narrowScreen.matches ? 0.55 : 0.01;
			// Labels never move off their step; a crowded one fades out instead.
			l.w ||= l.el.offsetWidth + 6;
			const free = l.p <= scene.xMax && at && show > faint && !underColumn(at.x, at.y) && !overlapsAny(placed, at.x, at.y, l.w);
			let target = 0;
			if (free) {
				placed.push({ x: at.x, y: at.y, w: l.w });
				target = show * (1 - 0.7 * smoothstep(-2, 4, at.depth - view.centerDepth));
			}
			l.alpha += (target - l.alpha) * Math.min(1, dt * 8);
			if (l.p > scene.xMax || !at || l.alpha < 0.02) {
				if (!target) l.alpha = 0;
				l.el.style.opacity = '0';
				continue;
			}
			pin(l.el, at, l.alpha);
		}
		pin(columnLabel, column, 1);
		// How far the zeros reach, on the floor in front of the stairs, kept clear of the controls.
		const { limit } = scene;
		if (limit !== null && limit > 3 && limit < scene.xMax) {
			limitLabel.textContent = narrowScreen.matches ? `sharp below x ≈ ${limit.toFixed(0)}` : `${scene.builder.count} zeros: every step sharp below x ≈ ${limit.toFixed(0)}`;
			const toward = [-view.right[2], 0, view.right[0]];
			const front = [1, -1]
				.map((sign) => project([sign * toward[0] * (R_OUT + 1.6), 0, sign * toward[2] * (R_OUT + 1.6)], rect))
				.filter(Boolean)
				.sort((a, b) => a.depth - b.depth)[0];
			if (front) {
				const halfWidth = limitLabel.offsetWidth / 2 + 12;
				front.x = Math.min(rect.width - halfWidth, Math.max(halfWidth, front.x));
				front.y = Math.min(front.y + 18, controlsEl.getBoundingClientRect().top - rect.top - 28);
			}
			pin(limitLabel, front, 1);
		} else pin(limitLabel, null, 0);
	};

	const draw = (time, dt) => {
		updateCamera();
		const { w, h } = targets;
		const vp = view.viewProj;
		const { builder } = scene;

		const gammaTop = zeros[max - 1];
		// Many lit zeros overlap on the column; dimming each keeps the stack a column of light, not a flare.
		const dim = Math.min(1, 4 / Math.sqrt(builder.count + 1));
		const flash = Math.exp(-(time - scene.pulseAt) * 4);
		for (let k = 0; k < max; k++) {
			const y = (zeros[k] / gammaTop) * scene.top;
			const used = k < builder.count;
			const fresh = k >= builder.count - 3 ? 2.2 + 0.6 * Math.sin(time * 6) : dim;
			const newest = k === builder.count - 1 ? flash * 4 : 0;
			zeroData.set([0, y, 0, used ? fresh + newest : 0.04], k * 4);
		}
		// A zero moved off the line sits beside the column at β, with its partner at 1 − β on the other side.
		const off = (scene.beta - 0.5) * 7;
		const y0 = (zeros[0] / gammaTop) * scene.top + 0.4;
		const moved = scene.beta !== 0.5 && builder.count >= 1;
		if (moved) {
			zeroData[3] = 0;
			movedData.set([view.right[0] * off, y0, view.right[2] * off, 1, -view.right[0] * off, y0, -view.right[2] * off, 1]);
		}


		gl.bindFramebuffer(gl.FRAMEBUFFER, targets.msaa);
		gl.viewport(0, 0, w, h);
		gl.clearColor(0, 0, 0, 1);
		gl.depthMask(true);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		gl.disable(gl.DEPTH_TEST);
		gl.depthMask(false);
		gl.disable(gl.BLEND);
		gl.useProgram(progs.backdrop.p);
		gl.uniformMatrix4fv(progs.backdrop.u.uInvViewProj, false, view.invViewProj);
		gl.uniform3fv(progs.backdrop.u.uEye, view.eye);
		gl.bindVertexArray(emptyVao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);

		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(true);
		gl.useProgram(progs.stair.p);
		gl.uniformMatrix4fv(progs.stair.u.uViewProj, false, vp);
		gl.uniform3fv(progs.stair.u.uEye, view.eye);
		gl.uniform1f(progs.stair.u.uDx, scene.xMax / (MESH_SAMPLES - 1));
		gl.uniform1i(progs.stair.u.uCount, MESH_SAMPLES);
		gl.uniform1f(progs.stair.u.uGlow, 1);
		gl.uniform1i(progs.stair.u.uGhost, 0);
		gl.uniform2f(progs.stair.u.uRadii, R_IN, R_OUT);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, heightTex);
		gl.uniform1i(progs.stair.u.uHeights, 0);
		gl.bindVertexArray(stair.vao);
		gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);

		gl.depthMask(false);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE);
		if (scene.ghost) {
			gl.uniform1i(progs.stair.u.uGhost, 1);
			gl.uniform2f(progs.stair.u.uRadii, R_OUT + 0.15, R_OUT + 0.7);
			gl.bindTexture(gl.TEXTURE_2D, ghostTex);
			gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);
		}
		gl.useProgram(progs.pillar.p);
		gl.uniformMatrix4fv(progs.pillar.u.uViewProj, false, vp);
		gl.uniform3fv(progs.pillar.u.uEye, view.eye);
		gl.uniform1f(progs.pillar.u.uTop, scene.top);
		gl.bindVertexArray(pillar.vao);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, (SEGMENTS + 1) * 2);

		gl.useProgram(progs.points.p);
		gl.uniformMatrix4fv(progs.points.u.uViewProj, false, vp);
		gl.uniform1f(progs.points.u.uPixels, view.pixels);
		gl.uniform3f(progs.points.u.uTint, 1.0, 0.8, 0.5);
		gl.bindVertexArray(zeroVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, zeroBuf);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, zeroData);
		gl.uniform1f(progs.points.u.uSize, 0.7);
		gl.uniform1f(progs.points.u.uGain, 0.22);
		gl.uniform1f(progs.points.u.uFalloff, 5.0);
		gl.drawArrays(gl.POINTS, 0, max);
		gl.uniform1f(progs.points.u.uSize, 0.2);
		gl.uniform1f(progs.points.u.uGain, 1.6);
		gl.uniform1f(progs.points.u.uFalloff, 2.5);
		gl.drawArrays(gl.POINTS, 0, max);
		if (moved) {
			gl.bindVertexArray(movedVao);
			gl.bindBuffer(gl.ARRAY_BUFFER, movedBuf);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, movedData);
			gl.uniform3f(progs.points.u.uTint, 1.0, 0.56, 0.65);
			gl.uniform1f(progs.points.u.uSize, 1.1);
			gl.uniform1f(progs.points.u.uGain, 0.5);
			gl.uniform1f(progs.points.u.uFalloff, 4.0);
			gl.drawArrays(gl.POINTS, 0, 2);
			gl.uniform1f(progs.points.u.uSize, 0.32);
			gl.uniform1f(progs.points.u.uGain, 2.2);
			gl.drawArrays(gl.POINTS, 0, 2);
		}

		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targets.msaa);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targets.scene.fbo);
		gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);

		gl.bindVertexArray(emptyVao);
		gl.disable(gl.BLEND);
		gl.disable(gl.DEPTH_TEST);
		gl.useProgram(progs.down.p);
		gl.uniform1f(progs.down.u.uThreshold, hdr ? 1.0 : 0.65);
		let src = targets.scene;
		targets.bloom.forEach((dst, i) => {
			gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
			gl.viewport(0, 0, dst.w, dst.h);
			gl.bindTexture(gl.TEXTURE_2D, src.tex);
			gl.uniform1i(progs.down.u.uTex, 0);
			gl.uniform2f(progs.down.u.uTexel, 1 / src.w, 1 / src.h);
			gl.uniform1i(progs.down.u.uPrefilter, i === 0 ? 1 : 0);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			src = dst;
		});
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE);
		gl.useProgram(progs.up.p);
		for (let i = targets.bloom.length - 1; i > 0; i--) {
			const from = targets.bloom[i];
			const to = targets.bloom[i - 1];
			gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
			gl.viewport(0, 0, to.w, to.h);
			gl.bindTexture(gl.TEXTURE_2D, from.tex);
			gl.uniform1i(progs.up.u.uTex, 0);
			gl.uniform2f(progs.up.u.uTexel, 1 / from.w, 1 / from.h);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		}
		gl.disable(gl.BLEND);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, w, h);
		gl.useProgram(progs.composite.p);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, targets.scene.tex);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, targets.bloom[0].tex);
		gl.uniform1i(progs.composite.u.uScene, 0);
		gl.uniform1i(progs.composite.u.uBloom, 1);
		gl.uniform2f(progs.composite.u.uRes, w, h);
		gl.uniform1f(progs.composite.u.uTime, time);
		gl.uniform1f(progs.composite.u.uBloomGain, hdr ? 0.55 : 0.4);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.activeTexture(gl.TEXTURE0);

		placeLabels(dt);
	};

	// dir: 1 adds zeros, -1 takes them away, 0 is paused. The slider only moves while paused.
	const play = { dir: 0, clock: 0 };
	let lastInput = -Infinity;

	const syncTransport = () => {
		const n = scene.builder.target;
		forwardButton.setAttribute('aria-pressed', String(play.dir === 1));
		backButton.setAttribute('aria-pressed', String(play.dir === -1));
		forwardButton.setAttribute('aria-label', play.dir === 1 ? 'Pause' : 'Add zeros');
		backButton.setAttribute('aria-label', play.dir === -1 ? 'Pause' : 'Remove zeros');
		forwardButton.disabled = play.dir !== 1 && n >= max;
		backButton.disabled = play.dir !== -1 && n <= 0;
		slider.disabled = play.dir !== 0;
	};

	const setPlaying = (dir) => {
		play.dir = dir;
		if (dir) play.clock = riseTimeFor(scene.builder.target, max);
		syncTransport();
	};

	const setTarget = (n) => {
		scene.builder.target = Math.max(0, Math.min(max, n));
		slider.value = String(positionForZeros(scene.builder.target, max));
		syncFill(slider);
		syncTransport();
	};

	const setBeta = (beta) => {
		scene.beta = beta;
		betaValue.textContent = beta === 0.5 ? 'Re = ½' : `Re = ${beta.toFixed(2)} and ${(1 - beta).toFixed(2)}`;
		document.body.classList.toggle('is-hypothetical', beta !== 0.5);
		syncFill(betaInput);
		scene.dirty = true;
	};

	const showCount = () => {
		const { count } = scene.builder;
		zerosValue.textContent = count ? `${count} · γ ≤ ${zeros[count - 1].toFixed(1)}` : '0';
	};

	const pointers = new Map();
	let pinch = 0;
	canvas.addEventListener('pointerdown', (e) => {
		canvas.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			pinch = Math.hypot(a.x - b.x, a.y - b.y);
		}
		lastInput = performance.now();
		canvas.classList.add('is-orbiting');
	});
	canvas.addEventListener('pointermove', (e) => {
		const p = pointers.get(e.pointerId);
		if (!p) return;
		if (pointers.size === 2) {
			p.x = e.clientX;
			p.y = e.clientY;
			const [a, b] = [...pointers.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			if (pinch > 0) cam.dist = clampZoom(cam.dist * (pinch / d));
			pinch = d;
		} else {
			cam.yaw -= (e.clientX - p.x) * 0.005;
			cam.pitch = Math.min(1.45, Math.max(-0.05, cam.pitch + (e.clientY - p.y) * 0.004));
			p.x = e.clientX;
			p.y = e.clientY;
		}
		lastInput = performance.now();
	});
	const release = (e) => {
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = 0;
		if (!pointers.size) canvas.classList.remove('is-orbiting');
	};
	canvas.addEventListener('pointerup', release);
	canvas.addEventListener('pointercancel', release);
	canvas.addEventListener('wheel', (e) => {
		e.preventDefault();
		cam.dist = clampZoom(cam.dist * Math.exp(e.deltaY * 0.001));
		lastInput = performance.now();
	}, { passive: false });

	slider.addEventListener('input', () => setTarget(zerosForPosition(Number(slider.value), max)));
	betaInput.addEventListener('input', () => setBeta(Math.round(Number(betaInput.value) * 100) / 100));
	ghostToggle.addEventListener('change', () => {
		scene.ghost = ghostToggle.checked;
	});
	const setPanelOpen = (open) => {
		panelToggle.setAttribute('aria-expanded', String(open));
		document.body.classList.toggle('is-panel-closed', !open);
	};
	panelToggle.addEventListener('click', () => setPanelOpen(panelToggle.getAttribute('aria-expanded') !== 'true'));
	const toolsToggle = document.getElementById('tools-toggle');
	const setToolsOpen = (open) => {
		toolsToggle.setAttribute('aria-expanded', String(open));
		document.body.classList.toggle('is-tools-closed', !open);
	};
	toolsToggle.addEventListener('click', () => setToolsOpen(toolsToggle.getAttribute('aria-expanded') !== 'true'));
	// A mouse click leaves focus on the button, and Space would then press it again instead of playing.
	document.querySelectorAll('.controls button, #panel-toggle, #tools-toggle, #about-open').forEach((el) => {
		el.addEventListener('click', (e) => {
			if (e.detail > 0) el.blur();
		});
	});
	forwardButton.addEventListener('click', () => setPlaying(play.dir === 1 ? 0 : 1));
	backButton.addEventListener('click', () => setPlaying(play.dir === -1 ? 0 : -1));
	rangeButtons.forEach((el, i) => el.addEventListener('click', () => setRange(RANGES[i])));
	rangeLower.addEventListener('click', () => setRange(RANGES[shiftRange(scene.rangeIndex, -1)]));
	rangeHigher.addEventListener('click', () => setRange(RANGES[shiftRange(scene.rangeIndex, 1)]));
	window.addEventListener('keydown', (e) => {
		if (aboutDialog.open || e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
		if (e.key === ' ') {
			e.preventDefault();
			if (play.dir) setPlaying(0);
			else setPlaying(scene.builder.target < max ? 1 : -1);
		}
	});
	window.addEventListener('resize', resize);

	setPanelOpen(!narrowScreen.matches);
	setToolsOpen(!narrowScreen.matches);
	requestAnimationFrame(() => document.body.classList.remove('is-loading'));
	// The dialog takes focus itself and opens at the top; left alone, Chrome focuses Close and scrolls to the end.
	document.getElementById('about-open').addEventListener('click', () => {
		aboutDialog.showModal();
		aboutDialog.scrollTop = 0;
		aboutDialog.focus({ preventScroll: true });
	});
	document.querySelectorAll('#about-close, #about-x').forEach((el) => el.addEventListener('click', () => aboutDialog.close()));
	// A click on the backdrop lands on the dialog element itself.
	aboutDialog.addEventListener('click', (e) => {
		if (e.target === aboutDialog) aboutDialog.close();
	});
	setBeta(0.5);
	setRange(100);
	setTarget(calm ? max : 0);
	resize();
	setPlaying(calm ? 0 : 1);

	let last = performance.now();
	const frame = (now) => {
		const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
		last = now;
		if (play.dir && canAdvance(scene.builder.count, scene.builder.target)) {
			const next = advanceClock(play.clock, play.dir, dt);
			play.clock = next.clock;
			setTarget(zerosAtClock(next.clock, max));
			if (!next.dir) setPlaying(0);
		}
		if (scene.xMax !== scene.xTarget) {
			setExtent(easeRange(scene.xMax, scene.xTarget, dt));
			scene.top = scene.xMax === scene.xTarget ? scene.topTarget : easeRange(scene.top, scene.topTarget, dt);
		}
		const { builder } = scene;
		const started = performance.now();
		while (performance.now() - started < 8 && builder.advance());
		const shifted = updateShift();
		if (builder.count !== scene.shownCount || shifted || scene.dirty) {
			if (!calm && builder.count > scene.shownCount && scene.shownCount >= 0) scene.pulseAt = now / 1000;
			refreshHeights();
			scene.shownCount = builder.count;
			scene.dirty = false;
			showCount();
		}
		const { count } = builder;
		scene.limit = count ? resolutionLimit(zeros[count - 1]) : null;
		if (!calm && now - lastInput > 3000) cam.yaw += dt * 0.06;
		hints.classList.toggle('is-quiet', now - lastInput < 4000 && lastInput > 0);
		draw(now / 1000, dt);
		const moved = scene.beta !== 0.5 && count >= 1;
		const shown = count ? { index: moved ? 0 : count - 1, beta: moved ? scene.beta : 0.5, flash: moved ? 0 : Math.exp(-(now / 1000 - scene.pulseAt) * 4) } : null;
		panel.draw(count, 0, scene.xTarget, scene.limit !== null && scene.limit > 3 ? scene.limit : 0, shown);
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
};

const invert4 = (a, out) => {
	const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a;
	const b00 = a00 * a11 - a01 * a10;
	const b01 = a00 * a12 - a02 * a10;
	const b02 = a00 * a13 - a03 * a10;
	const b03 = a01 * a12 - a02 * a11;
	const b04 = a01 * a13 - a03 * a11;
	const b05 = a02 * a13 - a03 * a12;
	const b06 = a20 * a31 - a21 * a30;
	const b07 = a20 * a32 - a22 * a30;
	const b08 = a20 * a33 - a23 * a30;
	const b09 = a21 * a32 - a22 * a31;
	const b10 = a21 * a33 - a23 * a31;
	const b11 = a22 * a33 - a23 * a32;
	const d = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
	out.set([
		(a11 * b11 - a12 * b10 + a13 * b09) * d,
		(a02 * b10 - a01 * b11 - a03 * b09) * d,
		(a31 * b05 - a32 * b04 + a33 * b03) * d,
		(a22 * b04 - a21 * b05 - a23 * b03) * d,
		(a12 * b08 - a10 * b11 - a13 * b07) * d,
		(a00 * b11 - a02 * b08 + a03 * b07) * d,
		(a32 * b02 - a30 * b05 - a33 * b01) * d,
		(a20 * b05 - a22 * b02 + a23 * b01) * d,
		(a10 * b10 - a11 * b08 + a13 * b06) * d,
		(a01 * b08 - a00 * b10 - a03 * b06) * d,
		(a30 * b04 - a31 * b02 + a33 * b00) * d,
		(a21 * b02 - a20 * b04 - a23 * b00) * d,
		(a11 * b07 - a10 * b09 - a12 * b06) * d,
		(a00 * b09 - a01 * b07 + a02 * b06) * d,
		(a31 * b01 - a30 * b03 - a32 * b00) * d,
		(a20 * b03 - a21 * b01 + a22 * b00) * d,
	]);
	return out;
};

if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
	else boot();
}
