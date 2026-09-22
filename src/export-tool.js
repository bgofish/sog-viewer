/*
 * "Export Self-Contained HTML" tool for sog-viewer.
 *
 * Bundles the CURRENTLY loaded model, camera pose, annotations (from
 * annotation-tool.js), labels (from label-tool.js) and loaded camera path
 * (from read-json-tool.js / CameraManager.loadAnimTrack) into a brand-new,
 * fully standalone .html file - the same "one file, no companion assets"
 * shape as a real LichtFeld Studio export, but produced entirely
 * client-side from a live sog-viewer session instead of the offline
 * C++/Python export pipeline.
 *
 * How it works:
 *   1. Get this page's own pristine source: build.mjs embeds a base64 copy
 *      of the exact file it just built into itself (id="lfsPristineHtml").
 *      This tool decodes that rather than fetch(location.href) (blocked by
 *      many browsers under file://, which is how this viewer is normally
 *      opened) or cloning the live DOM (which by export time has
 *      accumulated runtime-injected elements - pc-app's own canvas, tool
 *      panels, hotspot markers, etc. - that a fresh page load's custom
 *      elements would not expect to already be there; an earlier version
 *      of this tool used the DOM-clone fallback and produced a silent white
 *      screen on open, almost certainly for exactly this reason).
 *   2. Base64-encodes the model's raw bytes (from the File object captured
 *      by template.html's openFile()) into a separate, non-executable
 *      <script type="text/plain"> data tag (with the original filename on
 *      a data-filename attribute - see point 3b), rather than a giant
 *      inline string literal inside application code.
 *   3. Text-splices two exact, known anchors (same replaceOnce technique
 *      build.mjs itself uses, just done in the browser instead of at build
 *      time):
 *        a. `contentUrl,\n contents: null,` -> an object-spread IIFE that
 *           decodes the embedded model and returns BOTH contentUrl and
 *           contents, matching openModel()'s own convention exactly:
 *           contents must be a truthy fetch() Promise (build.mjs's
 *           "conditional initial load" delta skips loadGsplat() entirely
 *           when config.contents is falsy - contentUrl alone is not
 *           enough, regardless of what it points to - an earlier version
 *           of this tool left contents: null and silently loaded nothing);
 *           contentUrl must carry the real filename/extension, not the
 *           blob URL (loadGsplat derives the asset's filename/format from
 *           contentUrl's path, so a bare blob: URL with no .ply/.sog
 *           extension breaks format detection - an earlier version of this
 *           tool used the blob URL for both).
 *        b. the inlined `settings: {...}` stub build.mjs writes -> replaced
 *           with the live camera/animTracks/annotations captured just now.
 *   4. Downloads the result as a new .html file.
 *
 * template.html's initModelControls() also needed a matching fix: it only
 * ever updated the "model loaded" UI (close/export buttons, filename label,
 * hiding the empty-state screen) from its own openFile() flow. A
 * self-contained export loads its model through main()'s own initial
 * gsplatLoad instead, which initModelControls() has no way to know
 * succeeded unless it explicitly checks viewer.currentModel at startup -
 * otherwise the model loads correctly but the UI still shows the empty
 * "Open a file" screen over it.
 *
 * Caveats worth knowing (this file can't be exercised in a real browser
 * from here, so these are reasoned through and simulated against the real
 * built output rather than exercised end-to-end in an actual browser):
 *   - Base64 adds ~33% size, three times over now (the pristine-HTML copy
 *     build.mjs embeds, the model, and - since every export also carries
 *     its own pristine-HTML copy forward so it can itself be re-exported -
 *     that copy again), and the chunked encoder below builds one big
 *     intermediate string - fine for typical compressed .sog/.ply sizes,
 *     but a very large model may be slow/memory-heavy to embed this way.
 *   - Only single-file models are supported (whatever the Open button's
 *     <input type=file> accepted). A multi-chunk SOG (meta.json + several
 *     side files) isn't something the local-open flow handles either, so
 *     this isn't a new limitation, but it IS a real one.
 *   - Works for a model opened via the Open button (the real File object),
 *     or for re-exporting an already self-contained export (getModelSource()
 *     falls back to decoding the model bytes already sitting in
 *     #lfsModelData). A model loaded via a ?content= URL has neither, so
 *     export is disabled in that case. Re-exporting an export made *before*
 *     this fix still won't work - it never carried a pristine-HTML copy of
 *     itself forward - and fails with a clear alert rather than a broken
 *     file.
 *
 * IMPORTANT: like the other vendored tool files, this is NOT self-contained
 * at runtime - see gizmo.js's header comment for the concatenation/closure
 * details. The trailing `export` below is stripped at build time.
 *
 * Requires the `viewer` argument (unlike measure/gizmo, this tool is
 * meaningless without viewer.currentModel/currentModelFile/cameraManager).
 */

