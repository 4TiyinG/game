(function(){
    'use strict';
    
    // ==================== 性能监控 (FPS & 内存) ====================
    const perf = (() => {
        const config = window.__THREE_PERF_CONFIG__ || { enabled: true, autoOptimize: true };
        if (!config.enabled) return null;
        
        let fps = 60, frameCount = 0, lastTime = performance.now();
        let memoryUsage = 0, lowFPSCounter = 0;
        const LOW_FPS_THRESHOLD = 30;
        
        const update = () => {
            frameCount++;
            const now = performance.now();
            const delta = now - lastTime;
            
            if (delta >= 1000) {
                fps = Math.round((frameCount * 1000) / delta);
                frameCount = 0;
                lastTime = now;
                
                // @ts-ignore - Chrome memory API
                if (performance.memory) {
                    // @ts-ignore
                    memoryUsage = performance.memory.usedJSHeapSize / 1048576;
                }
                
                if (fps < LOW_FPS_THRESHOLD) {
                    lowFPSCounter++;
                    if (lowFPSCounter >= 3 && config.autoOptimize) {
                        console.warn('[ThreePerf] 检测到持续低帧率，触发自动优化');
                        if (window.__THREE_PERF_OPTIMIZE__) {
                            window.__THREE_PERF_OPTIMIZE__('auto');
                        }
                        lowFPSCounter = 0;
                    }
                } else {
                    lowFPSCounter = 0;
                }
                
                if (config.onStats) config.onStats({ fps, memory: memoryUsage });
            }
        };
        
        let rafId = null;
        const loop = () => { update(); rafId = requestAnimationFrame(loop); };
        const start = () => { if (rafId === null) loop(); };
        const stop = () => { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } };
        
        return { update, start, stop, getFPS: () => fps, getMemory: () => memoryUsage };
    })();

    // ==================== 手势优化 (节流 + RAF同步) ====================
    const gesture = (() => {
        const pendingCallbacks = new Map();
        let rafId = null;
        
        const schedule = (key, callback) => {
            pendingCallbacks.set(key, callback);
            if (rafId === null) {
                rafId = requestAnimationFrame(() => {
                    pendingCallbacks.forEach(cb => cb());
                    pendingCallbacks.clear();
                    rafId = null;
                });
            }
        };
        
        const cancel = () => {
            if (rafId) cancelAnimationFrame(rafId);
            pendingCallbacks.clear();
            rafId = null;
        };
        
        return { schedule, cancel };
    })();

    // ==================== 全局工具函数 ====================
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const isLandscape = () => window.innerWidth > window.innerHeight;

    // ==================== DOM 元素引用 ====================
    const dom = {
        jc: document.getElementById('joystick-container'),
        fb: document.getElementById('fire-button'),
        cp: document.getElementById('customize-panel'),
        tog: document.getElementById('toggle-panel'),
        sky: document.getElementById('sky-toggle'),
        editBtn: document.getElementById('edit-toggle'),
        jx: document.getElementById('joy-x'),
        jy: document.getElementById('joy-y'),
        fx: document.getElementById('fire-x'),
        fy: document.getElementById('fire-y'),
        rjoy: document.getElementById('reset-joy'),
        rfire: document.getElementById('reset-fire')
    };
    
    if (!dom.jc || !dom.fb) return;

    // ==================== 摇杆与射击按钮位置控制 ====================
    (function PositionController() {
        let editMode = false;
        let dragJoy = false, dragFire = false;
        let startX = 0, startY = 0, startLeft = 0, startBottom = 0;
        let rafId = null;
        
        const getJoyKey = () => `joy_${isLandscape() ? 1 : 0}`;
        const getFireKey = () => `fire_${isLandscape() ? 1 : 0}`;
        
        const updateJoy = (l, b, save = true) => {
            l = clamp(l, 5, window.innerWidth - dom.jc.offsetWidth - 10);
            b = clamp(b, 5, window.innerHeight - dom.jc.offsetHeight - 10);
            dom.jc.style.left = `${l}px`;
            dom.jc.style.bottom = `${b}px`;
            if (save) {
                localStorage.setItem(getJoyKey(), `${l},${b}`);
                dom.jx.value = l;
                dom.jy.value = b;
            }
        };
        
        const updateFire = (l, b, save = true) => {
            l = clamp(l, 5, window.innerWidth - dom.fb.offsetWidth - 10);
            b = clamp(b, 5, window.innerHeight - dom.fb.offsetHeight - 10);
            dom.fb.style.left = `${l}px`;
            dom.fb.style.bottom = `${b}px`;
            dom.fb.style.right = 'auto';
            dom.fb.style.top = 'auto';
            if (save) {
                localStorage.setItem(getFireKey(), `${l},${b}`);
                dom.fx.value = l;
                dom.fy.value = b;
            }
        };
        
        const loadJoy = () => {
            const v = localStorage.getItem(getJoyKey());
            if (v) {
                const [l, b] = v.split(',').map(Number);
                updateJoy(l, b, true);
            } else {
                updateJoy(25, 25, true);
            }
        };
        
        const loadFire = () => {
            const v = localStorage.getItem(getFireKey());
            if (v) {
                const [l, b] = v.split(',').map(Number);
                updateFire(l, b, true);
            } else {
                updateFire(25, 25, true);
            }
        };
        
        loadJoy();
        loadFire();
        
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                loadJoy();
                loadFire();
            }, 100);
        });
        
        dom.tog.onclick = () => dom.cp.classList.toggle('hidden');
        dom.sky.onclick = () => document.getElementById('canvas')?.requestFullscreen?.();
        
        dom.editBtn.onclick = () => {
            editMode = !editMode;
            dom.editBtn.classList.toggle('active', editMode);
            const slider = document.getElementById('fire-size-slider');
            if (slider) slider.classList.toggle('hidden', !editMode);
        };
        
        // 摇杆拖拽
        const joyMoveHandler = e => {
            if (!editMode || !dragJoy) return;
            e.preventDefault();
            const touch = e.touches[0];
            const newLeft = startLeft + (touch.clientX - startX);
            const newBottom = startBottom - (touch.clientY - startY);
            
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                updateJoy(newLeft, newBottom, false);
                rafId = null;
            });
        };
        
        const joyEndHandler = () => {
            if (dragJoy) {
                dragJoy = false;
                const l = parseFloat(dom.jc.style.left);
                const b = parseFloat(dom.jc.style.bottom);
                if (!isNaN(l) && !isNaN(b)) updateJoy(l, b, true);
                dom.jc.style.transition = '';
            }
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        };
        
        dom.jc.addEventListener('touchstart', e => {
            if (!editMode) return;
            e.preventDefault();
            const t = e.touches[0];
            dragJoy = true;
            startX = t.clientX;
            startY = t.clientY;
            startLeft = parseFloat(dom.jc.style.left);
            startBottom = parseFloat(dom.jc.style.bottom);
            dom.jc.style.transition = 'none';
            if (rafId) cancelAnimationFrame(rafId);
        }, { passive: false });
        
        document.addEventListener('touchmove', joyMoveHandler, { passive: false });
        document.addEventListener('touchend', joyEndHandler);
        document.addEventListener('touchcancel', joyEndHandler);
        
        // 射击按钮拖拽
        const fireMoveHandler = e => {
            if (!editMode || !dragFire) return;
            e.preventDefault();
            const touch = e.touches[0];
            const newLeft = startLeft + (touch.clientX - startX);
            const newBottom = startBottom - (touch.clientY - startY);
            
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                updateFire(newLeft, newBottom, false);
                rafId = null;
            });
        };
        
        const fireEndHandler = () => {
            if (dragFire) {
                dragFire = false;
                const l = parseFloat(dom.fb.style.left);
                const b = parseFloat(dom.fb.style.bottom);
                if (!isNaN(l) && !isNaN(b)) updateFire(l, b, true);
                dom.fb.style.transition = '';
            }
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        };
        
        dom.fb.addEventListener('touchstart', e => {
            if (!editMode) return;
            e.preventDefault();
            const t = e.touches[0];
            dragFire = true;
            startX = t.clientX;
            startY = t.clientY;
            startLeft = parseFloat(dom.fb.style.left);
            startBottom = parseFloat(dom.fb.style.bottom);
            dom.fb.style.transition = 'none';
            if (rafId) cancelAnimationFrame(rafId);
        }, { passive: false });
        
        document.addEventListener('touchmove', fireMoveHandler, { passive: false });
        document.addEventListener('touchend', fireEndHandler);
        document.addEventListener('touchcancel', fireEndHandler);
        
        const setJoyPos = () => {
            let l = parseInt(dom.jx.value, 10), b = parseInt(dom.jy.value, 10);
            if (isNaN(l)) l = 25;
            if (isNaN(b)) b = 25;
            updateJoy(l, b, true);
        };
        
        const setFirePos = () => {
            let l = parseInt(dom.fx.value, 10), b = parseInt(dom.fy.value, 10);
            if (isNaN(l)) l = 25;
            if (isNaN(b)) b = 25;
            updateFire(l, b, true);
        };
        
        dom.jx.onchange = dom.jy.onchange = setJoyPos;
        dom.fx.onchange = dom.fy.onchange = setFirePos;
        dom.rjoy.onclick = () => updateJoy(25, 25, true);
        dom.rfire.onclick = () => updateFire(25, 25, true);
        
        window.editModeRef = { get: () => editMode };
    })();

    // ==================== 动作按钮位置管理 ====================
    (function ActionButtonsController() {
        const btns = ['btn-jump', 'btn-crouch', 'btn-prone'];
        const rightBtns = ['reload-button', 'equip-button', 'aim-button'];
        const allBtns = [...btns, ...rightBtns];
        
        let editMode = false;
        const editBtn = document.getElementById('edit-toggle');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                editMode = editBtn.classList.contains('active');
            });
            setInterval(() => {
                editMode = editBtn.classList.contains('active');
            }, 100);
        }
        
        const getStorageKey = id => `${id}_pos_${isLandscape() ? 1 : 0}`;
        const clampPos = (btn, l, b) => ({
            left: Math.min(Math.max(5, l), window.innerWidth - btn.offsetWidth - 5),
            bottom: Math.min(Math.max(5, b), window.innerHeight - btn.offsetHeight - 5)
        });
        
        const getDefaultPos = btnId => {
            const landscape = isLandscape();
            if (btnId === 'reload-button') return { left: landscape ? window.innerWidth - 68 : window.innerWidth - 77, bottom: landscape ? 80 : 95 };
            if (btnId === 'equip-button') return { left: landscape ? window.innerWidth - 126 : window.innerWidth - 141, bottom: landscape ? 80 : 95 };
            if (btnId === 'aim-button') return { left: landscape ? window.innerWidth - 184 : window.innerWidth - 205, bottom: landscape ? 80 : 95 };
            const leftBase = landscape ? 15 : 25;
            const bottomBase = landscape ? 125 : 135;
            const gap = landscape ? 10 : 12;
            const idx = btns.indexOf(btnId);
            const bottom = bottomBase + Math.max(0, idx) * (52 + gap);
            return { left: leftBase, bottom: bottom };
        };
        
        const updatePos = (btn, l, b, save = true) => {
            const clamped = clampPos(btn, l, b);
            btn.style.left = `${clamped.left}px`;
            btn.style.bottom = `${clamped.bottom}px`;
            btn.style.right = 'auto';
            btn.style.top = 'auto';
            if (save) {
                localStorage.setItem(getStorageKey(btn.id), `${clamped.left},${clamped.bottom}`);
            }
        };
        
        const loadPos = btn => {
            const saved = localStorage.getItem(getStorageKey(btn.id));
            if (saved) {
                const [l, b] = saved.split(',').map(Number);
                if (!isNaN(l) && !isNaN(b)) {
                    updatePos(btn, l, b, false);
                    return;
                }
            }
            const def = getDefaultPos(btn.id);
            updatePos(btn, def.left, def.bottom, false);
        };
        
        allBtns.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.style.position = 'absolute';
                loadPos(btn);
            }
        });
        
        const attachDrag = btn => {
            if (!btn) return;
            let dragActive = false, sX = 0, sY = 0, sL = 0, sB = 0, rafId = null;
            
            const onMove = e => {
                if (!dragActive || !editMode) return;
                e.preventDefault();
                const touch = e.touches[0];
                const newLeft = sL + (touch.clientX - sX);
                const newBottom = sB - (touch.clientY - sY);
                
                if (rafId) cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(() => {
                    updatePos(btn, newLeft, newBottom, false);
                    rafId = null;
                });
            };
            
            const onEnd = () => {
                if (dragActive) {
                    dragActive = false;
                    const l = parseFloat(btn.style.left);
                    const b = parseFloat(btn.style.bottom);
                    if (!isNaN(l) && !isNaN(b)) updatePos(btn, l, b, true);
                    btn.style.transition = '';
                }
                if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            };
            
            btn.addEventListener('touchstart', e => {
                if (!editMode) return;
                e.preventDefault();
                const t = e.touches[0];
                dragActive = true;
                sX = t.clientX;
                sY = t.clientY;
                sL = parseFloat(btn.style.left);
                sB = parseFloat(btn.style.bottom);
                btn.style.transition = 'none';
                if (rafId) cancelAnimationFrame(rafId);
            }, { passive: false });
            
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
            document.addEventListener('touchcancel', onEnd);
        };
        
        allBtns.forEach(id => attachDrag(document.getElementById(id)));
        
        let resizeTimer;
        const reloadAll = () => {
            allBtns.forEach(id => {
                const btn = document.getElementById(id);
                if (btn) loadPos(btn);
            });
        };
        
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(reloadAll, 100);
        });
        
        window.addEventListener('orientationchange', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(reloadAll, 100);
        });
        
        window.actionEditModeRef = { get: () => editMode };
    })();

    // ==================== 动作触发 (键盘模拟) ====================
    (function ActionTrigger() {
        const actionMap = {
            btn_jump: { code: 'Space', keyCode: 32 },
            btn_crouch: { code: 'KeyC', keyCode: 67 },
            btn_prone: { code: 'KeyZ', keyCode: 90 },
            reload_button: { code: 'KeyR', keyCode: 82 },
            equip_button: { code: 'KeyE', keyCode: 69 },
            aim_button: { code: 'KeyF', keyCode: 70 }
        };
        
        const sendKey = (code, keyCode) => {
            const ev = new KeyboardEvent('keydown', { code, keyCode, bubbles: true });
            document.dispatchEvent(ev);
            setTimeout(() => {
                const up = new KeyboardEvent('keyup', { code, keyCode, bubbles: true });
                document.dispatchEvent(up);
            }, 50);
        };
        
        const handleAction = btnId => {
            if (window.actionEditModeRef?.get()) return;
            const key = actionMap[btnId];
            if (key) sendKey(key.code, key.keyCode);
        };
        
        const btns = ['btn-jump', 'btn-crouch', 'btn-prone', 'reload-button', 'equip-button', 'aim-button'];
        btns.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.onclick = () => handleAction(id);
        });
    })();

    // ==================== 射击按钮大小调节 ====================
    (function FireButtonSizer() {
        const fb = document.getElementById('fire-button');
        if (!fb) return;
        
        let slider = document.getElementById('fire-size-slider');
        if (!slider) {
            slider = document.createElement('div');
            slider.id = 'fire-size-slider';
            slider.className = 'hidden';
            slider.innerHTML = '<span>🔘大小</span><input type="range" id="fire-size-range" min="0.6" max="1.5" step="0.01" value="1"><span id="fire-size-value">100%</span>';
            document.body.appendChild(slider);
        }
        
        const range = document.getElementById('fire-size-range');
        const span = document.getElementById('fire-size-value');
        let editMode = false;
        const editBtn = document.getElementById('edit-toggle');
        
        const getScaleKey = () => `fire_scale_${isLandscape() ? 1 : 0}`;
        
        const loadScale = () => {
            const v = localStorage.getItem(getScaleKey());
            if (v) {
                const s = parseFloat(v);
                if (!isNaN(s) && s >= 0.6 && s <= 1.5) {
                    range.value = s;
                    applyScale(s);
                    return;
                }
            }
            range.value = 1;
            applyScale(1);
        };
        
        const applyScale = scale => {
            const base = isLandscape() ? 48 : 52;
            const newSize = Math.round(base * scale);
            fb.style.width = `${newSize}px`;
            fb.style.height = `${newSize}px`;
            fb.style.fontSize = `${Math.round(28 * scale)}px`;
            span.innerText = `${Math.round(scale * 100)}%`;
            localStorage.setItem(getScaleKey(), scale);
        };
        
        const updateSliderPos = () => {
            if (!fb || !slider) return;
            const rect = fb.getBoundingClientRect();
            let top = rect.bottom + 5;
            let left = rect.left + rect.width / 2 - slider.offsetWidth / 2;
            left = Math.min(Math.max(5, left), window.innerWidth - slider.offsetWidth - 5);
            slider.style.top = `${top}px`;
            slider.style.left = `${left}px`;
        };
        
        const onEditChange = () => {
            editMode = editBtn?.classList.contains('active') || false;
            slider.classList.toggle('hidden', !editMode);
            if (editMode) updateSliderPos();
        };
        
        if (editBtn) {
            const observer = new MutationObserver(onEditChange);
            observer.observe(editBtn, { attributes: true, attributeFilter: ['class'] });
            onEditChange();
        }
        
        range.addEventListener('input', e => {
            const val = parseFloat(e.target.value);
            applyScale(val);
            if (editMode) updateSliderPos();
        });
        
        window.addEventListener('resize', () => {
            loadScale();
            if (editMode) setTimeout(updateSliderPos, 50);
        });
        
        window.addEventListener('orientationchange', () => {
            setTimeout(() => {
                loadScale();
                if (editMode) updateSliderPos();
            }, 100);
        });
        
        const dragObserver = new MutationObserver(() => {
            if (editMode) updateSliderPos();
        });
        dragObserver.observe(fb, { attributes: true, attributeFilter: ['style'] });
        
        loadScale();
    })();

    // ==================== 性能模式开关 ====================
    (function PerformanceMode() {
        const perfBtn = document.getElementById('perf-toggle');
        if (!perfBtn) return;
        
        const enabled = localStorage.getItem('performance_mode') === 'true';
        if (enabled) {
            document.body.classList.add('performance-mode');
            perfBtn.classList.add('active');
        }
        
        perfBtn.addEventListener('click', () => {
            document.body.classList.toggle('performance-mode');
            const active = document.body.classList.contains('performance-mode');
            perfBtn.classList.toggle('active', active);
            localStorage.setItem('performance_mode', active);
            
            // 触发性能优化
            if (active && window.__THREE_PERF_OPTIMIZE__) {
                window.__THREE_PERF_OPTIMIZE__('manual');
            }
        });
    })();

    // ==================== 启动性能监控 ====================
    if (perf) perf.start();

    // ==================== 清理资源 (用于页面卸载) ====================
    window.__DOM_CONTROLLER_CLEANUP__ = () => {
        if (perf) perf.stop();
        gesture.cancel();
        console.log('[DomController] 已清理资源');
    };

})();