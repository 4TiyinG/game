// app-interact.js
var iconTP = `<svg class="icon-svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="2" fill="currentColor"/>
    <path d="M12 4v3M12 17v3M4 12h3M17 12h3"/>
</svg>`;
var iconFP = `<svg class="icon-svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
    <circle cx="12" cy="12" r="3"/>
</svg>`;

// 视角切换逻辑（TP / FP 切换）
var viewToggleBtn = document.getElementById('view-toggle');
if (viewToggleBtn) {
    var newBtn = viewToggleBtn.cloneNode(true);
    viewToggleBtn.parentNode.replaceChild(newBtn, viewToggleBtn);
    newBtn.innerHTML = iconTP;
    newBtn.addEventListener('click', function() {
        if (!thirdPersonCam || !firstPersonCam) return;
        
        if (isThirdPerson) {
            firstPersonCam._targetYaw = thirdPersonCam.yaw;
            firstPersonCam._targetPitch = thirdPersonCam.pitch;
            firstPersonCam.yaw = thirdPersonCam.yaw;
            firstPersonCam.pitch = thirdPersonCam.pitch;
            firstPersonCam._fpInitialized = false;
        } else {
            thirdPersonCam.yaw = firstPersonCam.yaw;
            thirdPersonCam.pitch = firstPersonCam.pitch;
            var targetPos = _tmpTargetPos.set(model.position.x, model.position.y + 1.5, model.position.z);
            var offsetVec = _tmpOffsetVec.set(0, 3.2, 3.2);
            var rotX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), thirdPersonCam.pitch);
            offsetVec.applyQuaternion(rotX);
            var rotY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), thirdPersonCam.yaw);
            offsetVec.applyQuaternion(rotY);
            var resetPos = _tmpResetPos.copy(targetPos).add(offsetVec);
            camera.position.copy(resetPos);
            lastFollowTarget = null;
        }

        var prevCam = activeCamera;
        var prevYaw = prevCam ? prevCam.yaw : 0;
        var prevPitch = prevCam ? prevCam.pitch : 0;
        var prevThirdPerson = isThirdPerson;

        // Save current camera state BEFORE switching
        if (prevThirdPerson && thirdPersonCam) { thirdPersonCam.saveState(); }

        isThirdPerson = !isThirdPerson;
        activeCamera = isThirdPerson ? thirdPersonCam : firstPersonCam;

        // Each camera maintains its own state — restore independently
        if (isThirdPerson) {
            // Switching BACK to third person — restore exact saved state
            thirdPersonCam.restoreState();
        } else {
            // Switching to first person — inherit yaw from TP, reset FP state
            firstPersonCam.yaw = prevYaw;
            firstPersonCam.pitch = 0;
            firstPersonCam._fpInitialized = false; // force re-init position tracking
        }

        // Adjust camera near plane for FP mode with default model (prevent face clipping)
        var cam = window.cameraModule ? window.cameraModule.camera : null;
        if (cam) { cam.near = (isThirdPerson || !core.isDefaultModel()) ? 0.1 : 0.01; cam.updateProjectionMatrix(); }
        // In FP mode with default model, immediately align model facing to camera direction
        var mdl = core ? core.getModel() : null;
        if (!isThirdPerson && mdl && core.isDefaultModel()) { mdl.rotation.y = activeCamera.yaw + Math.PI; }
        newBtn.innerHTML = isThirdPerson ? iconTP : iconFP;
        // Toggle Object_13 visibility for first-person (default model only)
        if (core && core.isDefaultModel() && core.setFPPartHidden) core.setFPPartHidden(!isThirdPerson);
        // 【修复】视角切换时重置脸部骨骼旋转，避免残留旋转与动画混合器冲突
        if (core && core.resetFaceBoneRotations) core.resetFaceBoneRotations();
        // Notify input system of camera mode change (内联处理，无 Worker)
        // inputWorker 已移除，相机旋转直接在主线程处理
    });
    newBtn.addEventListener('touchstart', function(e) { if (e.cancelable) e.preventDefault(); e.stopPropagation(); newBtn.click(); }, { passive: false });
}

