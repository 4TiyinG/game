// thermal-system.js — 骁龙8+ 温控综合管理系统
// 基于 Compute Pressure API + Performance Observer + requestIdleCallback
// 渐进增强：不支持 PressureObserver 时降级到 FPS+LongTask 方案
(function() {
    'use strict';

    // ================================================================
    // 模块一：ThermalMonitor — Compute Pressure API（系统级热感知）
    // ================================================================
    function ThermalMonitor() {
        this.observer = null;
        this.currentState = 'nominal'; // 'nominal' | 'fair' | 'serious' | 'critical'
        this.isSupported = false;
        this.listeners = [];
    }

    ThermalMonitor.prototype.init = function() {
        var self = this;
        if (typeof PressureObserver === 'undefined') {
            console.warn('[ThermalMonitor] Compute Pressure API not supported');
            return Promise.resolve(false);
        }

        try {
            var knownSources = PressureObserver.knownSources || [];
            var source = null;
            if (knownSources.indexOf('thermals') !== -1) source = 'thermals';
            else if (knownSources.indexOf('cpu') !== -1) source = 'cpu';

            if (!source) {
                console.warn('[ThermalMonitor] No supported pressure sources');
                return Promise.resolve(false);
            }

            self.isSupported = true;
            self.observer = new PressureObserver(function(records) {
                var last = records[records.length - 1];
                self.handlePressureChange(last);
            });

            self.observer.observe({ source: source, sampleInterval: 1000 });
            console.log('[ThermalMonitor] observing:', source);
            return Promise.resolve(true);
        } catch (err) {
            console.warn('[ThermalMonitor] init failed:', err);
            return Promise.resolve(false);
        }
    };

    ThermalMonitor.prototype.handlePressureChange = function(record) {
        this.currentState = record.state;
        for (var i = 0; i < this.listeners.length; i++) {
            this.listeners[i](record.state, record);
        }
    };

    ThermalMonitor.prototype.onPressureChange = function(cb) {
        this.listeners.push(cb);
    };

    ThermalMonitor.prototype.disconnect = function() {
        if (this.observer) this.observer.disconnect();
    };

    // ================================================================
    // 模块二：PerformanceMonitor — Long Task 监测
    // ================================================================
    function PerformanceMonitor() {
        this.longTaskCount = 0;
        this.lastMinuteTasks = [];
        this.onLongTaskCallback = null;
        this.observer = null;
    }

    PerformanceMonitor.prototype.init = function() {
        var self = this;
        if (typeof PerformanceObserver === 'undefined') return false;
        var supported = PerformanceObserver.supportedEntryTypes || [];
        if (supported.indexOf('longtask') === -1) return false;

        try {
            this.observer = new PerformanceObserver(function(list) {
                var entries = list.getEntries();
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].entryType === 'longtask') {
                        self.handleLongTask(entries[i]);
                    }
                }
            });
            this.observer.observe({ entryTypes: ['longtask'] });
            return true;
        } catch (e) {
            return false;
        }
    };

    PerformanceMonitor.prototype.handleLongTask = function(entry) {
        this.longTaskCount++;
        this.lastMinuteTasks.push({ duration: entry.duration, timestamp: Date.now() });
        var cutoff = Date.now() - 60000;
        this.lastMinuteTasks = this.lastMinuteTasks.filter(function(t) { return t.timestamp > cutoff; });

        if (this.onLongTaskCallback) {
            this.onLongTaskCallback({
                duration: entry.duration,
                count: this.longTaskCount,
                avgDuration: this.getAverageLongTaskDuration()
            });
        }
    };

    PerformanceMonitor.prototype.getAverageLongTaskDuration = function() {
        if (this.lastMinuteTasks.length === 0) return 0;
        var sum = 0;
        for (var i = 0; i < this.lastMinuteTasks.length; i++) sum += this.lastMinuteTasks[i].duration;
        return sum / this.lastMinuteTasks.length;
    };

    // ================================================================
    // 模块三：FPSMonitor — 帧率监测（内联到 animate 循环，不独立 rAF）
    // ================================================================
    function FPSMonitor() {
        this.fps = 60;
        this.frameTimes = [];
        this.droppedFrames = 0;
        this.frameCount = 0;
        this.onFPSDropCallback = null;
        this.lastFrameTime = 0;
    }

    FPSMonitor.prototype.tick = function(frameTime) {
        if (this.lastFrameTime) {
            var delta = frameTime - this.lastFrameTime;
            this.frameTimes.push(delta);
            if (this.frameTimes.length > 120) this.frameTimes.shift();
            if (delta > 33) this.droppedFrames++;
        }
        this.lastFrameTime = frameTime;

        this.frameCount++;
        if (this.frameCount >= 60) {
            var sum = 0;
            for (var i = 0; i < this.frameTimes.length; i++) sum += this.frameTimes[i];
            var avg = sum / this.frameTimes.length;
            this.fps = Math.round(1000 / avg);

            if (this.fps < 30 && this.onFPSDropCallback) {
                this.onFPSDropCallback({
                    fps: this.fps,
                    droppedFrames: this.droppedFrames,
                    severity: this.fps < 24 ? 'critical' : 'serious'
                });
            }
            this.frameCount = 0;
            this.droppedFrames = 0;
        }
    };

    FPSMonitor.prototype.onFPSDrop = function(cb) {
        this.onFPSDropCallback = cb;
    };

    // ================================================================
    // 模块四：IdleTaskManager — requestIdleCallback 任务队列
    // ================================================================
    function IdleTaskManager() {
        this.tasks = [];
        this.isProcessing = false;
        this.timeout = 2000;
    }

    IdleTaskManager.prototype.schedule = function(task, priority) {
        priority = priority || 'normal';
        this.tasks.push({ task: task, priority: priority });
        if (!this.isProcessing) this.processQueue();
    };

    IdleTaskManager.prototype.processQueue = function() {
        var self = this;
        if (this.tasks.length === 0) { this.isProcessing = false; return; }
        this.isProcessing = true;

        // 按优先级排序
        var order = { high: 0, normal: 1, low: 2 };
        this.tasks.sort(function(a, b) {
            return (order[a.priority] || 1) - (order[b.priority] || 1);
        });

        var ric = typeof requestIdleCallback === 'function' ? requestIdleCallback : function(cb) { return setTimeout(cb, 50); };

        ric(function(deadline) {
            var hasRIC = typeof deadline.timeRemaining === 'function';
            while (self.tasks.length > 0 && (!hasRIC || deadline.timeRemaining() > 0)) {
                var item = self.tasks.shift();
                try { item.task(); } catch (e) { console.error('[IdleTask]', e); }
            }
            if (self.tasks.length > 0) self.processQueue();
            else self.isProcessing = false;
        }, { timeout: this.timeout });
    };

    IdleTaskManager.prototype.clear = function() {
        this.tasks = [];
        this.isProcessing = false;
    };

    // ================================================================
    // 模块五：AdaptiveQualitySystem — 综合降级决策
    // ================================================================
    function AdaptiveQualitySystem() {
        this.thermalMonitor = new ThermalMonitor();
        this.perfMonitor = new PerformanceMonitor();
        this.fpsMonitor = new FPSMonitor();
        this.currentQuality = 'high'; // 'high' | 'medium' | 'low'
        this.degradationHistory = [];
        this.recoveryTimer = null;
        this.isEmergency = false;

        // 质量等级配置（对接现有 DRS 系统，不另建独立渲染控制）
        this.levels = {
            high:   { drsScale: 1.0,  shadow: true,  videoTexRepeat: 1 },
            medium: { drsScale: 0.85, shadow: true,  videoTexRepeat: 1 },
            low:    { drsScale: 0.7,  shadow: false, videoTexRepeat: 2 }
        };
    }

    AdaptiveQualitySystem.prototype.init = function() {
        var self = this;
        return this.thermalMonitor.init().then(function(thermalSupported) {
            // 长任务监测
            self.perfMonitor.init();
            self.perfMonitor.onLongTask(function(data) {
                if (data.count > 10 || data.avgDuration > 60) {
                    self.requestDegradation('long_task', data);
                }
            });

            // FPS 回调
            self.fpsMonitor.onFPSDrop(function(data) {
                self.requestDegradation('fps_drop', data);
            });

            // 温控回调
            if (thermalSupported) {
                self.thermalMonitor.onPressureChange(function(state) {
                    if (state === 'serious') self.requestDegradation('thermal', { state: state });
                    else if (state === 'critical') self.requestDegradation('thermal', { state: state, critical: true });
                    else if (state === 'nominal' && self.currentQuality !== 'high') {
                        self.scheduleRecovery();
                    }
                });
            }

            console.log('[AdaptiveQuality] System initialized | thermal:', thermalSupported);
        });
    };

    AdaptiveQualitySystem.prototype.tick = function(frameTime) {
        this.fpsMonitor.tick(frameTime);
    };

    AdaptiveQualitySystem.prototype.requestDegradation = function(reason, data) {
        var now = Date.now();
        // 防抖：30秒内不重复触发相同原因
        for (var i = 0; i < this.degradationHistory.length; i++) {
            if (this.degradationHistory[i].reason === reason && (now - this.degradationHistory[i].timestamp) < 30000) return;
        }
        this.degradationHistory.push({ reason: reason, timestamp: now, data: data });

        var target = this.getTargetLevel(reason, data);
        if (target !== this.currentQuality) this.applyQuality(target);
    };

    AdaptiveQualitySystem.prototype.getTargetLevel = function(reason, data) {
        var levels = ['high', 'medium', 'low'];
        var idx = levels.indexOf(this.currentQuality);

        if (reason === 'thermal' && data.critical) return 'low';
        if (reason === 'fps_drop') {
            if (data.severity === 'critical') return 'low';
            return 'medium';
        }
        if (reason === 'long_task') {
            if (data.avgDuration > 80) return 'low';
            return 'medium';
        }
        if (reason === 'thermal') return 'medium';

        return levels[Math.min(idx + 1, levels.length - 1)];
    };

    AdaptiveQualitySystem.prototype.applyQuality = function(level) {
        this.currentQuality = level;
        var cfg = this.levels[level];

        // 对接现有 DRS 系统（通过 window 全局变量）
        if (window._drsScale !== undefined) {
            window._drsScale = cfg.drsScale;
            if (window._applyDRS) window._applyDRS();
        }

        // 阴影开关
        if (window._renderer) {
            window._renderer.shadowMap.enabled = cfg.shadow;
            if (!cfg.shadow) {
                window._renderer.shadowMap.needsUpdate = true;
            }
        }

        // 视频纹理降级
        if (window.uiModule && uiModule.screenVideoState && uiModule.screenVideoState.texture) {
            var vt = uiModule.screenVideoState.texture;
            vt.repeat.set(cfg.videoTexRepeat, cfg.videoTexRepeat);
            vt._emergencyReduced = cfg.videoTexRepeat > 1;
        }

        // 紧急模式
        if (level === 'low') {
            this.isEmergency = true;
            if (window._idleTaskManager) window._idleTaskManager.clear();
        }

        console.log('[AdaptiveQuality] →', level, cfg);

        // 阶梯恢复计时器
        clearTimeout(this.recoveryTimer);
        if (level !== 'high') {
            this.recoveryTimer = setTimeout(function() {
                var levels = ['low', 'medium', 'high'];
                var recoverIdx = levels.indexOf(level) + 1;
                if (recoverIdx < levels.length) {
                    // 触发恢复
                }
            }, 300000); // 5分钟
        }
    };

    AdaptiveQualitySystem.prototype.scheduleRecovery = function() {
        var self = this;
        if (this.currentQuality === 'high') return;
        var levels = ['low', 'medium', 'high'];
        var nextIdx = levels.indexOf(this.currentQuality) - 1;
        if (nextIdx >= 0) {
            setTimeout(function() {
                self.applyQuality(levels[nextIdx]);
            }, 5000); // 5秒后逐步恢复
        }
    };

    AdaptiveQualitySystem.prototype.getStatus = function() {
        return {
            quality: this.currentQuality,
            fps: this.fpsMonitor.fps,
            thermal: this.thermalMonitor.currentState,
            longTaskCount: this.perfMonitor.longTaskCount,
            isEmergency: this.isEmergency
        };
    };

    // ================================================================
    // 初始化 + 暴露 API
    // ================================================================
    var adaptiveSystem = new AdaptiveQualitySystem();
    var idleManager = new IdleTaskManager();

    window._idleTaskManager = idleManager;
    window._adaptiveQuality = adaptiveSystem;

    window.ThermalSystem = {
        init: function() { return adaptiveSystem.init(); },
        tick: function(frameTime) { adaptiveSystem.tick(frameTime); },
        idle: idleManager,
        getStatus: function() { return adaptiveSystem.getStatus(); }
    };

    console.log('[ThermalSystem] Module loaded');
})();
