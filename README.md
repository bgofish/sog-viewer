# SOG Viewer

A single-file browser viewer for 3D Gaussian splat models: SOG (the format
exported by LichtFeld Studio) and standard PLY. No server, no install: open
`index.html` in a browser, pick a local `.sog` or `.ply` file with the Open
button, view it, close it, and pick another one whenever you want.

## Usage

1. Double-click `index.html` (or open it from the file explorer in Chrome/Edge/Firefox).
2. Click **Open SOG or PLY file** (center button or folder icon in the control bar) and choose a `.sog` or `.ply` Gaussian splat file.
3. Navigate: left mouse orbit, right mouse pan, wheel zoom, double-click to set focus, `F` frame scene, `R` reset camera. Orbit/fly toggle, measure, ortho mode, FOV settings and fullscreen all work as in the LichtFeld Studio export.
4. Click the **X** button to close the model, then open another file.

## Building

```sh
node build.mjs
```

`build.mjs` assembles `index.html` from `src/` (a verbatim copy of the
LichtFeld Studio HTML-export viewer resources, plus this repo's modified
template). It inlines the CSS and the JS bundle (gizmo + measure tool
vendored as in the studio export), applies a small set of documented
deltas to `index.js` (deferred model load, `openModel`/`closeModel`,
re-runnable model wiring) and inlines the default settings. Every delta
is asserted to match exactly once; if the upstream bundle changes the
build fails loudly instead of producing a broken viewer.

To refresh the vendored files from a newer LichtFeld Studio checkout,
copy `src/visualizer/gui/resources/viewer/{index.js,index.css,gizmo.js,measure-tool.js}`
over the ones in `src/` and rebuild.

## License

GPLv3 — derived from LichtFeld Studio (MrNeRF/LichtFeld-Studio) and its
PlayCanvas/SuperSplat-based viewer. See `LICENSE`.
