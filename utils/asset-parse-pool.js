// asset-parse-pool.js — Worker 池并行解析系统
// 压榨骁龙8+ 的 3 个 A710 大核 + 备用核
// Worker 数量 = cores - 2（留 2 个给主线程和系统）
// 在 Worker 内完成：GLB 解析、JSON.parse、createImageBitmap 解码
// 主线程仅负责接收解析结果并挂载到场景

(function() {
    'use strict';

    var _workers = [];
    var _taskQueue = [];
    var _isInitialized = false;
    var _workerCount = 0;

    // ===== 内联 Worker 代码（避免额外文件）=====
    var WORKER_CODE = `
self.onmessage = function(e) {
    var data = e.data;
    switch (data.type) {
        case 'parseGLB':
            parseGLB(data.buffer, data.url);
            break;
        case 'decodeImage':
            decodeImage(data.blob, data.options || {});
            break;
        case 'parseJSON':
            parseJSON(data.text);
            break;
        case 'decompress':
            decompress(data.buffer, data.algorithm || 'lz4');
            break;
    }
};

function parseGLB(buffer, url) {
    try {
        // 解析 GLB 二进制头部
        var view = new DataView(buffer);
        var magic = view.getUint32(0, true);
        var version = view.getUint32(4, true);
        var length = view.getUint32(8, true);

        if (magic !== 0x46546C67) { // 'glTF'
            self.postMessage({ type: 'error', message: 'Invalid GLB magic', url: url });
            return;
        }

        // 提取 JSON chunk 和 BIN chunk
        var offset = 12;
        var jsonChunk = null;
        var binChunk = null;

        while (offset < length) {
            var chunkLength = view.getUint32(offset, true);
            var chunkType = view.getUint32(offset + 4, true);
            var chunkData = buffer.slice(offset + 8, offset + 8 + chunkLength);

            if (chunkType === 0x4E4F534A) { // JSON
                jsonChunk = new TextDecoder().decode(chunkData);
            } else if (chunkType === 0x004E4942) { // BIN
                binChunk = chunkData;
            }
            offset += 8 + chunkLength;
        }

        // 返回解析结果（BIN chunk 通过 Transferable 零拷贝传输）
        var json = JSON.parse(jsonChunk);
        self.postMessage({
            type: 'parsedGLB',
            url: url,
            json: json,
            binaryBuffer: binChunk
        }, binChunk ? [binChunk] : []);
    } catch (e) {
        self.postMessage({ type: 'error', message: e.message, url: url });
    }
}

function decodeImage(blob, options) {
    createImageBitmap(blob, options).then(function(bitmap) {
        self.postMessage({ type: 'decodedImage', bitmap: bitmap }, [bitmap]);
    }).catch(function(e) {
        self.postMessage({ type: 'error', message: 'Image decode failed: ' + e.message });
    });
}

function parseJSON(text) {
    try {
        var json = JSON.parse(text);
        self.postMessage({ type: 'parsedJSON', json: json });
    } catch (e) {
        self.postMessage({ type: 'error', message: 'JSON parse failed: ' + e.message });
    }
}

function decompress(buffer, algorithm) {
    // 预留 WASM 解压接口（Brotli/LZ4）
    // 当前使用浏览器原生 DecompressionStream 作为降级
    try {
        if (algorithm === 'gzip' && typeof DecompressionStream !== 'undefined') {
            var ds = new DecompressionStream('gzip');
            var stream = new Response(buffer).body.pipeThrough(ds);
            new Response(stream).arrayBuffer().then(function(decompressed) {
                self.postMessage({ type: 'decompressed', buffer: decompressed }, [decompressed]);
            });
        } else if (algorithm === 'deflate' && typeof DecompressionStream !== 'undefined') {
            var ds2 = new DecompressionStream('deflate');
            var stream2 = new Response(buffer).body.pipeThrough(ds2);
            new Response(stream2).arrayBuffer().then(function(decompressed) {
                self.postMessage({ type: 'decompressed', buffer: decompressed }, [decompressed]);
            });
        } else {
            // 不支持的算法，原样返回
            self.postMessage({ type: 'decompressed', buffer: buffer }, [buffer]);
        }
    } catch (e) {
        self.postMessage({ type: 'error', message: 'Decompress failed: ' + e.message });
    }
}
`;

    // ===== 初始化 Worker 池 =====
    function init() {
        if (_isInitialized) return;
        _isInitialized = true;

        // 骁龙8+ 通常报告 8 核（1+3+4），取 cores - 2 = 6，但限制最多 4 个
        var cores = navigator.hardwareConcurrency || 4;
        _workerCount = Math.min(Math.max(cores - 2, 2), 4);
        console.log('[AssetParsePool] cores:', cores, 'workers:', _workerCount);

        var blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
        var url = URL.createObjectURL(blob);

        for (var i = 0; i < _workerCount; i++) {
            var worker = new Worker(url);
            worker._busy = false;
            worker._callback = null;
            worker.onmessage = createHandler(i);
            worker.onerror = function(e) {
                console.warn('[AssetParsePool] Worker error:', e);
            };
            _workers.push(worker);
        }

        // URL 在 Worker 创建后可以释放
        setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
    }

    function createHandler(index) {
        return function(e) {
            var worker = _workers[index];
            worker._busy = false;
            if (worker._callback) {
                var cb = worker._callback;
                worker._callback = null;
                cb(e.data);
            }
            // 处理队列中的下一个任务
            processQueue();
        };
    }

    // ===== 分配任务到空闲 Worker =====
    function dispatch(task) {
        for (var i = 0; i < _workers.length; i++) {
            if (!_workers[i]._busy) {
                var worker = _workers[i];
                worker._busy = true;
                worker._callback = task.callback;
                worker.postMessage(task.data, task.transfer || []);
                return true;
            }
        }
        return false;
    }

    function processQueue() {
        if (_taskQueue.length === 0) return;
        var task = _taskQueue.shift();
        if (!dispatch(task)) {
            // 没有空闲 Worker，放回队列头部
            _taskQueue.unshift(task);
        }
    }

    // ===== 公共 API =====

    // 解析 GLB 文件
    function parseGLB(buffer, url) {
        return new Promise(function(resolve, reject) {
            var task = {
                data: { type: 'parseGLB', buffer: buffer, url: url || '' },
                transfer: [buffer],
                callback: function(result) {
                    if (result.type === 'error') reject(new Error(result.message));
                    else resolve(result);
                }
            };
            if (!dispatch(task)) _taskQueue.push(task);
        });
    }

    // 解码图片为 ImageBitmap（零拷贝转移）
    function decodeImage(blob, options) {
        return new Promise(function(resolve, reject) {
            var task = {
                data: { type: 'decodeImage', blob: blob, options: options || {} },
                transfer: [],
                callback: function(result) {
                    if (result.type === 'error') reject(new Error(result.message));
                    else resolve(result.bitmap);
                }
            };
            if (!dispatch(task)) _taskQueue.push(task);
        });
    }

    // 解析 JSON
    function parseJSON(text) {
        return new Promise(function(resolve, reject) {
            var task = {
                data: { type: 'parseJSON', text: text },
                transfer: [],
                callback: function(result) {
                    if (result.type === 'error') reject(new Error(result.message));
                    else resolve(result.json);
                }
            };
            if (!dispatch(task)) _taskQueue.push(task);
        });
    }

    // 解压数据
    function decompress(buffer, algorithm) {
        return new Promise(function(resolve, reject) {
            var task = {
                data: { type: 'decompress', buffer: buffer, algorithm: algorithm || 'gzip' },
                transfer: [buffer],
                callback: function(result) {
                    if (result.type === 'error') reject(new Error(result.message));
                    else resolve(result.buffer);
                }
            };
            if (!dispatch(task)) _taskQueue.push(task);
        });
    }

    // 获取队列状态
    function getStatus() {
        var busyCount = 0;
        for (var i = 0; i < _workers.length; i++) {
            if (_workers[i]._busy) busyCount++;
        }
        return {
            totalWorkers: _workerCount,
            busyWorkers: busyCount,
            queuedTasks: _taskQueue.length
        };
    }

    // 终止所有 Worker
    function dispose() {
        for (var i = 0; i < _workers.length; i++) {
            _workers[i].terminate();
        }
        _workers = [];
        _taskQueue = [];
        _isInitialized = false;
    }

    window.AssetParsePool = {
        init: init,
        parseGLB: parseGLB,
        decodeImage: decodeImage,
        parseJSON: parseJSON,
        decompress: decompress,
        getStatus: getStatus,
        dispose: dispose,
        isReady: function() { return _isInitialized; }
    };

    console.log('[AssetParsePool] Module loaded');
})();