// ------------------- 以下为原有的 UI 交互事件逻辑 -------------------
// ===== 高效脚部离地检测系统（优先使用物理引擎加速）=====

// 对象池化：复用 Vector3 避免 GC
var _v3Pool = [
    new THREE.Vector3(), // [0]: left toe pos
    new THREE.Vector3(), // [1]: right toe pos
];

var _lastAirborneCheckTime = 0;
var _cachedAirborneState = false;
var _cachedGroundedState = false;
var AIRBORNE_CHECK_INTERVAL = 0.1; // 每100ms检测一次（增大间隔减少开销）

function isToeOffGround() {
    if (!coreModule || !coreModule.hasToeBones) return false;
    
    var leftPos = _v3Pool[0];
    var rightPos = _v3Pool[1];
    if (!coreModule.getToeWorldPositions(leftPos, rightPos)) return false;
    
    // 优先使用物理引擎加速检测
    if (physicsMode && physicsModule.updateToeDetection) {
        physicsModule.updateToeDetection(
            leftPos.x, leftPos.y, leftPos.z,
            rightPos.x, rightPos.y, rightPos.z
        );
        var r = physicsModule.getToeDetectionResult();
        return r.airborne;
    }
    
    // 回退 Three.js raycaster（极少使用）
    return _isBothFeetOffGroundFallback(leftPos, rightPos, 0.18);
}

// ===== Player Airborne Detection — 玩家空中状态检测（缓存读取，零分配）=====
function isPlayerAirborne() {
    // 优先读取物理引擎缓存结果
    if (physicsMode && physicsModule.getToeDetectionResult) {
        return physicsModule.getToeDetectionResult().airborne;
    }
    
    // 回退到 Three.js 缓存检测
    if (!coreModule || !coreModule.hasToeBones) return false;
    if (!raycaster || !scene) return false;
    
    var now = performance.now();
    if (now - _lastAirborneCheckTime < AIRBORNE_CHECK_INTERVAL * 1000) {
        return _cachedAirborneState;
    }
    _lastAirborneCheckTime = now;
    
    var leftPos = _v3Pool[0];
    var rightPos = _v3Pool[1];
    if (!coreModule.getToeWorldPositions(leftPos, rightPos)) {
        _cachedAirborneState = false;
        return false;
    }
    
    _cachedAirborneState = _isBothFeetOffGroundFallback(leftPos, rightPos, 0.14);
    return _cachedAirborneState;
}

// ===== Player Grounded Detection — 玩家着地检测 =====
function isPlayerGrounded() {
    // 优先使用物理系统的着地检测
    if (physicsMode && physicsModule.isReady && physicsModule.isReady()) {
        // 检测是否通过物理引擎有最新的缓存结果
        if (physicsModule.getToeDetectionResult) {
            return physicsModule.getToeDetectionResult().grounded;
        }
        // fallback: physics built-in grounded check
        if (physicsModule.getIsGrounded) {
            return physicsModule.getIsGrounded();
        }
    }
    
    // 回退到 Three.js 缓存检测
    if (!coreModule || !coreModule.hasToeBones) return false;
    if (!raycaster || !scene) return false;
    
    var now = performance.now();
    if (now - _lastAirborneCheckTime < AIRBORNE_CHECK_INTERVAL * 1000) {
        return _cachedGroundedState;
    }
    
    var leftPos = _v3Pool[0];
    var rightPos = _v3Pool[1];
    if (!coreModule.getToeWorldPositions(leftPos, rightPos)) {
        _cachedGroundedState = false;
        return false;
    }
    
    _cachedGroundedState = _isBothFeetGroundedFallback(leftPos, rightPos, 0.15);
    return _cachedGroundedState;
}

// ===== Three.js 回退检测（极少使用，仅当物理引擎不可用时）=====
function _isBothFeetOffGroundFallback(leftPos, rightPos, threshold) {
    var leftOff = _isFootOffGroundFallback(leftPos, threshold);
    var rightOff = _isFootOffGroundFallback(rightPos, threshold);
    return leftOff && rightOff;
}

