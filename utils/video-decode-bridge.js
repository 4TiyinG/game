// video-decode-bridge.js — WebCodecs 解码桥接 + MediaCapabilities 探测
// 负责在主线程和 video-decode-worker.js 之间建立通信桥梁
// 并使用 MediaCapabilities API 探测骁龙8+ 的硬解能力
(function() {
    'use strict';

    var _worker = null;
    var _texture = null;
    var _mesh = null;
    var _isUsingWebCodecs = false;
    var _rvfCallback = null; // requestVideoFrameCallback 降级方案

    // ===== 能力探测 =====
    function detectCapabilities() {
        var caps = {
            webcodecs: typeof VideoDecoder !== 'undefined',
            offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
            mediaCapabilities: typeof navigator !== 'undefined' && navigator.mediaCapabilities,
            requestVideoFrameCallback: typeof HTMLVideoElement !== 'undefined' &&
                typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function'
        };
        caps.allSupported = caps.webcodecs && caps.offscreenCanvas;
        console.log('[VideoDecodeBridge] capabilities:', caps);
        return caps;
    }

    // ===== MediaCapabilities 硬解能力查询 =====
    function queryDecodeCapability(config) {
        if (!navigator.mediaCapabilities) return Promise.resolve({ smooth: true, powerEfficient: true });

        return navigator.mediaCapabilities.decodingInfo({
            type: 'file',
            video: {
                contentType: config.contentType || 'video/mp4; codecs="avc1.42E01E"',
                width: config.width || 1280,
                height: config.height || 720,
                bitrate: config.bitrate || 5000000,
                framerate: config.framerate || 30
            }
        }).then(function(result) {
            console.log('[VideoDecodeBridge] MediaCapabilities:', {
                smooth: result.smooth,
                powerEfficient: result.powerEfficient,
                supported: result.supported
            });
            return result;
        }).catch(function() {
            return { smooth: true, powerEfficient: true, supported: true };
        });
    }

    // ===== 初始化 WebCodecs 解码流水线 =====
    function initWebCodecsPipeline(texture, mesh) {
        _texture = texture;
        _mesh = mesh;

        try {
            _worker = new Worker('./workers/video-decode-worker.js');
            _worker.onmessage = handleWorkerMessage;
            _worker.onerror = function(e) {
                console.warn('[VideoDecodeBridge] Worker error:', e);
            };
            _worker.postMessage({ type: 'init', config: {} });
            _isUsingWebCodecs = true;
            return true;
        } catch (e) {
            console.warn('[VideoDecodeBridge] WebCodecs pipeline init failed:', e);
            return false;
        }
    }

    // ===== 处理 Worker 返回的消息 =====
    function handleWorkerMessage(e) {
        var data = e.data;

        switch (data.type) {
            case 'ready':
                console.log('[VideoDecodeBridge] Decoder ready:', data.width, 'x', data.height);
                break;

            case 'frame':
                // 收到解码后的 ImageBitmap，直接更新纹理
                if (_texture && data.bitmap) {
                    _texture.image = data.bitmap;
                    _texture.needsUpdate = true;
                }
                break;

            case 'unsupported':
                console.warn('[VideoDecodeBridge] WebCodecs unsupported:', data.reason);
                _isUsingWebCodecs = false;
                break;

            case 'demuxUnsupported':
                // MP4 demux 不支持，降级到 <video> 方案
                console.warn('[VideoDecodeBridge] MP4 demux unsupported, falling back to <video>');
                _isUsingWebCodecs = false;
                break;

            case 'decodeError':
                console.warn('[VideoDecodeBridge] Decode error:', data.message);
                break;

            case 'error':
                console.warn('[VideoDecodeBridge] Error:', data.message);
                break;
        }
    }

    // ===== 投递视频文件给 Worker 解码 =====
    function startDecoding(arrayBuffer) {
        if (!_worker || !_isUsingWebCodecs) return false;
        _worker.postMessage({ type: 'demux', buffer: arrayBuffer }, [arrayBuffer]);
        return true;
    }

    // ===== requestVideoFrameCallback 降级方案 =====
    // 当 WebCodecs 不可用时，用 rVFC 替代 rAF 来同步纹理更新
    // 优势：回调频率与视频帧率同步（如 25fps 视频触发 25 次），而非 rAF 的固定 60 次
    function startVideoFrameCallback(video, texture) {
        if (!video || !texture) return;
        if (!HTMLVideoElement.prototype.requestVideoFrameCallback) return;

        _rvfCallback = function(now, metadata) {
            texture.needsUpdate = true; // 标记纹理需要更新
            video.requestVideoFrameCallback(_rvfCallback);
        };
        video.requestVideoFrameCallback(_rvfCallback);
        console.log('[VideoDecodeBridge] Using requestVideoFrameCallback for texture sync');
    }

    function stopVideoFrameCallback(video) {
        _rvfCallback = null;
    }

    // ===== 暂停/恢复 =====
    function pause() {
        if (_worker && _isUsingWebCodecs) {
            _worker.postMessage({ type: 'pause' });
        }
    }

    function resume() {
        if (_worker && _isUsingWebCodecs) {
            _worker.postMessage({ type: 'resume' });
        }
    }

    // ===== 销毁 =====
    function dispose() {
        if (_worker) {
            _worker.postMessage({ type: 'dispose' });
            _worker.terminate();
            _worker = null;
        }
        _isUsingWebCodecs = false;
        _texture = null;
        _mesh = null;
        _rvfCallback = null;
    }

    // ===== 暴露 API =====
    window.VideoDecodeBridge = {
        detectCapabilities: detectCapabilities,
        queryDecodeCapability: queryDecodeCapability,
        initWebCodecsPipeline: initWebCodecsPipeline,
        startDecoding: startDecoding,
        startVideoFrameCallback: startVideoFrameCallback,
        stopVideoFrameCallback: stopVideoFrameCallback,
        pause: pause,
        resume: resume,
        dispose: dispose,
        isUsingWebCodecs: function() { return _isUsingWebCodecs; }
    };

    console.log('[VideoDecodeBridge] Module loaded');
})();
