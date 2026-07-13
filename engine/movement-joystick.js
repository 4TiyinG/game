// movement-joystick.js — 虚拟摇杆输入模块（nipplejs 封装）
(function() {
    var joystickState = {
        active: false,
        dx: 0,
        dz: 0,
        force: 0
    };

    function initJoystick(zone, nipplejs) {
        if (!nipplejs) return;
        // 根据屏幕尺寸动态调整摇杆大小，匹配 CSS zone 尺寸
        var zoneRect = zone.getBoundingClientRect();
        var zoneSize = Math.max(zoneRect.width, 54);
        // 确保摇杆头不会溢出视觉底盘
        var nippleSize = Math.min(zoneSize, 80);

        var joystick = nipplejs.create({
            zone: zone,
            mode: 'static',
            position: { left: '50%', top: '50%' },
            color: '#3b82f6',
            size: nippleSize,
            threshold: 0.15,
            fadeTime: 100,
            restOpacity: 0.9,
            catchDistance: 120
        });

        joystick.on('move', function(evt, data) {
            var angle = data.angle.radian;
            var force = data.force;

            // Raw direction (used for movement & rotation — supports full 360°)
            var dx = Math.cos(angle) * force;
            var dz = -Math.sin(angle) * force;

            // 直接在主线程做输入平滑（替代 inputWorker，消除 1 帧延迟）
            if (window._smoothJoystickInput) {
                window._smoothJoystickInput(dx, dz, force, true);
            } else {
                // 回退：无平滑函数时直接更新
                joystickState.active = true;
                joystickState.force = force;
                joystickState.dx = dx;
                joystickState.dz = dz;
            }
        });

        joystick.on('end', function() {
            // 直接在主线程处理（替代 inputWorker）
            if (window._smoothJoystickInput) {
                window._smoothJoystickInput(0, 0, 0, false);
            } else {
                joystickState.active = false;
                joystickState.force = 0;
                joystickState.dx = 0;
                joystickState.dz = 0;
            }
        });
    }

    function handleMovement(delta, cameraController, model, body, isPhysicsMode, state, maxSpeed) {
        cameraController.update(delta, state.dx, state.dz, state.force);
    }

    // ============================================================
    // PC 键盘模块（仅非触屏设备生效，不干扰摇杆/手机端）
    // ============================================================
    var _isPc = !('ontouchstart' in window) && window.navigator.maxTouchPoints === 0;
    var _kbKeys = { w: false, a: false, s: false, d: false, shift: false };

    function _resetKbState() {
        _kbKeys.w = false;
        _kbKeys.a = false;
        _kbKeys.s = false;
        _kbKeys.d = false;
        _kbKeys.shift = false;
    }

    function _applyKbState() {
        var dx = 0, dz = 0;
        if (_kbKeys.w) dz -= 1;
        if (_kbKeys.s) dz += 1;
        if (_kbKeys.a) dx -= 1;
        if (_kbKeys.d) dx += 1;

        if (dx !== 0 || dz !== 0) {
            // 归一化对角线
            var mag = Math.sqrt(dx * dx + dz * dz);
            if (mag > 1) { dx /= mag; dz /= mag; }
            joystickState.active = true;
            joystickState.dx = dx;
            joystickState.dz = dz;
            joystickState.force = _kbKeys.shift ? 1.0 : 0.5;
        } else {
            joystickState.active = false;
            joystickState.dx = 0;
            joystickState.dz = 0;
            joystickState.force = 0;
        }
    }

    function _onKbKeyDown(e) {
        var key = e.key.toLowerCase();
        if (key === 'shift') { _kbKeys.shift = true; e.preventDefault(); _applyKbState(); return; }
        if (key === 'v') { e.preventDefault(); var vBtn = document.getElementById('view-toggle'); if (vBtn) vBtn.click(); return; }
        if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
            _kbKeys[key] = true;
            e.preventDefault();
            _applyKbState();
        }
    }

    function _onKbKeyUp(e) {
        var key = e.key.toLowerCase();
        if (key === 'shift') { _kbKeys.shift = false; e.preventDefault(); _applyKbState(); return; }
        if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
            _kbKeys[key] = false;
            e.preventDefault();
            _applyKbState();
        }
    }

    function initKeyboard() {
        if (!_isPc) return;
        document.addEventListener('keydown', _onKbKeyDown);
        document.addEventListener('keyup', _onKbKeyUp);
        window.addEventListener('blur', function() {
            _resetKbState();
            joystickState.active = false;
            joystickState.dx = 0;
            joystickState.dz = 0;
            joystickState.force = 0;
        });
    }

    window.movementModule = {
        joystickState: joystickState,
        initJoystick: initJoystick,
        initKeyboard: initKeyboard,
        handleMovement: handleMovement
    };
})();
