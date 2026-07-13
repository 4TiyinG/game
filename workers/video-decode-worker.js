// video-decode-worker.js — WebCodecs + OffscreenCanvas 后台解码流水线
// 在 Worker 中使用 VideoDecoder 硬件解码视频帧，通过 OffscreenCanvas 绘制后
// 转为 ImageBitmap 零拷贝传回主线程，从根本上消除主线程解码卡顿

var _decoder = null;
var _canvas = null;
var _ctx = null;
var _isRunning = false;
var _framePool = [];
var _maxPoolSize = 3; // 帧池上限，避免内存碎片

// ===== 初始化解码器 =====
function initDecoder(config) {
    if (typeof VideoDecoder === 'undefined') {
        self.postMessage({ type: 'unsupported', reason: 'VideoDecoder API not available' });
        return false;
    }

    try {
        _canvas = new OffscreenCanvas(config.width || 1280, config.height || 720);
        _ctx = _canvas.getContext('2d', { alpha: false });
        if (!_ctx) {
            self.postMessage({ type: 'unsupported', reason: 'OffscreenCanvas 2D context failed' });
            return false;
        }

        _decoder = new VideoDecoder({
            output: handleDecodedFrame,
            error: function(e) {
                self.postMessage({ type: 'decodeError', message: e.message || String(e) });
            }
        });

        _decoder.configure({
            codec: config.codec || 'avc1.42E01E', // H.264 Baseline
            optimizeForLatency: false,
            hardwareAcceleration: 'prefer-hardware' // 骁龙8+ 硬解优先
        });

        _isRunning = true;
        self.postMessage({ type: 'ready', width: _canvas.width, height: _canvas.height });
        return true;
    } catch (e) {
        self.postMessage({ type: 'unsupported', reason: e.message });
        return false;
    }
}

// ===== 处理解码后的视频帧 =====
function handleDecodedFrame(frame) {
    if (!_isRunning || !_ctx) {
        frame.close();
        return;
    }

    try {
        // 绘制到 OffscreenCanvas
        _ctx.drawImage(frame, 0, 0, _canvas.width, _canvas.height);
        frame.close();

        // 转为 ImageBitmap 并转移所有权给主线程（零拷贝）
        createImageBitmap(_canvas).then(function(bitmap) {
            self.postMessage({ type: 'frame', bitmap: bitmap }, [bitmap]);
        }).catch(function(e) {
            // ImageBitmap 创建失败时跳过此帧
        });
    } catch (e) {
        try { frame.close(); } catch (_) {}
    }
}

// ===== 接收编码视频块并投递给解码器 =====
function feedChunk(data) {
    if (!_decoder || _decoder.state !== 'configured') return;

    try {
        var chunk = new EncodedVideoChunk({
            type: data.type || 'key', // 'key' 或 'delta'
            timestamp: data.timestamp || 0,
            duration: data.duration || 0,
            data: data.buffer
        });
        _decoder.decode(chunk);
    } catch (e) {
        self.postMessage({ type: 'decodeError', message: 'feedChunk failed: ' + e.message });
    }
}

// ===== 接收完整文件并提取 MP4 数据 =====
// 使用 mp4box.js 风格的简易 demux（仅支持 MP4）
function demuxAndFeed(arrayBuffer) {
    // 检查是否为 MP4
    var view = new DataView(arrayBuffer);
    if (arrayBuffer.byteLength < 12 || view.getUint32(4, false) !== 0x66747970) {
        self.postMessage({ type: 'error', message: 'WebCodecs 解码仅支持 MP4 格式，已降级到 <video> 标签' });
        return;
    }

    // 如果浏览器不支持 mp4box.js，无法 demux，降级
    if (typeof self.mp4box === 'undefined') {
        self.postMessage({ type: 'demuxUnsupported', buffer: arrayBuffer }, [arrayBuffer]);
        return;
    }

    // 高级 demux 流程（需 mp4box.js 库支持）
    var file = self.mp4box.createFile();
    file.onError = function(e) {
        self.postMessage({ type: 'error', message: 'MP4 demux error: ' + e });
    };
    file.onReady = function(info) {
        var videoTrack = null;
        for (var i = 0; i < info.tracks.length; i++) {
            if (info.tracks[i].codec && info.tracks[i].codec.startsWith('avc')) {
                videoTrack = info.tracks[i];
                break;
            }
        }
        if (!videoTrack) {
            self.postMessage({ type: 'error', message: '未找到 H.264 视频轨道' });
            return;
        }

        // 配置解码器
        var codec = videoTrack.codec || 'avc1.42E01E';
        if (!initDecoder({ codec: codec, width: videoTrack.track_width, height: videoTrack.track_height })) {
            return;
        }

        // 设置样本提取回调
        file.setExtractionOptions(videoTrack.id, null, { nbSamples: 30 });
        file.onSamples = function(trackId, ref, samples) {
            for (var i = 0; i < samples.length; i++) {
                var s = samples[i];
                var buf = s.data.buffer.slice(s.data.byteOffset, s.data.byteOffset + s.data.byteLength);
                feedChunk({
                    type: s.is_sync ? 'key' : 'delta',
                    timestamp: Math.round(s.cts * 1000000 / s.timescale),
                    duration: Math.round(s.duration * 1000000 / s.timescale),
                    buffer: buf
                });
            }
            file.start();
        };
        file.start();
    };

    // 喂数据给 mp4box
    var copy = arrayBuffer.slice(0);
    copy.fileStart = 0;
    file.appendBuffer(copy);
    file.flush();
}

// ===== 消息处理 =====
self.onmessage = function(e) {
    var data = e.data;

    switch (data.type) {
        case 'init':
            initDecoder(data.config || {});
            break;

        case 'feed':
            feedChunk(data);
            break;

        case 'demux':
            demuxAndFeed(data.buffer);
            break;

        case 'pause':
            _isRunning = false;
            if (_decoder) _decoder.reset();
            break;

        case 'resume':
            _isRunning = true;
            if (_decoder && _decoder.state === 'unconfigured') {
                _decoder.configure({ codec: data.codec || 'avc1.42E01E', hardwareAcceleration: 'prefer-hardware' });
            }
            break;

        case 'dispose':
            _isRunning = false;
            if (_decoder) { try { _decoder.close(); } catch(e) {} _decoder = null; }
            _canvas = null;
            _ctx = null;
            _framePool = [];
            break;

        case 'resize':
            if (_canvas && data.width && data.height) {
                _canvas.width = data.width;
                _canvas.height = data.height;
            }
            break;
    }
};
