// input-smooth.worker.js — Event-driven input processing worker
// Sends smoothed joystick state only when values change significantly
(function() {
    var state = {
        // Joystick (smoothed output)
        dx: 0, dz: 0, force: 0, active: false,
        // Raw input (before smoothing)
        rawDx: 0, rawDz: 0, rawForce: 0,
        // Camera rotation (kept in sync for future use)
        targetYaw: 0, targetPitch: 0,
        yaw: 0, pitch: 0,
        // Config
        isFirstPerson: false,
        // Smoothing
        smoothFactor: 0.45,    // higher = more responsive
        deadzone: 0.08,         // ignore tiny jitter
        changeThreshold: 0.005  // only send if changed enough
    };

    self.onmessage = function(e) {
        var data = e.data;

        switch (data.type) {
            case 'joystick': {
                if (data.action === 'move') {
                    state.rawDx = data.dx;
                    state.rawDz = data.dz;
                    state.rawForce = data.force;
                    state.active = true;
                    smoothAndSend();
                } else if (data.action === 'end') {
                    // Snap to zero immediately on release (no lag)
                    state.dx = 0;
                    state.dz = 0;
                    state.force = 0;
                    state.active = false;
                    state.rawDx = 0;
                    state.rawDz = 0;
                    state.rawForce = 0;
                    sendState();
                }
                break;
            }

            case 'touch': {
                // Touch rotation handled directly on main thread for zero-latency
                // Worker keeps yaw/pitch in sync for mode switching
                if (data.action === 'move') {
                    var rotSpeed = state.isFirstPerson ? 0.012 : 0.006;
                    var maxPitch = state.isFirstPerson ? (Math.PI / 2.5) : (Math.PI / 2.1);
                    state.targetYaw -= (data.dx || 0) * rotSpeed;
                    state.targetPitch += (data.dy || 0) * rotSpeed;
                    state.targetPitch = Math.max(-maxPitch, Math.min(maxPitch, state.targetPitch));
                    state.yaw += (state.targetYaw - state.yaw) * 0.35;
                    state.pitch += (state.targetPitch - state.pitch) * 0.35;
                }
                break;
            }

            case 'mode': {
                state.isFirstPerson = !!data.firstPerson;
                break;
            }

            case 'setRotation': {
                if (data.yaw !== undefined) {
                    state.yaw = data.yaw;
                    state.targetYaw = data.yaw;
                }
                if (data.pitch !== undefined) {
                    state.pitch = data.pitch;
                    state.targetPitch = data.pitch;
                }
                break;
            }

            case 'getConfig': {
                // Respond with current config for debugging
                self.postMessage({ type: 'config', smoothFactor: state.smoothFactor, deadzone: state.deadzone });
                break;
            }

            case 'setConfig': {
                if (data.smoothFactor !== undefined) state.smoothFactor = data.smoothFactor;
                if (data.deadzone !== undefined) state.deadzone = data.deadzone;
                break;
            }
        }
    };

    function smoothAndSend() {
        var sf = state.smoothFactor;
        // Exponential moving average
        var newDx = state.dx + (state.rawDx - state.dx) * sf;
        var newDz = state.dz + (state.rawDz - state.dz) * sf;
        var newForce = state.force + (state.rawForce - state.force) * sf;

        // Deadzone filtering — snap to zero if below threshold
        var mag = Math.sqrt(newDx * newDx + newDz * newDz);
        if (mag < state.deadzone) {
            newDx = 0; newDz = 0; newForce = 0;
        }

        // Change detection — only send if values changed enough
        var ct = state.changeThreshold;
        if (Math.abs(newDx - state.dx) > ct ||
            Math.abs(newDz - state.dz) > ct ||
            Math.abs(newForce - state.force) > ct ||
            state.active !== true) {
            state.dx = newDx;
            state.dz = newDz;
            state.force = newForce;
            sendState();
        }
    }

    function sendState() {
        self.postMessage({
            type: 'state',
            dx: state.dx,
            dz: state.dz,
            force: state.force,
            active: state.active ? 1 : 0
        });
    }
})();
