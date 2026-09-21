/*
 * Annotation tool for the self-contained HTML viewer export.
 *
 * Pick points on the model, title them, and save/load the resulting set as
 * a SuperSplat-style annotations.json:
 *
 *   { "annotations": [ { "position": [x,y,z], "title": "...", "text": "...",
 *       "extras": {}, "camera": { "initial": { "position": [x,y,z],
 *       "target": [x,y,z], "fov": n } } }, ... ] }
 *
 * Each annotation is rendered with the viewer's existing native `Annotation`
 * script (the same hotspot/tooltip class used for annotations baked into
 * settings.json at export time - see index.js's `Annotations` class) rather
 * than a second parallel visual system. Clicking a hotspot already fires
 * `events.fire('annotation.activate', ann)`, which index.js's CameraManager
 * already handles by flying the orbit camera to `ann.camera.initial` - see
 * `events.on('annotation.activate', ...)` in index.js. This file reuses that
 * tested path rather than duplicating it, the same way read-json-tool.js
 * reuses CameraManager.loadAnimTrack()'s cameraMode machinery.
 *
 * `camera.initial` is captured from the live camera view at the moment an
 * annotation is added (frame the shot you want, then place the point), so
 * every annotation both marks a position AND bookmarks how to look at it.
 *
 * Scope: this intentionally mirrors only the three requested label-tool
 * actions (add / export / import), not the fuller label editing gestures
 * (drag-to-reposition, double-click rename, right-click delete). A mis-added
 * annotation currently has to be cleared by re-importing a previous export
 * or reloading; ask if you'd like those added too.
 *
 * IMPORTANT: like gizmo.js/measure-tool.js/label-tool.js/read-json-tool.js,
 * this file is NOT self-contained at runtime. It is concatenated (see
 * build.mjs) after index.js and wrapped in an IIFE at build time, so it
 * shares index.js's bundled engine classes (Vec3, Entity, Annotation, ...)
 * by closure rather than a real ES import. Do not add real `import`
 * statements here; the trailing `export` below is stripped at build time.
 *
 * Optional second argument: a `viewer` object (as returned by `main()`).
 * Used for `viewer.cameraManager.camera` (the live view to bookmark) and,
 * when it exposes `openModel`/`closeModel` (sog-viewer), to clear
 * annotations on every model change - same convention as label-tool.js.
 */

// Pointer must move less than this (px) between down and up for a click to
// register as a pick; matches measure-tool.js/label-tool.js.
const ANNOTATION_CLICK_DEADZONE = 8;

