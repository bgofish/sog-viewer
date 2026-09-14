import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(root, 'src');
const read = (name) => readFileSync(path.join(srcDir, name), 'utf8');

const replaceOnce = (text, search, replace, label) => {
    for (const nl of ['\n', '\r\n']) {
        const s = search.replaceAll('\n', nl);
        const r = replace.replaceAll('\n', nl);
        const count = text.split(s).length - 1;
        if (count === 1) {
            const i = text.indexOf(s);
            return text.slice(0, i) + r + text.slice(i + s.length);
        }
    }
    throw new Error(`${label}: expected exactly 1 occurrence, not found`);
};

const stripTrailingExport = (code, stmt, label) => {
    const pos = code.lastIndexOf(stmt);
    if (pos === -1) {
        throw new Error(`${label}: trailing export statement not found`);
    }
    return code.slice(0, pos);
};

let js = read('index.js');

js = replaceOnce(js,
    `    // Load model
    const gsplatLoad = loadGsplat(app, config, (progress) => {
        state.progress = progress;
    });`,
    `    // Load model
    const gsplatLoad = config.contents ? loadGsplat(app, config, (progress) => {
        state.progress = progress;
    }) : Promise.resolve(null);`,
    'conditional initial load');

js = replaceOnce(js,
    `        // wait for the model to load
        Promise.all([gsplatLoad, skyboxLoad]).then((results) => {
            const gsplat = results[0].gsplat;`,
    `        this.onModelReady = (gsplatEntity) => {
            if (!gsplatEntity) {
                return;
            }
            this.currentModel = gsplatEntity;
            const gsplat = gsplatEntity.gsplat;`,
    'onModelReady head');

js = replaceOnce(js,
    `                sceneBound.setFromTransformedAabb(gsplatBbox, results[0].getWorldTransform());`,
    `                sceneBound.setFromTransformedAabb(gsplatBbox, gsplatEntity.getWorldTransform());`,
    'onModelReady bbox');

js = replaceOnce(js,
    `            if (!config.noui) {
                this.annotations = new Annotations(global, this.cameraFrame != null);
            }
            this.inputController = new InputController(global);`,
    `            if (!this.annotations && !config.noui) {
                this.annotations = new Annotations(global, this.cameraFrame != null);
            }
            if (!this.inputController) {
                this.inputController = new InputController(global);
            }`,
    'idempotent controllers');

js = replaceOnce(js,
    `                };
                eventHandler.on('frame:ready', readyHandler);
            }
        });
    }
    // configure camera based on application mode and post process settings`,
    `                };
                eventHandler.on('frame:ready', readyHandler);
            }
        };
        Promise.all([gsplatLoad, skyboxLoad]).then(([gsplatEntity]) => {
            this.onModelReady(gsplatEntity);
        });
    }
    // configure camera based on application mode and post process settings`,
    'onModelReady tail');

js = replaceOnce(js,
    `    // Create the viewer
    return new Viewer(global, gsplatLoad, skyboxLoad);
};`,
    `    // Create the viewer
    const viewer = new Viewer(global, gsplatLoad, skyboxLoad);
    viewer.openModel = (url, filename) => loadGsplat(app, {
        contents: fetch(url),
        contentUrl: filename || url
    }, (progress) => {
        state.progress = progress;
    }).then((entity) => {
        viewer.onModelReady(entity);
        return entity;
    });
    viewer.closeModel = () => {
        const model = viewer.currentModel;
        if (!model) {
            return;
        }
        viewer.currentModel = null;
        const assetId = model.gsplat && model.gsplat.asset;
        const asset = assetId != null ? app.assets.get(assetId) : null;
        model.destroy();
        if (asset) {
            app.assets.remove(asset);
            asset.unload();
        }
        viewer.cameraManager = null;
        viewer.annotations = null;
        state.readyToRender = true;
        app.renderNextFrame = true;
    };
    return viewer;
};`,
    'openModel/closeModel');

js = replaceOnce(js,
    `            // update animation timeline
            if (state.cameraMode === 'anim') {
                state.animationTime = controllers.anim.animState.cursor.value;
            }
        };
        // handle input events`,
    `            // update animation timeline
            if (state.cameraMode === 'anim') {
                state.animationTime = controllers.anim.animState.cursor.value;
            }
        };
        // Swap in a freshly-built anim track (e.g. from the read-json-tool)
        // as the live 'anim' controller. Reuses the same cameraMode/
        // transition machinery as the built-in animTracks path instead of
        // duplicating it: assigning state.cameraMode fires the
        // 'cameraMode:changed' handler below, which calls onEnter() on
        // whatever controllers.anim currently points at and resets the
        // transition timer.
        this.loadAnimTrack = (track) => {
            controllers.anim = new AnimController(track);
            state.hasAnimation = true;
            state.animationDuration = controllers.anim.animState.cursor.duration;
            state.animationPaused = false;
            if (state.cameraMode === 'anim') {
                // the state proxy only fires 'cameraMode:changed' on an
                // actual value change, so hop through 'orbit' first to force
                // re-entry into the new controller.
                state.cameraMode = 'orbit';
            }
            state.cameraMode = 'anim';
        };
        // handle input events`,
    'CameraManager.loadAnimTrack');

const bundle = js
    + '\n(function () {\n'
    + stripTrailingExport(read('gizmo.js'), 'export { Gizmo, TranslateGizmo };', 'gizmo.js')
    + '\n'
    + stripTrailingExport(read('measure-tool.js'), 'export { initMeasureTool };', 'measure-tool.js')
    + '\n'
    + stripTrailingExport(read('label-tool.js'), 'export { initLabelTool };', 'label-tool.js')
    + '\n'
    + stripTrailingExport(read('read-json-tool.js'), 'export { initReadJsonTool };', 'read-json-tool.js')
    + '\nwindow.__lfsInitMeasureTool = initMeasureTool;\n'
    + 'window.__lfsInitLabelTool = initLabelTool;\n'
    + 'window.__lfsInitReadJsonTool = initReadJsonTool;\n})();\n';

let html = read('template.html');

const indent = (text, spaces) => {
    const pad = ' '.repeat(spaces);
    return text.split('\n').map((line) => (line ? pad + line : line)).join('\n');
};

html = replaceOnce(html,
    '<link rel="stylesheet" href="./index.css">',
    `<style>\n${indent(read('index.css'), 12)}\n        </style>`,
    'inline css');

html = replaceOnce(html,
    "import { main } from './index.js';",
    bundle,
    'inline js bundle');

html = replaceOnce(html,
    'settings: fetch(settingsUrl).then(response => response.json())',
    'settings: {"camera":{"fov":50,"position":[5,5,5],"target":[0,0,0],"startAnim":"none"},"background":{"color":[0,0,0]},"animTracks":[]}',
    'inline settings');

const out = path.join(root, 'index.html');
writeFileSync(out, html);
console.log(`Wrote ${out} (${(Buffer.byteLength(html) / 1048576).toFixed(2)} MiB)`);
