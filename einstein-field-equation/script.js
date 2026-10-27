'use strict';

// World units: bodies live in the square from -HALF to HALF in the XZ plane, height is Y.
// The drawn sheet reaches EXTENT and fades from FADE_START to FADE_END, tuned so the grid
// is nearly gone where the play area ends: whatever looks clickable is clickable.
const HALF = 24;
const WALL = HALF - 1;
const EXTENT = 36;
const FADE_START = 6;
const FADE_END = 34;
const DEPTH = 6.5;
const G = 520;
const MAX_BODIES = 8;
const MASS_MIN = 0.2;
const MESH_N = 400;
const SHEET_BAND = 8;
const WAVE_N = 192;
const WAVE_CELL = (2 * HALF) / WAVE_N;
const WAVE_C2 = 0.22;
const WAVE_DAMP = 0.986;
const SHADE_REF = DEPTH * 1.9;
const DUST = 1800;
const DUST_SPREAD = [2.2, 12];
// Grains and moons flung farther than this from the heaviest body go back into orbit around it,
// so the disk keeps being stirred by the planets but never drains away.
const DUST_LEASH = 14;
const MOON_LEASH = 10;
const TRAIL = 220;
const SUBSTEPS = 3;
const FOV = 0.8;

const KINDS = {
	star: { soften: 2.4, maxMass: 6, radius: (m) => 0.75 + 0.35 * Math.sqrt(m) },
	planet: { soften: 1.6, maxMass: 3, radius: (m) => 0.35 + 0.33 * Math.sqrt(m) },
	hole: { soften: 1.25, maxMass: 10, radius: (m) => 0.3 + 0.22 * Math.sqrt(m) },
};

// The sheet is the softened Newtonian potential, so everything that orbits is
// pulled by exactly the slope that is drawn.
const wellHeight = (bodies, x, z) => {
	let h = 0;
	for (const b of bodies) {
		const dx = x - b.x;
		const dz = z - b.z;
		h -= (DEPTH * b.mass) / Math.sqrt(1 + (dx * dx + dz * dz) / (b.soften * b.soften));
	}
	return h;
};

const gravityAt = (bodies, x, z, skip) => {
	let ax = 0;
	let az = 0;
	for (const b of bodies) {
		if (b === skip) continue;
		const dx = b.x - x;
		const dz = b.z - z;
		const d2 = dx * dx + dz * dz + b.soften * b.soften;
		const f = (G * b.mass) / (d2 * Math.sqrt(d2));
		ax += f * dx;
		az += f * dz;
	}
	return [ax, az];
};

const circularSpeed = (mass, soften, r) => Math.sqrt((G * mass * r * r) / (r * r + soften * soften) ** 1.5);

// Keeps a body inside the square sheet, bouncing it off the edge with some loss.
const bounceInSquare = (b, wall) => {
	for (const [p, v] of [['x', 'vx'], ['z', 'vz']]) {
		if (Math.abs(b[p]) <= wall) continue;
		const side = Math.sign(b[p]);
		b[p] = side * wall;
		if (b[v] * side > 0) b[v] *= -0.6;
	}
};

// Height of a sphere's center when it rests in the sheet without cutting through it: the
// highest point, over a disc under the sphere, of the surface plus the sphere's cap there.
const restingHeight = (heightAt, x, z, radius) => {
	let top = heightAt(x, z) + radius;
	for (let ring = 1; ring <= 6; ring++) {
		const r = (radius * ring) / 6;
		const cap = Math.sqrt(Math.max(0, radius * radius - r * r));
		for (let k = 0; k < 12; k++) {
			const a = (k / 12) * Math.PI * 2;
			top = Math.max(top, heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r) + cap);
		}
	}
	return top;
};

// Which way to walk the sheet so the bands farthest from the eye are drawn first. Walking
// along the axis the camera mostly looks down is the classic painter's order for a height field.
const sheetDrawOrder = (eye, target) => {
	const dx = eye[0] - target[0];
	const dz = eye[2] - target[2];
	return Math.abs(dz) >= Math.abs(dx) ? { axis: 'z', ascending: dz > 0 } : { axis: 'x', ascending: dx > 0 };
};

// Heavy bodies drag the whole sheet down, since the potential fades slowly. Measuring how far
// the edge of the play area has sunk lets the sheet be lifted back, so flat space stays at zero.
const farFieldLevel = (bodies) => {
	let sum = 0;
	for (let k = 0; k < 16; k++) {
		const a = (k / 16) * Math.PI * 2;
		sum += wellHeight(bodies, Math.cos(a) * HALF, Math.sin(a) * HALF);
	}
	return sum / 16;
};

const MOON_FADE_IN = 1.2;
const MOON_FADE_OUT = 0.6;

// Opacity of a moon over time: down while it is leaving, up otherwise, in seconds.
const stepFade = (fade, leaving, dt) =>
	leaving ? Math.max(0, fade - dt / MOON_FADE_OUT) : Math.min(1, fade + dt / MOON_FADE_IN);

const clampMass = (kind, mass) => Math.min(KINDS[kind].maxMass, Math.max(MASS_MIN, mass));

const mergeBodies = (a, b) => {
	const mass = a.mass + b.mass;
	const heavy = a.mass >= b.mass ? a : b;
	const kind = a.kind === 'hole' || b.kind === 'hole' ? 'hole' : a.kind === 'star' || b.kind === 'star' ? 'star' : 'planet';
	return {
		x: (a.x * a.mass + b.x * b.mass) / mass,
		z: (a.z * a.mass + b.z * b.mass) / mass,
		vx: (a.vx * a.mass + b.vx * b.mass) / mass,
		vz: (a.vz * a.mass + b.vz * b.mass) / mass,
		mass,
		kind,
		hue: heavy.hue,
	};
};

// Damped wave equation on a square grid, edges pinned. Returns the peak amplitude.
const stepWaves = (h, v, n) => {
	let peak = 0;
	for (let j = 1; j < n - 1; j++) {
		for (let i = 1; i < n - 1; i++) {
			const k = j * n + i;
			const lap = h[k - 1] + h[k + 1] + h[k - n] + h[k + n] - 4 * h[k];
			v[k] = (v[k] + WAVE_C2 * lap) * WAVE_DAMP;
		}
	}
	for (let k = 0; k < h.length; k++) {
		h[k] += v[k];
		const a = Math.abs(h[k]) + Math.abs(v[k]);
		if (a > peak) peak = a;
	}
	return peak;
};

// Wave nodes sit at texel centers, matching LINEAR sampling of the wave texture on the GPU.
const sampleWave = (h, x, z) => {
	const n = WAVE_N;
	const gx = Math.min(n - 1.001, Math.max(0, (x + HALF) / WAVE_CELL - 0.5));
	const gz = Math.min(n - 1.001, Math.max(0, (z + HALF) / WAVE_CELL - 0.5));
	const i = Math.floor(gx);
	const j = Math.floor(gz);
	const fx = gx - i;
	const fz = gz - j;
	const k = j * n + i;
	const a = h[k] * (1 - fx) + h[k + 1] * fx;
	const b = h[k + n] * (1 - fx) + h[k + n + 1] * fx;
	return a * (1 - fz) + b * fz;
};

