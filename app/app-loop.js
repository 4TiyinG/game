// app-loop.js

// 摇杆闲置计时器：当摇杆停留在阈值区间内时累积，超时自动过渡到 idle
var _joystickIdleTimer = 0;
// 【修复】落地检测状态：上一帧是否在空中
var _wasPlayerInAir = false;

// 【修复】主循环时钟初始化，避免 animate 中 clock 未定义
var clock = new THREE.Clock();

    // 对象池：用于脚部骨骼坐标读取（减少 GC）
var _loopV3Pool = [new THREE.Vector3(), new THREE.Vector3()];
// 复用 Box3（相机跟随目标计算 + 3D音频位置更新）
var _tmpBox3 = new THREE.Box3();
var _tmpCenter = new THREE.Vector3();
var _tmpCamDir = new THREE.Vector3();
// Ammo 检测更新计时器
var _ammoDetectTimer = 0;
// 【修复】空中判定滞回：避免单帧误判导致摇杆动画被阻断
var _airborneHysteresis = 0;
var AIRBORNE_HYSTERESIS_FRAMES = 3; // 连续3帧才真正判定为空中

// ===== 热管理：仅保留 Delta 截断 + DRS 降级兜底 =====
var _isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
// 不锁帧：rAF 已同步显示器刷新率，手动跳帧只会增加延迟
var MAX_DELTA = 0.033; // Delta 截断：防止后台返回后物理追赶（30fps 下限）
var _lastFrameTime = 0;
var _isPaused = false;
window._isPaused = false;

// DRS 动态分辨率 — 仅在持续掉帧时降级，正常情况保持 100%
var _drsScale = 1.0;
var _drsSlowFrames = 0;
var _drsFastFrames = 0;
var _drsBaseWidth = 0;
var _drsBaseHeight = 0;

function applyDRS() {
    if (!renderer || !window._canvasContainer) return;
    var w = Math.round(_drsBaseWidth * _drsScale);
    var h = Math.round(_drsBaseHeight * _drsScale);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
}
// 暴露 DRS 和 renderer 给 thermal-system.js 使用
window._applyDRS = applyDRS;
window._renderer = renderer;

setTimeout(function() {
    var c = document.getElementById('canvas-container');
    if (c) {
        _drsBaseWidth = c.clientWidth;
        _drsBaseHeight = c.clientHeight;
        window._canvasContainer = c;
    }
}, 100);