function _isBothFeetGroundedFallback(leftPos, rightPos, threshold) {
    var leftGrounded = _isFootGroundedFallback(leftPos, threshold);
    var rightGrounded = _isFootGroundedFallback(rightPos, threshold);
    return leftGrounded && rightGrounded;
}

function _isFootOffGroundFallback(footPos, threshold) {
    if (!raycaster || !scene) return true;
    var rayOrigin = footPos.clone();
    var rayDir = new THREE.Vector3(0, -1, 0);
    raycaster.set(rayOrigin, rayDir);
    raycaster.far = 0.45;
    var intersects = raycaster.intersectObjects(scene.children, true);
    if (intersects.length === 0) return true;
    return intersects[0].distance > threshold;
}

function _isFootGroundedFallback(footPos, threshold) {
    if (!raycaster || !scene) return false;
    var rayOrigin = footPos.clone();
    var rayDir = new THREE.Vector3(0, -1, 0);
    raycaster.set(rayOrigin, rayDir);
    raycaster.far = 0.45;
    var intersects = raycaster.intersectObjects(scene.children, true);
    if (intersects.length === 0) return false;
    return intersects[0].distance <= threshold;
}

DOM.fileInput.addEventListener('change', function(e) { loadLocalFile(e.target.files[0]); });
DOM.loadBtn.addEventListener('click', function() {
    if (DOM.fileInput) { DOM.fileInput.click(); } else { var fallbackInput = document.getElementById('file-input'); if (fallbackInput) fallbackInput.click(); }
});
DOM.pickerTrigger.addEventListener('click', function() { if (actions.length === 0 || isLoading) return; DOM.pickerWrapper.classList.toggle('open'); });
document.addEventListener('click', function(e) { if (!DOM.pickerWrapper.contains(e.target)) DOM.pickerWrapper.classList.remove('open'); });
DOM.settingsBtn.addEventListener('click', function() { toggleSettingsOverlay(true); });
DOM.settingsClose.addEventListener('click', function() { toggleSettingsOverlay(false); });
DOM.settingsOverlay.addEventListener('click', function(e) { if (e.target === DOM.settingsOverlay) toggleSettingsOverlay(false); });
document.getElementById('reset-settings-btn').addEventListener('click', function() {
    core.resetToDefaults();
    if (window.__syncUIConfig) { window.__syncUIConfig(); }
    updateStatus('✅ 已恢复默认设置');
    setTimeout(function() {
        if (!joystickState.active) core.playAnimation(core.getIdleAnimIndex());
    }, 1000);
});

