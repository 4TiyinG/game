// physics-tick.worker.js — Offloads physics math & movement calculations from main thread
// Computes player velocity from joystick input + camera yaw, with smoothing
(function() {
    // Input state (from main thread via messages)
    var joystick = { dx: 0, dz: 0, force: 0, active: false };
    var cameraYaw = 0;
    var walkSpeed = 3.2;       // 行走速度（原 2.8）
    var runSpeed = 5.8;        // 奔跑速度（新增）
    var maxMoveSpeed = walkSpeed;
    var physicsEnabled = false;

    // Smoothing state for velocity
    var currentVX = 0, currentVZ = 0;
    var velocitySmoothFactor = 0.35; // higher = more responsive, lower = smoother

    // Output: computed world-space velocity
    var outputVX = 0, outputVZ = 0;
    var outputNeedsUpdate = true;

    // Precomputed direction vectors (avoid trig every frame)
    var lastComputedYaw = -999;
    var fwdX = 0, fwdZ = -1, rgtX = 1, rgtZ = 0;

    function updateDirectionVectors() {
        if (cameraYaw === lastComputedYaw) return;
        lastComputedYaw = cameraYaw;
        fwdX = -Math.sin(cameraYaw);
        fwdZ = -Math.cos(cameraYaw);
        rgtX = Math.cos(cameraYaw);
        rgtZ = -Math.sin(cameraYaw);
    }

    function computeVelocity() {
        if (!physicsEnabled || !joystick.active) {
            // Smoothly decelerate to zero (更快速停止，避免拖尾感)
            currentVX *= 0.82;
            currentVZ *= 0.82;
            if (Math.abs(currentVX) < 0.001 && Math.abs(currentVZ) < 0.001) {
                currentVX = 0; currentVZ = 0;
                outputNeedsUpdate = false; // no change, skip message
                return;
            }
        } else {
            var inputLen = Math.sqrt(joystick.dx * joystick.dx + joystick.dz * joystick.dz);
            if (inputLen > 0.01) {
                updateDirectionVectors();
                var normFactor = 1.0 / inputLen;
                var nx = joystick.dx * normFactor;
                var nz = joystick.dz * normFactor;
                
                // 【速度优化】根据输入力度动态切换走/跑速度
                // force >= 0.6 视为奔跑（与动画系统 runForceThreshold 保持一致）
                var targetSpeed = joystick.force >= 0.6 ? runSpeed : walkSpeed;
                var scaledSpeed = targetSpeed * Math.min(inputLen, 1.0);
                
                var targetVX = (-nz * fwdX + nx * rgtX) * scaledSpeed;
                var targetVZ = (-nz * fwdZ + nx * rgtZ) * scaledSpeed;
                // Smooth velocity (exponential moving average)
                var sf = velocitySmoothFactor;
                currentVX += (targetVX - currentVX) * sf;
                currentVZ += (targetVZ - currentVZ) * sf;
            } else {
                currentVX *= 0.82;
                currentVZ *= 0.82;
            }
        }
        outputVX = currentVX;
        outputVZ = currentVZ;
        outputNeedsUpdate = true;
    }

    function computeModelRotation() {
        if (!physicsEnabled || !joystick.active) return 0;
        var inputLen = Math.sqrt(joystick.dx * joystick.dx + joystick.dz * joystick.dz);
        if (inputLen < 0.01) return 0;
        updateDirectionVectors();
        var normFactor = 1.0 / inputLen;
        var nx = joystick.dx * normFactor;
        var nz = joystick.dz * normFactor;
        var vx = (-nz * fwdX + nx * rgtX);
        var vz = (-nz * fwdZ + nx * rgtZ);
        return Math.atan2(vx, vz);
    }

    self.onmessage = function(e) {
        var data = e.data;
        switch (data.type) {
            case 'joystick': {
                if (data.action === 'move') {
                    joystick.dx = data.dx;
                    joystick.dz = data.dz;
                    joystick.force = data.force;
                    joystick.active = true;
                } else if (data.action === 'end') {
                    joystick.active = false;
                    joystick.dx = 0; joystick.dz = 0; joystick.force = 0;
                }
                computeVelocity();
                break;
            }

            case 'cameraYaw': {
                cameraYaw = data.yaw;
                if (joystick.active) computeVelocity();
                break;
            }

            case 'physicsMode': {
                physicsEnabled = !!data.enabled;
                if (!physicsEnabled) {
                    currentVX = 0; currentVZ = 0;
                    outputVX = 0; outputVZ = 0;
                    outputNeedsUpdate = true;
                }
                break;
            }

            case 'maxSpeed': {
                maxMoveSpeed = data.speed;
                break;
            }

            case 'tick': {
                // Main thread sends combined tick with joystick + camera data
                if (data.jActive !== undefined) {
                    joystick.active = !!data.jActive;
                    joystick.dx = data.jDx || 0;
                    joystick.dz = data.jDz || 0;
                    joystick.force = data.jForce || 0;
                    if (!joystick.active) {
                        joystick.dx = 0; joystick.dz = 0; joystick.force = 0;
                    }
                }
                if (data.camYaw !== undefined) {
                    cameraYaw = data.camYaw;
                }
                // Main thread requests velocity update each frame
                if (physicsEnabled) computeVelocity();
                if (outputNeedsUpdate || joystick.active) {
                    self.postMessage({
                        type: 'velocity',
                        vx: outputVX,
                        vz: outputVZ,
                        rotation: computeModelRotation(),
                        active: joystick.active ? 1 : 0
                    });
                    outputNeedsUpdate = false;
                }
                break;
            }

            case 'getConfig': {
                self.postMessage({
                    type: 'config',
                    velocitySmoothFactor: velocitySmoothFactor
                });
                break;
            }

            case 'setConfig': {
                if (data.velocitySmoothFactor !== undefined) {
                    velocitySmoothFactor = data.velocitySmoothFactor;
                }
                break;
            }
        }
    };
})();