function initAnnotationTool(global, viewer) {
    const { app, camera, events } = global;
    const canvas = app.graphicsDevice.canvas;
    const parent = app.root;

    // ---- state ----------------------------------------------------------
    const annotations = [];  // exportable data: {position,title,text,extras,camera}
    const entries = [];      // parallel array of {entity, script}, one per annotation
    let active = false;
    let currentModelName = null;
    let picker = null;
    let currentIndex = -1;

    // Exposed so export-tool.js can fold the live annotation set into a
    // self-contained export without this file needing to know anything
    // about exporting. This is a stable array reference (replaceAnnotations
    // clears/refills it in place rather than reassigning), so a plain
    // assignment here is enough to always see current content later.
    if (viewer) {
        viewer.__lfsAnnotations = annotations;
    }

    // ---- annotations browser bar: shown top-center whenever at least one
    // annotation exists, lets you page through them with the camera jumping
    // to each one's bookmarked shot (same annotation.activate event a
    // hotspot click fires) ------------------------------------------------
    const browserBar = document.createElement('div');
    browserBar.id = 'annotationBrowser';
    browserBar.classList.add('hidden');

    const browserPrev = document.createElement('button');
    browserPrev.type = 'button';
    browserPrev.title = 'Previous annotation';
    browserPrev.textContent = '\u2039';

    const browserTitle = document.createElement('span');
    browserTitle.id = 'annotationTitle';

    const browserNext = document.createElement('button');
    browserNext.type = 'button';
    browserNext.title = 'Next annotation';
    browserNext.textContent = '\u203a';

    browserBar.appendChild(browserPrev);
    browserBar.appendChild(browserTitle);
    browserBar.appendChild(browserNext);
    document.getElementById('ui').appendChild(browserBar);

    const refreshBrowser = () => {
        if (annotations.length === 0) {
            browserBar.classList.add('hidden');
            currentIndex = -1;
            return;
        }
        if (currentIndex < 0 || currentIndex >= annotations.length) {
            currentIndex = 0;
        }
        browserTitle.textContent = annotations[currentIndex].title || ('Annotation ' + (currentIndex + 1));
        browserBar.classList.remove('hidden');
    };

    const gotoAnnotation = (index) => {
        if (annotations.length === 0) {
            return;
        }
        currentIndex = ((index % annotations.length) + annotations.length) % annotations.length;
        refreshBrowser();
        events.fire('annotation.activate', annotations[currentIndex]);
    };

    browserPrev.addEventListener('click', () => gotoAnnotation(currentIndex - 1));
    browserNext.addEventListener('click', () => gotoAnnotation(currentIndex + 1));

    // Annotations baked into settings.annotations at export time (see
    // export-tool.js) are rendered by the native `Annotations` class
    // (index.js), entirely independent of this file - that class creates
    // its own hotspot entities directly from global.settings.annotations,
    // and this tool never sees them. Without this, the browser bar stays
    // empty (and hidden) in an exported file even though the 3D hotspot
    // markers themselves render correctly: two separate systems reading the
    // same data, only one of which this file drives. Populate the bar's
    // data from the same array - by reference, not a copy - so it can page
    // through them too, without creating a second, duplicate set of markers.
    if (Array.isArray(global.settings.annotations) && global.settings.annotations.length > 0) {
        for (const ann of global.settings.annotations) {
            annotations.push(ann);
        }
        refreshBrowser();
    }

    // Keep the bar in sync when a hotspot is clicked directly instead of
    // via the bar's own arrows - including the native class's own hotspots
    // above, which this file has no other way to hear from. Since those
    // share object identity with what was just pushed above, indexOf finds
    // them; own entries below already set currentIndex themselves before
    // firing this same event, so this is a harmless no-op for those.
    events.on('annotation.activate', (ann) => {
        const idx = annotations.indexOf(ann);
        if (idx !== -1 && idx !== currentIndex) {
            currentIndex = idx;
            refreshBrowser();
        }
    });

    // ---- native Annotation script entity (same class the viewer's own
    // baked-in annotations use, for identical hotspot/tooltip rendering and
    // to reuse the existing annotation.activate -> camera-jump handler) ---
    const createEntry = (data, index) => {
        const entity = new Entity();
        entity.addComponent('script');
        entity.script.create(Annotation);
        const script = entity.script.annotation;
        script.label = (index + 1).toString();
        script.title = data.title;
        script.text = data.text;
        entity.setPosition(data.position[0], data.position[1], data.position[2]);
        parent.addChild(entity);
        script.on('show', () => {
            // Clicking a hotspot directly should keep the browser bar in
            // sync with what's now on screen.
            currentIndex = index;
            refreshBrowser();
            events.fire('annotation.activate', data);
        });
        script.on('hover', () => {
            app.renderNextFrame = true;
        });
        return { entity, script };
    };

    const addAnnotation = (data) => {
        const index = annotations.length;
        annotations.push(data);
        entries.push(createEntry(data, index));
        currentIndex = index;
        refreshBrowser();
    };

    const clearAnnotations = () => {
        for (const { entity } of entries) {
            entity.destroy();
        }
        entries.length = 0;
        annotations.length = 0;
        refreshBrowser();
    };

    const replaceAnnotations = (next) => {
        clearAnnotations();
        for (const data of next) {
            addAnnotation(data);
        }
        currentIndex = next.length ? 0 : -1;
        refreshBrowser();
        app.renderNextFrame = true;
    };

    // ---- capture the current view as this annotation's bookmarked shot --
    const captureCamera = () => {
        const cam = viewer && viewer.cameraManager && viewer.cameraManager.camera;
        if (!cam) {
            return { position: [0, 0, 0], target: [0, 0, 0], fov: 50 };
        }
        const focus = new Vec3();
        cam.calcFocusPoint(focus);
        return {
            position: [cam.position.x, cam.position.y, cam.position.z],
            target: [focus.x, focus.y, focus.z],
            fov: cam.fov
        };
    };

    // ---- annotations.json save/load -------------------------------------
    const serializeAnnotations = () => JSON.stringify({ annotations }, null, 2);

    const suggestedName = () => {
        if (currentModelName) {
            const base = currentModelName.replace(/\.[^.]*$/, '');
            if (base) {
                return base + '.annotations.json';
            }
        }
        try {
            const name = decodeURIComponent(new URL(location.href).pathname.split('/').pop() || '');
            const base = name.replace(/\.[^.]*$/, '');
            if (base) {
                return base + '.annotations.json';
            }
        }
        catch (e) {
            // fall through to the default name
        }
        return 'annotations.json';
    };

    const saveAnnotations = async () => {
        const text = serializeAnnotations();
        const name = suggestedName();
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: name,
                    types: [{ description: 'Annotations (.json)', accept: { 'application/json': ['.json'] } }]
                });
                const writable = await handle.createWritable();
                await writable.write(text);
                await writable.close();
                return;
            }
            catch (err) {
                if (err && err.name === 'AbortError') {
                    return;
                }
            }
        }
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const isVec3ish = (v) => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => Number.isFinite(Number(n)));

    const parseAnnotations = (raw) => {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.annotations);
        if (!Array.isArray(arr)) {
            throw new Error('no annotations array found');
        }
        return arr.map((entry, i) => {
            const n = i + 1;
            if (!entry || !isVec3ish(entry.position)) {
                throw new Error('annotation ' + n + ' has an invalid position');
            }
            const position = entry.position.slice(0, 3).map(Number);
            const title = entry.title != null ? String(entry.title) : 'Annotation ' + n;
            const text = entry.text != null ? String(entry.text) : '';
            const extras = (entry.extras && typeof entry.extras === 'object') ? entry.extras : {};

            // camera.initial is required by index.js's annotation.activate
            // handler (it destructures annotation.camera.initial with no
            // fallback), so a missing/invalid one is synthesized here rather
            // than left out - using the current live view, same as a freshly
            // added annotation would if you hadn't specified one.
            const initial = entry.camera && entry.camera.initial;
            let camera;
            if (initial && isVec3ish(initial.position) && isVec3ish(initial.target) && Number.isFinite(Number(initial.fov))) {
                camera = {
                    initial: {
                        position: initial.position.slice(0, 3).map(Number),
                        target: initial.target.slice(0, 3).map(Number),
                        fov: Number(initial.fov)
                    }
                };
            }
            else {
                camera = { initial: captureCamera() };
            }

            return { position, title, text, extras, camera };
        });
    };

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.classList.add('hidden');
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) {
            return;
        }
        let next;
        try {
            next = parseAnnotations(await file.text());
        }
        catch (err) {
            window.alert('Failed to load annotations: ' + err.message);
            return;
        }
        if (annotations.length > 0 && !window.confirm('Replace ' + annotations.length + ' existing annotation(s) with ' + next.length + ' from the file?')) {
            return;
        }
        replaceAnnotations(next);
    });
    document.getElementById('ui').appendChild(fileInput);

    // ---- point picking on click (drag = camera navigation, not a pick) --
    const isPrimary = (e) => (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary);
    let tracking = false;
    let picking = false;
    let downX = 0;
    let downY = 0;

    const onPointerDown = (e) => {
        if (active && isPrimary(e)) {
            tracking = true;
            downX = e.clientX;
            downY = e.clientY;
        }
    };
    const onPointerMove = (e) => {
        if (tracking && (Math.abs(e.clientX - downX) > ANNOTATION_CLICK_DEADZONE || Math.abs(e.clientY - downY) > ANNOTATION_CLICK_DEADZONE)) {
            tracking = false;
        }
    };
    const onPointerUp = async (e) => {
        if (!active || !tracking || !isPrimary(e) || picking) {
            return;
        }
        tracking = false;

        if (!picker) {
            picker = new Picker(app, camera);
        }
        picking = true;
        let result = null;
        try {
            result = await picker.pick(e.offsetX, e.offsetY);
        }
        finally {
            picking = false;
        }
        if (!result) {
            return;
        }

        const title = window.prompt('Annotation title:', 'Annotation ' + (annotations.length + 1));
        if (title === null) {
            return;
        }
        const trimmed = title.trim();
        if (!trimmed) {
            return;
        }

        addAnnotation({
            position: [result.x, result.y, result.z],
            title: trimmed,
            text: '',
            extras: {},
            camera: { initial: captureCamera() }
        });
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp, true);

    // ---- toolbar buttons --------------------------------------------------
    const modeButton = document.getElementById('annotate');
    const saveButton = document.getElementById('annotationSave');
    const loadButton = document.getElementById('annotationLoad');

    const setActive = (state) => {
        active = state;
        if (modeButton) {
            modeButton.classList.toggle('active', active);
        }
        if (canvas) {
            canvas.style.cursor = state ? 'crosshair' : '';
        }
        app.renderNextFrame = true;
    };

    modeButton?.addEventListener('click', () => {
        const next = !active;
        if (next) {
            // Only one pick tool should be live at a time; measure and
            // labels both attach a left-button gizmo / consume clicks the
            // same way annotation placement does.
            for (const id of ['measure', 'labels']) {
                const other = document.getElementById(id);
                if (other && other.classList.contains('active')) {
                    other.click();
                }
            }
        }
        setActive(next);
    });

    saveButton?.addEventListener('click', () => saveAnnotations());
    loadButton?.addEventListener('click', () => fileInput.click());

    // ---- model swap support (optional `viewer` argument) -----------------
    // Annotation positions are world coordinates of the loaded model, so
    // they must be cleared whenever the model changes. No-op in the studio
    // export, whose viewer has no openModel/closeModel.
    if (viewer && typeof viewer.openModel === 'function' && typeof viewer.closeModel === 'function') {
        const openModel = viewer.openModel;
        const closeModel = viewer.closeModel;
        viewer.openModel = function () {
            clearAnnotations();
            const name = arguments.length > 1 ? arguments[1] : null;
            currentModelName = name ? String(name) : null;
            return openModel.apply(this, arguments);
        };
        viewer.closeModel = function () {
            clearAnnotations();
            currentModelName = null;
            return closeModel.apply(this, arguments);
        };
    }

    events?.on('inputEvent', (name) => {
        if (name === 'cancel' && active) {
            setActive(false);
        }
    });
}

export { initAnnotationTool };
