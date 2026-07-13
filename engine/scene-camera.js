// scene-camera.js — 场景/相机/渲染器初始化 + 第三人称相机控制器
(function() {
    var scene = new THREE.Scene();
    var loader = new THREE.CubeTextureLoader();
    loader.setPath('./assets/textures/skybox/');
    scene.background = loader.load(['skybox_px.jpg', 'skybox_nx.jpg', 'skybox_py.jpg', 'skybox_ny.jpg', 'skybox_pz.jpg', 'skybox_nz.jpg']);
    // 恢复环境贴图（PBR 材质需要环境反射才不会看起来扁平/模糊）
    scene.environment = scene.background;

    var camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(4, 3, 8);

    var container = document.getElementById('canvas-container');
    var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
    // 关键：保留高像素比（至少 min(DPR, 2)），否则画面严重模糊
    // 现代手机 GPU 完全可以处理 2x 像素比
    var renderer = new THREE.WebGLRenderer({
        antialias: true, // 重新开启抗锯齿，消除边缘锯齿
        powerPreference: "high-performance",
        alpha: false,
        stencil: false,
        depth: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    // 重新开启 PCFSoft 阴影（256 太模糊，改用 512 + PCFSoft）
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    // 性能优化：避免 renderer.render 内部重复清屏
    renderer.autoClear = true;
    renderer.sortObjects = true;
    container.appendChild(renderer.domElement);

    // ===== WebGL 上下文丢失/恢复 =====
    var canvas = renderer.domElement;
    var _contextLostTextures = [];
    var _contextRestoring = false;

    canvas.addEventListener('webglcontextlost', function(e) {
        e.preventDefault();
        console.warn('[WebGL] 上下文丢失，暂停渲染');
        if (window._isPaused !== undefined) window._isPaused = true;
        // 收集所有纹理引用用于恢复
        _contextLostTextures = [];
        scene.traverse(function(obj) {
            if (obj.material) {
                var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                mats.forEach(function(mat) {
                    for (var key in mat) {
                        if (mat[key] && mat[key].isTexture && _contextLostTextures.indexOf(mat[key]) === -1) {
                            _contextLostTextures.push(mat[key]);
                        }
                    }
                });
            }
        });
    });

    canvas.addEventListener('webglcontextrestored', function() {
        console.log('[WebGL] 上下文恢复，流式重传纹理');
        _contextRestoring = true;
        var index = 0;
        function uploadNextTexture() {
            if (index >= _contextLostTextures.length) {
                _contextRestoring = false;
                window._isPaused = false;
                console.log('[WebGL] 纹理重传完成，恢复渲染');
                return;
            }
            _contextLostTextures[index].needsUpdate = true;
            index++;
            requestAnimationFrame(uploadNextTexture);
        }
        uploadNextTexture();
    });

    // ===== 页面可见性硬休眠 =====
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            window._isPaused = true;
            clock.stop && clock.stop();
            // 暂停视频播放，避免后台解码空转
            if (window.uiModule && uiModule.screenVideoState && uiModule.screenVideoState.video) {
                try { uiModule.screenVideoState.video.pause(); } catch (e) {}
            }
            // 挂起音频上下文，省电
            if (window.uiModule && uiModule.screenVideoState && uiModule.screenVideoState._audioCtx) {
                try { uiModule.screenVideoState._audioCtx.suspend(); } catch (e) {}
            }
            // 暂停 WebCodecs 解码器
            if (window.VideoDecodeBridge && VideoDecodeBridge.isUsingWebCodecs()) {
                VideoDecodeBridge.pause();
            }
            console.log('[Visibility] 页面不可见，渲染暂停');
        } else {
            window._isPaused = false;
            if (clock.start) clock.start();
            if (clock.getDelta) clock.getDelta();
            window._lastFrameTime = 0;
            // 恢复 WebCodecs 解码器
            if (window.VideoDecodeBridge && VideoDecodeBridge.isUsingWebCodecs()) {
                VideoDecodeBridge.resume();
            }
            // 恢复视频播放
            if (window.uiModule && uiModule.screenVideoState && uiModule.screenVideoState.video && uiModule.screenVideoState.active) {
                try {
                    uiModule.screenVideoState.video.play().catch(function() {});
                    // 恢复音频上下文
                    if (uiModule.screenVideoState._audioCtx && uiModule.screenVideoState._audioCtx.state === 'suspended') {
                        uiModule.screenVideoState._audioCtx.resume().catch(function() {});
                    }
                } catch (e) {}
            }
            console.log('[Visibility] 页面恢复，渲染继续');
        }
    });

    // 文件输入点击时也暂停高负载渲染
    document.addEventListener('focusin', function(e) {
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'file') {
            window._isPaused = true;
        }
    });
    document.addEventListener('focusout', function(e) {
        if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'file') {
            window._isPaused = false;
            if (clock.getDelta) clock.getDelta();
            window._lastFrameTime = 0;
        }
    });

    window.addEventListener('resize', function() {
        var width = container.clientWidth;
        var height = container.clientHeight;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
    });

    // ========================================================
    // 系统一：第三人称相机独立控制器
    // ========================================================
    function ThirdPersonCamera(camera, renderer, player, opt) {
        this.camera = camera;
        this.renderer = renderer;
        this.player = player;
        opt = opt || {};
        this.moveSpeed = opt.moveSpeed !== undefined ? opt.moveSpeed : 0.15;
        this.rotateSpeed = opt.rotateSpeed !== undefined ? opt.rotateSpeed : 0.006;
        this.maxPitch = opt.maxPitch !== undefined ? opt.maxPitch : Math.PI / 2.1; 
        this.eyeHeight = opt.eyeHeight !== undefined ? opt.eyeHeight : 0.0;
        this.offsetY = opt.offsetY !== undefined ? opt.offsetY : 2.5;
        this.offsetZ = opt.offsetZ !== undefined ? opt.offsetZ : 6;
        this.positionLerpFactor = opt.lerpFactor !== undefined ? opt.lerpFactor : 0.1;
        this.runShakeAmplitude = opt.runShakeAmplitude !== undefined ? opt.runShakeAmplitude : 0.02;
        this.runShakeFrequency = opt.runShakeFrequency !== undefined ? opt.runShakeFrequency : 1.8;
        this.yaw = 0;
        this.pitch = 0.3;
        this.touchMap = new Map();
        this._tpShakeOffset = new THREE.Vector3();
        this._tpWorldShake = new THREE.Vector3();
        this._tpEuler = new THREE.Euler();
        this._offset = new THREE.Vector3();
        this._initTouchEvents();
        this._initMouseEvents();
    }
    ThirdPersonCamera.prototype.saveState = function() {
        this._savedPosition = this.camera.position.clone();
        this._savedYaw = this.yaw;
        this._savedPitch = this.pitch;
        this._savedSmoothPos = this._tpSmoothPos ? this._tpSmoothPos.clone() : null;
    };

    ThirdPersonCamera.prototype.restoreState = function() {
        if (this._savedPosition) {
            this.camera.position.copy(this._savedPosition);
        }
        if (this._savedYaw !== undefined) { this.yaw = this._savedYaw; }
        if (this._savedPitch !== undefined) { this.pitch = this._savedPitch; }
        // Snap smooth pos to orbit position (avoid lerp from FP eye position)
        if (this._savedSmoothPos) {
            this._tpSmoothPos.copy(this._savedSmoothPos);
        } else if (this._tpSmoothPos) {
            var target = this.player.position.clone().add(new THREE.Vector3(0, 1.5, 0));
            var radius = Math.sqrt(this.offsetY * this.offsetY + this.offsetZ * this.offsetZ);
            var x = radius * Math.sin(this.yaw) * Math.cos(this.pitch);
            var y = radius * Math.sin(this.pitch) + 0.5;
            var z = radius * Math.cos(this.yaw) * Math.cos(this.pitch);
            this._tpSmoothPos.set(target.x + x, target.y + y, target.z + z);
        }
    };

    ThirdPersonCamera.prototype._initTouchEvents = function() {
        var canvas = this.renderer.domElement;
        var touchMap = this.touchMap;
        var R = 0.5;
        var self = this;
        var onTouchStart = function(e) {
            var touches = e.changedTouches;
            for (var i = 0; i < touches.length; i++) {
                var touch = touches[i];
                touchMap.set(touch.identifier, {
                    type: touch.clientX > window.innerWidth * R ? 'rotate' : 'unknown',
                    lastX: touch.clientX,
                    lastY: touch.clientY
                });
            }
        };
        var onTouchMove = function(e) {
            var touches = e.changedTouches;
            for (var i = 0; i < touches.length; i++) {
                var touch = touches[i];
                var id = touch.identifier;
                if (touchMap.has(id)) {
                    var rec = touchMap.get(id);
                    if (rec.type === 'rotate') {
                        var dx = touch.clientX - rec.lastX;
                        var dy = touch.clientY - rec.lastY;
                        // Directly apply rotation for immediate response (bypass worker latency)
                        self.yaw -= dx * self.rotateSpeed;
                        self.pitch += dy * self.rotateSpeed;
                        self.pitch = Math.max(-self.maxPitch, Math.min(self.maxPitch, self.pitch));
                        rec.lastX = touch.clientX;
                        rec.lastY = touch.clientY;
                    } else {
                        rec.lastX = touch.clientX;
                        rec.lastY = touch.clientY;
                    }
                }
            }
        };
        var onTouchEnd = function(e) {
            var touches = e.changedTouches;
            for (var i = 0; i < touches.length; i++) {
                touchMap.delete(touches[i].identifier);
            }
        };
        var onTouchCancel = function(e) {
            var touches = e.changedTouches;
            for (var i = 0; i < touches.length; i++) {
                touchMap.delete(touches[i].identifier);
            }
        };
        canvas.addEventListener('touchstart', onTouchStart, { passive: true });
        canvas.addEventListener('touchmove', onTouchMove, { passive: true });
        canvas.addEventListener('touchend', onTouchEnd);
        canvas.addEventListener('touchcancel', onTouchCancel);
        canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    };
    // ============================================================
    // 鼠标旋转相机（PC 端：右键按住 → 跟随指针旋转，参考正常 3D 游戏）
    // ============================================================
    ThirdPersonCamera.prototype._initMouseEvents = function() {
        var canvas = this.renderer.domElement;
        var self = this;
        var isDragging = false;
        var lastX = 0, lastY = 0;

        var onMouseDown = function(e) {
            if (e.button === 2) { // 右键
                isDragging = true;
                lastX = e.clientX;
                lastY = e.clientY;
                e.preventDefault();
            }
        };
        var onMouseMove = function(e) {
            if (!isDragging) return;
            var dx = e.clientX - lastX;
            var dy = e.clientY - lastY;
            self.yaw -= dx * self.rotateSpeed;
            self.pitch += dy * self.rotateSpeed;
            self.pitch = Math.max(-self.maxPitch, Math.min(self.maxPitch, self.pitch));
            lastX = e.clientX;
            lastY = e.clientY;
        };
        var onMouseUp = function(e) {
            if (e.button === 2) isDragging = false;
        };

        canvas.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('mouseleave', function() { isDragging = false; });
        // 阻止右键菜单
        canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    };
    ThirdPersonCamera.prototype.update = function(delta, moveX, moveY, force, elapsedTime, customTarget) {
        var pos = this.player.position;
        var speed = this.moveSpeed;
        var isMoving = (moveX !== 0 || moveY !== 0);
        if (isMoving) {
            var inputLen = Math.sqrt(moveX * moveX + moveY * moveY);
            var normFactor = inputLen > 0.001 ? 1.0 / inputLen : 0;
            var nx = moveX * normFactor;
            var ny = moveY * normFactor;
            var scaledSpeed = speed * Math.min(inputLen, 1.0);
            var forward = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, this.yaw, 0));
            var right = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, this.yaw, 0));
            var moveVec = new THREE.Vector3();
            moveVec.addScaledVector(forward, -ny * scaledSpeed);
            moveVec.addScaledVector(right, nx * scaledSpeed);
            var bound = 500;
            pos.x = Math.max(-bound, Math.min(bound, pos.x + moveVec.x * delta));
            pos.z = Math.max(-bound, Math.min(bound, pos.z + moveVec.z * delta));
            if (moveVec.x !== 0 || moveVec.z !== 0) {
                var targetRot = Math.atan2(moveVec.x, moveVec.z);
                // Shortest path angular lerp for smooth turning
                var currentRot = this.player.rotation.y;
                var rDiff = targetRot - currentRot;
                while (rDiff > Math.PI) rDiff -= Math.PI * 2;
                while (rDiff < -Math.PI) rDiff += Math.PI * 2;
                var rLerp = 1 - Math.exp(-12 * delta);
                this.player.rotation.y = currentRot + rDiff * rLerp;
            }
        }
        var target = (customTarget) ? customTarget : this.player.position.clone().add(new THREE.Vector3(0, 1.5, 0));
        var shakeX = 0, shakeY = 0;
        if (isMoving) {
            var elapsed = elapsedTime || 0;
            var amp = this.runShakeAmplitude * Math.min(inputLen, 1.0);
            var freq = this.runShakeFrequency;
            shakeX = Math.sin(elapsed * freq) * amp;
            shakeY = Math.cos(elapsed * freq * 0.7) * amp * 0.5;
        }
        var shakeOffset = this._tpShakeOffset.set(shakeX, shakeY, 0);
        var radius = Math.sqrt(this.offsetY * this.offsetY + this.offsetZ * this.offsetZ);
        var x = radius * Math.sin(this.yaw) * Math.cos(this.pitch);
        var y = radius * Math.sin(this.pitch);
        var z = radius * Math.cos(this.yaw) * Math.cos(this.pitch);
        var offset = this._offset.set(x, y, z);
        offset.y += 0.5;
        var ideal = target.clone().add(offset);
        var worldShake = this._tpWorldShake.copy(shakeOffset).applyEuler(this._tpEuler.set(0, this.yaw, 0));
        ideal.add(worldShake);
        this.camera.position.lerp(ideal, this.positionLerpFactor);
        this.camera.lookAt(target);
    };
    // ========================================================
    // 系统二：第一人称相机独立控制器
    // ========================================================
    function FirstPersonCamera(camera, renderer, player, opt) {
        this.camera = camera;
        this.renderer = renderer;
        this.player = player;
        opt = opt || {};
        this.moveSpeed = opt.moveSpeed !== undefined ? opt.moveSpeed : 0.15;
        this.rotateSpeed = opt.rotateSpeed !== undefined ? opt.rotateSpeed : 0.012;
        this.maxPitch = opt.maxPitch !== undefined ? opt.maxPitch : Math.PI / 2.5;
        this.runShakeAmplitude = opt.runShakeAmplitude !== undefined ? opt.runShakeAmplitude : 0.02;
        this.runShakeFrequency = opt.runShakeFrequency !== undefined ? opt.runShakeFrequency : 1.8;
        this.yaw = 0;
        this.pitch = 0;
        this.touchMap = new Map();
        this._targetYaw = this.yaw;
        this._targetPitch = this.pitch;
        this.touchRotLerpFactor = 0.35;
        this._initTouchEvents();
        this.fpLerpFactor = 0.28;
        this._fpSmoothPos = new THREE.Vector3();
        this._fpInitialized = false;
        this._fpEyeTarget = new THREE.Vector3();
        this._fpForwardDir = new THREE.Vector3();
        this._fpOffset = new THREE.Vector3();
        this._fpShakeOffset = new THREE.Vector3();
        // FP head bone tracking
        this._fpBoneQuat = new THREE.Quaternion();
        this._fpBoneEuler = new THREE.Euler();
        this._fpCamEuler = new THREE.Euler(0, 0, 0, 'YXZ');
        this._fpLookDir = new THREE.Vector3(0, 0, -1);
        this._fpUpDir = new THREE.Vector3(0, 1, 0);
        this._initMouseEvents();
    }
    FirstPersonCamera.prototype._initTouchEvents = function() {
        var canvas = this.renderer.domElement;
        var touchMap = this.touchMap;
        var self = this;
        var onTouchStart = function(e) {
            var touches = e.changedTouches;
            for (var i = 0; i < touches.length; i++) {
                var touch = touches[i];
                touchMap.set(touch.identifier, {
                    lastX: touch.clientX,
                    lastY: touch.clientY
                });
            }
        };
        var onTouchMove = function(e) {
            var touches = e.changedTouches;
            for (var i = 0; i < touches.length; i++) {
                var touch = touches[i];
                var id = touch.identifier;
                if (touchMap.has(id)) {
                    var rec = touchMap.get(id);
                    var dx = touch.clientX - rec.lastX;
                    var dy = touch.clientY - rec.lastY;
                    // Directly apply rotation for immediate response
                    self.yaw -= dx * self.rotateSpeed;
                    self.pitch -= dy * self.rotateSpeed;
                    self.pitch = Math.max(-self.maxPitch, Math.min(self.maxPitch, self.pitch));
                    rec.lastX = touch.clientX;
                    rec.lastY = touch.clientY;
                }
            }
        };
        var onTouchEnd = function(e) {
            var touches = e.changedTouches;
            for (var i = 0; i < touches.length; i++) {
                touchMap.delete(touches[i].identifier);
            }
        };
        var onTouchCancel = function(e) {
            var touches = e.changedTouches;
            for (var i = 0; i < touches.length; i++) {
                touchMap.delete(touches[i].identifier);
            }
        };
        canvas.addEventListener('touchstart', onTouchStart, { passive: true });
        canvas.addEventListener('touchmove', onTouchMove, { passive: true });
        canvas.addEventListener('touchend', onTouchEnd);
        canvas.addEventListener('touchcancel', onTouchCancel);
        canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    };
    // ============================================================
    // 鼠标右键环顾（第一人称：右键按住 → 跟随指针环顾四周）
    // ============================================================
    FirstPersonCamera.prototype._initMouseEvents = function() {
        var canvas = this.renderer.domElement;
        var self = this;
        var isDragging = false;
        var lastX = 0, lastY = 0;

        var onMouseDown = function(e) {
            if (e.button === 2) { // 右键
                isDragging = true;
                lastX = e.clientX;
                lastY = e.clientY;
                e.preventDefault();
            }
        };
        var onMouseMove = function(e) {
            if (!isDragging) return;
            var dx = e.clientX - lastX;
            var dy = e.clientY - lastY;
            self.yaw -= dx * self.rotateSpeed;
            self.pitch -= dy * self.rotateSpeed;  // 【修复】第一人称鼠标向上视角向上
            self.pitch = Math.max(-self.maxPitch, Math.min(self.maxPitch, self.pitch));
            lastX = e.clientX;
            lastY = e.clientY;
        };
        var onMouseUp = function(e) {
            if (e.button === 2) isDragging = false;
        };

        canvas.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('mouseleave', function() { isDragging = false; });
        // 阻止右键菜单
        canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    };
    FirstPersonCamera.prototype.update = function(delta, moveX, moveY, force, elapsedTime, customTarget) {
        var pos = this.player.position;
        var speed = this.moveSpeed;
        var isMoving = (moveX !== 0 || moveY !== 0);
        if (isMoving) {
            var inputLen = Math.sqrt(moveX * moveX + moveY * moveY);
            var normFactor = inputLen > 0.001 ? 1.0 / inputLen : 0;
            var nx = moveX * normFactor;
            var ny = moveY * normFactor;
            var scaledSpeed = speed * Math.min(inputLen, 1.0);
            var forward = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, this.yaw, 0));
            var right = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, this.yaw, 0));
            var moveVec = new THREE.Vector3();
            moveVec.addScaledVector(forward, -ny * scaledSpeed);
            moveVec.addScaledVector(right, nx * scaledSpeed);
            var bound = 500;
            pos.x = Math.max(-bound, Math.min(bound, pos.x + moveVec.x * delta));
            pos.z = Math.max(-bound, Math.min(bound, pos.z + moveVec.z * delta));
        }
        // Determine eye/anchor position
        var eyeTarget = this._fpEyeTarget.set(0, 0, 0);
        var foundFPHead = false;
        var foundBoneQuat = false;

        // Priority: head_15 bone > eye center > head bone > fallback
        if (window.coreModule && window.coreModule.hasFPHeadBone()) {
            foundFPHead = window.coreModule.getFPHeadWorldPos(eyeTarget);
            foundBoneQuat = window.coreModule.getFPHeadWorldQuaternion(this._fpBoneQuat);
        }
        if (!foundFPHead && window.coreModule && window.coreModule.isDefaultModel() && window.coreModule.hasEyeBones()) {
            if (window.coreModule.getEyeCenterWorldPos(eyeTarget)) {
                foundFPHead = true;
            }
        }
        if (!foundFPHead && window.coreModule && window.coreModule.isDefaultModel() && window.coreModule.hasHeadBone()) {
            var bonePos = new THREE.Vector3();
            if (window.coreModule.getHeadWorldPos(bonePos)) {
                eyeTarget.copy(bonePos).add(new THREE.Vector3(0, 0.15, 0));
                foundFPHead = true;
            }
        }
        if (!foundFPHead) {
            eyeTarget.set(this.player.position.x, this.player.position.y + 1.85, this.player.position.z);
        }

        var shakeX = 0, shakeY = 0;
        if (isMoving) {
            var elapsed = elapsedTime || 0;
            var amp = this.runShakeAmplitude * Math.min(inputLen, 1.0);
            var freq = this.runShakeFrequency;
            shakeX = Math.sin(elapsed * freq) * amp;
            shakeY = Math.cos(elapsed * freq * 0.7) * amp * 0.5;
        }
        var shakeOffset = this._fpShakeOffset.set(shakeX, shakeY, 0);
        if (!this._fpInitialized) {
            this._fpSmoothPos.copy(eyeTarget);
            this._fpInitialized = true;
        }
        this._fpSmoothPos.lerp(eyeTarget, this.fpLerpFactor);
        this._fpSmoothPos.add(shakeOffset);

        // Camera position
        var isDefault = window.coreModule && window.coreModule.isDefaultModel();
        if (isDefault && foundFPHead) {
            // Offset forward from bone along bone's local forward
            if (foundBoneQuat) {
                this._fpLookDir.set(0, 0, -1).applyQuaternion(this._fpBoneQuat);
            } else {
                this._fpLookDir.set(0, 0, -1).applyEuler(new THREE.Euler(0, this.yaw, 0));
            }
            this.camera.position.copy(this._fpSmoothPos).addScaledVector(this._fpLookDir, 0.12).add(new THREE.Vector3(0, 0.06, 0));
        } else {
            this.camera.position.copy(this._fpSmoothPos).add(new THREE.Vector3(0, 0.05, 0));
        }

        // Camera rotation: bone orientation + user touch offset
        if (foundBoneQuat) {
            // Start from bone world orientation
            this._fpBoneEuler.setFromQuaternion(this._fpBoneQuat, 'YXZ');
            // Overlay user yaw/pitch as offsets on top of bone orientation
            var baseYaw = this._fpBoneEuler.y;
            var basePitch = this._fpBoneEuler.x;
            // User touch provides relative offsets from current absolute yaw
            // Convert absolute camera yaw to relative offset from bone yaw
            var userYawOffset = this.yaw - baseYaw;
            this._fpCamEuler.set(
                basePitch + this.pitch,  // bone pitch + user pitch offset
                baseYaw + userYawOffset, // bone yaw + user yaw offset (= this.yaw)
                0,
                'YXZ'
            );
        } else {
            this._fpCamEuler.set(this.pitch, this.yaw, 0, 'YXZ');
        }
        this.camera.rotation.copy(this._fpCamEuler);
    };
    // ========================================================
    // 导出模块
    // ========================================================
    window.cameraModule = {
        scene: scene,
        camera: camera,
        renderer: renderer,
        ThirdPersonCamera: ThirdPersonCamera,
        FirstPersonCamera: FirstPersonCamera
    };
})();
