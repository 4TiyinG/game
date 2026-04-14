// GameExtras.js - 高性能扩展模块（Web Worker + 实例化渲染 + 几何体池化）
window.GameExtras = (function() {
    const Gu = window.GameUtils;
    
    let scene = null, camera = null, renderer = null, aiModel = null;
    let mirrorObj = null, mirrorOriginalPos = null, mirrorHitCooldown = false;
    
    // ========== 子弹系统：使用 InstancedMesh（实例化渲染）==========
    const MAX_BULLETS = 40;
    let bulletInstancedMesh = null;      // 单个 InstancedMesh 管理所有子弹
    let bulletInstanceMatrices = [];      // 每个实例的变换矩阵
    let bulletActiveMap = new Map();      // id → instanceIndex
    let bulletIdToInstance = new Map();    // id → instanceIndex
    let instanceToId = new Map();          // instanceIndex → id
    let nextInstanceIndex = 0;
    let nextBulletId = 0;
    let freeInstances = [];                // 空闲实例索引池
    
    // 共享几何体和材质
    let sharedBulletGeom = null;
    let sharedBulletMat = null;
    
    // ========== 命中特效系统：对象池优化 ==========
    const HIT_POOL_SIZE = 30;
    let hitEffectPool = [];
    let activeEffects = [];
    let hitEffectGeom = null;
    let hitEffectMat = null;
    
    // ========== Worker 相关 ==========
    let bulletWorker = null;
    let workerReady = false;
    let workerReadyResolve = null;
    const workerReadyPromise = new Promise(resolve => { workerReadyResolve = resolve; });
    
    // 临时复用对象（减少 GC）
    const _tempVec = new THREE.Vector3();
    const _tempDir = new THREE.Vector3();
    const _tempMatrix = new THREE.Matrix4();
    
    // 性能监控
    let statsEnabled = false;
    let stats = null;
    let frameCount = 0;
    let lastTime = performance.now();
    
    // ========== Worker 代码（二进制协议 + Transferable） ==========
    const workerCode = `
        let bullets = [];
        let config = {
            bulletSpeed: 50,
            maxLife: 0.8,
            maxBullets: 40,
            viewDistance: 100,
            aiBox: { minX: -0.5, minY: -1, minZ: -0.5, maxX: 0.5, maxY: 1, maxZ: 0.5 },
            mirrorBox: { minX: -2.5, minY: 0.05, minZ: -6.15, maxX: 2.5, maxY: 3.05, maxZ: -5.85 }
        };
        let aiWorldPos = { x: 0, y: 0, z: 0 };
        let mirrorHitCooldownWorker = false;
        let frameCounter = 0;
        
        self.onmessage = function(e) {
            const { type, data } = e.data;
            switch (type) {
                case 'init':
                    config = { ...config, ...data.config };
                    self.postMessage({ type: 'ready' });
                    break;
                case 'update':
                    if (data.aiPos) aiWorldPos = data.aiPos;
                    if (data.mirrorCooldown !== undefined) mirrorHitCooldownWorker = data.mirrorCooldown;
                    const result = updateBullets(data.dt);
                    // 使用 Transferable 传输二进制数据
                    const bulletCount = result.bullets.length;
                    const buffer = new Float32Array(bulletCount * 4);
                    for (let i = 0; i < bulletCount; i++) {
                        const b = result.bullets[i];
                        buffer[i*4] = b.id;
                        buffer[i*4+1] = b.x;
                        buffer[i*4+2] = b.y;
                        buffer[i*4+3] = b.z;
                    }
                    self.postMessage({ 
                        type: 'updateResult', 
                        bullets: buffer.buffer, 
                        hits: result.hits,
                        frame: frameCounter++
                    }, [buffer.buffer]);
                    break;
                case 'addBullet':
                    addBullet(data.id, data.pos, data.dir, data.playerVel);
                    break;
                case 'clear':
                    bullets = [];
                    break;
                case 'setConfig':
                    Object.assign(config, data);
                    break;
            }
        };
        
        function addBullet(id, pos, dir, playerVel) {
            if (bullets.length >= config.maxBullets) bullets.shift();
            const speed = config.bulletSpeed;
            bullets.push({
                id: id,
                x: pos.x, y: pos.y, z: pos.z,
                vx: dir.x * speed + playerVel.x,
                vy: dir.y * speed + playerVel.y,
                vz: dir.z * speed + playerVel.z,
                life: config.maxLife
            });
        }
        
        function updateBullets(dt) {
            const hits = [];
            const newBullets = [];
            for (let i = 0; i < bullets.length; i++) {
                const b = bullets[i];
                b.x += b.vx * dt;
                b.y += b.vy * dt;
                b.z += b.vz * dt;
                b.life -= dt;
                
                let hit = false;
                // 边界检查
                if (Math.hypot(b.x, b.z) > config.viewDistance) hit = true;
                // AI 碰撞检测
                if (!hit && aiWorldPos) {
                    const aiMinX = aiWorldPos.x + config.aiBox.minX;
                    const aiMaxX = aiWorldPos.x + config.aiBox.maxX;
                    const aiMinY = aiWorldPos.y + config.aiBox.minY;
                    const aiMaxY = aiWorldPos.y + config.aiBox.maxY;
                    const aiMinZ = aiWorldPos.z + config.aiBox.minZ;
                    const aiMaxZ = aiWorldPos.z + config.aiBox.maxZ;
                    if (b.x >= aiMinX && b.x <= aiMaxX &&
                        b.y >= aiMinY && b.y <= aiMaxY &&
                        b.z >= aiMinZ && b.z <= aiMaxZ) {
                        hit = true;
                        hits.push({ type: 'ai', pos: { x: b.x, y: b.y, z: b.z }, bulletId: b.id });
                    }
                }
                // 镜子碰撞检测
                if (!hit && !mirrorHitCooldownWorker) {
                    const m = config.mirrorBox;
                    if (b.x >= m.minX && b.x <= m.maxX &&
                        b.y >= m.minY && b.y <= m.maxY &&
                        b.z >= m.minZ && b.z <= m.maxZ) {
                        hit = true;
                        hits.push({ type: 'mirror', pos: { x: b.x, y: b.y, z: b.z }, bulletId: b.id });
                    }
                }
                if (hit || b.life <= 0) continue;
                newBullets.push(b);
            }
            bullets = newBullets;
            return { 
                bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y, z: b.z })), 
                hits: hits 
            };
        }
    `;
    
    // ========== 实例化渲染：初始化子弹 InstancedMesh ==========
    function initBulletInstancedMesh() {
        if (!scene) return;
        if (!sharedBulletGeom) {
            sharedBulletGeom = new THREE.SphereGeometry(0.028, 8, 8);
        }
        if (!sharedBulletMat) {
            sharedBulletMat = new THREE.MeshStandardMaterial({ 
                color: 0xffaa44, 
                emissive: 0xff4400, 
                emissiveIntensity: 0.7,
                flatShading: false
            });
        }
        
        // 创建 InstancedMesh
        bulletInstancedMesh = new THREE.InstancedMesh(
            sharedBulletGeom, 
            sharedBulletMat, 
            MAX_BULLETS
        );
        bulletInstancedMesh.castShadow = true;
        bulletInstancedMesh.receiveShadow = false;
        bulletInstancedMesh.frustumCulled = true;  // 启用视锥体裁剪
        scene.add(bulletInstancedMesh);
        
        // 预初始化所有实例为不可见（位置设为场景外）
        bulletInstanceMatrices = new Array(MAX_BULLETS);
        for (let i = 0; i < MAX_BULLETS; i++) {
            bulletInstancedMesh.setMatrixAt(i, _tempMatrix.makeTranslation(9999, 9999, 9999));
            freeInstances.push(i);
        }
        bulletInstancedMesh.instanceMatrix.needsUpdate = true;
    }
    
    // 获取或创建子弹实例
    function allocateBulletInstance(id, pos) {
        let instanceIdx;
        if (freeInstances.length > 0) {
            instanceIdx = freeInstances.pop();
        } else {
            // 池满时复用最旧的实例
            instanceIdx = nextInstanceIndex % MAX_BULLETS;
            const oldId = instanceToId.get(instanceIdx);
            if (oldId !== undefined) {
                bulletActiveMap.delete(oldId);
                bulletIdToInstance.delete(oldId);
                instanceToId.delete(instanceIdx);
            }
            nextInstanceIndex++;
        }
        
        bulletActiveMap.set(id, instanceIdx);
        bulletIdToInstance.set(id, instanceIdx);
        instanceToId.set(instanceIdx, id);
        
        // 设置矩阵
        _tempMatrix.makeTranslation(pos.x, pos.y, pos.z);
        bulletInstancedMesh.setMatrixAt(instanceIdx, _tempMatrix);
        return instanceIdx;
    }
    
    function updateBulletInstance(id, pos) {
        const instanceIdx = bulletIdToInstance.get(id);
        if (instanceIdx !== undefined) {
            _tempMatrix.makeTranslation(pos.x, pos.y, pos.z);
            bulletInstancedMesh.setMatrixAt(instanceIdx, _tempMatrix);
        }
    }
    
    function deallocateBulletInstance(id) {
        const instanceIdx = bulletIdToInstance.get(id);
        if (instanceIdx !== undefined) {
            // 移出视野
            bulletInstancedMesh.setMatrixAt(instanceIdx, _tempMatrix.makeTranslation(9999, 9999, 9999));
            freeInstances.push(instanceIdx);
            bulletActiveMap.delete(id);
            bulletIdToInstance.delete(id);
            instanceToId.delete(instanceIdx);
        }
    }
    
    function commitBulletMatrixUpdates() {
        if (bulletInstancedMesh) {
            bulletInstancedMesh.instanceMatrix.needsUpdate = true;
        }
    }
    
    // ========== 命中特效系统：对象池 ==========
    function initHitEffectPool() {
        if (!scene) return;
        hitEffectGeom = new THREE.SphereGeometry(0.06, 6, 6);
        hitEffectMat = new THREE.MeshStandardMaterial({ 
            color: 0xffaa44, 
            emissive: 0xff6600, 
            emissiveIntensity: 1.0,
            transparent: true,
            opacity: 0.9
        });
        
        for (let i = 0; i < HIT_POOL_SIZE; i++) {
            const mesh = new THREE.Mesh(hitEffectGeom, hitEffectMat.clone());
            mesh.visible = false;
            scene.add(mesh);
            hitEffectPool.push(mesh);
        }
    }
    
    function spawnHitEffect(pos) {
        let mesh = hitEffectPool.pop();
        if (!mesh) {
            mesh = new THREE.Mesh(hitEffectGeom, hitEffectMat.clone());
            scene.add(mesh);
        }
        mesh.position.set(pos.x, pos.y, pos.z);
        mesh.visible = true;
        mesh.material.emissiveIntensity = 1.0;
        
        // 动画效果：缩放和淡出
        const startScale = 0.5;
        const endScale = 1.2;
        let progress = 0;
        const duration = 200;
        const startTime = performance.now();
        
        function animateEffect() {
            const now = performance.now();
            const elapsed = now - startTime;
            progress = Math.min(1, elapsed / duration);
            const scale = startScale + (endScale - startScale) * progress;
            mesh.scale.set(scale, scale, scale);
            mesh.material.opacity = 1 - progress;
            mesh.material.emissiveIntensity = 1 - progress;
            
            if (progress < 1) {
                requestAnimationFrame(animateEffect);
            } else {
                mesh.visible = false;
                mesh.scale.set(1, 1, 1);
                mesh.material.opacity = 0.9;
                if (hitEffectPool.length < HIT_POOL_SIZE) {
                    hitEffectPool.push(mesh);
                } else {
                    scene.remove(mesh);
                    mesh.geometry.dispose();
                    mesh.material.dispose();
                }
                const idx = activeEffects.findIndex(e => e.mesh === mesh);
                if (idx !== -1) activeEffects.splice(idx, 1);
            }
        }
        
        requestAnimationFrame(animateEffect);
        activeEffects.push({ mesh, startTime });
    }
    
    // ========== Worker 通信优化 ==========
    function initWorker() {
        if (bulletWorker) bulletWorker.terminate();
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        bulletWorker = new Worker(url);
        URL.revokeObjectURL(url);
        
        bulletWorker.onmessage = (e) => {
            const { type } = e.data;
            if (type === 'ready') {
                workerReady = true;
                if (workerReadyResolve) workerReadyResolve();
                return;
            }
            if (type === 'updateResult') {
                const { bullets, hits } = e.data;
                // 处理二进制子弹数据
                if (bullets && bullets.byteLength) {
                    syncBulletsFromBinary(bullets);
                }
                processHitsOptimized(hits);
            }
        };
        
        bulletWorker.postMessage({
            type: 'init',
            data: { config: { maxBullets: MAX_BULLETS, bulletSpeed: 50, maxLife: 0.8, viewDistance: 100 } }
        });
    }
    
    function syncBulletsFromBinary(buffer) {
        const floatArr = new Float32Array(buffer);
        const count = floatArr.length / 4;
        const activeIds = new Set();
        
        for (let i = 0; i < count; i++) {
            const id = floatArr[i*4];
            const x = floatArr[i*4+1];
            const y = floatArr[i*4+2];
            const z = floatArr[i*4+3];
            activeIds.add(id);
            
            const existingIdx = bulletIdToInstance.get(id);
            if (existingIdx === undefined) {
                // 新子弹：分配实例
                allocateBulletInstance(id, { x, y, z });
            } else {
                // 已有子弹：更新位置
                updateBulletInstance(id, { x, y, z });
            }
        }
        
        // 回收不再活跃的子弹
        for (const [id, instanceIdx] of bulletIdToInstance.entries()) {
            if (!activeIds.has(id)) {
                deallocateBulletInstance(id);
            }
        }
        
        commitBulletMatrixUpdates();
    }
    
    function processHitsOptimized(hits) {
        for (const hit of hits) {
            spawnHitEffect(hit.pos);
            if (hit.type === 'ai') {
                window.onAIHit && window.onAIHit();
            } else if (hit.type === 'mirror' && mirrorObj && !mirrorHitCooldown) {
                triggerMirrorHitOptimized();
            }
        }
    }
    
    function triggerMirrorHitOptimized() {
        if (!mirrorObj || mirrorHitCooldown) return;
        mirrorHitCooldown = true;
        
        const originalEmissive = mirrorObj.material.emissiveIntensity || 0;
        mirrorObj.material.emissive = new THREE.Color(0xffaa66);
        mirrorObj.material.emissiveIntensity = 1.5;
        
        const origY = mirrorOriginalPos ? mirrorOriginalPos.y : mirrorObj.position.y;
        mirrorObj.position.y = origY + 0.03;
        mirrorObj.rotation.z = 0.02;
        
        setTimeout(() => {
            if (mirrorObj && mirrorObj.material) {
                mirrorObj.material.emissive = new THREE.Color(0x000000);
                mirrorObj.material.emissiveIntensity = originalEmissive;
            }
        }, 100);
        
        setTimeout(() => {
            if (mirrorObj) {
                mirrorObj.position.y = origY;
                mirrorObj.rotation.z = 0;
            }
        }, 80);
        
        setTimeout(() => { mirrorHitCooldown = false; }, 500);
        
        if (bulletWorker) {
            bulletWorker.postMessage({ type: 'update', data: { mirrorCooldown: true } });
            setTimeout(() => {
                if (bulletWorker) bulletWorker.postMessage({ type: 'update', data: { mirrorCooldown: false } });
            }, 500);
        }
    }
    
    // ========== GPU 预热（避免首次卡顿） ==========
    function warmupGPU() {
        if (!renderer || !scene || !camera) return;
        
        // 创建临时对象强制编译着色器
        const tempGeom = new THREE.SphereGeometry(0.028, 8, 8);
        const tempMat = new THREE.MeshStandardMaterial({ color: 0xffaa44 });
        const tempMesh = new THREE.Mesh(tempGeom, tempMat);
        tempMesh.position.set(9999, 9999, 9999);
        scene.add(tempMesh);
        
        const tempEffectGeom = new THREE.SphereGeometry(0.06, 6, 6);
        const tempEffectMat = new THREE.MeshStandardMaterial({ color: 0xffaa44, emissive: 0xff6600 });
        const tempEffect = new THREE.Mesh(tempEffectGeom, tempEffectMat);
        tempEffect.position.set(9999, 9999, 9999);
        scene.add(tempEffect);
        
        if (renderer.compile) {
            renderer.compile(scene, camera);
        } else {
            renderer.render(scene, camera);
        }
        
        scene.remove(tempMesh);
        scene.remove(tempEffect);
        tempGeom.dispose();
        tempMat.dispose();
        tempEffectGeom.dispose();
        tempEffectMat.dispose();
    }
    
    // ========== 性能监控 ==========
    function initStats() {
        if (!statsEnabled) return;
        stats = new Stats();
        stats.showPanel(0); // 0: fps, 1: ms, 2: memory, 3: loaded
        stats.dom.style.position = 'absolute';
        stats.dom.style.top = '10px';
        stats.dom.style.left = '10px';
        stats.dom.style.zIndex = '100';
        document.body.appendChild(stats.dom);
    }
    
    function updateStats() {
        if (stats) {
            stats.begin();
        }
    }
    
    function endStats() {
        if (stats) {
            stats.end();
        }
    }
    
    // ========== 公开 API ==========
    async function createBullet(worldPos, direction, playerVel) {
        if (!bulletWorker || !workerReady) return null;
        const id = nextBulletId++;
        bulletWorker.postMessage({
            type: 'addBullet',
            data: {
                id: id,
                pos: { x: worldPos.x, y: worldPos.y, z: worldPos.z },
                dir: { x: direction.x, y: direction.y, z: direction.z },
                playerVel: { x: playerVel.x, y: playerVel.y, z: playerVel.z }
            }
        });
        return id;
    }
    
    function updateBullets(dt) {
        if (!bulletWorker || !workerReady) return;
        updateStats();
        const aiPos = aiModel ? { x: aiModel.position.x, y: aiModel.position.y, z: aiModel.position.z } : { x: 0, y: 0, z: 0 };
        bulletWorker.postMessage({
            type: 'update',
            data: { dt: Math.min(dt, 0.033), aiPos, mirrorCooldown: mirrorHitCooldown }
        });
        endStats();
    }
    
    function init(opt) {
        scene = opt.scene;
        camera = opt.camera;
        renderer = opt.renderer;
        aiModel = opt.aiModel;
        mirrorObj = opt.mirrorObj;
        mirrorOriginalPos = opt.mirrorOriginalPos;
        statsEnabled = opt.enableStats || false;
        
        // 清理旧数据
        if (bulletInstancedMesh && scene) {
            scene.remove(bulletInstancedMesh);
            bulletInstancedMesh.dispose();
        }
        bulletActiveMap.clear();
        bulletIdToInstance.clear();
        instanceToId.clear();
        freeInstances = [];
        nextInstanceIndex = 0;
        nextBulletId = 0;
        
        activeEffects.forEach(e => {
            if (e.mesh && e.mesh.parent) scene.remove(e.mesh);
            if (e.mesh && e.mesh.geometry) e.mesh.geometry.dispose();
            if (e.mesh && e.mesh.material) e.mesh.material.dispose();
        });
        activeEffects = [];
        hitEffectPool = [];
        
        // 初始化系统
        initBulletInstancedMesh();
        initHitEffectPool();
        initWorker();
        initStats();
        
        setTimeout(() => warmupGPU(), 100);
    }
    
    function setAiModel(model) { aiModel = model; }
    function setMirror(mirror, originalPos) { mirrorObj = mirror; mirrorOriginalPos = originalPos; mirrorHitCooldown = false; }
    function getActiveBulletCount() { return bulletIdToInstance.size; }
    function setWorkerConfig(config) {
        if (bulletWorker && workerReady) {
            bulletWorker.postMessage({ type: 'setConfig', data: config });
        }
    }
    
    function dispose() {
        if (bulletWorker) {
            bulletWorker.terminate();
            bulletWorker = null;
        }
        if (bulletInstancedMesh) {
            scene.remove(bulletInstancedMesh);
            bulletInstancedMesh.dispose();
            bulletInstancedMesh = null;
        }
        if (sharedBulletGeom) {
            sharedBulletGeom.dispose();
            sharedBulletGeom = null;
        }
        if (sharedBulletMat) {
            sharedBulletMat.dispose();
            sharedBulletMat = null;
        }
        activeEffects.forEach(e => {
            if (e.mesh && e.mesh.geometry) e.mesh.geometry.dispose();
            if (e.mesh && e.mesh.material) e.mesh.material.dispose();
        });
        hitEffectPool.forEach(mesh => {
            if (mesh && mesh.geometry) mesh.geometry.dispose();
            if (mesh && mesh.material) mesh.material.dispose();
        });
    }
    
    // 武器自定义（保持原有功能）
    let _muzzleTimer = null;
    function applyWeaponCustomization(gunModel, weaponPos, weaponRotDeg, weaponScale, isAiming, userBasePos, curModelPos, saveStorage, muzzleLocal, _vec) {
        if (!gunModel) return;
        gunModel.rotation.set(
            THREE.MathUtils.degToRad(weaponRotDeg.value.x),
            THREE.MathUtils.degToRad(weaponRotDeg.value.y),
            THREE.MathUtils.degToRad(weaponRotDeg.value.z)
        );
        gunModel.scale.set(weaponScale.value.x, weaponScale.value.y, weaponScale.value.z);
        userBasePos.set(weaponPos.value.x, weaponPos.value.y, weaponPos.value.z);
        if (!isAiming.value) curModelPos.copy(userBasePos);
        saveStorage();
        if (_muzzleTimer) clearTimeout(_muzzleTimer);
        _muzzleTimer = setTimeout(() => {
            if (gunModel) muzzleLocal.copy(Gu.computeMuzzle(gunModel, _vec));
        }, 30);
    }
    
    return {
        init, setAiModel, setMirror, createBullet, updateBullets, applyWeaponCustomization,
        spawnHitEffect, getActiveBulletCount, setWorkerConfig, dispose
    };
})();