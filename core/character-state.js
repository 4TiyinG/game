// character-state.js

// 【核心修复】：防御性读取，即使 ui.js 加载慢了一点，也不会直接让整个 core 崩溃
var ui = (typeof uiModule !== 'undefined') ? uiModule : { DOM: {}, updateStatus: function() {} };
var DOM = ui.DOM;
var updateStatus = ui.updateStatus;

var worker = new Worker('./workers/collider-mesh.worker.js');
var builderWorker = new Worker('./workers/vertex-transform.worker.js');
var model = null;
var mixer = null;
var actions = [];
var combinedIndices = null;
var skinnedMeshes = [];
var deformedVertices = null;
var currentActionIndex = 0;
var idleAnimIndex = 0;
var isAnimationPlaying = false;
var isJoystickControlled = false;
var isUpdating = false;

var defaultSettings = {
    map: {
        forward: "walk", backward: "walk", left: "walk", right: "walk",
        forward_run: "run", backward_run: "run", left_run: "run", right_run: "run",
        jump: "jump", crouch: "skill2_1", skill1: "debut", skill2: "attack1_1", hit: "hit"
    },
    clip: {
        forward: { start: 0, end: 0 }, backward: { start: 0, end: 0 },
        left: { start: 0, end: 0 }, right: { start: 0, end: 0 },
        forward_run: { start: 0, end: 0 }, backward_run: { start: 0, end: 0 },
        left_run: { start: 0, end: 0 }, right_run: { start: 0, end: 0 },
        jump: { start: 0, end: 0 }, crouch: { start: 0, end: 0 },
        skill1: { start: 0, end: 0 }, skill2: { start: 0, end: 0 }, hit: { start: 0, end: 0 }
    },
    cooldown: 0.12,
    speed: 1.0,
    runForceThreshold: 0.6  // force >= this value triggers run animation
};

var animSettings = JSON.parse(JSON.stringify(defaultSettings));
var lastMappedAnimIndex = -1;
var lastMappedDirection = 'forward';
var lastSwitchTime = 0;
var onModelLoadedCallback = null;

var headBone = null;
var headBoneFound = false;
var isDefaultModel = false;

function getAnimIndexByName(name) {
    if (!name || !actions || actions.length === 0) return -1;
    for (var i = 0; i < actions.length; i++) {
        var clipName = actions[i]._clip.name;
        if (clipName === name) { return i; }
    }
    return -1;
}