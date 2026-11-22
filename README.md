# Web AI Experiments

A collection of interactive web experiments built with AI assistance, in plain HTML, CSS, and JavaScript.

Each experiment explores an idea from math, physics or computer graphics, lives in its own directory, and can be run independently.

No frameworks. No build tools. No dependencies.

## Live Demos

[Visit Hub Web Page](https://guillhermm.github.io/web-ai-experiments/) to see all experiments.

## Experiments

- **Curved Spacetime**  
  An interactive rubber-sheet picture of gravity in raw WebGL 2, where stars, planets and black holes bend a glowing grid, and dust and moons orbit along the curvature.  
  **Path:** `einstein-field-equation/`

- **The Riemann Hypothesis**  
  Riemann's explicit formula for the primes as a spiral staircase in raw WebGL 2: zeta zeros ripple a smooth ramp until it settles into one glowing step per prime, around the critical line. A slider moves a zero off the line to show what the hypothesis rules out.  
  **Path:** `riemann-hypothesis/`

## Notes

These projects are experimental by nature and are not intended as production-ready components.

The hub links to each folder (`./name/`), never to `./name/index.html`, so the address bar shows the clean URL. `node --test tests/*.mjs` checks that and that every linked folder has a page. Opened straight from disk (`file://`), where no server turns a folder into its `index.html`, `hub.js` points those links at `index.html`. The hub runs under a Content Security Policy (CSP) that allows only its own script, its own styles and images, and Google Fonts.

## License

MIT License - See [LICENSE](LICENSE) file for details.
