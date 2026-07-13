// position-smooth.js — 位置插值修正系统（历史帧缓冲 + Lerp 平滑）
(function() {
    var posHistory = [];
    var POS_THRESHOLD = 0.25;
    var POS_HISTORY_LENGTH = 6;

    var _core = null;
    var _actions = null;
    var _model = null;
    var _actionKeys = null;
    var _isLerping = false;
    var _targetPos = { x: 0, z: 0 };
    var _lerpSpeed = 8.0;
    // 【新增】物理模式状态锁
    var _isPhysicsMode = false;

    function initCorrectSystem(core, actions, model, actionKeys) {
        _core = core; _actions = actions; _model = model; _actionKeys = actionKeys;
        posHistory = []; _isLerping = false; _targetPos.x = 0; _targetPos.z = 0;
        _isPhysicsMode = false; // 默认非物理
    }

    // 【新增】同步物理模式状态
    function setPhysicsMode(isPhysics) {
        _isPhysicsMode = isPhysics;
        if (_isPhysicsMode) {
            // 物理模式下，立即清除历史记录，防止残留数据干扰
            posHistory = [];
            _isLerping = false;
        }
    }

    function recordPosition(followTarget) {
        if (!_core || !_actions || !_model) return;
        // 物理模式下不记录历史，因为物理体位置不由动画控制
        if (_isPhysicsMode) return;
        var actAction = _actions[_core.getCurrentActionIndex()];
        if (actAction && actAction.loop === THREE.AnimationAction.LoopOnce) {
            posHistory.push(followTarget.clone());
            if (posHistory.length > POS_HISTORY_LENGTH) posHistory.shift();
        }
    }

    function checkClipStop() {
        if (!_core || !_actions || !_model) return false;
        var currentIdx = _core.getCurrentActionIndex();
        var actAction = _actions[currentIdx];
        if (!actAction || actAction.loop !== THREE.AnimationAction.LoopOnce) return false;

        var settings = _core.getAnimSettings();
        var foundKey = null;
        for (var i = 0; i < _actionKeys.length; i++) {
            var key = _actionKeys[i];
            var mapName = settings.map[key];
            if (mapName && typeof mapName === 'string') {
                var idx = _core.getAnimIndexByName(mapName);
                if (idx !== -1 && idx === currentIdx) { foundKey = key; break; }
            }
        }
        if (foundKey) {
            var clip = settings.clip[foundKey];
            if (clip && clip.end > 0 && actAction.time >= clip.end) {
                actAction.stop();
                
                // 【核心修复】：物理模式下，绝不执行位置修正
                if (!_isPhysicsMode) {
                    // 非物理模式，正常执行历史回正与插值
                    if (posHistory.length > 0) {
                        var lastIdx = posHistory.length - 1;
                        var preEndPos = posHistory[lastIdx];
                        var currentPos = _model.position.clone();
                        var diffX = Math.abs(preEndPos.x - currentPos.x);
                        var diffZ = Math.abs(preEndPos.z - currentPos.z);
                        if (diffX > POS_THRESHOLD || diffZ > POS_THRESHOLD) {
                            _targetPos.x = preEndPos.x;
                            _targetPos.z = preEndPos.z;
                            _isLerping = true;
                        }
                    }
                    posHistory = [];
                } else {
                    // 物理模式下，只清理历史，不强拉位置，完全交给物理引擎
                    posHistory = [];
                }
                return true; // 动画已被截断
            }
        }
        return false;
    }

    function isLerping() { return _isLerping; }
    function forceStopLerp() { _isLerping = false; }
    function updateLerp(targetObject, delta) {
        if (!_isLerping || !targetObject) return;
        var speed = _lerpSpeed * delta;
        targetObject.position.x += (_targetPos.x - targetObject.position.x) * speed;
        targetObject.position.z += (_targetPos.z - targetObject.position.z) * speed;
        if (Math.abs(targetObject.position.x - _targetPos.x) < 0.001 && Math.abs(targetObject.position.z - _targetPos.z) < 0.001) {
            targetObject.position.x = _targetPos.x; targetObject.position.z = _targetPos.z; _isLerping = false;
        }
    }

    window.positionCorrectModule = {
        initCorrectSystem: initCorrectSystem,
        setPhysicsMode: setPhysicsMode,
        recordPosition: recordPosition,
        checkClipStop: checkClipStop,
        isLerping: isLerping,
        forceStopLerp: forceStopLerp,
        updateLerp: updateLerp
    };
})();