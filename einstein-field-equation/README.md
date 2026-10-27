# Curved Spacetime (WebGL)

An embedding diagram of curved spacetime in raw WebGL 2: no libraries, no build step, no server.

Open `index.html` in a browser that supports WebGL 2.

![Curved Spacetime preview](preview.jpg)

## Screenshots

| Desktop | Black hole | Phone |
|---|---|---|
| ![A star and a planet in their wells, with dust and two moons](screenshots/1-desktop.jpg) | ![A black hole lensing the grid next to the star](screenshots/2-black-hole.jpg) | ![The scene on a phone, with the touch hints](screenshots/3-mobile.jpg) |

## What is on screen

- **The sheet**: a square 400 × 400 mesh that fades out toward its edges so it reads as endless.
  The fade is tuned to be nearly gone where the play area ends, so anywhere the grid shows, you
  can add or move a body. Its height, computed in the vertex shader, is the softened Newtonian
  potential of every body, lifted by however far the edge of the play area has sunk, so flat
  space stays level however heavy the bodies get. Grid lines are drawn in the fragment shader with
  screen-space anti-aliasing and colored by depth, and stars light the grid around them. Being
  translucent, the sheet is drawn far to near in bands without writing depth, so its far side and
  the wells behind a slope stay visible from any angle. A depth-only pass follows, so dust, moons
  and trails behind a slope are still hidden.
- **Ripples**: a damped wave equation runs on a 192 × 192 grid on the CPU and is uploaded each frame
  as a half-float texture. Accelerating, thrown, merging or newly added bodies disturb it.
- **Bodies**: ray-traced spheres on camera-facing quads that write their own depth, so they cut
  cleanly into the sheet. Stars have animated plasma and a corona, planets are lit by the nearest
  star, black holes are black with a photon ring and an accretion disk with Doppler brightening.
- **Orbits**: the bodies pull on each other (N-body), and 1,800 dust grains and two moons with trails
  orbit in the same potential that shapes the sheet. Anything that falls into a body, or is flung
  too far from the heaviest one, comes back in a fresh orbit around it, so the disk never drains. A moon that hits a body falls in
  with a ripple, and its replacement fades in instead of popping up. Bodies that touch merge, conserving momentum and mass (up to the merged kind's cap);
  a black hole always wins.
- **Lensing**: each black hole bends the finished frame with the point-lens equation, which draws an
  Einstein ring and warps the grid and stars behind it.
- **Post-processing**: HDR render target with 4× MSAA, dual-filter bloom, ACES tone mapping,
  slight chromatic aberration, vignette and film grain. Falls back to 8-bit targets when the GPU
  cannot render to float textures.
- **Sky**: procedural stars and a nebula band, fixed in the world so they turn with the camera.

## Controls

Input runs on pointer events, so mouse, pen and touch share the same gestures. The hints at the
bottom switch between mouse and touch wording.

| Mouse | Touch | Effect |
|---|---|---|
| Drag a body | Drag a body | Move it; release while moving to throw it |
| Scroll over a body | Pinch on a body | Change its mass (up to 3 for a planet, 6 for a star, 10 for a black hole) |
| Double-click empty space | Double-tap empty space | Add a planet in orbit (up to 8 bodies) |
| Hold, or Shift + double-click | Hold | Add a black hole |
| Double-click a body | Double-tap a body | Remove it (one always stays) |
| Drag empty space | Drag empty space | Orbit the camera |
| Scroll elsewhere | Pinch elsewhere | Zoom |

The camera drifts slowly after a few seconds without input, unless the system asks for reduced
motion.

## Tests

The CPU math (potential, gravity, circular orbits, merging, waves, matrices, ray picking on the
curved sheet, tap and double-tap detection) is tested with Node's built-in runner, no install needed:

```sh
node --test tests/math.test.mjs
```

Shaders and rendering are checked by eye; there is no automated visual test.

## CodePen

Paste the contents of `<body>` into the HTML panel, `styles.css` into CSS and `script.js` into JS.
The `<meta>` Content Security Policy in `index.html` is for local use only and is not needed there.