const TAP_SLOP = 10;
const TAP_MS = 300;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_REACH = 32;
const LONG_PRESS_MS = 550;

// down carries a moved flag set while the pointer was held, so a finger that
// wanders off and comes back is not a tap.
const isTap = (down, up) => !down.moved && up.t - down.t < TAP_MS && Math.hypot(up.x - down.x, up.y - down.y) < TAP_SLOP;

const isDoubleTap = (prev, tap) =>
	!!prev && tap.t - prev.t < DOUBLE_TAP_MS && Math.hypot(tap.x - prev.x, tap.y - prev.y) < DOUBLE_TAP_REACH;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => {
	const l = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
};

// Column-major 4x4 matrices, the layout WebGL expects.
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

const invert = (a) => {
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
	const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if (!det) return null;
	const d = 1 / det;
	return new Float32Array([
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
};

const transform = (m, p) => [
	m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
	m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
	m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
	m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
];

const rayFromNdc = (invViewProj, nx, ny) => {
	const a = transform(invViewProj, [nx, ny, -1]);
	const b = transform(invViewProj, [nx, ny, 1]);
	const origin = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
	return { origin, dir: normalize(sub([b[0] / b[3], b[1] / b[3], b[2] / b[3]], origin)) };
};

const raySphere = (origin, dir, center, radius) => {
	const oc = sub(origin, center);
	const b = dot(oc, dir);
	const disc = b * b - (dot(oc, oc) - radius * radius);
	if (disc < 0) return null;
	const t = -b - Math.sqrt(disc);
	return t > 0 ? t : null;
};

const rayPlaneY = (origin, dir, y) => {
	if (Math.abs(dir[1]) < 1e-6) return null;
	const t = (y - origin[1]) / dir[1];
	return t > 0 ? [origin[0] + dir[0] * t, y, origin[2] + dir[2] * t] : null;
};

// March along the ray until it dips under the height field, then bisect.
const pickSurface = (origin, dir, heightAt, maxT = 300, step = 0.2) => {
	const at = (t) => [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
	const gap = (p) => p[1] - heightAt(p[0], p[2]);
	if (gap(origin) < 0) return null;
	let prev = 0;
	for (let t = step; t < maxT; t += step) {
		if (gap(at(t)) < 0) {
			let lo = prev;
			let hi = t;
			for (let i = 0; i < 30; i++) {
				const mid = (lo + hi) / 2;
				if (gap(at(mid)) < 0) hi = mid;
				else lo = mid;
			}
			return at(hi);
		}
		prev = t;
	}
	return null;
};

const GLSL_HEAD = `#version 300 es
precision highp float;
precision highp int;
const float DEPTH = ${DEPTH.toFixed(4)};
const float HALF = ${HALF.toFixed(4)};
const float FADE_START = ${FADE_START.toFixed(4)};
const float FADE_END = ${FADE_END.toFixed(4)};
const float SHADE_REF = ${SHADE_REF.toFixed(4)};
`;

const GLSL_NOISE = `
float hash13(vec3 p) {
	p = fract(p * 0.1031);
	p += dot(p, p.zyx + 31.32);
	return fract((p.x + p.y) * p.z);
}
float hash12(vec2 p) {
	vec3 q = fract(vec3(p.xyx) * 0.1031);
	q += dot(q, q.yzx + 33.33);
	return fract((q.x + q.y) * q.z);
}
float noise(vec3 x) {
	vec3 i = floor(x);
	vec3 f = fract(x);
	f = f * f * (3.0 - 2.0 * f);
	return mix(
		mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
		mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
		f.z);
}
float fbm(vec3 p) {
	float s = 0.0;
	float a = 0.5;
	for (int i = 0; i < 5; i++) {
		s += a * noise(p);
		p = p * 2.03 + 17.1;
		a *= 0.5;
	}
	return s;
}
`;

const GLSL_PALETTE = `
vec3 palette(float t) {
	vec3 c0 = vec3(0.05, 0.10, 0.32);
	vec3 c1 = vec3(0.10, 0.55, 1.00);
	vec3 c2 = vec3(0.42, 0.28, 1.00);
	vec3 c3 = vec3(1.00, 0.22, 0.75);
	vec3 c4 = vec3(1.00, 0.62, 0.28);
	if (t < 0.18) return mix(c0, c1, t / 0.18);
	if (t < 0.42) return mix(c1, c2, (t - 0.18) / 0.24);
	if (t < 0.68) return mix(c2, c3, (t - 0.42) / 0.26);
	return mix(c3, c4, (t - 0.68) / 0.32);
}
`;

const FULLSCREEN_VS = `${GLSL_HEAD}
out vec2 vUv;
void main() {
	vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
	vUv = p;
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const SKY_FS = `${GLSL_HEAD}${GLSL_NOISE}
in vec2 vUv;
uniform mat4 uInvViewProj;
uniform float uTime;
out vec4 outColor;

vec3 stars(vec3 d, float scale, float density, float size) {
	vec3 c = floor(d * scale);
	float h = hash13(c);
	if (h < 1.0 - density) return vec3(0.0);
	vec3 o = vec3(hash13(c + 17.1), hash13(c + 31.7), hash13(c + 47.3)) * 0.6 + 0.2;
	float dist = length(d - normalize(c + o)) * scale;
	float twinkle = 0.65 + 0.35 * sin(uTime * (0.8 + h * 3.0) + h * 60.0);
	vec3 tint = mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.82, 0.62), hash13(c + 5.0));
	return tint * exp(-dist * dist / (size * size)) * twinkle * (0.4 + 1.6 * fract(h * 13.0));
}

void main() {
	vec2 ndc = vUv * 2.0 - 1.0;
	vec4 a = uInvViewProj * vec4(ndc, -1.0, 1.0);
	vec4 b = uInvViewProj * vec4(ndc, 1.0, 1.0);
	vec3 d = normalize(b.xyz / b.w - a.xyz / a.w);

	vec3 bandN = normalize(vec3(0.35, 1.0, -0.25));
	float band = exp(-pow(dot(d, bandN) * 2.2, 2.0));
	float n1 = fbm(d * 3.0 + 3.1);
	float n2 = fbm(d * 6.0 - 1.7);
	float lanes = smoothstep(0.32, 0.62, fbm(d * 9.0 + 5.0));
	vec3 neb = mix(vec3(0.03, 0.07, 0.20), vec3(0.26, 0.05, 0.24), smoothstep(0.35, 0.7, n2));
	neb *= pow(n1, 2.6) * 1.1 * band * (0.35 + 0.65 * lanes);
	neb += vec3(0.004, 0.006, 0.016) * (0.6 + 0.4 * d.y);

	vec3 col = neb;
	col += stars(d, 160.0, 0.035, 0.11) * 0.7;
	col += stars(d, 70.0, 0.025, 0.09) * 1.2 * (0.5 + band);
	outColor = vec4(col, 1.0);
}`;

const SHEET_VS = `${GLSL_HEAD}
layout(location = 0) in vec2 aFlat;
uniform mat4 uViewProj;
uniform vec4 uBodies[8];
uniform int uCount;
uniform float uLift;
uniform sampler2D uWave;
out vec3 vWorld;
out vec2 vFlat;
out float vWave;

float well(vec2 p) {
	float h = 0.0;
	for (int i = 0; i < 8; i++) {
		if (i >= uCount) break;
		vec4 b = uBodies[i];
		vec2 d = p - b.xy;
		h -= DEPTH * b.z * inversesqrt(1.0 + dot(d, d) / (b.w * b.w));
	}
	return h;
}

void main() {
	float w = textureLod(uWave, (aFlat + HALF) / (2.0 * HALF), 0.0).r;
	vWave = w;
	vFlat = aFlat;
	vWorld = vec3(aFlat.x, well(aFlat) + w - uLift, aFlat.y);
	gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

const SHEET_FS = `${GLSL_HEAD}${GLSL_PALETTE}
in vec3 vWorld;
in vec2 vFlat;
in float vWave;
uniform vec3 uEye;
uniform vec4 uLights[4];
uniform vec3 uLightColors[4];
uniform int uLightCount;
out vec4 outColor;

float gridAA(vec2 p, float width) {
	vec2 fw = fwidth(p);
	vec2 g = abs(fract(p - 0.5) - 0.5) / fw;
	float line = 1.0 - clamp(min(g.x, g.y) / width, 0.0, 1.0);
	return line * (1.0 - smoothstep(0.25, 0.6, max(fw.x, fw.y)));
}

void main() {
	float r = length(vFlat);
	float reach = mix(max(abs(vFlat.x), abs(vFlat.y)), length(vFlat), 0.5);
	float edge = pow(1.0 - smoothstep(FADE_START, FADE_END, reach), 2.2);
	float t = pow(clamp(-vWorld.y / SHADE_REF, 0.0, 1.0), 0.75);
	vec3 pal = palette(t);

	vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
	vec3 v = normalize(uEye - vWorld);
	if (dot(n, v) < 0.0) n = -n;
	float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);

	vec3 lit = vec3(0.0);
	for (int i = 0; i < 4; i++) {
		if (i >= uLightCount) break;
		vec3 d = uLights[i].xyz - vWorld;
		float dd = dot(d, d);
		float ndl = max(dot(n, d * inversesqrt(dd)), 0.0);
		lit += uLightColors[i] * uLights[i].w * (0.3 + 0.7 * ndl) / (1.0 + dd * 0.05);
	}

	float major = gridAA(vFlat, 1.25);
	float minor = gridAA(vFlat * 4.0, 1.0) * 0.2;
	float wave = clamp(abs(vWave) * 3.0, 0.0, 1.0);
	vec3 lines = pal * (major + minor) * (1.2 + wave * 3.0) + (major + minor) * lit * 2.2;
	vec3 base = vec3(0.004, 0.006, 0.018) + pal * (0.025 + fres * 0.14) + lit * 0.06;
	outColor = vec4(base + lines, edge * mix(0.9, 0.32, t));
}`;

const BILLBOARD_VS = `${GLSL_HEAD}
layout(location = 0) in vec2 aCorner;
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uSize;
uniform int uFlat;
out vec3 vPos;
out vec2 vCorner;
void main() {
	vCorner = aCorner;
	vec3 offset = uFlat == 1 ? vec3(aCorner.x, 0.0, aCorner.y) : uRight * aCorner.x + uUp * aCorner.y;
	vPos = uCenter + offset * uSize;
	gl_Position = uViewProj * vec4(vPos, 1.0);
}`;

// Ray-traced spheres on a camera-facing quad. Writing gl_FragDepth makes them cut
// cleanly into the sheet.
const BODY_FS = `${GLSL_HEAD}${GLSL_NOISE}
in vec3 vPos;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform vec3 uCenter;
uniform float uRadius;
uniform int uKind;
uniform vec3 uHue;
uniform vec3 uLightPos;
uniform float uTime;
out vec4 outColor;

void main() {
	vec3 rd = normalize(vPos - uEye);
	vec3 oc = uEye - uCenter;
	float b = dot(oc, rd);
	float h = b * b - (dot(oc, oc) - uRadius * uRadius);
	if (h < 0.0) discard;
	vec3 p = uEye + rd * (-b - sqrt(h));
	vec3 n = (p - uCenter) / uRadius;
	vec4 clip = uViewProj * vec4(p, 1.0);
	gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
	float mu = max(dot(n, -rd), 0.0);

	vec3 col = vec3(0.0);
	if (uKind == 0) {
		float a = uTime * 0.12;
		vec3 q = n * 3.2;
		q.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * q.xz;
		float g = fbm(q + vec3(0.0, uTime * 0.18, 0.0));
		float cells = fbm(q * 2.6 - uTime * 0.08);
		vec3 hot = vec3(1.0, 0.93, 0.78);
		vec3 warm = vec3(1.0, 0.46, 0.12);
		col = mix(warm, hot, smoothstep(0.35, 0.72, g)) * (0.5 + 0.5 * cells);
		col *= pow(mu, 0.45) * 2.6;
		col += vec3(1.0, 0.35, 0.08) * pow(1.0 - mu, 3.0) * 2.0;
	} else if (uKind == 1) {
		vec3 L = normalize(uLightPos - p);
		float diff = max(dot(n, L), 0.0);
		float bands = fbm(vec3(n.y * 7.0, (n.x + n.z) * 1.3, uTime * 0.03));
		vec3 albedo = mix(uHue * 0.25, uHue, smoothstep(0.3, 0.75, bands));
		col = albedo * (0.06 + diff * 1.6);
		float rim = pow(1.0 - mu, 2.5);
		col += uHue * rim * (0.25 + 2.2 * max(dot(n, L) + 0.35, 0.0));
	}
	outColor = vec4(col, 1.0);
}`;

const GLOW_FS = `${GLSL_HEAD}${GLSL_NOISE}
in vec3 vPos;
in vec2 vCorner;
uniform int uKind;
uniform float uRatio;
uniform vec3 uEye;
uniform float uTime;
uniform float uGain;
out vec4 outColor;

void main() {
	float q = length(vCorner) * uRatio;
	float fadeOut = 1.0 - smoothstep(uRatio * 0.6, uRatio, q);
	vec3 col = vec3(0.0);
	if (uKind == 0) {
		vec2 d = vCorner / max(length(vCorner), 1e-4);
		float rays = pow(noise(vec3(d * 4.0, q * 0.6 - uTime * 0.35)), 3.0) * 2.2;
		float halo = exp(-max(q - 1.0, 0.0) * 1.3);
		col = vec3(1.0, 0.5, 0.18) * (halo * 1.3 + rays * exp(-max(q - 1.0, 0.0) * 0.6)) * fadeOut;
	} else if (uKind == 2) {
		float ring = exp(-pow((q - 1.45) * 5.0, 2.0));
		col = (vec3(1.0, 0.72, 0.42) * ring * 3.5 + vec3(0.55, 0.3, 1.0) * exp(-max(q - 1.0, 0.0) * 1.2) * 0.25) * fadeOut;
	} else {
		float inner = 1.6;
		if (q < inner * 0.85 || q > uRatio) discard;
		float ang = atan(vCorner.y, vCorner.x);
		float spin = ang - uTime * 3.0 / pow(q, 1.5);
		vec2 pr = vec2(cos(spin), sin(spin)) * q;
		float n = fbm(vec3(pr * 1.4, q * 2.5));
		float profile = smoothstep(inner * 0.85, inner * 1.25, q) * exp(-(q - inner) * 0.42) * fadeOut;
		vec3 tangent = vec3(-sin(ang), 0.0, cos(ang));
		float doppler = 1.0 + 0.75 * dot(tangent, normalize(uEye - vPos));
		vec3 hot = mix(vec3(1.0, 0.45, 0.15), vec3(1.0, 0.92, 0.82), exp(-(q - inner) * 0.55));
		col = hot * profile * (0.25 + 1.8 * n * n) * doppler * 1.4;
	}
	outColor = vec4(col * uGain, 1.0);
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
	gl_PointSize = clamp(uSize * uPixels / clip.w, 1.5, 64.0);
	vValue = aPoint.w;
}`;

const POINTS_FS = `${GLSL_HEAD}
in float vValue;
uniform int uMode;
uniform vec3 uTint;
uniform float uGain;
out vec4 outColor;
void main() {
	vec2 d = gl_PointCoord - 0.5;
	float r2 = dot(d, d) * 4.0;
	if (r2 > 1.0) discard;
	float a = exp(-r2 * 3.5);
	vec3 c = uMode == 0 ? mix(vec3(1.0, 0.45, 0.2), vec3(0.45, 0.75, 1.0), clamp(vValue, 0.0, 1.0)) : uTint;
	outColor = vec4(c * a * uGain, 1.0);
}`;

const LINES_VS = `${GLSL_HEAD}
layout(location = 0) in vec4 aPoint;
uniform mat4 uViewProj;
out float vAlpha;
void main() {
	gl_Position = uViewProj * vec4(aPoint.xyz, 1.0);
	vAlpha = aPoint.w;
}`;

const LINES_FS = `${GLSL_HEAD}
in float vAlpha;
uniform vec3 uTint;
out vec4 outColor;
void main() {
	outColor = vec4(uTint * vAlpha, 1.0);
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

// Black holes bend the finished frame: a pixel at distance r from the hole shows
// what sits at r - E^2 / r, the point-lens equation, which draws the Einstein ring.
const COMPOSITE_FS = `${GLSL_HEAD}${GLSL_NOISE}
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform vec4 uLens[4];
uniform int uLensCount;
uniform float uTime;
uniform float uBloomGain;
out vec4 outColor;

vec3 aces(vec3 x) {
	return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
	vec2 px = vUv * uRes;
	for (int i = 0; i < 4; i++) {
		if (i >= uLensCount) break;
		vec2 d = px - uLens[i].xy;
		float r = max(length(d), 1e-3);
		px = uLens[i].xy + d / r * (r - uLens[i].z / r);
	}
	vec2 uv = clamp(px / uRes, 0.0, 1.0);
	vec2 cd = vUv - 0.5;
	vec2 ca = cd * dot(cd, cd) * 0.006;
	vec3 col = vec3(texture(uScene, uv + ca).r, texture(uScene, uv).g, texture(uScene, uv - ca).b);
	col += texture(uBloom, uv).rgb * uBloomGain;
	col = aces(col * 1.05);
	float vig = 1.0 - smoothstep(0.35, 1.15, length(cd * vec2(uRes.x / uRes.y, 1.0)) * 0.95);
	col *= mix(0.5, 1.0, vig);
	col = pow(col, vec3(1.0 / 2.2));
	col += (hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.028;
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
	const fmt = hdr
		? { internal: gl.RGBA16F, type: gl.HALF_FLOAT }
		: { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };

	const progs = {
		sky: program(FULLSCREEN_VS, SKY_FS),
		sheet: program(SHEET_VS, SHEET_FS),
		body: program(BILLBOARD_VS, BODY_FS),
		glow: program(BILLBOARD_VS, GLOW_FS),
		points: program(POINTS_VS, POINTS_FS),
		lines: program(LINES_VS, LINES_FS),
		down: program(FULLSCREEN_VS, DOWN_FS),
		up: program(FULLSCREEN_VS, UP_FS),
		composite: program(FULLSCREEN_VS, COMPOSITE_FS),
	};

	const vertexArray = (data, size, usage = gl.STATIC_DRAW) => {
		const vao = gl.createVertexArray();
		const buf = gl.createBuffer();
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, data, usage);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, size, gl.FLOAT, false, 0, 0);
		return { vao, buf };
	};

	const sheetVerts = new Float32Array((MESH_N + 1) ** 2 * 2);
	for (let j = 0, k = 0; j <= MESH_N; j++) {
		for (let i = 0; i <= MESH_N; i++) {
			sheetVerts[k++] = -EXTENT + (2 * EXTENT * i) / MESH_N;
			sheetVerts[k++] = -EXTENT + (2 * EXTENT * j) / MESH_N;
		}
	}
	// The same quads twice: first in rows along z, then in columns along x, so the sheet can
	// be drawn back to front from whichever side the camera is on.
	const quadsPerLine = MESH_N * 6;
	const sheetIdx = new Uint32Array(quadsPerLine * MESH_N * 2);
	let written = 0;
	const pushQuad = (i, j) => {
		const a = j * (MESH_N + 1) + i;
		const b = a + MESH_N + 1;
		sheetIdx.set([a, b, a + 1, a + 1, b, b + 1], written);
		written += 6;
	};
	for (let j = 0; j < MESH_N; j++) for (let i = 0; i < MESH_N; i++) pushQuad(i, j);
	for (let i = 0; i < MESH_N; i++) for (let j = 0; j < MESH_N; j++) pushQuad(i, j);
	const sheet = vertexArray(sheetVerts, 2);
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sheetIdx, gl.STATIC_DRAW);

	const quad = vertexArray(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), 2);
	const dustData = new Float32Array(DUST * 4);
	const dustVa = vertexArray(dustData, 4, gl.DYNAMIC_DRAW);
	const moonData = new Float32Array(8);
	const moonVa = vertexArray(moonData, 4, gl.DYNAMIC_DRAW);
	const trailData = new Float32Array(TRAIL * 4);
	const trailVa = vertexArray(trailData, 4, gl.DYNAMIC_DRAW);
	const emptyVao = gl.createVertexArray();
	gl.bindVertexArray(null);

	const waveH = new Float32Array(WAVE_N * WAVE_N);
	const waveV = new Float32Array(WAVE_N * WAVE_N);
	const waveTex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, waveTex);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, WAVE_N, WAVE_N, 0, gl.RED, gl.FLOAT, waveH);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

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
	const releaseTargets = () => {
		if (!targets) return;
		gl.deleteFramebuffer(targets.msaa);
		targets.renderbuffers.forEach((rb) => gl.deleteRenderbuffer(rb));
		[targets.scene, ...targets.bloom].forEach((t) => {
			gl.deleteFramebuffer(t.fbo);
			gl.deleteTexture(t.tex);
		});
	};

	const buildTargets = (w, h) => {
		releaseTargets();
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

	const cam = { yaw: 0.6, pitch: 0.62, dist: 28, target: [0, -2.5, 0] };
	const view = { eye: [0, 0, 0], viewProj: null, invViewProj: null, right: [1, 0, 0], up: [0, 1, 0], pixels: 1 };

	const resize = () => {
		const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
		const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
		if (targets && targets.w === w && targets.h === h) return;
		canvas.width = w;
		canvas.height = h;
		buildTargets(w, h);
	};

	const updateCamera = () => {
		// The field of view is vertical, so portrait screens need to back off to fit the sheet's width.
		const dist = cam.dist * Math.max(1, 1.3 / (targets.w / targets.h));
		const cp = Math.cos(cam.pitch);
		const eye = [
			cam.target[0] + dist * cp * Math.sin(cam.yaw),
			cam.target[1] + dist * Math.sin(cam.pitch),
			cam.target[2] + dist * cp * Math.cos(cam.yaw),
		];
		// Never let a low, close camera slip under the sheet.
		eye[1] = Math.max(eye[1], surfaceAt(eye[0], eye[2]) + 1.2);
		const v = lookAt(eye, cam.target, [0, 1, 0]);
		const p = perspective(FOV, targets.w / targets.h, 0.1, 400);
		view.eye = eye;
		view.viewProj = multiply(p, v);
		view.invViewProj = invert(view.viewProj);
		view.right = [v[0], v[4], v[8]];
		view.up = [v[1], v[5], v[9]];
		view.pixels = (targets.h / 2) / Math.tan(FOV / 2);
	};

	const bodies = [];
	// Only planets show a hue, so only planets take one from the cycle.
	const HUES = [[0.75, 0.45, 1.0], [0.3, 1.0, 0.65], [0.25, 0.75, 1.0], [1.0, 0.55, 0.35], [1.0, 0.4, 0.7]];
	let hueIndex = 0;

	const radiusOf = (b) => KINDS[b.kind].radius(b.mass);
	let sheetLift = 0;
	const surfaceAt = (x, z) => wellHeight(bodies, x, z) + sampleWave(waveH, x, z) - sheetLift;

	const addBody = (props) => {
		if (bodies.length >= MAX_BODIES) return null;
		const b = {
			vx: 0,
			vz: 0,
			hue: props.kind === 'planet' ? HUES[hueIndex++ % HUES.length] : HUES[0],
			...props,
			target: props.mass,
			soften: KINDS[props.kind].soften,
			y: 0,
			ax: 0,
			az: 0,
		};
		bodies.push(b);
		return b;
	};

	const removeBody = (b) => {
		if (bodies.length > 1) bodies.splice(bodies.indexOf(b), 1);
	};

	const kick = (x, z, amount) => {
		const ci = Math.round((x + HALF) / WAVE_CELL - 0.5);
		const cj = Math.round((z + HALF) / WAVE_CELL - 0.5);
		const reach = 4;
		for (let j = cj - reach; j <= cj + reach; j++) {
			for (let i = ci - reach; i <= ci + reach; i++) {
				if (i < 1 || j < 1 || i >= WAVE_N - 1 || j >= WAVE_N - 1) continue;
				const wx = -HALF + (i + 0.5) * WAVE_CELL - x;
				const wz = -HALF + (j + 0.5) * WAVE_CELL - z;
				waveV[j * WAVE_N + i] += amount * Math.exp(-(wx * wx + wz * wz) / 0.35);
			}
		}
	};

	const heaviest = () => bodies.reduce((a, b) => (b.mass > a.mass ? b : a));

	// Orbit the body that pulls hardest at this point, so new things settle into orbits.
	const orbitVelocity = (x, z, skip) => {
		let host = null;
		let best = 0;
		for (const b of bodies) {
			if (b === skip) continue;
			const d2 = (b.x - x) ** 2 + (b.z - z) ** 2 + b.soften ** 2;
			const pull = b.mass / d2;
			if (pull > best) {
				best = pull;
				host = b;
			}
		}
		if (!host) return [0, 0];
		const dx = x - host.x;
		const dz = z - host.z;
		const r = Math.hypot(dx, dz) || 1;
		const v = circularSpeed(host.mass, host.soften, r);
		return [host.vx - (dz / r) * v, host.vz + (dx / r) * v];
	};

	const dust = new Float32Array(DUST * 4);
	const placeOrbiter = (arr, k, rMin, rMax) => {
		const host = heaviest();
		const R = radiusOf(host);
		const r = Math.max(R * 1.8, rMin) + (rMax - rMin) * Math.random() ** 0.8;
		const a = Math.random() * Math.PI * 2;
		const v = circularSpeed(host.mass, host.soften, r) * (0.97 + Math.random() * 0.06);
		arr[k] = host.x + Math.cos(a) * r;
		arr[k + 1] = host.z + Math.sin(a) * r;
		arr[k + 2] = host.vx - Math.sin(a) * v;
		arr[k + 3] = host.vz + Math.cos(a) * v;
	};

	const MOON_TINTS = [[0.6, 1.4, 1.6], [1.6, 0.8, 1.4]];
	const moons = MOON_TINTS.map((tint) => ({ s: new Float32Array(4), tint, trail: [], fade: 1, leaving: false }));

	const stepOrbiter = (s, k, h) => {
		const [ax, az] = gravityAt(bodies, s[k], s[k + 1]);
		s[k + 2] += ax * h;
		s[k + 3] += az * h;
		s[k] += s[k + 2] * h;
		s[k + 1] += s[k + 3] * h;
	};

	const swallowed = (x, z) => {
		for (const b of bodies) {
			const R = radiusOf(b);
			if ((x - b.x) ** 2 + (z - b.z) ** 2 < R * R) return true;
		}
		return Math.max(Math.abs(x), Math.abs(z)) > HALF + 1;
	};

	let drag = null;

	const simulate = (dt) => {
		for (const b of bodies) {
			if (Math.abs(b.target - b.mass) > 1e-3) b.mass += (b.target - b.mass) * 0.12;
		}

		const h = dt / SUBSTEPS;
		for (let s = 0; s < SUBSTEPS; s++) {
			for (const b of bodies) [b.ax, b.az] = gravityAt(bodies, b.x, b.z, b);
			for (const b of bodies) {
				if (drag?.body === b) continue;
				b.vx += b.ax * h;
				b.vz += b.az * h;
				b.x += b.vx * h;
				b.z += b.vz * h;
				bounceInSquare(b, WALL);
			}
			for (let k = 0; k < DUST * 4; k += 4) stepOrbiter(dust, k, h);
			for (const m of moons) stepOrbiter(m.s, 0, h);
		}

		if (drag?.body) {
			const b = drag.body;
			const px = b.x;
			const pz = b.z;
			b.x += (drag.tx - b.x) * 0.4;
			b.z += (drag.tz - b.z) * 0.4;
			const vx = (b.x - px) / dt;
			const vz = (b.z - pz) / dt;
			b.vx += (vx - b.vx) * 0.5;
			b.vz += (vz - b.vz) * 0.5;
			const speed = Math.hypot(vx, vz);
			if (speed > 1) kick(b.x, b.z, -0.0035 * Math.min(speed, 40) * b.mass);
		}

		for (let i = 0; i < bodies.length; i++) {
			for (let j = i + 1; j < bodies.length; j++) {
				const a = bodies[i];
				const b = bodies[j];
				const reach = (radiusOf(a) + radiusOf(b)) * 0.75;
				if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 > reach * reach) continue;
				const merged = mergeBodies(a, b);
				const keep = a.mass >= b.mass ? a : b;
				Object.assign(keep, merged, { target: clampMass(merged.kind, merged.mass), soften: KINDS[merged.kind].soften });
				keep.mass = clampMass(keep.kind, keep.mass);
				if (drag?.body === a || drag?.body === b) drag = null;
				bodies.splice(bodies.indexOf(keep === a ? b : a), 1);
				kick(keep.x, keep.z, -2.2);
				j = bodies.length;
				i = bodies.length;
			}
		}

		for (const b of bodies) {
			const a = Math.hypot(b.ax, b.az);
			if (a > 0.5) kick(b.x, b.z, -0.00028 * b.mass * Math.min(a, 60));
		}
		stepWaves(waveH, waveV, WAVE_N);
		stepWaves(waveH, waveV, WAVE_N);

		const host = heaviest();
		const lost = (x, z, leash) => swallowed(x, z) || (x - host.x) ** 2 + (z - host.z) ** 2 > leash * leash;
		for (let k = 0; k < DUST * 4; k += 4) {
			if (lost(dust[k], dust[k + 1], DUST_LEASH)) placeOrbiter(dust, k, ...DUST_SPREAD);
		}
		// A moon that hits a body falls in with a ripple; one flung too far fades out first.
		// Either way the new moon fades in, so it reads as a new moon and not a jump.
		for (const m of moons) {
			const hit = swallowed(m.s[0], m.s[1]);
			if (hit) kick(m.s[0], m.s[1], -0.6);
			if (!hit && !m.leaving && lost(m.s[0], m.s[1], MOON_LEASH)) m.leaving = true;
			m.fade = stepFade(m.fade, m.leaving, dt);
			if (hit || (m.leaving && m.fade === 0)) {
				placeOrbiter(m.s, 0, 4, 7);
				m.trail.length = 0;
				m.fade = 0;
				m.leaving = false;
			}
		}
	};

	const LIGHT_COLORS = { star: [1.0, 0.55, 0.25], hole: [1.0, 0.6, 0.35] };

	const draw = (time) => {
		sheetLift = farFieldLevel(bodies);
		updateCamera();
		const { w, h } = targets;
		const vp = view.viewProj;

		for (const b of bodies) b.y = restingHeight(surfaceAt, b.x, b.z, radiusOf(b));
		for (let k = 0, o = 0; k < DUST * 4; k += 4, o += 4) {
			const x = dust[k];
			const z = dust[k + 1];
			dustData[o] = x;
			dustData[o + 1] = surfaceAt(x, z) + 0.05;
			dustData[o + 2] = z;
			dustData[o + 3] = Math.hypot(dust[k + 2], dust[k + 3]) / 16;
		}
		moons.forEach((m, i) => {
			const y = surfaceAt(m.s[0], m.s[1]) + 0.18;
			moonData.set([m.s[0], y, m.s[1], 1], i * 4);
			m.trail.unshift([m.s[0], y, m.s[1]]);
			if (m.trail.length > TRAIL) m.trail.pop();
		});

		const bodyUniform = new Float32Array(32);
		bodies.forEach((b, i) => bodyUniform.set([b.x, b.z, b.mass, b.soften], i * 4));
		const lights = bodies.filter((b) => b.kind !== 'planet').slice(0, 4);
		const lightUniform = new Float32Array(16);
		const lightColorUniform = new Float32Array(12);
		lights.forEach((b, i) => {
			lightUniform.set([b.x, b.y, b.z, b.kind === 'star' ? Math.sqrt(b.mass) : 0.6 * Math.sqrt(b.mass)], i * 4);
			lightColorUniform.set(LIGHT_COLORS[b.kind], i * 3);
		});

		gl.bindTexture(gl.TEXTURE_2D, waveTex);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WAVE_N, WAVE_N, gl.RED, gl.FLOAT, waveH);

		gl.bindFramebuffer(gl.FRAMEBUFFER, targets.msaa);
		gl.viewport(0, 0, w, h);
		gl.clearColor(0, 0, 0, 1);
		// clear() obeys depthMask, which the previous frame left off.
		gl.depthMask(true);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		gl.disable(gl.DEPTH_TEST);
		gl.depthMask(false);
		gl.disable(gl.BLEND);
		gl.useProgram(progs.sky.p);
		gl.uniformMatrix4fv(progs.sky.u.uInvViewProj, false, view.invViewProj);
		gl.uniform1f(progs.sky.u.uTime, time);
		gl.bindVertexArray(emptyVao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);

		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(true);
		const billboard = (pr, center, size, flat) => {
			gl.uniformMatrix4fv(pr.u.uViewProj, false, vp);
			gl.uniform3fv(pr.u.uCenter, center);
			gl.uniform3fv(pr.u.uRight, view.right);
			gl.uniform3fv(pr.u.uUp, view.up);
			gl.uniform1f(pr.u.uSize, size);
			gl.uniform1i(pr.u.uFlat, flat ? 1 : 0);
		};
		const KIND_ID = { star: 0, planet: 1, hole: 2 };
		gl.useProgram(progs.body.p);
		gl.bindVertexArray(quad.vao);
		for (const b of bodies) {
			const R = radiusOf(b);
			const center = [b.x, b.y, b.z];
			const light = lights.reduce((best, l) => {
				const d = (l.x - b.x) ** 2 + (l.z - b.z) ** 2;
				return d < best.d ? { d, l } : best;
			}, { d: Infinity, l: null }).l;
			billboard(progs.body, center, R * 1.35, false);
			gl.uniform3fv(progs.body.u.uEye, view.eye);
			gl.uniform1f(progs.body.u.uRadius, R);
			gl.uniform1i(progs.body.u.uKind, KIND_ID[b.kind]);
			gl.uniform3fv(progs.body.u.uHue, b.hue);
			gl.uniform3fv(progs.body.u.uLightPos, light ? [light.x, light.y, light.z] : [0, 30, 0]);
			gl.uniform1f(progs.body.u.uTime, time);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		}

		gl.enable(gl.BLEND);
		gl.depthMask(false);
		gl.blendFunc(gl.ONE, gl.ONE);
		gl.useProgram(progs.glow.p);
		const glow = (b, kind, ratio, flat, gain) => {
			const R = radiusOf(b);
			billboard(progs.glow, [b.x, b.y, b.z], R * ratio, flat);
			gl.uniform1i(progs.glow.u.uKind, kind);
			gl.uniform1f(progs.glow.u.uRatio, ratio);
			gl.uniform3fv(progs.glow.u.uEye, view.eye);
			gl.uniform1f(progs.glow.u.uTime, time);
			gl.uniform1f(progs.glow.u.uGain, gain);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		};
		for (const b of bodies) if (b.kind === 'hole') glow(b, 3, 7, true, 1);

		// The sheet is translucent, so it must not hide its own far side: no depth writes,
		// and bands are drawn far to near so nearer slopes blend over farther ones.
		gl.depthMask(false);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.useProgram(progs.sheet.p);
		gl.uniformMatrix4fv(progs.sheet.u.uViewProj, false, vp);
		gl.uniform4fv(progs.sheet.u.uBodies, bodyUniform);
		gl.uniform1i(progs.sheet.u.uCount, bodies.length);
		gl.uniform1f(progs.sheet.u.uLift, sheetLift);
		gl.uniform3fv(progs.sheet.u.uEye, view.eye);
		gl.uniform4fv(progs.sheet.u.uLights, lightUniform);
		gl.uniform3fv(progs.sheet.u.uLightColors, lightColorUniform);
		gl.uniform1i(progs.sheet.u.uLightCount, lights.length);
		gl.uniform1i(progs.sheet.u.uWave, 0);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, waveTex);
		gl.bindVertexArray(sheet.vao);
		const order = sheetDrawOrder(view.eye, cam.target);
		const base = order.axis === 'z' ? 0 : quadsPerLine * MESH_N;
		const bands = MESH_N / SHEET_BAND;
		for (let n = 0; n < bands; n++) {
			const band = order.ascending ? n : bands - 1 - n;
			const first = base + band * SHEET_BAND * quadsPerLine;
			gl.drawElements(gl.TRIANGLES, SHEET_BAND * quadsPerLine, gl.UNSIGNED_INT, first * 4);
		}
		// Depth only, after the color: dust, moons and trails behind a slope stay hidden.
		gl.colorMask(false, false, false, false);
		gl.depthMask(true);
		gl.drawElements(gl.TRIANGLES, quadsPerLine * MESH_N, gl.UNSIGNED_INT, 0);
		gl.colorMask(true, true, true, true);

		// Halos skip the depth test so their light spills over the rim of the well.
		gl.depthMask(false);
		gl.disable(gl.DEPTH_TEST);
		gl.blendFunc(gl.ONE, gl.ONE);
		gl.useProgram(progs.glow.p);
		gl.bindVertexArray(quad.vao);
		for (const b of bodies) {
			if (b.kind === 'star') glow(b, 0, 5, false, 0.35);
			if (b.kind === 'hole') glow(b, 2, 3, false, 1);
		}
		gl.enable(gl.DEPTH_TEST);

		gl.useProgram(progs.points.p);
		gl.uniformMatrix4fv(progs.points.u.uViewProj, false, vp);
		gl.uniform1f(progs.points.u.uPixels, view.pixels);
		gl.uniform1i(progs.points.u.uMode, 0);
		gl.uniform1f(progs.points.u.uSize, 0.12);
		gl.uniform1f(progs.points.u.uGain, 1.6);
		gl.bindVertexArray(dustVa.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, dustVa.buf);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, dustData);
		gl.drawArrays(gl.POINTS, 0, DUST);

		gl.useProgram(progs.lines.p);
		gl.uniformMatrix4fv(progs.lines.u.uViewProj, false, vp);
		gl.bindVertexArray(trailVa.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, trailVa.buf);
		for (const m of moons) {
			const n = m.trail.length;
			if (n < 2) continue;
			m.trail.forEach((p, i) => trailData.set([p[0], p[1], p[2], (1 - i / n) ** 1.5], i * 4));
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, trailData, 0, n * 4);
			gl.uniform3fv(progs.lines.u.uTint, m.tint.map((c) => c * m.fade));
			gl.drawArrays(gl.LINE_STRIP, 0, n);
		}

		gl.useProgram(progs.points.p);
		gl.uniform1i(progs.points.u.uMode, 1);
		gl.uniform1f(progs.points.u.uSize, 0.55);
		gl.uniform1f(progs.points.u.uGain, 2.2);
		gl.bindVertexArray(moonVa.vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, moonVa.buf);
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, moonData);
		moons.forEach((m, i) => {
			gl.uniform3fv(progs.points.u.uTint, m.tint.map((c) => c * m.fade));
			gl.uniform1f(progs.points.u.uSize, 0.55 * (0.4 + 0.6 * m.fade));
			gl.drawArrays(gl.POINTS, i, 1);
		});

		gl.disable(gl.DEPTH_TEST);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targets.msaa);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targets.scene.fbo);
		gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);

		gl.bindVertexArray(emptyVao);
		gl.disable(gl.BLEND);
		gl.useProgram(progs.down.p);
		gl.uniform1f(progs.down.u.uThreshold, hdr ? 1.2 : 0.75);
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

		const lens = new Float32Array(16);
		let lensCount = 0;
		for (const b of bodies) {
			if (b.kind !== 'hole' || lensCount >= 4) continue;
			const c = transform(vp, [b.x, b.y, b.z]);
			if (c[3] <= 0.1) continue;
			const R = radiusOf(b);
			const sx = (c[0] / c[3] * 0.5 + 0.5) * w;
			const sy = (c[1] / c[3] * 0.5 + 0.5) * h;
			const rPx = (R * view.pixels) / c[3];
			const einstein = rPx * 2.4;
			lens.set([sx, sy, einstein * einstein, rPx], lensCount++ * 4);
		}

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
		gl.uniform4fv(progs.composite.u.uLens, lens);
		gl.uniform1i(progs.composite.u.uLensCount, lensCount);
		gl.uniform1f(progs.composite.u.uTime, time);
		gl.uniform1f(progs.composite.u.uBloomGain, hdr ? 0.55 : 0.45);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.activeTexture(gl.TEXTURE0);
	};

	const rayAt = (e) => {
		const r = canvas.getBoundingClientRect();
		const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
		const ny = 1 - ((e.clientY - r.top) / r.height) * 2;
		return rayFromNdc(view.invViewProj, nx, ny);
	};

	const bodyUnder = (ray) => {
		let hit = null;
		let best = Infinity;
		for (const b of bodies) {
			const t = raySphere(ray.origin, ray.dir, [b.x, b.y, b.z], radiusOf(b) * 1.4 + 0.3);
			if (t !== null && t < best) {
				best = t;
				hit = b;
			}
		}
		return hit;
	};

	let lastInput = -Infinity;
	const touched = () => {
		lastInput = performance.now();
		hints.classList.add('is-quiet');
	};

	const addAt = (point, kind) => {
		const ray = rayAt(point);
		const p = pickSurface(ray.origin, ray.dir, surfaceAt);
		if (!p || Math.max(Math.abs(p[0]), Math.abs(p[2])) > WALL) return;
		const [vx, vz] = orbitVelocity(p[0], p[2]);
		const added = addBody({ x: p[0], z: p[2], vx, vz, mass: kind === 'hole' ? 1.5 : 0.5, kind });
		if (added) {
			kick(added.x, added.z, -1.6);
			navigator.vibrate?.(12);
		}
	};

	const doubleTap = (point) => {
		const b = bodyUnder(rayAt(point));
		if (b) removeBody(b);
		else addAt(point, point.shiftKey ? 'hole' : 'planet');
	};

	const aim = (e) => {
		const ray = rayAt(e);
		const p = rayPlaneY(ray.origin, ray.dir, drag.body.y);
		if (!p) return;
		const max = WALL;
		drag.tx = Math.min(max, Math.max(-max, p[0] + drag.ox));
		drag.tz = Math.min(max, Math.max(-max, p[2] + drag.oz));
	};

	const endDrag = (throwIt) => {
		if (drag?.body && throwIt) {
			const b = drag.body;
			const speed = Math.hypot(b.vx, b.vz);
			if (speed > 30) {
				b.vx *= 30 / speed;
				b.vz *= 30 / speed;
			}
			kick(b.x, b.z, -0.4 * b.mass);
		}
		drag = null;
		canvas.classList.remove('is-dragging', 'is-orbiting');
	};

	// Pointer events cover mouse, pen and touch alike. dblclick and wheel do not
	// exist on most phones, so taps, long presses and pinches are built here.
	const pointers = new Map();
	let pinch = null;
	let lastTap = null;
	let press = null;

	const pinchState = () => {
		const [a, b] = [...pointers.values()];
		return { mid: { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }, span: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
	};

	canvas.addEventListener('contextmenu', (e) => e.preventDefault());

	canvas.addEventListener('pointerdown', (e) => {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		touched();
		canvas.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false });

		if (pointers.size === 2) {
			clearTimeout(press?.timer);
			press = null;
			endDrag(false);
			const { mid, span } = pinchState();
			const body = bodyUnder(rayAt(mid));
			pinch = { span, body, mass: body?.target, dist: cam.dist };
			return;
		}
		if (pointers.size > 2) return;

		const ray = rayAt(e);
		const b = bodyUnder(ray);
		if (b) {
			const p = rayPlaneY(ray.origin, ray.dir, b.y);
			drag = { body: b, ox: p ? b.x - p[0] : 0, oz: p ? b.z - p[2] : 0, tx: b.x, tz: b.z };
			canvas.classList.add('is-dragging');
			return;
		}
		drag = { body: null, x: e.clientX, y: e.clientY };
		canvas.classList.add('is-orbiting');
		const point = { clientX: e.clientX, clientY: e.clientY };
		press = {
			id: e.pointerId,
			timer: setTimeout(() => {
				press.fired = true;
				endDrag(false);
				addAt(point, 'hole');
			}, LONG_PRESS_MS),
		};
	});

	canvas.addEventListener('pointermove', (e) => {
		const ptr = pointers.get(e.pointerId);
		if (!ptr) {
			if (e.pointerType === 'mouse') canvas.classList.toggle('is-over-body', !!bodyUnder(rayAt(e)));
			return;
		}
		if (Math.hypot(e.clientX - ptr.x, e.clientY - ptr.y) > TAP_SLOP) ptr.moved = true;
		touched();

		if (pinch) {
			ptr.x = e.clientX;
			ptr.y = e.clientY;
			const ratio = pinchState().span / pinch.span;
			if (pinch.body) pinch.body.target = clampMass(pinch.body.kind, pinch.mass * ratio);
			else cam.dist = Math.min(80, Math.max(10, pinch.dist / ratio));
			return;
		}
		if (ptr.moved && press?.id === e.pointerId && !press.fired) {
			clearTimeout(press.timer);
			press = null;
		}
		if (!drag) return;
		if (drag.body) {
			aim(e);
			return;
		}
		cam.yaw -= (e.clientX - drag.x) * 0.005;
		cam.pitch = Math.min(1.45, Math.max(0.08, cam.pitch + (e.clientY - drag.y) * 0.004));
		drag.x = e.clientX;
		drag.y = e.clientY;
	});

	const lift = (e) => {
		const down = pointers.get(e.pointerId);
		if (!down) return;
		pointers.delete(e.pointerId);
		if (pinch) {
			// The finger left on screen should not start orbiting from a stale position.
			if (pointers.size < 2) pinch = null;
			pointers.clear();
			return;
		}
		const longPressed = press?.fired;
		clearTimeout(press?.timer);
		press = null;
		endDrag(e.type === 'pointerup');
		if (e.type !== 'pointerup' || longPressed) return;

		const tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
		if (!isTap(down, tap)) {
			lastTap = null;
			return;
		}
		if (isDoubleTap(lastTap, tap)) {
			lastTap = null;
			doubleTap({ clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey });
		} else {
			lastTap = tap;
		}
	};
	canvas.addEventListener('pointerup', lift);
	canvas.addEventListener('pointercancel', lift);

	canvas.addEventListener('wheel', (e) => {
		e.preventDefault();
		touched();
		const b = bodyUnder(rayAt(e));
		if (b) {
			b.target = clampMass(b.kind, b.target * Math.exp(-e.deltaY * 0.0015));
			return;
		}
		cam.dist = Math.min(80, Math.max(10, cam.dist * Math.exp(e.deltaY * 0.001)));
	}, { passive: false });

	addEventListener('resize', resize);
	resize();

	// Two-body start: star and planet around their shared center of mass.
	const starMass = 1.2;
	const planetMass = 0.4;
	const sep = 9.5;
	const vRel = circularSpeed(starMass + planetMass, KINDS.star.soften, sep);
	const total = starMass + planetMass;
	addBody({ x: (-planetMass / total) * sep, z: 0, vx: 0, vz: (-planetMass / total) * vRel, mass: starMass, kind: 'star' });
	addBody({ x: (starMass / total) * sep, z: 0, vx: 0, vz: (starMass / total) * vRel, mass: planetMass, kind: 'planet' });
	for (let k = 0; k < DUST * 4; k += 4) placeOrbiter(dust, k, ...DUST_SPREAD);
	moons.forEach((m) => placeOrbiter(m.s, 0, 4, 7));

	let last = performance.now();
	let time = 0;
	const frame = (now) => {
		const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000));
		last = now;
		time += dt;
		if (!calm && !drag && now - lastInput > 4000) cam.yaw += dt * 0.035;
		resize();
		simulate(dt);
		draw(time);
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
};

if (typeof document !== 'undefined') boot();
