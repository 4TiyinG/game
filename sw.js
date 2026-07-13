// sw.js — Service Worker 预热缓存
// 启动时将核心资源预加载到 CacheStorage，后续 fetch 直接从内存级缓存返回
// 耗时从 5~10ms（磁盘）降至 <1ms（内存）

var CACHE_NAME = 'snapdragon-3d-v1';
// 仅缓存实际存在的核心文件（路径需与项目结构完全匹配）
var CORE_ASSETS = [
    '/',
    '/index.html',
    '/css/ui-base.css',
    '/css/ui-actions.css',
    '/css/ui-settings.css',
    '/css/ui-responsive.css',
    '/css/ui-backdrop.css',
    '/css/ui-footer.css',
    '/css/ui-header.css',
    '/css/ui-joystick.css',
    '/assets/libs/three.module.js',
    '/assets/libs/jsm/loaders/GLTFLoader.js',
    '/assets/libs/jsm/loaders/DRACOLoader.js',
    '/assets/libs/jsm/utils/BufferGeometryUtils.js',
    '/assets/libs/nipplejs.min.js',
    '/assets/textures/skybox/skybox_px.jpg',
    '/assets/textures/skybox/skybox_nx.jpg',
    '/assets/textures/skybox/skybox_py.jpg',
    '/assets/textures/skybox/skybox_ny.jpg',
    '/assets/textures/skybox/skybox_pz.jpg',
    '/assets/textures/skybox/skybox_nz.jpg',
    '/assets/textures/hardwood2_diffuse.jpg',
    '/app/app-loop.js',
    '/app/app-loader.js',
    '/app/app-state.js',
    '/app/app-interact.js',
    '/app/app-env.js',
    '/app/app-utils.js',
    '/engine/scene-camera.js',
    '/engine/ik-controller.js',
    '/engine/ik-adapter.js',
    '/engine/ik-ccd.js',
    '/engine/ik-debug.js',
    '/engine/ik-foot-phase.js',
    '/engine/ik-skeleton.js',
    '/engine/physics-world.js',
    '/engine/audio-system.js',
    '/engine/movement-joystick.js',
    '/engine/position-smooth.js',
    '/core/character-module.js',
    '/core/character-anim.js',
    '/core/character-collider.js',
    '/core/character-settings.js',
    '/core/character-state.js',
    '/ui/ui-dom.js',
    '/ui/ui-config-panel.js',
    '/ui/video-screen-shader.js',
    '/utils/model-cache.js',
    '/utils/task-scheduler.js',
    '/utils/thermal-system.js',
    '/utils/video-decode-bridge.js',
    '/utils/opfs-cache.js',
    '/utils/asset-parse-pool.js',
    '/utils/gpu-upload-queue.js',
    '/workers/model-parser.worker.js',
    '/workers/collider-mesh.worker.js',
    '/workers/video-reader.worker.js',
    '/workers/video-decode-worker.js',
    '/draco/draco_decoder.js',
    '/draco/draco_decoder.wasm',
    '/draco/draco_wasm_wrapper.js',
    '/model/hongmao.glb',
    '/model/pc.glb'
];

// 安装时预加载核心资源
self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            // 逐个添加，避免单个失败导致全部失败
            return Promise.allSettled(
                CORE_ASSETS.map(function(url) {
                    return cache.add(url).catch(function(e) {
                        console.warn('[SW] Failed to cache:', url, e.message);
                    });
                })
            );
        }).then(function() {
            console.log('[SW] Core assets pre-cached');
            return self.skipWaiting();
        })
    );
});

// 激活时清理旧缓存
self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(names) {
            return Promise.all(
                names.map(function(name) {
                    if (name !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    }
                })
            );
        }).then(function() {
            return self.clients.claim();
        })
    );
});

// 拦截 fetch 请求，优先从缓存返回
self.addEventListener('fetch', function(event) {
    // 仅处理 GET 请求
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request).then(function(cachedResponse) {
            if (cachedResponse) {
                // 缓存命中：立即返回（<1ms）
                return cachedResponse;
            }
            // 缓存未命中：从网络获取，并缓存结果
            return fetch(event.request).then(function(networkResponse) {
                // 仅缓存成功的响应
                if (!networkResponse || networkResponse.status !== 200) {
                    return networkResponse;
                }
                var responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then(function(cache) {
                    cache.put(event.request, responseClone);
                });
                return networkResponse;
            }).catch(function() {
                // 网络失败且无缓存：返回离线提示
                return new Response('Offline', { status: 503, statusText: 'Offline' });
            });
        })
    );
});

// 接收主线程的消息
self.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    if (event.data && event.data.type === 'CACHE_URL') {
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.add(event.data.url);
        }).then(function() {
            event.source.postMessage({ type: 'CACHED', url: event.data.url });
        });
    }
});
