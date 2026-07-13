// app-state.js
var scene = cameraModule.scene;
var camera = cameraModule.camera;
var renderer = cameraModule.renderer;
var DOM = uiModule.DOM;
var updateStatus = uiModule.updateStatus;
var updateAnimPicker = uiModule.updateAnimPicker;
var toggleSettingsOverlay = uiModule.toggleSettingsOverlay;

var resolveCollisions = physicsModule.resolveCollisions;
var constrainToGround = physicsModule.constrainToGround;
var applyGravity = physicsModule.applyGravity;
var initPlayerCollider = physicsModule.initPlayerCollider;
var setPlayerHitCallback = physicsModule.setPlayerHitCallback;
var wakeUpBody = physicsModule.wakeUpBody;
var createPhysicsObject = physicsModule.createPhysicsObject;
var syncPlayerState = physicsModule.syncPlayerState;
var resetPhysicsBody = physicsModule.resetPhysicsBody;

var joystickState = movementModule.joystickState;
var initJoystick = movementModule.initJoystick;
var handleMovement = movementModule.handleMovement;
var core = coreModule;

// 输入平滑 — 直接在主线程处理（消除 Worker 往返延迟）
var _smoothDx = 0, _smoothDz = 0, _smoothForce = 0;
var _smoothFactor = 0.45;
var _deadzone = 0.08;
var _changeThreshold = 0.005;

function _smoothInput(dx, dz, force, active) {
    if (!active) {
        _smoothDx *= 0.5;
        _smoothDz *= 0.5;
        _smoothForce *= 0.5;
        if (Math.abs(_smoothDx) < _changeThreshold) _smoothDx = 0;
        if (Math.abs(_smoothDz) < _changeThreshold) _smoothDz = 0;
        if (Math.abs(_smoothForce) < _changeThreshold) _smoothForce = 0;
    } else {
        _smoothDx += (dx - _smoothDx) * _smoothFactor;
        _smoothDz += (dz - _smoothDz) * _smoothFactor;
        _smoothForce += (force - _smoothForce) * _smoothFactor;
        // 死区过滤
        var mag = Math.sqrt(_smoothDx * _smoothDx + _smoothDz * _smoothDz);
        if (mag < _deadzone) {
            _smoothDx = 0; _smoothDz = 0; _smoothForce = 0;
        }
    }
    joystickState.dx = _smoothDx;
    joystickState.dz = _smoothDz;
    joystickState.force = _smoothForce;
    joystickState.active = active;
}

// 暴露给摇杆模块调用（替代 inputWorker.postMessage）
window._smoothJoystickInput = _smoothInput;

// 物理速度计算 — 直接在主线程处理（消除 Worker 往返延迟）
var _physVX = 0, _physVZ = 0, _physRotation = 0, _physActive = false;
var _physWalkSpeed = 3.2;
var _physRunSpeed = 5.8;
var _physSmoothFactor = 0.35;
var _physCamYaw = 0;
var _physLastYaw = -999;
var _physFwdX = 0, _physFwdZ = -1, _physRgtX = 1, _physRgtZ = 0;

function _updatePhysDirections() {
    if (_physCamYaw === _physLastYaw) return;
    _physLastYaw = _physCamYaw;
    _physFwdX = -Math.sin(_physCamYaw);
    _physFwdZ = -Math.cos(_physCamYaw);
    _physRgtX = Math.cos(_physCamYaw);
    _physRgtZ = -Math.sin(_physCamYaw);
}

function _computePhysVelocity(active, dx, dz, force, camYaw, physicsEnabled) {
    _physCamYaw = camYaw || 0;
    _physActive = active;
    if (!physicsEnabled) {
        _physVX = 0; _physVZ = 0; _physRotation = 0;
        return;
    }
    if (!active) {
        _physVX *= 0.82;
        _physVZ *= 0.82;
        if (Math.abs(_physVX) < 0.001 && Math.abs(_physVZ) < 0.001) {
            _physVX = 0; _physVZ = 0;
        }
        _physRotation = 0;
        return;
    }
    var inputLen = Math.sqrt(dx * dx + dz * dz);
    if (inputLen < 0.01) {
        _physVX *= 0.82;
        _physVZ *= 0.82;
        _physRotation = 0;
        return;
    }
    _updatePhysDirections();
    var normFactor = 1.0 / inputLen;
    var nx = dx * normFactor;
    var nz = dz * normFactor;
    var targetSpeed = force >= 0.6 ? _physRunSpeed : _physWalkSpeed;
    var scaledSpeed = targetSpeed * Math.min(inputLen, 1.0);
    var targetVX = (-nz * _physFwdX + nx * _physRgtX) * scaledSpeed;
    var targetVZ = (-nz * _physFwdZ + nx * _physRgtZ) * scaledSpeed;
    _physVX += (targetVX - _physVX) * _physSmoothFactor;
    _physVZ += (targetVZ - _physVZ) * _physSmoothFactor;
    // 模型朝向
    var vx = (-nz * _physFwdX + nx * _physRgtX);
    var vz = (-nz * _physFwdZ + nx * _physRgtZ);
    _physRotation = Math.atan2(vx, vz);
}

window._computePhysVelocity = _computePhysVelocity;

// Worker 实例仅保留 collider 和 model-parser（真正卸载重计算的 Worker）
var modelLoaderWorker = new Worker('./workers/model-parser.worker.js');

var model = null, mixer = null, actions = [];
var body = null, sphereShape = null, colliderVisual = null, modelMaterials = [];
var physicsObjects = [];
var dynamicCollider = true, physicsMode = false, showCollider = false, wireframeMode = false;
var enableTapSwitch = true, isLoading = false, isBuildingCollider = false;
var clock = new THREE.Clock();
var MAX_MOVE_SPEED = 2.8;
var actionKeys = ['jump', 'crouch', 'skill1', 'skill2', 'hit'];
var isActionPlaying = false;
var actionCleanup = null;
var lastHitTime = 0;
var hitCooldown = 1.0;
var lastFollowTarget = null;

var _tmpBBox = new THREE.Box3();
var _tmpTarget = new THREE.Vector3();
var _tmpTargetPos = new THREE.Vector3();
var _targetModelRotation = null; // null = not initialized, number = target Y rotation (radians)
var _rotationLerpSpeed = 12; // higher = faster rotation snap
var _tmpOffsetVec = new THREE.Vector3();
var _tmpResetPos = new THREE.Vector3();

var thirdPersonCam = null;
var firstPersonCam = null;
var activeCamera = null;
var isThirdPerson = true;
var _physSmoothTarget = null;
var _loadFrameId = null; 

var loader = null;
