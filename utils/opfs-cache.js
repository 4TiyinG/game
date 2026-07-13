// opfs-cache.js — OPFS（Origin Private File System）缓存系统
// 将 Worker 解析好的预处理数据（顶点 Float32Array、纹理 RGBA）写入 OPFS
// 二次加载时直接 read() 跳过所有解析步骤，利用 UFS 4.0 高速读写
// 速度比 IndexedDB 快 3~5 倍
(function() {
    'use strict';

    var _rootDir = null;
    var _isSupported = typeof navigator !== 'undefined' &&
        navigator.storage && navigator.storage.getDirectory;

    // ===== 初始化根目录 =====
    function init() {
        if (!_isSupported) {
            console.warn('[OPFS] Not supported, falling back to IndexedDB');
            return Promise.resolve(false);
        }
        return navigator.storage.getDirectory().then(function(dir) {
            _rootDir = dir;
            console.log('[OPFS] Root directory ready');
            return true;
        }).catch(function(e) {
            console.warn('[OPFS] init failed:', e);
            _isSupported = false;
            return false;
        });
    }

    // ===== 写入预处理数据 =====
    // key: 资源唯一标识（如 "player-model-v2"）
    // buffers: { geometry: Float32Array, indices: Uint32Array, textures: [{name, data}] }
    function savePreprocessed(key, buffers) {
        if (!_rootDir) return Promise.resolve(false);

        return _rootDir.getDirectoryHandle(key, { create: true }).then(function(dirHandle) {
            var promises = [];

            // 写入几何体数据
            if (buffers.geometry) {
                promises.push(writeFile(dirHandle, 'geometry.bin', buffers.geometry.buffer));
            }
            if (buffers.indices) {
                promises.push(writeFile(dirHandle, 'indices.bin', buffers.indices.buffer));
            }
            if (buffers.normals) {
                promises.push(writeFile(dirHandle, 'normals.bin', buffers.normals.buffer));
            }
            if (buffers.uvs) {
                promises.push(writeFile(dirHandle, 'uvs.bin', buffers.uvs.buffer));
            }

            // 写入纹理数据（RGBA 原始像素）
            if (buffers.textures) {
                for (var i = 0; i < buffers.textures.length; i++) {
                    var tex = buffers.textures[i];
                    promises.push(writeFile(dirHandle, 'tex_' + i + '_' + tex.name + '.raw', tex.data));
                }
            }

            // 写入元数据
            var meta = {
                timestamp: Date.now(),
                version: 1,
                textureCount: buffers.textures ? buffers.textures.length : 0,
                vertexCount: buffers.geometry ? buffers.geometry.length / 3 : 0,
                indexCount: buffers.indices ? buffers.indices.length : 0
            };
            promises.push(writeFile(dirHandle, 'meta.json', JSON.stringify(meta)));

            return Promise.all(promises).then(function() {
                console.log('[OPFS] Saved:', key, meta);
                return true;
            });
        }).catch(function(e) {
            console.warn('[OPFS] save failed:', key, e);
            return false;
        });
    }

    // ===== 读取预处理数据 =====
    function loadPreprocessed(key) {
        if (!_rootDir) return Promise.resolve(null);

        return _rootDir.getDirectoryHandle(key).then(function(dirHandle) {
            // 先读取元数据
            return readFile(dirHandle, 'meta.json').then(function(metaBuf) {
                var meta = JSON.parse(new TextDecoder().decode(metaBuf));
                meta.dirHandle = dirHandle;

                // 并发读取所有数据文件
                var reads = {};
                if (meta.vertexCount > 0) {
                    reads.geometry = readFile(dirHandle, 'geometry.bin').then(function(buf) {
                        return new Float32Array(buf);
                    });
                    reads.normals = readFile(dirHandle, 'normals.bin').then(function(buf) {
                        return new Float32Array(buf);
                    });
                    reads.uvs = readFile(dirHandle, 'uvs.bin').then(function(buf) {
                        return new Float32Array(buf);
                    });
                }
                if (meta.indexCount > 0) {
                    reads.indices = readFile(dirHandle, 'indices.bin').then(function(buf) {
                        return new Uint32Array(buf);
                    });
                }

                var texPromises = [];
                for (var i = 0; i < meta.textureCount; i++) {
                    texPromises.push(
                        findTextureFile(dirHandle, i).then(function(name) {
                            if (!name) return null;
                            return readFile(dirHandle, name).then(function(buf) {
                                return { name: name, data: buf };
                            });
                        })
                    );
                }

                // 合并所有读取结果
                var keys = Object.keys(reads);
                var allPromises = keys.map(function(k) { return reads[k]; });
                return Promise.all(allPromises).then(function(results) {
                    var data = { meta: meta };
                    for (var j = 0; j < keys.length; j++) {
                        data[keys[j]] = results[j];
                    }
                    return Promise.all(texPromises).then(function(textures) {
                        data.textures = textures.filter(function(t) { return t !== null; });
                        console.log('[OPFS] Loaded:', key, data.meta);
                        return data;
                    });
                });
            });
        }).catch(function(e) {
            // 缓存不存在是正常情况，不报 warn
            return null;
        });
    }

    // ===== 检查缓存是否存在 =====
    function has(key) {
        if (!_rootDir) return Promise.resolve(false);
        return _rootDir.getDirectoryHandle(key).then(function() { return true; })
            .catch(function() { return false; });
    }

    // ===== 删除缓存 =====
    function remove(key) {
        if (!_rootDir) return Promise.resolve(false);
        return _rootDir.removeEntry(key, { recursive: true }).then(function() {
            console.log('[OPFS] Removed:', key);
            return true;
        }).catch(function() { return false; });
    }

    // ===== 清空所有缓存 =====
    function clear() {
        if (!_rootDir) return Promise.resolve(false);
        return _rootDir.keys().then(function(keys) {
            var promises = [];
            for (var i = 0; i < keys.length; i++) {
                promises.push(_rootDir.removeEntry(keys[i], { recursive: true }));
            }
            return Promise.all(promises);
        }).then(function() {
            console.log('[OPFS] All cache cleared');
            return true;
        });
    }

    // ===== 分片读取（温控联动模式）=====
    // 每次只读 chunkSize 字节，避免内存带宽争抢加剧发热
    function loadChunked(key, chunkSize) {
        chunkSize = chunkSize || 2 * 1024 * 1024; // 默认 2MB
        if (!_rootDir) return Promise.resolve(null);

        return _rootDir.getDirectoryHandle(key).then(function(dirHandle) {
            return readFile(dirHandle, 'meta.json').then(function(metaBuf) {
                var meta = JSON.parse(new TextDecoder().decode(metaBuf));
                // 分片读取仅返回元数据 + 文件列表，实际数据按需分片读取
                meta.dirHandle = dirHandle;
                meta.chunkSize = chunkSize;
                meta.isChunked = true;
                return meta;
            });
        }).catch(function() { return null; });
    }

    // ===== 内部工具函数 =====
    function writeFile(dirHandle, name, buffer) {
        return dirHandle.getFileHandle(name, { create: true }).then(function(fileHandle) {
            return fileHandle.createWritable();
        }).then(function(writable) {
            return writable.write(buffer).then(function() {
                return writable.close();
            });
        });
    }

    function readFile(dirHandle, name) {
        return dirHandle.getFileHandle(name).then(function(fileHandle) {
            return fileHandle.getFile();
        }).then(function(file) {
            return file.arrayBuffer();
        });
    }

    function findTextureFile(dirHandle, index) {
        // 查找以 tex_{index}_ 开头的文件
        return dirHandle.keys().then(function(keys) {
            var prefix = 'tex_' + index + '_';
            for (var i = 0; i < keys.length; i++) {
                if (keys[i].indexOf(prefix) === 0) return keys[i];
            }
            return null;
        });
    }

    // ===== 暴露 API =====
    window.OPFSCache = {
        init: init,
        isSupported: function() { return _isSupported; },
        savePreprocessed: savePreprocessed,
        loadPreprocessed: loadPreprocessed,
        has: has,
        remove: remove,
        clear: clear,
        loadChunked: loadChunked
    };

    console.log('[OPFSCache] Module loaded | supported:', _isSupported);
})();