var raycaster = new THREE.Raycaster();
var pointer = new THREE.Vector2();
var SCREEN_CLICK_DISTANCE = 5; // 最大有效点击距离（玩家到屏幕中心）
var _screenBox = new THREE.Box3();
var _screenCenter = new THREE.Vector3();
function handleInteraction(clientX, clientY) {
    if (!model || isLoading || isBuildingCollider || !enableTapSwitch) return;
    var rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    // 优先检测是否点击了 PC 屏幕（带距离限制）
    if (window.pcScreenMesh && window.uiModule && uiModule.screenVideoState && uiModule.screenVideoState.active) {
        var screenIntersects = raycaster.intersectObject(window.pcScreenMesh, true);
        if (screenIntersects.length > 0) {
            // 计算玩家到屏幕中心的距离，超出范围不响应
            _screenBox.setFromObject(window.pcScreenMesh);
            _screenBox.getCenter(_screenCenter);
            var dist = model.position.distanceTo(_screenCenter);
            if (dist <= SCREEN_CLICK_DISTANCE) {
                uiModule.toggleScreenVideoPlayback();
                return;
            }
        }
    }

    // 未命中屏幕时，保持原有模型点击切换动画
    if (raycaster.intersectObject(model, true).length > 0 && mixer && actions.length > 0) core.toggleAnimation();
}
renderer.domElement.addEventListener('click', function(e) { handleInteraction(e.clientX, e.clientY); });
renderer.domElement.addEventListener('touchstart', function(e) { handleInteraction(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });

var uiButtons = [DOM.toggleColliderBtn, DOM.toggleDynamicBtn, DOM.toggleWireframeBtn, DOM.togglePhysicsBtn, DOM.toggleTapBtn, DOM.settingsBtn, DOM.pickerTrigger];
for (var b = 0; b < uiButtons.length; b++) {
    var btnEl = uiButtons[b];
    if (btnEl) {
        btnEl.addEventListener('touchstart', function(e) { if (e.cancelable) e.preventDefault(); e.stopPropagation(); this.click(); }, { passive: false });
    }
}

DOM.toggleDynamicBtn.classList.add('active');
DOM.toggleColliderBtn.addEventListener('click', function() { showCollider = !showCollider; if (colliderVisual) colliderVisual.visible = showCollider; DOM.toggleColliderBtn.classList.toggle('active', showCollider); });
DOM.toggleDynamicBtn.addEventListener('click', function() { dynamicCollider = !dynamicCollider; DOM.toggleDynamicBtn.classList.toggle('active', dynamicCollider); });
DOM.toggleWireframeBtn.addEventListener('click', function() { wireframeMode = !wireframeMode; for (var matIdx = 0; matIdx < modelMaterials.length; matIdx++) { modelMaterials[matIdx].wireframe = wireframeMode; } DOM.toggleWireframeBtn.classList.toggle('active'); });
DOM.togglePhysicsBtn.addEventListener('click', function() {
    if (!body || !model) return;
    physicsMode = !physicsMode;
    DOM.togglePhysicsBtn.classList.toggle('active', physicsMode);
    // Notify physics system of mode change (physicsWorker 已内联到主线程)
    // 速度计算逻辑直接使用 physicsMode 变量，无需通知 Worker
    // 物理模式开启时：通知位置修正系统停止回正（Ammo 物理碰撞接管角色位置）
    // 物理模式关闭时：恢复位置修正系统（动画驱动角色位置，需要回正防滑步）
    if (positionCorrectModule && positionCorrectModule.setPhysicsMode) {
        positionCorrectModule.setPhysicsMode(physicsMode);
    }
    if (physicsMode) {
        // 【核心修复】：开启物理模式时，立即将物理体位置同步到当前 model 位置
        // 防止物理体仍停留在初始位置，导致角色被拉回
        if (physicsModule.setPlayerPosition) {
            physicsModule.setPlayerPosition(model.position.x, model.position.y, model.position.z);
        }
        // 唤醒 Ammo 玩家刚体
        if (physicsModule.wakeUpBody && body.setActivationState) {
            physicsModule.wakeUpBody(body);
        }
    } else {
        // 关闭物理模式时：将 model 位置同步到物理体当前位置
        // 防止下次开启物理模式时位置跳变
        if (physicsModule.isReady && physicsModule.isReady()) {
            var ms = body.getMotionState();
            if (ms && window.physicsModule && window.physicsModule.btTransform) {
                var t = window.physicsModule.btTransform;
                ms.getWorldTransform(t);
                var origin = t.getOrigin();
                model.position.x = origin.x();
                model.position.y = origin.y() - 0.8; // 胶囊体半高补偿
                model.position.z = origin.z();
            }
        }
    }
    updateStatus(physicsMode ? '⚡ Ammo 物理引擎' : '✅ 已就绪');
});
DOM.toggleTapBtn.addEventListener('click', function() { enableTapSwitch = !enableTapSwitch; DOM.toggleTapBtn.classList.toggle('active', enableTapSwitch); DOM.toggleTapBtn.innerHTML = enableTapSwitch ? '<svg class="icon-svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12L2 16h5l-1 7 9-12h-5l3-7z"/></svg><span>点击切换</span>' : '<svg class="icon-svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 0 1 0 12.72M5.64 18.36a9 9 0 0 1 0-12.72M9 9l6 6M15 9l-6 6"/></svg><span style="color:#ef4444;">已禁用</span>'; });

function initJoystickWhenReady() {
    if (window.nipplejs) { initJoystick(DOM.joystickZone, window.nipplejs); }
    else { setTimeout(initJoystickWhenReady, 100); }
}
initJoystickWhenReady();

// PC 键盘初始化（在摇杆初始化之后调用，但互不干扰）
if (window.movementModule && window.movementModule.initKeyboard) {
    window.movementModule.initKeyboard();
}

var origOnModelLoaded = onModelLoaded;
onModelLoaded = function(gltf) { origOnModelLoaded(gltf); };

function bindActionButton(btnId, mapKey) {
    var el = document.getElementById(btnId);
    if (!el) return;
    var triggerAction = function(e) {
        if (e) e.preventDefault();
        var settings = core.getAnimSettings();
        var targetName = settings.map[mapKey];
        var targetIdx = -1;
        if (targetName) { targetIdx = core.getAnimIndexByName(targetName); }
        if (targetIdx !== -1 && actions[targetIdx]) {
            // Cancel previous action listener (but DON'T trigger cleanup — let transition handle it)
            if (actionCleanup) {
                mixer.removeEventListener('finished', actionCleanup);
                actionCleanup = null;
            }
            isActionPlaying = true;

            // 【修复】跳跃动画：先检测脚部是否离地，离地时立即无过渡播放，避免延迟
            var jumpPlayed = false;
            if (mapKey === 'jump' && targetIdx !== -1 && actions[targetIdx]) {
                if (isToeOffGround()) {
                    // 脚部已离地，立即播放跳跃动画（无过渡）
                    core.switchAnimation(targetIdx);
                    jumpPlayed = true;
                }
            }
            // 非跳跃或脚部未离地时，使用原有过渡播放
            if (!jumpPlayed) {
                // Play animation with blend transition (0.3s for smooth action start)
                core.playAnimation(targetIdx, 0.3);
            }
            var targetAction = actions[targetIdx];
            targetAction.setLoop(THREE.AnimationAction.LoopOnce, 1);
            targetAction.clampWhenFinished = true;
            // Set clip start time immediately so the first frame matches the jump pose
            var clip = settings.clip[mapKey];
            if (clip && clip.end > 0) {
                targetAction.time = Math.min(Math.max(clip.start, 0), targetAction._clip.duration);
            }
            // Force mixer update to apply the first frame instantly
            if (mixer) { mixer.update(0); }

            // THEN apply physics impulse — synchronized with the animation first frame
            if (mapKey === 'jump') {
                // 【Vue 项目参考】使用 tryJump：土狼时间 + 跳跃缓冲 + 保护期管理
                if (physicsModule.tryJump) {
                    physicsModule.tryJump();
                } else {
                    var currentVy = physicsModule.getVerticalVelocity ? physicsModule.getVerticalVelocity() : 0;
                    if (currentVy <= 0.5) {
                        physicsModule.setVerticalVelocity(5.5);
                    }
                }
            }
            var onFinished = function() {
                mixer.removeEventListener('finished', onFinished);
                targetAction.clampWhenFinished = false;
                isActionPlaying = false;
                actionCleanup = null;
                // Transition back to idle with blend
                if (!joystickState.active) { core.playAnimation(core.getIdleAnimIndex()); }
            };
            actionCleanup = onFinished;
            mixer.addEventListener('finished', onFinished);
        } else {
            updateStatus('⚡ ' + mapKey + ' 未绑定动画');
            setTimeout(function() { if (!joystickState.active) core.playAnimation(core.getIdleAnimIndex()); }, 1000);
        }
    };
    el.addEventListener('click', triggerAction);
    el.addEventListener('touchstart', function(e) { if (e.cancelable) e.preventDefault(); e.stopPropagation(); triggerAction(e); }, { passive: false });
}
bindActionButton('btn-jump', 'jump');
bindActionButton('btn-crouch', 'crouch');
bindActionButton('btn-skill1', 'skill1');
bindActionButton('btn-skill2', 'skill2');

loadDefaultModel();
