/*
 * "Read JSON" tool for the self-contained HTML viewer export.
 *
 * Client-side equivalent of the CamPath-HTML LichtFeld Studio plugin's
 * keyframe-format bake (camera_path_panel.py's `_apply_keyframe_format` /
 * core.py's `apply_camera_path`): lets the user pick a camera_path.json
 * straight from the running viewer, instead of running the offline Python
 * panel to produce a separate "_edited.html". The coordinate/quaternion/FOV
 * math below is a line-for-line port of core.py's `build_keyframe_samples` /
 * `build_anim_track` (parse_axis_order, permute_vec, reorder_quat,
 * conjugate_quat, quat_to_matrix, rotate_vec, compute_target,
 * focal_length_to_fov_deg) using core.py's confirmed-working defaults
 * (axis_order "-x,y,-z", quat_order "wxyz", forward (0,0,-1)) - keep the two
 * in sync if those defaults, or the animTracks schema they both produce,
 * ever change. Verified against core.py output: random synthetic keyframe
 * sets round-trip to identical position/target/time/duration/frameRate
 * values (default options, and non-default axis_order/quat_order/
 * invert_quat/look_distance/frame_rate) at 1e-9 tolerance.
 *
 * The resulting track is handed to CameraManager.loadAnimTrack() (a small
 * addition to index.js - see build.mjs's "loadAnimTrack method" delta),
 * which reuses the viewer's existing cameraMode/transition machinery rather
 * than this file trying to drive playback itself.
 *
 * IMPORTANT: like gizmo.js/measure-tool.js/label-tool.js, this file is NOT
 * self-contained at runtime. It is concatenated (see src/io/formats/html.cpp
 * for the studio export, build.mjs for this repo) after index.js and
 * wrapped in an IIFE at build time, so it shares index.js's bundled engine
 * classes by closure rather than a real ES import. Do not add real `import`
 * statements here; the trailing `export` below is stripped at build time.
 *
 * Optional second argument: a `viewer` object (as returned by `main()`),
 * used to reach `viewer.cameraManager.loadAnimTrack()`. Matches
 * label-tool.js's `(global, viewer)` signature.
 */

// ---- confirmed-working defaults (see core.py) -----------------------------
const CAMPATH_AXIS_ORDER = '-x,y,-z';
const CAMPATH_FORWARD_LOCAL = [0, 0, -1];
const CAMPATH_QUAT_ORDER = 'wxyz';
const CAMPATH_INVERT_QUAT = false;
const CAMPATH_LOOK_DISTANCE = 10.0;
const CAMPATH_SENSOR_WIDTH_MM = 36.0;
const CAMPATH_TRACK_NAME = 'camera_path';
const CAMPATH_LOOP_MODE = 'repeat';
const CAMPATH_INTERPOLATION = 'spline';
const CAMPATH_SMOOTHNESS = 0.5;

// ---- core.py port: axis remap ----------------------------------------------
const campathParseAxisOrder = (spec) => {
    const tokens = spec.split(',').map((t) => t.trim());
    if (tokens.length !== 3) {
        throw new Error(`axis_order must have exactly 3 comma-separated tokens, got ${JSON.stringify(spec)}`);
    }
    const axisMap = { x: 0, y: 1, z: 2 };
    const idx = [];
    const signs = [];
    for (let t of tokens) {
        let sign = 1;
        if (t.startsWith('-')) {
            sign = -1;
            t = t.slice(1);
        } else if (t.startsWith('+')) {
            t = t.slice(1);
        }
        t = t.toLowerCase();
        if (!(t in axisMap)) {
            throw new Error(`invalid axis token "${t}" in axis_order (expected x/y/z, optionally signed)`);
        }
        idx.push(axisMap[t]);
        signs.push(sign);
    }
    return { idx, signs };
};

const campathPermuteVec = (v, idx, signs) => [
    signs[0] * v[idx[0]],
    signs[1] * v[idx[1]],
    signs[2] * v[idx[2]],
];

// ---- core.py port: quaternion -> forward -> target point -------------------
const campathFocalLengthToFovDeg = (focalMm, sensorWidthMm = 36.0) =>
    (2 * Math.atan(sensorWidthMm / (2 * focalMm))) * (180 / Math.PI);

const campathReorderQuat = (raw, order = 'wxyz') => {
    order = order.toLowerCase();
    if (order === 'wxyz') {
        const [w, x, y, z] = raw;
        return [x, y, z, w];
    } else if (order === 'xyzw') {
        return [raw[0], raw[1], raw[2], raw[3]];
    }
    throw new Error(`quat_order must be 'wxyz' or 'xyzw', got ${JSON.stringify(order)}`);
};

const campathConjugateQuat = ([x, y, z, w]) => [-x, -y, -z, w];

const campathQuatToMatrix = (x, y, z, w) => [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
];