const EXPORT_CONTENT_ANCHOR = `                contentUrl,
                contents: null,`;

const EXPORT_SETTINGS_ANCHOR = 'settings: {"camera":{"fov":50,"position":[5,5,5],"target":[0,0,0],"startAnim":"none"},"background":{"color":[0,0,0]},"animTracks":[],"annotations":[]}';

function initExportTool(global, viewer) {
    if (!viewer) {
        return;
    }
    const button = document.getElementById('exportHtml');
    if (!button) {
        return;
    }

    // ---- base64 encode without blowing the call stack on large files ----
    const bufferToBase64 = (buffer) => {
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    };

    // ---- capture the live camera / annotations / labels / anim track as a
    // fresh settings object -------------------------------------------------
    //
    // IMPORTANT: this must be in the real "v2" settings schema (version: 2,
    // plural `cameras[0].initial`, `startMode`, `hasStartPose`, the
    // postEffectSettings/tonemapping block), not the simpler "v1" shape
    // build.mjs's placeholder stub happens to use (singular `camera`, no
    // version field). importSettings() (index.js) always runs anything
    // without settings.version through migrateV1 -> migrateV2 - and
    // migrateV2 unconditionally hardcodes `annotations: []` and has no
    // `labels` concept at all, silently discarding both even though it
    // correctly reshapes camera/animTracks along the way (which is exactly
    // why those always worked here while annotations/labels never did).
    // Setting version: 2 makes importSettings() take its pass-through branch
    // instead, which performs no reshaping at all - so extra fields like our
    // own `labels` (not part of the native schema) just ride along untouched.
    const buildSettings = () => {
        const cameraManager = viewer.cameraManager;
        const cam = cameraManager && cameraManager.camera;

        let initial = { fov: 50, position: [5, 5, 5], target: [0, 0, 0] };
        if (cam) {
            const focus = new Vec3();
            cam.calcFocusPoint(focus);
            initial = {
                fov: cam.fov,
                position: [cam.position.x, cam.position.y, cam.position.z],
                target: [focus.x, focus.y, focus.z]
            };
        }

        const animTrack = cameraManager && cameraManager.currentAnimTrack;
        const animTracks = animTrack ? [animTrack] : [];

        const liveAnnotations = viewer.__lfsAnnotations || [];
        const annotations = liveAnnotations.map((a) => ({
            position: a.position.slice(0, 3),
            title: a.title,
            text: a.text,
            extras: a.extras || {},
            camera: {
                initial: {
                    position: a.camera.initial.position.slice(0, 3),
                    target: a.camera.initial.target.slice(0, 3),
                    fov: a.camera.initial.fov
                }
            }
        }));

        const liveLabels = viewer.__lfsLabels || [];
        const labels = liveLabels.map((l) => ({
            text: l.text,
            position: [l.position.x, l.position.y, l.position.z]
        }));

        return {
            version: 2,
            tonemapping: 'none',
            highPrecisionRendering: false,
            background: { color: [0, 0, 0] },
            postEffectSettings: {
                sharpness: { enabled: false, amount: 0 },
                bloom: { enabled: false, intensity: 1, blurLevel: 2 },
                grading: { enabled: false, brightness: 0, contrast: 1, saturation: 1, tint: [1, 1, 1] },
                vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
                fringing: { enabled: false, intensity: 0.5 }
            },
            animTracks,
            cameras: [{ initial }],
            annotations,
            startMode: animTrack ? 'animTrack' : 'default',
            hasStartPose: true,
            labels
        };
    };

    // ---- base64 decode (inverse of bufferToBase64, for reading back the
    // build-time-embedded pristine HTML copy) -----------------------------
    const base64ToText = (b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        return new TextDecoder('utf-8').decode(bytes);
    };

    // ---- this page's own pristine source --------------------------------
    // build.mjs embeds a base64 copy of the exact file it just built into
    // itself (id="lfsPristineHtml"), specifically so this doesn't have to
    // rely on fetch(location.href) - blocked by many browsers under
    // file://, which is how this viewer is normally opened - or on cloning
    // the live DOM, which by the time you click Export has accumulated
    // runtime-injected elements (pc-app's own canvas, tool panels, hotspot
    // markers, ...) that a fresh page load's custom elements would not
    // expect to already be there. Reading the embedded copy sidesteps both
    // failure modes entirely: it's exactly the file as shipped, decoded
    // fresh every time, never touched by anything that happened during this
    // session.
    const getBaseHtml = () => {
        const el = document.getElementById('lfsPristineHtml');
        if (!el || !el.textContent) {
            throw new Error('this build is missing its embedded pristine-HTML copy (id="lfsPristineHtml") - rebuild with the current build.mjs');
        }
        const text = base64ToText(el.textContent);
        if (!text.includes(EXPORT_CONTENT_ANCHOR) || !text.includes(EXPORT_SETTINGS_ANCHOR)) {
            throw new Error('the embedded pristine-HTML copy is missing an expected anchor - build.mjs and export-tool.js have drifted out of sync');
        }
        return text;
    };

    // Replaces only the FIRST occurrence of `search`, not every occurrence.
    // This file's own source (bundled into the page like every vendored
    // tool) contains EXPORT_CONTENT_ANCHOR/EXPORT_SETTINGS_ANCHOR as literal
    // strings too, so a global replace would also mangle those - corrupting
    // this tool's own copy inside the exported file. The real bootstrap
    // occurrence is always textually first (it's in <head>; the tool bundle
    // sits near the end of <body>), so "first occurrence" reliably means
    // "the real one".
    const replaceFirst = (text, search, replace) => {
        const i = text.indexOf(search);
        if (i === -1) {
            return null;
        }
        return text.slice(0, i) + replace + text.slice(i + search.length);
    };

    // ---- where to get the model's raw bytes from -------------------------
    // Either a real File from the Open button (viewer.currentModelFile), or -
    // if this page is itself an already-exported file - the model bytes
    // already sitting in #lfsModelData, decoded back out. Same atob/
    // Uint8Array decode used by the bootstrap's own content-loading IIFE.
    const getModelSource = () => {
        if (viewer.currentModelFile) {
            const file = viewer.currentModelFile;
            return { name: file.name, arrayBuffer: () => file.arrayBuffer() };
        }
        const el = document.getElementById('lfsModelData');
        if (el && el.textContent) {
            const name = (el.dataset && el.dataset.filename) || 'model';
            return {
                name,
                arrayBuffer: async () => {
                    const bin = atob(el.textContent);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) {
                        bytes[i] = bin.charCodeAt(i);
                    }
                    return bytes.buffer;
                }
            };
        }
        return null;
    };

    const exportHtml = async () => {
        const source = getModelSource();
        if (!viewer.currentModel || !source) {
            window.alert('Export needs a model opened via the Open button, or an already self-contained export to re-export (the raw model bytes are what get embedded).');
            return;
        }

        button.disabled = true;
        try {
            const baseHtml = getBaseHtml();
            const buffer = await source.arrayBuffer();
            const modelBase64 = bufferToBase64(buffer);
            const settings = buildSettings();
            // Annotation/label titles and text are user-typed and land raw
            // inside a <script type="module"> tag's JS source below - unlike
            // the base64 model data, this text isn't something we control the
            // contents of. If any of it happens to contain "</script", the
            // HTML parser would truncate the tag right there (the same bug
            // class fixed earlier for the model-data tag, via a different
            // entry point this time). Every '/' in JSON.stringify's output is
            // necessarily inside a string value - JSON's own structural
            // syntax never uses '/' - so escaping all of them as \/ is always
            // safe and closes this off regardless of what was typed.
            const settingsJson = JSON.stringify(settings).replace(/\//g, '\\/');
            console.info('[ExportHtml] embedding', settings.annotations.length, 'annotation(s),',
                settings.labels.length, 'label(s), animTracks:', settings.animTracks.length,
                '- from viewer.__lfsAnnotations:', (viewer.__lfsAnnotations || []).length,
                'viewer.__lfsLabels:', (viewer.__lfsLabels || []).length);

            const dataScriptTag = `<script type="text/plain" id="lfsModelData" data-filename="${(source.name || 'model').replace(/"/g, '&quot;')}">${modelBase64}<\/script>\n</body>`;
            // Carry the pristine template forward into this new export too -
            // otherwise only the very first export (made from the real app)
            // would ever be re-exportable; every export after that would
            // have no base of its own to splice a future export from. This
            // is exactly baseHtml re-encoded, so re-exporting from this new
            // file finds the identical pristine template all over again.
            const pristineBase64 = bufferToBase64(new TextEncoder().encode(baseHtml).buffer);
            const pristineScriptTag = `<script type="text/plain" id="lfsPristineHtml">${pristineBase64}<\/script>`;
            const contentReplacement = `                ...(() => {
                    const el = document.getElementById('lfsModelData');
                    if (!el) {
                        return { contentUrl, contents: null };
                    }
                    const bin = atob(el.textContent);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) {
                        bytes[i] = bin.charCodeAt(i);
                    }
                    const blobUrl = URL.createObjectURL(new Blob([bytes]));
                    // contents must be truthy - see build.mjs's "conditional
                    // initial load" delta, which skips loadGsplat() entirely
                    // when config.contents is falsy, regardless of
                    // contentUrl. contentUrl must keep the real filename
                    // (not the blob URL) - loadGsplat derives the asset's
                    // filename/format from contentUrl's path, so a bare blob
                    // URL with no .ply/.sog extension would break format
                    // detection. Both match openModel()'s own
                    // contentUrl: filename || url / contents: fetch(url)
                    // convention exactly rather than inventing a new one.
                    return { contentUrl: el.dataset.filename || blobUrl, contents: fetch(blobUrl) };
                })(),`;

            let out = replaceFirst(baseHtml, EXPORT_CONTENT_ANCHOR, contentReplacement);
            if (out === null) {
                throw new Error('could not find the content-loading anchor in this page\'s own source');
            }
            const next = replaceFirst(out, EXPORT_SETTINGS_ANCHOR, 'settings: ' + settingsJson);
            if (next === null) {
                throw new Error('could not find the settings anchor in this page\'s own source');
            }
            out = next.replace(/<\/body>\s*<\/html>\s*$/, dataScriptTag + '\n' + pristineScriptTag + '\n</html>');

            // Self-check: verify the settings we just computed actually made
            // it into the exact string that's about to become the file, and
            // show what's really sitting where the settings should be. If
            // this ever disagrees with the pre-splice counts logged above,
            // the bug is definitively in this splice/write path, not upstream.
            const settingsLanded = out.includes(settingsJson);
            const windowSseIdx = out.indexOf('window.sse = {');
            console.info('[ExportHtml] settingsJson landed in final output:', settingsLanded,
                '(', settingsJson.length, 'chars)');
            console.info('[ExportHtml] text at window.sse in final output:',
                out.slice(windowSseIdx, windowSseIdx + 400));

            const blob = new Blob([out], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            const base = (source.name || 'scene').replace(/\.[^.]*$/, '');
            anchor.download = base + '.standalone.html';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        catch (err) {
            console.error('[ExportHtml] failed to export:', err);
            window.alert('Failed to export: ' + err.message);
        }
        finally {
            button.disabled = false;
        }
    };

    button.addEventListener('click', () => exportHtml());
}

export { initExportTool };
