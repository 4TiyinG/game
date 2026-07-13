// ui-config-panel.js — 设置面板交互：动画映射 + 滑块控制
(function() {
    var selectedKey = null;
    var allKeys = ['forward', 'backward', 'left', 'right', 'forward_run', 'backward_run', 'left_run', 'right_run', 'jump', 'crouch', 'skill1', 'skill2', 'hit'];
    var dirLabels = {
        forward: '前走', backward: '后走', left: '左走', right: '右走',
        forward_run: '前跑', backward_run: '后跑', left_run: '左跑', right_run: '右跑',
        jump: '跳跃', crouch: '趴下', skill1: '技能A', skill2: '技能B', hit: '受击'
    };

    function updateClipDisplay() {
        var s = parseFloat(document.getElementById('start-active').value);
        var e = parseFloat(document.getElementById('end-active').value);
        document.getElementById('range-active').textContent = s.toFixed(2) + ' - ' + e.toFixed(2) + 's';
    }

    function saveCurrentClip() {
        if (!selectedKey || !window.coreModule) return;
        var settings = window.coreModule.getAnimSettings();
        var s = parseFloat(document.getElementById('start-active').value);
        var e = parseFloat(document.getElementById('end-active').value);
        if (s > e) { s = e; document.getElementById('start-active').value = e; }
        settings.clip[selectedKey] = { start: s, end: e };
    }

    function loadKeyToEditor(key) {
        if (!window.coreModule) return;
        selectedKey = key;
        var settings = window.coreModule.getAnimSettings();
        var clip = settings.clip[key] || { start: 0, end: 0 };

        // Update label
        document.getElementById('editor-label').textContent = dirLabels[key] + ' 映射';

        // Update dropdown
        var sel = document.getElementById('map-active');
        var val = settings.map[key];
        if (val && typeof val === 'string') {
            var idx = window.coreModule.getAnimIndexByName(val);
            sel.value = idx !== -1 ? String(idx) : "-1";
        } else {
            sel.value = val !== undefined && val !== -1 ? String(val) : "-1";
        }

        // Update sliders
        var actualIdx = parseInt(sel.value);
        var duration = 2.0;
        var actions = window.__configActions || [];
        if (actualIdx !== -1 && actions[actualIdx]) { duration = actions[actualIdx]._clip.duration; }
        var startSlider = document.getElementById('start-active');
        var endSlider = document.getElementById('end-active');
        startSlider.max = duration; endSlider.max = duration;
        startSlider.value = Math.min(clip.start, duration);
        endSlider.value = Math.min(clip.end, duration);
        updateClipDisplay();

        // Show slider area if an animation is mapped
        var sliderArea = document.getElementById('editor-slider-area');
        sliderArea.style.display = actualIdx !== -1 ? 'block' : 'none';

        // Update chip active state
        var chips = document.querySelectorAll('.dir-chip');
        for (var i = 0; i < chips.length; i++) {
            chips[i].classList.toggle('active', chips[i].getAttribute('data-key') === key);
        }
    }

    function syncUISettings(core, actions, actionKeys) {
        window.__configActions = actions;
        // Populate dropdown
        var sel = document.getElementById('map-active');
        sel.innerHTML = '<option value="-1">无 (默认)</option>';
        for (var a = 0; a < actions.length; a++) {
            var nameClip = actions[a]._clip.name || ('动画 ' + (a + 1));
            var opt = document.createElement('option');
            opt.value = a;
            opt.textContent = nameClip;
            sel.appendChild(opt);
        }
        // Reload selected key
        if (selectedKey) { loadKeyToEditor(selectedKey); }
    }

    function initConfigUI(core, actions, actionKeys) {
        window.__configActions = actions;

        // Populate dropdown
        var sel = document.getElementById('map-active');
        sel.innerHTML = '<option value="-1">无 (默认)</option>';
        for (var a = 0; a < actions.length; a++) {
            var nameClip = actions[a]._clip.name || ('动画 ' + (a + 1));
            var opt = document.createElement('option');
            opt.value = a;
            opt.textContent = nameClip;
            sel.appendChild(opt);
        }

        // Direction chip click handlers
        var chips = document.querySelectorAll('.dir-chip');
        for (var i = 0; i < chips.length; i++) {
            (function(chip) {
                chip.addEventListener('click', function() {
                    saveCurrentClip();
                    loadKeyToEditor(this.getAttribute('data-key'));
                });
            })(chips[i]);
        }

        // Dropdown change
        sel.addEventListener('change', function() {
            if (!selectedKey || !core) return;
            var settings = core.getAnimSettings();
            var val = parseInt(this.value);
            var name = null;
            if (val !== -1 && actions[val]) { name = actions[val]._clip.name; }
            settings.map[selectedKey] = name || null;
            var dur = 2.0;
            if (val !== -1 && actions[val]) { dur = actions[val]._clip.duration; }
            var startSlider = document.getElementById('start-active');
            var endSlider = document.getElementById('end-active');
            var clip = settings.clip[selectedKey] || { start: 0, end: 0 };
            startSlider.max = dur; endSlider.max = dur;
            startSlider.value = Math.min(clip.start, dur);
            endSlider.value = Math.min(clip.end, dur);
            updateClipDisplay();
            document.getElementById('editor-slider-area').style.display = val !== -1 ? 'block' : 'none';
            core.saveSettings();
        });

        // Slider input handlers
        var startSlider = document.getElementById('start-active');
        var endSlider = document.getElementById('end-active');
        var updateClip = function() {
            if (!selectedKey || !core) return;
            var settings = core.getAnimSettings();
            var s = parseFloat(startSlider.value);
            var e = parseFloat(endSlider.value);
            if (s > e) { startSlider.value = e; s = e; }
            settings.clip[selectedKey] = { start: s, end: e };
            updateClipDisplay();
            core.saveSettings();
        };
        startSlider.addEventListener('input', updateClip);
        endSlider.addEventListener('input', updateClip);

        // Cooldown
        document.getElementById('switch-cooldown').addEventListener('input', function(e) {
            var val = parseFloat(e.target.value);
            core.getAnimSettings().cooldown = val;
            document.getElementById('cooldown-display').textContent = val.toFixed(2) + 's';
            core.saveSettings();
        });

        // Speed
        document.getElementById('anim-speed').addEventListener('input', function(e) {
            var val = parseFloat(e.target.value);
            core.getAnimSettings().speed = val;
            document.getElementById('speed-display').textContent = val.toFixed(1) + 'x';
            if (core.getIsAnimationPlaying() && actions[core.getCurrentActionIndex()]) {
                actions[core.getCurrentActionIndex()].timeScale = val;
            }
            core.saveSettings();
        });

        // Run force threshold
        document.getElementById('run-threshold').addEventListener('input', function(e) {
            var val = parseFloat(e.target.value);
            core.getAnimSettings().runForceThreshold = val;
            document.getElementById('run-threshold-display').textContent = val.toFixed(2);
            core.saveSettings();
        });

        window.__syncUIConfig = function() { syncUISettings(core, actions, actionKeys); };

        // Auto-select first key
        loadKeyToEditor('forward');
    }

    window.uiConfigModule = {
        initConfigUI: initConfigUI,
        syncUISettings: syncUISettings
    };
})();