const campathRotateVec = (quatXyzw, v) => {
    const m = campathQuatToMatrix(quatXyzw[0], quatXyzw[1], quatXyzw[2], quatXyzw[3]);
    return [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ];
};

const campathComputeTarget = (position, rotationXyzw, distance, forwardLocal) => {
    let fwd = campathRotateVec(rotationXyzw, forwardLocal);
    const norm = Math.sqrt(fwd[0] * fwd[0] + fwd[1] * fwd[1] + fwd[2] * fwd[2]) || 1.0;
    fwd = [fwd[0] / norm, fwd[1] / norm, fwd[2] / norm];
    return [
        position[0] + fwd[0] * distance,
        position[1] + fwd[1] * distance,
        position[2] + fwd[2] * distance,
    ];
};

// ---- core.py port: camera_path.json -> animTracks entry --------------------
const campathBuildKeyframeSamples = (cameraPath, opts) => {
    const {
        lookDistance = CAMPATH_LOOK_DISTANCE,
        forwardLocal = CAMPATH_FORWARD_LOCAL,
        axisOrder = CAMPATH_AXIS_ORDER,
        quatOrder = CAMPATH_QUAT_ORDER,
        invertQuat = CAMPATH_INVERT_QUAT,
        sensorWidthMm = CAMPATH_SENSOR_WIDTH_MM,
    } = opts || {};

    const keyframes = cameraPath.keyframes;
    if (!Array.isArray(keyframes) || keyframes.length === 0) {
        throw new Error('camera_path.json has no keyframes');
    }
    const times = keyframes.map((kf) => kf.time);
    const { idx, signs } = campathParseAxisOrder(axisOrder);

    const positionsFlat = [];
    const targetsFlat = [];
    const fovList = [];
    for (const kf of keyframes) {
        const pos = kf.position;
        let rot = campathReorderQuat(kf.rotation, quatOrder);
        if (invertQuat) rot = campathConjugateQuat(rot);
        // target computed in source space, then position and target are
        // remapped together - correct because axis remap is linear and
        // commutes with the position + distance*forward composition.
        const tgt = campathComputeTarget(pos, rot, lookDistance, forwardLocal);
        positionsFlat.push(...campathPermuteVec(pos, idx, signs));
        targetsFlat.push(...campathPermuteVec(tgt, idx, signs));
        fovList.push(campathFocalLengthToFovDeg(kf.focal_length_mm, sensorWidthMm));
    }
    return { times, positionsFlat, targetsFlat, fovList };
};

const campathBuildAnimTrack = (cameraPath, opts) => {
    const {
        name = CAMPATH_TRACK_NAME,
        lookDistance = CAMPATH_LOOK_DISTANCE,
        forwardLocal = CAMPATH_FORWARD_LOCAL,
        loopMode = CAMPATH_LOOP_MODE,
        interpolation = CAMPATH_INTERPOLATION,
        smoothness = CAMPATH_SMOOTHNESS,
        frameRate = null,
        axisOrder = CAMPATH_AXIS_ORDER,
        quatOrder = CAMPATH_QUAT_ORDER,
        invertQuat = CAMPATH_INVERT_QUAT,
    } = opts || {};

    const { times, positionsFlat, targetsFlat } = campathBuildKeyframeSamples(cameraPath, {
        lookDistance, forwardLocal, axisOrder, quatOrder, invertQuat,
    });

    const duration = cameraPath.clip_duration ?? (times.length ? times[times.length - 1] : 0.0);

    let fr = frameRate;
    if (fr === null || fr === undefined) {
        // Auto-derive from keyframe density, but never let it collapse to 0
        // for sparse control-point paths - fall back to a sane default.
        fr = (duration && times.length > 1) ? Math.max(1, Math.round((times.length - 1) / duration)) : 30;
    }

    return {
        name,
        duration,
        frameRate: fr,
        target: 'camera',
        loopMode,
        interpolation,
        smoothness,
        keyframes: {
            times,
            values: {
                position: positionsFlat,
                target: targetsFlat,
            },
        },
    };
};

function initReadJsonTool(global, viewer) {
    // ---- file picker + toolbar button --------------------------------
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
        let track;
        try {
            const cameraPath = JSON.parse(await file.text());
            track = campathBuildAnimTrack(cameraPath, {});
        }
        catch (err) {
            window.alert('Failed to load camera path: ' + err.message);
            return;
        }
        const cameraManager = viewer && viewer.cameraManager;
        if (!cameraManager || !cameraManager.loadAnimTrack) {
            window.alert('Failed to load camera path: viewer camera manager is not ready yet');
            return;
        }
        cameraManager.loadAnimTrack(track);
    });
    document.getElementById('ui').appendChild(fileInput);

    const button = document.getElementById('readJson');
    button?.addEventListener('click', () => fileInput.click());
}

export { initReadJsonTool };
