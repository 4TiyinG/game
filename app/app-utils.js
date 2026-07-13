// app-utils.js
var _lastHullVertCount = 0;
var _hullUpdateCounter = 0;

function syncColliderShape() {
    // Rebuild player convex hull from deformed vertices (green wireframe)
    if (!physicsModule.isReady || !physicsModule.isReady()) return;
    var deformed = coreModule.getDeformedVerts();
    if (!deformed || deformed.length < 9) return;
    // Throttle: rebuild every 3 frames to balance accuracy vs performance
    _hullUpdateCounter++;
    if (_hullUpdateCounter < 3) return;
    _hullUpdateCounter = 0;
    physicsModule.buildPlayerConvexHull(deformed, 120);
}

function triggerHitAnimation() {
    var now = performance.now();
    if ((now - lastHitTime) < hitCooldown * 1000) return;
    var settings = core.getAnimSettings();
    var targetName = settings.map.hit;
    var targetIdx = -1;
    if (targetName) { targetIdx = core.getAnimIndexByName(targetName); }
    if (targetIdx !== -1 && actions[targetIdx]) {
        if (isActionPlaying && actionCleanup) { actionCleanup(); }
        isActionPlaying = true;
        lastHitTime = now;
        core.playAnimation(targetIdx);
        var targetAction = actions[targetIdx];
        targetAction.setLoop(THREE.AnimationAction.LoopOnce, 1);
        targetAction.clampWhenFinished = true;
        var clip = settings.clip.hit;
        if (clip && clip.end > 0) {
            targetAction.time = Math.min(Math.max(clip.start, 0), targetAction._clip.duration);
        }
        var onFinished = function() {
            mixer.removeEventListener('finished', onFinished);
            targetAction.loop = THREE.AnimationAction.LoopRepeat;
            targetAction.clampWhenFinished = false;
            isActionPlaying = false;
            actionCleanup = null;
            if (!joystickState.active) {
                core.playAnimation(core.getIdleAnimIndex());
            }
        };
        actionCleanup = onFinished;
        mixer.addEventListener('finished', onFinished);
    }
}

setPlayerHitCallback(function() {
    triggerHitAnimation();
});