function animate(time) {
    requestAnimationFrame(animate);

    // 页面不可见时硬休眠
    if (window._isPaused || _isPaused) return;

    var frameStart = performance.now();
    _lastFrameTime = time || performance.now();
    window._lastFrameTime = _lastFrameTime;

    // 温控系统帧率采样
    if (window.ThermalSystem) ThermalSystem.tick(frameStart);
    // GPU 分帧上传队列 tick（限流上传纹理/几何体）
    if (window.GPUUploadQueue) GPUUploadQueue.tick();

    var rawDelta = clock.getDelta();
    // Delta 截断：防止后台返回后物理追赶
    var delta = Math.min(rawDelta, MAX_DELTA);
    var elapsed = clock.getElapsedTime();

    // 物理速度计算 — 直接在主线程内联（替代 physicsWorker，消除 1 帧延迟）
    if (physicsMode && window._computePhysVelocity) {
        window._computePhysVelocity(
            joystickState.active,
            joystickState.dx, joystickState.dz, joystickState.force,
            activeCamera.yaw || 0,
            true
        );
    }

    if (joystickState.active && positionCorrectModule.isLerping()) { positionCorrectModule.forceStopLerp(); }

    if (activeCamera && model && body) {
        // Non-physics mode: use main-thread handleMovement
        if (!(physicsMode && physicsModule.isReady && physicsModule.isReady())) {
            handleMovement(delta, activeCamera, model, body, false, joystickState, MAX_MOVE_SPEED);
        } else {
            // Physics mode: joystick + camera data sent via tick message above
        }

        // ============================================================
        // 【优化】动画打断与方向判定逻辑
        // ============================================================

        if (joystickState.active) {
            var activeDir = 'idle';
            var threshold = 0.25;  // lower threshold for direction detection
            var absDx = Math.abs(joystickState.dx);
            var absDz = Math.abs(joystickState.dz);
            var force = joystickState.force || 0;

            if (absDx > threshold || absDz > threshold) {
                // Determine 4 cardinal directions only (no diagonals)
                var baseDir;
                if (absDz > absDx) {
                    baseDir = joystickState.dz > 0 ? 'backward' : 'forward';
                } else {
                    baseDir = joystickState.dx > 0 ? 'right' : 'left';
                }

                // Distinguish walk vs run based on force threshold with hysteresis
                var runThreshold = animSettings.runForceThreshold || 0.6;
                var hysteresis = 0.15; // 滞回区宽度，防止阈值附近抖动
                if (core.getLastMappedDirection() === baseDir + '_run' || core.getLastMappedDirection() === baseDir) {
                    // 已有方向状态，使用滞回判定
                    if (core.getLastMappedDirection().indexOf('_run') !== -1) {
                        // 当前是 run，切回 walk 需要 force < runThreshold - hysteresis
                        activeDir = (force >= runThreshold - hysteresis) ? baseDir + '_run' : baseDir;
                    } else {
                        // 当前是 walk，切换到 run 需要 force >= runThreshold
                        activeDir = (force >= runThreshold) ? baseDir + '_run' : baseDir;
                    }
                } else {
                    // 无历史状态，使用原始阈值
                    activeDir = (force >= runThreshold) ? baseDir + '_run' : baseDir;
                }
                // 有方向输入，重置闲置计时器
                _joystickIdleTimer = 0;
            } else {
                // 摇杆在阈值内但未释放：累积闲置计时
                _joystickIdleTimer += delta;
            }

            if (activeDir !== 'idle') {
                // ============================================================
                // 【修复】空中状态检测：物理系统覆盖 + 滞回防抖，避免地面误判
                // ============================================================
                var airborne = false;
                if (physicsMode && physicsModule.isReady && physicsModule.isReady()) {
                    // 【增强】物理系统着地时，直接覆盖 Ammo 缓存，避免地面误判
                    var physicsGrounded = false;
                    if (physicsModule.getIsGrounded) {
                        physicsGrounded = physicsModule.getIsGrounded();
                    }
                    
                    if (physicsGrounded) {
                        airborne = false;
                        _airborneHysteresis = 0;
                    } else {
                        // 物理系统未着地，读取 Ammo 缓存 + 滞回
                        if (physicsModule.getToeDetectionResult) {
                            var ammoAirborne = physicsModule.getToeDetectionResult().airborne;
                            if (ammoAirborne) {
                                _airborneHysteresis++;
                            } else {
                                _airborneHysteresis = 0;
                            }
                            // 连续多帧才判定为空中，避免单帧误判
                            airborne = _airborneHysteresis >= AIRBORNE_HYSTERESIS_FRAMES;
                        } else {
                            airborne = isPlayerAirborne();
                        }
                    }
                }
                
                if (airborne) {
                    // 空中不播放摇杆移动动画，保持当前动画
                    if (_joystickIdleTimer < 0.15) {
                        _joystickIdleTimer += delta;
                    }
                } else {
                    // 地面状态：正常播放摇杆动画
                    // ============================================================
                    // 【优化】动作打断机制：移动时能自然打断其他动画（如跳跃、待机等）
                    // ============================================================
                    if (isActionPlaying) {
                        // 【修复】持续压杆贴近物体时，跳跃保护期内不强行切回移动动画，
                        // 避免起跳动作被立刻打断，导致视觉上像“卡在物体上”
                        var jumpProtected = physicsMode && physicsModule.isReady && physicsModule.isReady() && physicsModule.isJumpProtectionActive && physicsModule.isJumpProtectionActive();
                        if (!jumpProtected) {
                            // 立即清理动作监听器（无论是否着地，空中移动也要打断跳跃动画）
                            if (actionCleanup) {
                                mixer.removeEventListener('finished', actionCleanup);
                                actionCleanup = null;
                            }
                            isActionPlaying = false;

                            // 【优化】使用专用的强制打断路径：跳过 cooldown，极短过渡（60ms）
                            // 实现跳跃→移动的零延迟流畅切换
                            if (core.interruptToMovementAnim) {
                                core.interruptToMovementAnim(activeDir);
                            } else {
                                // fallback：老的 playJoystickAnim 路径
                                core.playJoystickAnim(activeDir, true);
                            }
                        }
                    } else {
                        // 正常移动方向切换（无动作打断）
                        core.playJoystickAnim(activeDir);
                    }
                }
            } else if (_joystickIdleTimer > 0.15 && core.getIsJoystickControlled()) {
                // 摇杆在阈值区间内停留超过 150ms，平滑过渡到 idle
                // 【优化】不再检查 !isActionPlaying，避免动作标志位残留阻塞 idle 过渡
                core.playAnimation(core.getIdleAnimIndex());
                core.setIsJoystickControlled(false);
            }
        } else {
            _joystickIdleTimer = 0;
            if (core.getIsJoystickControlled()) {
                core.playAnimation(core.getIdleAnimIndex());
                core.setIsJoystickControlled(false);
            }
        }

        // Ammo.js physics: use pre-computed velocity from physics worker
        if (physicsMode && physicsModule.isReady && physicsModule.isReady()) {
            // 【Vue 项目参考】每帧更新跳跃状态（土狼时间、保护期、缓冲管理）
            if (physicsModule.updateJumpState) {
                physicsModule.updateJumpState();
            }
            // 【修复】跳跃保护期内仍然允许水平速度更新（保留空中控制和斜向跳跃）
            if (_physActive) {
                physicsModule.setPlayerVelocity(_physVX, _physVZ);
                // Set target rotation (will be lerped below)
                if (isThirdPerson) {
                    _targetModelRotation = _physRotation;
                }
            } else {
                physicsModule.setPlayerVelocity(0, 0);
            }
            // 【Vue 项目参考】台阶跨越检测：在速度设置后、步进前执行
            // 使用 worker 输出的目标速度 (_physVX/_physVZ) 判断是否奔跑，而非刚体实际速度
            if (physicsModule.tryStepUpWithInput) {
                physicsModule.tryStepUpWithInput(_physVX, _physVZ);
            } else if (physicsModule.tryStepUp) {
                try { physicsModule.tryStepUp(); } catch(e) {}
            }
            physicsModule.stepSimulation(delta);
            physicsModule.syncPlayerToModel(model);
            
            // 【优化】在地面状态、无方向输入时，每 100ms 更新一次 Ammo 脚部检测缓存
            _ammoDetectTimer -= delta;
            if (_ammoDetectTimer <= 0) {
                _ammoDetectTimer = 0.1;
                if (coreModule && coreModule.getToeWorldPositions && physicsModule.updateToeDetection) {
                    var lPos = _loopV3Pool[0];
                    var rPos = _loopV3Pool[1];
                    if (coreModule.getToeWorldPositions(lPos, rPos)) {
                        physicsModule.updateToeDetection(
                            lPos.x, lPos.y, lPos.z,
                            rPos.x, rPos.y, rPos.z
                        );
                    }
                }
            }
            
            // 【优化】落地检测：从空中 → 地面时，平滑过渡到 idle 或移动动画
            // 使用物理引擎缓存的检测结果（优先）+ 物理系统 getIsGrounded 回退
            var _playerIsGroundedNow = false;
            if (physicsMode && physicsModule.isReady && physicsModule.isReady()) {
                if (physicsModule.getToeDetectionResult) {
                    _playerIsGroundedNow = physicsModule.getToeDetectionResult().grounded;
                }
                // 增强：Ammo 缓存可能因跳跃标志而延迟更新，使用物理系统 getIsGrounded 覆盖
                if (!_playerIsGroundedNow && physicsModule.getIsGrounded) {
                    _playerIsGroundedNow = physicsModule.getIsGrounded();
                }
            }
            
            if (_wasPlayerInAir && _playerIsGroundedNow && isActionPlaying && actions && actions.length > 0) {
                // 清除旧监听器，避免残留
                if (actionCleanup) {
                    mixer.removeEventListener('finished', actionCleanup);
                    actionCleanup = null;
                }
                isActionPlaying = false;
                // 使用 250ms 交叉淡入淡出，确保落地动画流畅过渡
                // 注意：activeDir 已在上面 if(joystickState.active) 块中定义，var 提升到函数作用域
                if (typeof activeDir !== 'undefined' && joystickState.active && activeDir !== 'idle') {
                    core.interruptToMovementAnim(activeDir);
                } else {
                    core.playAnimation(core.getIdleAnimIndex(), 0.25);
                }
            }
            _wasPlayerInAir = !_playerIsGroundedNow;
        } else if (physicsMode) {
            // Ammo 未就绪时退回简单重力
            model.position.y = applyGravity(model.position.x, model.position.y, model.position.z, delta);
            model.position.y = constrainToGround(model.position.y);
        }

        var followTarget = _tmpTarget;
        if (colliderVisual && colliderVisual.geometry) {
            // 复用预分配 Box3，避免每帧 new
            _tmpBox3.setFromBufferAttribute(colliderVisual.geometry.attributes.position);
            _tmpBox3.getCenter(followTarget);
            positionCorrectModule.recordPosition(followTarget);
            if (isThirdPerson) {
                if (!lastFollowTarget) { lastFollowTarget = followTarget.clone(); }
                lastFollowTarget.lerp(followTarget, 0.25);
                followTarget.copy(lastFollowTarget);
            } else {
                lastFollowTarget = null;
            }
        } else if (model) {
            _tmpBox3.setFromObject(model);
            _tmpBox3.getCenter(followTarget);
        }
        // Camera update — yaw/pitch 直接在主线程设置，无需 Worker
        // Ammo 物理模式下传入 0 速度避免 camera.update 再次移动角色
        if (physicsMode && physicsModule.isReady && physicsModule.isReady()) {
            activeCamera.update(delta, 0, 0, 0, elapsed, followTarget);
        } else {
            activeCamera.update(delta, joystickState.dx, joystickState.dz, joystickState.force, elapsed, followTarget);
        }

        if (!isThirdPerson) {
            // FPS "look around" — body quickly follows camera direction
            var targetYaw = activeCamera.yaw + Math.PI;
            var currentYaw = model.rotation.y;
            var diff = targetYaw - currentYaw;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            model.rotation.y += diff * 0.5;

            // Head pitch follows camera pitch (default model only)
            if (window.coreModule && window.coreModule.isDefaultModel() && core.hasHeadBone && core.hasHeadBone()) {
                window.__headPitch = window.__headPitch || 0;
                window.__headPitch += (activeCamera.pitch - window.__headPitch) * 0.35;
                core.setHeadRotation(window.__headPitch);
            }

            // Eye bones follow camera direction (default model only)
            if (window.coreModule && window.coreModule.isDefaultModel() && core.hasEyeBones && core.hasEyeBones()) {
                // Calculate yaw offset between camera look direction and body facing
                var lookYaw = activeCamera.yaw + Math.PI;
                var bodyYaw = model.rotation.y;
                var yawDiff = lookYaw - bodyYaw;
                while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
                while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
                // Clamp to realistic eye turn range
                var eyeYawOffset = Math.max(-0.4, Math.min(0.4, yawDiff));
                window.__headPitch = window.__headPitch || 0;
                core.setEyeRotation(eyeYawOffset, window.__headPitch * 0.6);
            }
        }
    }

    if (positionCorrectModule.isLerping()) { positionCorrectModule.updateLerp(model, delta); }

    if (mixer) {
        // 【修复】在 mixer.update 之前先将摇杆控制的动画时间包裹在 clip 区间内
        // 避免 mixer 处理到 clip.end 之外的帧导致的硬跳卡顿
        if (core.getIsJoystickControlled() && actions[core.getCurrentActionIndex()]) {
            var _wrapAction = actions[core.getCurrentActionIndex()];
            var _wrapDir = core.getLastMappedDirection();
            if (_wrapDir !== 'idle') {
                var _wrapSettings = core.getAnimSettings();
                var _wrapClip = _wrapSettings.clip[_wrapDir];
                if (_wrapClip && _wrapClip.end > _wrapClip.start && _wrapAction) {
                    var _loopLen = _wrapClip.end - _wrapClip.start;
                    if (_wrapAction.time > _wrapClip.end) {
                        // 包裹时间，保留超出部分的小数偏移，实现连续循环
                        var _overshoot = _wrapAction.time - _wrapClip.end;
                        _wrapAction.time = _wrapClip.start + (_overshoot % _loopLen);
                    }
                }
            }
        }

        if (coreModule.updateTransitionWeights) coreModule.updateTransitionWeights();
        if (window.legIKModule) legIKModule.restore();
        mixer.update(delta);
        // 【修复】mixer.update 后恢复模型 Y 位置（物理系统控制垂直位置）
        // 防止动作切换时（如跳跃→移动）动画的根运动覆盖物理 Y 位置导致瞬移地面
        if (physicsMode && physicsModule.isReady && physicsModule.isReady() && physicsModule.syncPlayerToModel) {
            physicsModule.syncPlayerToModel(model);
        }
        // 脚部 IK 更新 — 必须每帧执行，跳帧会导致 restore/update 交替产生抖动
        if (window.legIKModule) {
            legIKModule.update(delta);
            // 【修复抖动】在 IK 更新后，将台阶视觉偏移叠加到物理同步后的 Y 位置上
            // 而非让 IK 直接覆盖 model.position.y（会与 syncPlayerToModel 冲突导致抖动）
            if (legIKModule._pendingMeshOffsetY !== undefined && Math.abs(legIKModule._pendingMeshOffsetY) > 0.0001) {
                model.position.y += legIKModule._pendingMeshOffsetY;
            }
        }
    }
    if (!isLoading && !isBuildingCollider) {
        if (dynamicCollider && (core.getIsAnimationPlaying() || joystickState.active)) { core.requestWorkerUpdate(); }
    }

    // 后处理：二次校对——如果上述预包裹因 mix 步进仍然超出，执行最终回位
    // 【优化】移除 !isActionPlaying 条件，确保动作打断后移动动画的循环包裹不受阻
    if (core.getIsJoystickControlled() && core.getIsAnimationPlaying() && actions[core.getCurrentActionIndex()]) {
        var curAction = actions[core.getCurrentActionIndex()];
        var dirKey = core.getLastMappedDirection();
        if (dirKey !== 'idle') {
            var settings = core.getAnimSettings();
            var clip = settings.clip[dirKey];
            if (clip && clip.end > clip.start) {
                var loopLen = clip.end - clip.start;
                if (curAction.time > clip.end) {
                    var overshoot = curAction.time - clip.end;
                    curAction.time = clip.start + (overshoot % loopLen);
                }
            }
        }
    }

    if (positionCorrectModule.checkClipStop() && actionCleanup) { actionCleanup(); }

    // Smooth rotation lerp for model facing direction
    if (model && _targetModelRotation !== null && isThirdPerson) {
        var current = model.rotation.y;
        var target = _targetModelRotation;
        // Shortest path angular lerp
        var diff = target - current;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        var lerpFactor = 1 - Math.exp(-_rotationLerpSpeed * delta);
        model.rotation.y = current + diff * lerpFactor;
    }

    // ===== 3D 空间音更新 =====
    if (window.AudioSystem && AudioSystem.setListener && model) {
        var playerPos = model.position;
        camera.getWorldDirection(_tmpCamDir);
        AudioSystem.setListener(
            playerPos.x, playerPos.y, playerPos.z,
            _tmpCamDir.x, _tmpCamDir.y, _tmpCamDir.z,
            0, 1, 0
        );

        // 音频源更新 — 每 3 帧更新一次，避免每帧遍历场景
        if (window._audioSrcFrame === undefined) window._audioSrcFrame = 0;
        if ((++window._audioSrcFrame) % 3 === 0 && scene && scene.children) {
            for (var i = 0; i < scene.children.length; i++) {
                var obj = scene.children[i];
                if (obj.userData && obj.userData.audioRef && obj.userData.audioRef.position) {
                    var ap = obj.userData.audioRef.position;
                    AudioSystem.updateSpatialSource(obj.userData.audioRef, ap.x, ap.y, ap.z);
                }
            }
        }

        // 更新视频 3D 音频位置 — 每 5 帧更新一次，复用预分配对象
        if (window._audioFrame === undefined) window._audioFrame = 0;
        if (window.uiModule && uiModule.screenVideoState && uiModule.screenVideoState._panner && window.pcScreenMesh) {
            if ((++window._audioFrame) % 5 === 0) {
                _tmpBox3.setFromObject(window.pcScreenMesh);
                _tmpBox3.getCenter(_tmpCenter);
                try {
                    if (uiModule.screenVideoState._panner.positionX) {
                        uiModule.screenVideoState._panner.positionX.value = _tmpCenter.x;
                        uiModule.screenVideoState._panner.positionY.value = _tmpCenter.y;
                        uiModule.screenVideoState._panner.positionZ.value = _tmpCenter.z;
                    } else if (uiModule.screenVideoState._panner.setPosition) {
                        uiModule.screenVideoState._panner.setPosition(_tmpCenter.x, _tmpCenter.y, _tmpCenter.z);
                    }
                } catch (e) {
                    // ignore
                }
            }
        }
    }

    renderer.render(scene, camera);

    // ===== DRS 动态分辨率：仅持续掉帧时降级，正常情况不干预 =====
    if (_isMobile && frameStart) {
        var frameTime = performance.now() - frameStart;
        if (frameTime > 33) { // >33ms = 低于30fps
            _drsSlowFrames++;
            _drsFastFrames = 0;
            // 连续 10 帧掉帧才降级（避免偶发卡顿触发）
            if (_drsSlowFrames >= 10 && _drsScale > 0.6) {
                _drsScale = Math.max(0.6, _drsScale - 0.1);
                applyDRS();
                _drsSlowFrames = 0;
                console.log('[DRS] 降级至', Math.round(_drsScale * 100) + '%');
            }
        } else if (frameTime < 20) {
            _drsFastFrames++;
            _drsSlowFrames = 0;
            // 连续 300 帧(5秒@60fps)流畅才升级
            if (_drsFastFrames >= 300 && _drsScale < 1.0) {
                _drsScale = Math.min(1.0, _drsScale + 0.05);
                applyDRS();
                _drsFastFrames = 0;
                console.log('[DRS] 升级至', Math.round(_drsScale * 100) + '%');
            }
        } else {
            _drsSlowFrames = 0;
            _drsFastFrames = 0;
        }

        // ===== 温控应急：连续掉帧时降低视频纹理采样 =====
        if (_drsSlowFrames >= 5 && window.uiModule && uiModule.screenVideoState && uiModule.screenVideoState.texture) {
            var vt = uiModule.screenVideoState.texture;
            if (!vt._emergencyReduced) {
                vt.repeat.set(2, 2); // 纹理采样降半
                vt._emergencyReduced = true;
                console.log('[Thermal] 视频纹理降级触发');
            }
        } else if (_drsFastFrames >= 100 && window.uiModule && uiModule.screenVideoState && uiModule.screenVideoState.texture) {
            var vt2 = uiModule.screenVideoState.texture;
            if (vt2._emergencyReduced) {
                vt2.repeat.set(1, 1); // 恢复
                vt2._emergencyReduced = false;
                console.log('[Thermal] 视频纹理恢复');
            }
        }
    }
}
animate();
