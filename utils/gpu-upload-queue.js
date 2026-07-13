// gpu-upload-queue.js — 分帧 GPU 上传调度器
// 严格限制单帧上传总量，避免骁龙8+ 瞬时功耗飙升触发温控墙
// 每帧最多 512KB 纹理 + 200 个顶点 Buffer，配合 IdleCallback 加速非关键资源
// 与 ThermalSystem 联动：温控预警时自动降速

(function() {
    'use strict';

    var MAX_TEXTURE_BYTES_PER_FRAME = 512 * 1024; // 512KB/帧
    var MAX_BUFFER_UPLOADS_PER_FRAME = 200;       // 200个顶点 Buffer/帧
    var _textureQueue = [];
    var _bufferQueue = [];
    var _idleQueue = [];
    var _isRunning = false;
    var _coolingDown = false;
    var _coolingFrames = 0;

    // 温控联动：连续掉帧时暂停上传
    function checkThermal() {
        if (window._adaptiveQuality && _adaptiveQuality.fpsMonitor) {
            var fps = _adaptiveQuality.fpsMonitor.fps;
            if (fps < 30) {
                _coolingDown = true;
                _coolingFrames = 2; // 休息 2 帧
                console.log('[GPUUploadQueue] Thermal cooldown: FPS', fps);
            }
        }
    }

    // ===== 主循环 tick（由 animate() 调用）=====
    function tick() {
        if (_coolingDown) {
            _coolingFrames--;
            if (_coolingFrames <= 0) _coolingDown = false;
            return;
        }

        var textureBytesUploaded = 0;
        var bufferCount = 0;

        // 1. 优先上传纹理（关键资源）
        while (_textureQueue.length > 0 && textureBytesUploaded < MAX_TEXTURE_BYTES_PER_FRAME) {
            var texTask = _textureQueue.shift();
            try {
                texTask.upload();
                textureBytesUploaded += texTask.size || 0;
            } catch (e) {
                console.warn('[GPUUploadQueue] Texture upload failed:', e);
            }
        }

        // 2. 上传顶点 Buffer
        while (_bufferQueue.length > 0 && bufferCount < MAX_BUFFER_UPLOADS_PER_FRAME) {
            var bufTask = _bufferQueue.shift();
            try {
                bufTask.upload();
                bufferCount++;
            } catch (e) {
                console.warn('[GPUUploadQueue] Buffer upload failed:', e);
            }
        }

        // 3. 检查温控状态
        checkThermal();
    }

    // ===== 添加纹理上传任务 =====
    function enqueueTexture(texture, imageBitmap, isHighPriority) {
        var task = {
            size: estimateTextureSize(imageBitmap),
            upload: function() {
                texture.image = imageBitmap;
                texture.needsUpdate = true;
            }
        };

        if (isHighPriority) {
            _textureQueue.unshift(task); // 高优先级插队
        } else {
            _textureQueue.push(task);
        }
    }

    // ===== 添加顶点 Buffer 上传任务 =====
    function enqueueBuffer(geometry, attributeName, array) {
        _bufferQueue.push({
            upload: function() {
                var attr = geometry.getAttribute(attributeName);
                if (attr) {
                    attr.array = array;
                    attr.needsUpdate = true;
                } else {
                    geometry.setAttribute(attributeName, new THREE.BufferAttribute(array, 3));
                }
            }
        });
    }

    // ===== 添加空闲任务（非关键资源）=====
    function enqueueIdle(task) {
        _idleQueue.push(task);

        // 尝试用 requestIdleCallback 处理
        var ric = typeof requestIdleCallback === 'function' ? requestIdleCallback : null;
        if (ric) {
            ric(function(deadline) {
                while (_idleQueue.length > 0 && deadline.timeRemaining() > 0) {
                    var t = _idleQueue.shift();
                    try { t(); } catch (e) { console.warn('[GPUUploadQueue] Idle task failed:', e); }
                }
            }, { timeout: 2000 });
        } else {
            // 降级：setTimeout
            while (_idleQueue.length > 0) {
                var t = _idleQueue.shift();
                try { t(); } catch (e) {}
            }
        }
    }

    // ===== 从预处理数据构建 Geometry（OPFS 快速路径）=====
    function buildGeometryFromPreprocessed(data) {
        var geometry = new THREE.BufferGeometry();

        if (data.geometry) {
            geometry.setAttribute('position', new THREE.BufferAttribute(data.geometry, 3));
        }
        if (data.normals) {
            geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
        }
        if (data.uvs) {
            geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
        }
        if (data.indices) {
            geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
        }

        geometry.computeBoundingSphere();
        geometry.computeBoundingBox();
        return geometry;
    }

    // ===== 从预处理数据构建纹理（OPFS 快速路径）=====
    function buildTextureFromPreprocessed(rawData, width, height) {
        var texture = new THREE.DataTexture(rawData, width, height, THREE.RGBAFormat);
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = window._renderer ? _renderer.capabilities.getMaxAnisotropy() : 1;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        return texture;
    }

    // ===== 估算纹理大小 =====
    function estimateTextureSize(imageBitmap) {
        if (!imageBitmap) return 0;
        var w = imageBitmap.width || 512;
        var h = imageBitmap.height || 512;
        return w * h * 4; // RGBA = 4 bytes/pixel
    }

    // ===== 获取队列状态 =====
    function getStatus() {
        return {
            textureQueue: _textureQueue.length,
            bufferQueue: _bufferQueue.length,
            idleQueue: _idleQueue.length,
            coolingDown: _coolingDown
        };
    }

    // ===== 清空队列 =====
    function clear() {
        _textureQueue = [];
        _bufferQueue = [];
        _idleQueue = [];
    }

    window.GPUUploadQueue = {
        tick: tick,
        enqueueTexture: enqueueTexture,
        enqueueBuffer: enqueueBuffer,
        enqueueIdle: enqueueIdle,
        buildGeometryFromPreprocessed: buildGeometryFromPreprocessed,
        buildTextureFromPreprocessed: buildTextureFromPreprocessed,
        getStatus: getStatus,
        clear: clear
    };

    console.log('[GPUUploadQueue] Module loaded');
})();
