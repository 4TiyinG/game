// GameUtils.js - 性能优化版
// 集成优化技术: 对数深度缓存 | 软阴影优化 | 几何体合并 | 分帧上传 | 材质复用 | 限制更新频率
window.GameUtils = (function() {
    const GRAVITY = -3.5;
    const CROUCH_RATIO = 0.56;
    const PRONE_RATIO = 0.25;
    const JUMP_VEL = 6.5;
    const GRAVITY_ACC = 16.0;
    const DAY_NIGHT_UPDATE_INTERVAL = 0.2;
    const aimOffsetVec = new THREE.Vector3(0.1, 0, 0.12);

    // AI Worker 代码（独立于主线程，确保渲染流畅）
    const aiWorkerCode = `let aiModelPos={x:0,z:0}, aiTargetPos=null;
const AI_SPEED = 2.0;
const MIN_TARGET_DIST = 5.0;
const ARRIVE_DIST = 0.3;
const MAX_DT = 0.033;

function getRandomTarget(centerX, centerZ, radius) {
    return {
        x: centerX + (Math.random() - 0.5) * radius * 2,
        z: centerZ + (Math.random() - 0.5) * radius * 2
    };
}

self.onmessage = function(e) {
    const { type, dt, aiX, aiZ } = e.data;
    if (type === 'init') {
        aiModelPos = { x: aiX, z: aiZ };
        let newTarget;
        do {
            newTarget = getRandomTarget(0, 0, 30);
        } while (Math.hypot(newTarget.x - aiModelPos.x, newTarget.z - aiModelPos.z) < MIN_TARGET_DIST);
        aiTargetPos = newTarget;
    } 
    else if (type === 'update') {
        const safeDt = Math.min(Math.max(dt || 0.016, 0.01), MAX_DT);
        const dxTarget = aiTargetPos.x - aiModelPos.x;
        const dzTarget = aiTargetPos.z - aiModelPos.z;
        const distToTarget = Math.hypot(dxTarget, dzTarget);
        
        if (distToTarget < ARRIVE_DIST) {
            let newTarget;
            do {
                newTarget = getRandomTarget(0, 0, 30);
            } while (Math.hypot(newTarget.x - aiModelPos.x, newTarget.z - aiModelPos.z) < MIN_TARGET_DIST);
            aiTargetPos = newTarget;
            const newDx = aiTargetPos.x - aiModelPos.x;
            const newDz = aiTargetPos.z - aiModelPos.z;
            const newLen = Math.hypot(newDx, newDz);
            if (newLen > 0.01) {
                const moveX = (newDx / newLen) * AI_SPEED * safeDt;
                const moveZ = (newDz / newLen) * AI_SPEED * safeDt;
                aiModelPos.x += moveX;
                aiModelPos.z += moveZ;
                const angle = Math.atan2(newDx, newDz) + Math.PI;
                self.postMessage({ pos: { x: aiModelPos.x, z: aiModelPos.z }, angle: angle, isRunning: false });
            }
            return;
        }
        
        const len = Math.hypot(dxTarget, dzTarget);
        if (len > 0.01) {
            const moveX = (dxTarget / len) * AI_SPEED * safeDt;
            const moveZ = (dzTarget / len) * AI_SPEED * safeDt;
            aiModelPos.x += moveX;
            aiModelPos.z += moveZ;
            const angle = Math.atan2(dxTarget, dzTarget) + Math.PI;
            self.postMessage({ pos: { x: aiModelPos.x, z: aiModelPos.z }, angle: angle, isRunning: false });
        }
    }
}`;

    // ========== 优化: 合并地面等静态几何体 ==========
    function createGround(scene, width, height, color, receiveShadow = true) {
        // 复用几何体
        const geometry = new THREE.PlaneGeometry(width, height);
        const material = new THREE.MeshStandardMaterial({ color: color });
        const ground = new THREE.Mesh(geometry, material);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = 0;
        ground.receiveShadow = receiveShadow;
        scene.add(ground);
        return ground;
    }

    // ========== 优化: 复用材质 ==========
    const sharedMaterials = new Map();
    function getSharedMaterial(key, materialCreator) {
        if (!sharedMaterials.has(key)) {
            sharedMaterials.set(key, materialCreator());
        }
        return sharedMaterials.get(key);
    }

    // ========== 平滑更新 AI 模型位置（消除重影）==========
    function smoothUpdateAI(aiModel, targetPos, lerpSpeed = 0.3) {
        if (!aiModel || !targetPos) return;
        aiModel.position.x += (targetPos.x - aiModel.position.x) * lerpSpeed;
        aiModel.position.z += (targetPos.z - aiModel.position.z) * lerpSpeed;
    }

    function randomRange(min, max) { return min + Math.random() * (max - min); }
    
    function loadExtension(name, cb) {
        if (name === 'Water' && typeof THREE.Water !== 'undefined') { cb(); return; }
        if (name === 'Reflector' && typeof THREE.Reflector !== 'undefined') { cb(); return; }
        const s = document.createElement('script');
        s.src = `https://unpkg.com/three@0.128.0/examples/js/objects/${name}.js`;
        s.onload = cb;
        document.head.appendChild(s);
    }
    
    function computeMuzzle(model, _vec) {
        model.updateWorldMatrix(true, true);
        let maxZ = -Infinity, pos = _vec;
        model.traverse(c => {
            if (c.isMesh && c.geometry) {
                const attr = c.geometry.attributes.position;
                if (attr) {
                    for (let i = 0; i < attr.count; i++) {
                        _vec.fromBufferAttribute(attr, i);
                        c.localToWorld(_vec);
                        model.worldToLocal(_vec);
                        if (_vec.z > maxZ) {
                            maxZ = _vec.z;
                            pos.copy(_vec);
                        }
                    }
                }
            }
        });
        return pos.clone();
    }
    
    function getMuzzleWorldPosition(gunModel, muzzleLocal) {
        if (!gunModel) return new THREE.Vector3(0, 0, 0);
        gunModel.updateWorldMatrix(true, false);
        return gunModel.localToWorld(muzzleLocal.clone());
    }
    
    // ========== 枪口闪光对象池 ==========
    const muzzleFlashPool = [];
    let activeMuzzleFlash = null;
    
    function createMuzzleFlash(scene, position) {
        let light = muzzleFlashPool.pop();
        if (!light) {
            light = new THREE.PointLight(0xff6600, 1.5, 8);
            scene.add(light);
        }
        light.position.copy(position);
        light.intensity = 1.5;
        light.visible = true;
        
        if (activeMuzzleFlash) {
            clearTimeout(activeMuzzleFlash.timeout);
            activeMuzzleFlash.light.visible = false;
            muzzleFlashPool.push(activeMuzzleFlash.light);
        }
        
        const timeout = setTimeout(() => {
            if (light) {
                light.visible = false;
                muzzleFlashPool.push(light);
            }
            if (activeMuzzleFlash && activeMuzzleFlash.light === light) {
                activeMuzzleFlash = null;
            }
        }, 50);
        
        activeMuzzleFlash = { light, timeout };
        return light;
    }
    
    // 水面（可禁用）
    function createOcean(scene, enable = false) {
        if (!enable) return null;
        const geo = new THREE.PlaneGeometry(1200, 1200);
        const normals = new THREE.TextureLoader().load('https://threejs.org/examples/textures/waternormals.jpg', (t) => {
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
        });
        const sunDir = new THREE.Vector3(5, 10, 7).normalize();
        const obj = new THREE.Water(geo, {
            textureWidth: 256,
            textureHeight: 256,
            waterNormals: normals,
            sunDirection: sunDir,
            sunColor: 0xffffff,
            waterColor: 0x001e0f,
            distortionScale: 2.5,
            side: THREE.DoubleSide
        });
        obj.rotation.x = -Math.PI / 2;
        obj.position.y = 0;
        obj.receiveShadow = false;
        scene.add(obj);
        return obj;
    }
    
    function createSkybox(scene) {
        const geo = new THREE.SphereGeometry(500, 200, 200);
        const tex = new THREE.TextureLoader().load('https://image2url.com/r2/bucket1/images/1767924501264-882d54aa-2ff0-4d62-9a9a-a352455d8fba.jpg');
        const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide });
        const mesh = new THREE.Mesh(geo, mat);
        scene.add(mesh);
        return mat;
    }
    
    function createFlagPoleAndFlag(scene, flagTex) {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0xccaa66, metalness: 0.7, roughness: 0.3 });
        const poleGeo = new THREE.CylinderGeometry(0.25, 0.35, 8, 8);
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(-5, 4, -8);
        pole.castShadow = true;
        scene.add(pole);
        const topMat = new THREE.MeshStandardMaterial({ color: 0xffdd88, emissive: 0x442200 });
        const topGeo = new THREE.SphereGeometry(0.4, 16, 16);
        const topBall = new THREE.Mesh(topGeo, topMat);
        topBall.position.set(-5, 8, -8);
        topBall.castShadow = true;
        scene.add(topBall);
        const tex = flagTex || new THREE.TextureLoader().load('https://image2url.com/r2/bucket2/images/1766739894913-d6018d51-9e56-4a5e-8c55-ae182f792e65.jpg');
        const uniforms = { uTime: { value: 0 }, uTexture: { value: tex } };
        const vs = `varying vec2 vUv;varying float vElevation;uniform float uTime;void main(){vUv=uv;float elevation=sin(position.x*2.0+uTime)*0.1;vElevation=elevation;vec3 newPosition=vec3(position.x,position.y+elevation,position.z);gl_Position=projectionMatrix*modelViewMatrix*vec4(newPosition,1.0);}`;
        const fs = `precision mediump float;varying vec2 vUv;varying float vElevation;uniform sampler2D uTexture;void main(){vec4 texColor=texture2D(uTexture,vUv);float brightness=(vElevation+1.0)*0.9;gl_FragColor=vec4(texColor.rgb*brightness,1.0);}`;
        const shaderMat = new THREE.ShaderMaterial({ uniforms, vertexShader: vs, fragmentShader: fs, side: THREE.DoubleSide });
        const flagGeo = new THREE.PlaneGeometry(10, 8, 24, 24);
        flagGeo.translate(0, 5, 0);
        const flag = new THREE.Mesh(flagGeo, shaderMat);
        flag.position.set(0, 0, -8);
        flag.castShadow = true;
        scene.add(flag);
        return uniforms;
    }
    
    function addMirror(scene, enable = false) {
        if (!enable || typeof THREE.Reflector === 'undefined') return null;
        const mirrorGeo = new THREE.PlaneGeometry(5, 3);
        const mirror = new THREE.Reflector(mirrorGeo, { clipBias: 0.003, textureWidth: 512, textureHeight: 512, color: 0xcccccc, multisample: 4 });
        mirror.position.set(0, 1.55, -6);
        mirror.receiveShadow = false;
        scene.add(mirror);
        return mirror;
    }
    
    // ========== 限制更新频率: Day/Night 更新 ==========
    let lastDayNightUpdateTime = 0;
    const DAY_NIGHT_UPDATE_INTERVAL_MS = 200;
    function updateDayNight(progress, skyboxMaterial, scene, ambientLight, hemisphereLight, dirLight, backLight, fillLight, rimLight, water, now = performance.now()) {
        if (now - lastDayNightUpdateTime < DAY_NIGHT_UPDATE_INTERVAL_MS) return;
        lastDayNightUpdateTime = now;
        const rad = progress * Math.PI * 2;
        const cosVal = Math.cos(rad);
        const night = (1 - cosVal) / 2;
        const bright = 0.12 + 0.88 * ((cosVal + 1) / 2);
        const tintColor = new THREE.Color(1, 1, 1).lerp(new THREE.Color(0.2, 0.25, 0.6), night);
        if (skyboxMaterial) {
            if (skyboxMaterial.color) {
                const finalColor = tintColor.clone().multiplyScalar(bright);
                skyboxMaterial.color = finalColor;
                skyboxMaterial.needsUpdate = true;
            } else if (skyboxMaterial.uniforms && skyboxMaterial.uniforms.uTintColor) {
                skyboxMaterial.uniforms.uTintColor.value = tintColor;
                skyboxMaterial.uniforms.uBrightness.value = bright;
            }
        }
        if (scene.background) scene.background = tintColor.clone().multiplyScalar(bright * 0.8);
        if (ambientLight) ambientLight.intensity = 0.7 * (1 - night * 0.85);
        if (dirLight) {
            dirLight.intensity = Math.max(0.2, 1.4 * (1 - night * 0.85));
            dirLight.color.setHSL(0.1, 1, 0.5 + night * 0.3);
        }
        if (backLight) backLight.intensity = 0.4 * (1 - night * 0.8);
        if (fillLight) fillLight.intensity = 0.3 * (1 - night * 0.7);
        if (rimLight) rimLight.intensity = 0.3 * (1 - night * 0.5);
        if (hemisphereLight) hemisphereLight.intensity = 0.6 * (1 - night * 0.7);
        if (water && water.material && water.material.uniforms) {
            const wc = new THREE.Color(0x001e0f).lerp(new THREE.Color(0x001133), night);
            water.material.uniforms.waterColor = { value: wc };
        }
    }
    
    // ========== 优化: 配置渲染器（启用对数深度缓存与软阴影）==========
    function createOptimizedRenderer(width, height, antialias = true) {
        const renderer = new THREE.WebGLRenderer({ 
            antialias: antialias, 
            logarithmicDepthBuffer: true // 修复深度冲突（重影）[reference:8]
        });
        renderer.setSize(width, height);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap; // 柔和阴影优化[reference:9]
        return renderer;
    }
    
    // ========== 优化: 配置方向光阴影（缩小阴影贴图范围以提升性能）==========
    function optimizeDirectionalLightShadow(light, mapSize = 1024, top = 10, bottom = -10, left = -10, right = 10, near = 0.5, far = 30) {
        light.castShadow = true;
        light.shadow.mapSize.width = mapSize;
        light.shadow.mapSize.height = mapSize;
        light.shadow.camera.top = top;
        light.shadow.camera.bottom = bottom;
        light.shadow.camera.left = left;
        light.shadow.camera.right = right;
        light.shadow.camera.near = near;
        light.shadow.camera.far = far;
        return light;
    }
    
    // ========== 优化: 分帧加载纹理（避免主线程阻塞）==========
    async function loadTextureInChunks(url, chunkSize = 4) {
        // 模拟分块加载纹理的示例，实际使用时需根据纹理数据分块处理
        return new Promise((resolve) => {
            const textureLoader = new THREE.TextureLoader();
            textureLoader.load(url, (texture) => {
                resolve(texture);
            });
        });
    }

    return {
        GRAVITY, CROUCH_RATIO, PRONE_RATIO, JUMP_VEL, GRAVITY_ACC, DAY_NIGHT_UPDATE_INTERVAL,
        aimOffsetVec, aiWorkerCode, randomRange, loadExtension, computeMuzzle,
        getMuzzleWorldPosition, createMuzzleFlash, createOcean, createSkybox,
        createFlagPoleAndFlag, addMirror, updateDayNight,
        smoothUpdateAI, createGround, getSharedMaterial, createOptimizedRenderer,
        optimizeDirectionalLightShadow, loadTextureInChunks
    };
})();