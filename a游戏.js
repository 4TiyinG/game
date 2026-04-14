(function(){
const Gu = window.GameUtils, Ui = window.GameUI, Ex = window.GameExtras;
const SceneBuilder = window.GameScene; 
Ui.injectStyles();

if(typeof Vue === 'undefined'){
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/vue@3/dist/vue.global.js';
    document.head.appendChild(s);
    s.onload = () => initGame();
} else {
    initGame();
}

function initGame(){
    const { createApp, ref, watch, onMounted, shallowRef } = Vue;
    const app = createApp({
        setup(){
            // 响应式状态
            const ammo = ref(60);
            const maxAmmo = ref(60);
            const health = ref(100);
            const isAiming = ref(false);
            const isReloading = ref(false);
            const isEquipping = ref(false);
            const isLoading = ref(true);
            const customizePanelVisible = ref(false);
            const weaponPos = ref({ x: -0.23, y: -2.56, z: 0.02 });
            const weaponRotDeg = ref({ x: 2, y: -180, z: 3 });
            const weaponScale = ref({ x: 0.6, y: 0.6, z: 0.6 });
            const cameraHeight = ref(1.6);
            const sensitivity = ref(1);

            // 内部状态
            let scene, camera, renderer, gunModel, mixer, animations = {};
            let moveFlags = { f: false, b: false, l: false, r: false };
            let joyActive = false, joyCenter = { x:0, y:0 }, joyPos = { x:0, y:0 }, joyTouchId = null;
            let joyFingers = new Map(), aimFingers = new Map();
            const baseAimSens = 0.0028, baseHipSens = 0.005;
            let aimSens = 0.0028, hipSens = 0.005;
            let targetFOV = 75, curFOV = 75;
            const userBasePos = new THREE.Vector3();
            const curModelPos = new THREE.Vector3();
            let state = { shooting: false, curAnim: null, moveSpeed: 8, origSpeed: 8 };
            const muzzleLocal = new THREE.Vector3(0, 0, 0.5);
            const _vec = new THREE.Vector3(), _target = new THREE.Vector3(), _dir = new THREE.Vector3();
            const _worldMuzzle = new THREE.Vector3();
            let muzzleFlashPool = [];
            let activeMuzzleFlash = null;
            const MUZZLE_FLASH_POOL_SIZE = 3;
            let muzzleFlashTimer = null;
            const playerVelocity = new THREE.Vector3();
            let shootTimer = null, reloadTimer = null, equipTimer = null;
            let water = null, flagUniforms = null, mirrorObj = null, mirrorOriginalPos = null, skyboxMaterial = null;
            let ambientLight, hemisphereLight, dirLight, backLight, fillLight, rimLight;
            const cycleDuration = 60;
            let cycleTime = 0, lastCycleUpdate = 0;
            let verticalVelocity = 0, isGrounded = true;
            let targetHeight = 1.6, normalHeight = 1.6, posture = 'stand';
            let lastDayNightUpdate = 0;
            let aiModel = null, aiMixer = null, aiAnimations = {}, aiWorker = null;
            const DEFAULT_POS = { x: -0.23, y: -2.56, z: 0.02 };
            const DEFAULT_ROT_DEG = { x: 2, y: -180, z: 3 };
            const DEFAULT_SCALE = { x: 0.6, y: 0.6, z: 0.6 };
            const STORAGE_KEY = 'ak12_custom_config';
            let currentVel = new THREE.Vector3(0, 0, 0);
            const ACCEL = 45.0, DECEL = 35.0, RUN_THRESHOLD = 0.6;
            let saveDebounceTimer = null;
            let longPressInterval = null;
            let lowFreqCounter = 0;
            const LOW_FREQ_INTERVAL = 5;
            let weaponCustomTimer = null;
            let burstShotCount = 0;
            let targetAIPos = new THREE.Vector3();
            let targetAIAngle = 0;
            
            let gameScene = null;
            let triggerRender = null;
            let resetIdleTimer = null;
            
            // 物理世界
            class PhysicsWorld {
                constructor(){
                    this.gravity = -16;
                    this.velocity = new THREE.Vector3(0, 0, 0);
                    this.position = new THREE.Vector3(0, 0, 0);
                    this.grounded = true;
                }
                integrate(dt){
                    this.velocity.y += this.gravity * dt;
                    this.position.y += this.velocity.y * dt;
                    if(this.position.y <= targetHeight){
                        this.position.y = targetHeight;
                        this.velocity.y = 0;
                        this.grounded = true;
                    } else {
                        this.grounded = false;
                    }
                    camera.position.y = this.position.y;
                }
                updateInput(dt){
                    const hasMove = joyActive || moveFlags.f || moveFlags.b || moveFlags.l || moveFlags.r;
                    if(!hasMove){
                        let decel = Math.min(1, DECEL * dt);
                        currentVel.x *= (1 - decel);
                        currentVel.z *= (1 - decel);
                        if(Math.abs(currentVel.x) < 0.01) currentVel.x = 0;
                        if(Math.abs(currentVel.z) < 0.01) currentVel.z = 0;
                        playerVelocity.x = currentVel.x;
                        playerVelocity.z = currentVel.z;
                        playerVelocity.y = verticalVelocity;
                        return;
                    }
                    let rawX = (moveFlags.l ? -1 : 0) + (moveFlags.r ? 1 : 0);
                    let rawZ = (moveFlags.f ? -1 : 0) + (moveFlags.b ? 1 : 0);
                    let len = Math.hypot(rawX, rawZ);
                    if(len > 0.01){ rawX /= len; rawZ /= len; }
                    let targetVelX = rawX * state.moveSpeed;
                    let targetVelZ = rawZ * state.moveSpeed;
                    let acc = (targetVelX === 0 && targetVelZ === 0) ? DECEL : ACCEL;
                    let alpha = Math.min(1, acc * dt);
                    currentVel.x += (targetVelX - currentVel.x) * alpha;
                    currentVel.z += (targetVelZ - currentVel.z) * alpha;
                    let moveX = currentVel.x * dt;
                    let moveZ = currentVel.z * dt;
                    if(Math.abs(moveX) + Math.abs(moveZ) > 0.001){
                        let angle = camera.rotation.y;
                        let cos = Math.cos(angle), sin = Math.sin(angle);
                        let dx = moveX * cos + moveZ * sin;
                        let dz = moveZ * cos - moveX * sin;
                        camera.position.x += dx;
                        camera.position.z += dz;
                    }
                    playerVelocity.x = currentVel.x;
                    playerVelocity.z = currentVel.z;
                    playerVelocity.y = verticalVelocity;
                    playerVelocity.applyAxisAngle(_vec.set(0,1,0), camera.rotation.y);
                }
            }
            const physics = new PhysicsWorld();

            function updateAmmoUI(){
                const el = document.getElementById('ammo');
                if(el) el.innerText = `${ammo.value}/${maxAmmo.value}`;
            }
            watch(ammo, () => updateAmmoUI(), { immediate: true });
            watch(maxAmmo, () => updateAmmoUI());

            function loadStorage(){
                try{
                    const s = localStorage.getItem(STORAGE_KEY);
                    if(s){
                        const p = JSON.parse(s);
                        if(p.pos) weaponPos.value = p.pos;
                        if(p.rot) weaponRotDeg.value = p.rot;
                        if(p.scale) weaponScale.value = p.scale;
                        if(p.cameraHeight) cameraHeight.value = p.cameraHeight;
                        if(p.sensitivity) sensitivity.value = p.sensitivity;
                    }
                } catch(e){}
            }

            function saveStorage(){
                if(saveDebounceTimer) clearTimeout(saveDebounceTimer);
                saveDebounceTimer = setTimeout(() => {
                    try{
                        localStorage.setItem(STORAGE_KEY, JSON.stringify({
                            pos: weaponPos.value,
                            rot: weaponRotDeg.value,
                            scale: weaponScale.value,
                            cameraHeight: cameraHeight.value,
                            sensitivity: sensitivity.value
                        }));
                    } catch(e){}
                }, 300);
            }

            function updateSensitivity(){
                aimSens = baseAimSens * sensitivity.value;
                hipSens = baseHipSens * sensitivity.value;
            }
            watch(sensitivity, () => { updateSensitivity(); saveStorage(); });

            function updateNormalHeight(){
                normalHeight = cameraHeight.value;
                if(posture === 'stand') targetHeight = normalHeight;
                else if(posture === 'crouch') targetHeight = normalHeight * Gu.CROUCH_RATIO;
                else targetHeight = normalHeight * Gu.PRONE_RATIO;
            }
            watch(cameraHeight, () => {
                updateNormalHeight();
                if(posture === 'stand') camera.position.y = targetHeight;
                saveStorage();
                immediateRender();
            });

            function setPosture(newPosture){
                if(posture === newPosture) return;
                posture = newPosture;
                if(newPosture === 'stand') targetHeight = normalHeight;
                else if(newPosture === 'crouch') targetHeight = normalHeight * Gu.CROUCH_RATIO;
                else targetHeight = normalHeight * Gu.PRONE_RATIO;
                updateMoveSpeed();
                immediateRender();
            }

            function jump(){
                if(!isGrounded) return;
                if(posture !== 'stand'){
                    setPosture('stand');
                    return;
                }
                verticalVelocity = Gu.JUMP_VEL;
                isGrounded = false;
                physics.velocity.y = verticalVelocity;
                physics.grounded = false;
                immediateRender();
            }

            function playAnim(name, loop = true){
                if(!mixer || !animations[name] || state.curAnim === name) return;
                if(state.curAnim && animations[state.curAnim])
                    mixer.clipAction(animations[state.curAnim]).stop();
                const act = mixer.clipAction(animations[name]);
                act.reset();
                act.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce);
                act.clampWhenFinished = !loop;
                act.play();
                state.curAnim = name;
                immediateRender();
            }

            function applyWeaponCustomization() {
                if (!gunModel) return;
                Ex.applyWeaponCustomization(
                    gunModel, weaponPos, weaponRotDeg, weaponScale, isAiming,
                    userBasePos, curModelPos, saveStorage, muzzleLocal, _vec
                );
                immediateRender();
            }
            watch(weaponPos, () => {
                if(weaponCustomTimer) clearTimeout(weaponCustomTimer);
                weaponCustomTimer = setTimeout(() => { applyWeaponCustomization(); weaponCustomTimer=null; }, 16);
            }, { deep: true });
            watch(weaponRotDeg, () => {
                if(weaponCustomTimer) clearTimeout(weaponCustomTimer);
                weaponCustomTimer = setTimeout(() => { applyWeaponCustomization(); weaponCustomTimer=null; }, 16);
            }, { deep: true });
            watch(weaponScale, () => {
                if(weaponCustomTimer) clearTimeout(weaponCustomTimer);
                weaponCustomTimer = setTimeout(() => { applyWeaponCustomization(); weaponCustomTimer=null; }, 16);
            }, { deep: true });

            function initMuzzleFlashPool() {
                for(let i=0;i<MUZZLE_FLASH_POOL_SIZE;i++){
                    const light = new THREE.PointLight(0xff6600, 1.2, 6);
                    light.visible = false;
                    scene.add(light);
                    muzzleFlashPool.push(light);
                }
            }
            function getMuzzleFlash(){
                if(muzzleFlashPool.length) return muzzleFlashPool.pop();
                const light = new THREE.PointLight(0xff6600, 1.2, 6);
                scene.add(light);
                return light;
            }
            function recycleMuzzleFlash(light){
                if(!light) return;
                light.visible = false;
                if(muzzleFlashPool.length < MUZZLE_FLASH_POOL_SIZE) muzzleFlashPool.push(light);
                else scene.remove(light);
            }
            function showMuzzleFlash(pos){
                if(activeMuzzleFlash) recycleMuzzleFlash(activeMuzzleFlash);
                const flash = getMuzzleFlash();
                flash.position.copy(pos);
                flash.visible = true;
                activeMuzzleFlash = flash;
                if(muzzleFlashTimer) clearTimeout(muzzleFlashTimer);
                muzzleFlashTimer = setTimeout(()=>{
                    if(activeMuzzleFlash){
                        recycleMuzzleFlash(activeMuzzleFlash);
                        activeMuzzleFlash = null;
                    }
                    muzzleFlashTimer = null;
                }, 40);
                immediateRender();
            }

            function shoot(playAnimFlag=true){
                if(ammo.value<=0 || isReloading.value || isEquipping.value) return;
                ammo.value--;
                camera.getWorldDirection(_dir);
                _dir.normalize();
                gunModel.localToWorld(muzzleLocal, _worldMuzzle);
                showMuzzleFlash(_worldMuzzle);
                if(playAnimFlag) playAnim('shoot', false);
                
                const bulletStart = camera.position.clone().add(_dir.clone().multiplyScalar(0.5));
                Ex.createBullet(bulletStart, _dir, playerVelocity).catch(e=>console.warn);
                
                if(shootTimer) clearTimeout(shootTimer);
                shootTimer = setTimeout(()=>{
                    if(!state.shooting && !isReloading.value && !isEquipping.value && !isAiming.value){
                        let spd = Math.hypot(currentVel.x, currentVel.z);
                        if(spd > state.moveSpeed * RUN_THRESHOLD && animations.run) playAnim('run', true);
                        else if(spd > 0.1 && animations.walk) playAnim('walk', true);
                        else playAnim('idle', true);
                    }
                }, (animations.shoot?.duration || 0.2) * 1000);
                immediateRender();
            }

            function burstShoot(){
                burstShotCount++;
                shoot(burstShotCount % 10 === 1);
            }

            function onReload(){
                if(isReloading.value || isEquipping.value) return;
                if(ammo.value < maxAmmo.value){
                    isReloading.value = true;
                    playAnim('reload', false);
                    if(reloadTimer) clearTimeout(reloadTimer);
                    reloadTimer = setTimeout(()=>{
                        ammo.value = maxAmmo.value;
                        isReloading.value = false;
                        let spd = Math.hypot(currentVel.x, currentVel.z);
                        if(spd > state.moveSpeed * RUN_THRESHOLD && animations.run) playAnim('run', true);
                        else if(spd > 0.1 && animations.walk) playAnim('walk', true);
                        else playAnim('idle', true);
                        immediateRender();
                    }, (animations.reload?.duration || 2.0)*1000);
                }
            }

            function onEquip(){
                if(isEquipping.value || isReloading.value) return;
                isEquipping.value = true;
                playAnim('equip', false);
                if(equipTimer) clearTimeout(equipTimer);
                equipTimer = setTimeout(()=>{
                    isEquipping.value = false;
                    let spd = Math.hypot(currentVel.x, currentVel.z);
                    if(spd > state.moveSpeed * RUN_THRESHOLD && animations.run) playAnim('run', true);
                    else if(spd > 0.1 && animations.walk) playAnim('walk', true);
                    else playAnim('idle', true);
                    immediateRender();
                }, (animations.equip?.duration || 1.5)*1000);
            }

            function updateMoveSpeed(){
                let sp = state.origSpeed;
                if(posture === 'crouch') sp *= 0.5;
                else if(posture === 'prone') sp *= 0.25;
                state.moveSpeed = isAiming.value ? sp * 0.55 : sp;
            }

            function immediateRender(){
                if(!renderer || !scene || !camera) return;
                renderer.render(scene, camera);
                if(triggerRender) triggerRender();
            }
            
            function initScene(){
                gameScene = SceneBuilder.createScene(
                    normalHeight,
                    (model, animMixer, anims, muzzle) => {
                        gunModel = model;
                        mixer = animMixer;
                        animations = anims;
                        muzzleLocal.copy(Gu.computeMuzzle(gunModel, _vec));
                        applyWeaponCustomization();
                        initMuzzleFlashPool();
                        isLoading.value = false;
                        const ld = document.getElementById('loading');
                        if(ld) ld.style.display = 'none';
                        playAnim('equip', false);
                        setTimeout(()=>{
                            if(!isEquipping.value){
                                let spd = Math.hypot(currentVel.x, currentVel.z);
                                if(spd > state.moveSpeed * RUN_THRESHOLD && animations.run) playAnim('run', true);
                                else if(spd > 0.1 && animations.walk) playAnim('walk', true);
                                else playAnim('idle', true);
                            }
                        }, (animations.equip?.duration || 1.5)*1000);
                        setTimeout(()=>preWarmShoot(), 100);
                        immediateRender();
                    },
                    (model, aMixer, aAnims, worker) => {
                        aiModel = model;
                        aiMixer = aMixer;
                        aiAnimations = aAnims;
                        aiWorker = worker;
                        Ex.setAiModel(aiModel);
                        if(aiModel){
                            targetAIPos.copy(aiModel.position);
                            targetAIAngle = aiModel.rotation.y;
                        }
                        if(aiWorker){
                            aiWorker.onmessage = (e) => {
                                const { pos, angle } = e.data;
                                if(pos){
                                    targetAIPos.set(pos.x, aiModel ? aiModel.position.y : 0, pos.z);
                                    immediateRender();
                                }
                                if(angle !== undefined){
                                    targetAIAngle = angle;
                                    immediateRender();
                                }
                            };
                        }
                    }
                );
                scene = gameScene.scene;
                camera = gameScene.camera;
                renderer = gameScene.renderer;
                ambientLight = gameScene.ambientLight;
                hemisphereLight = gameScene.hemisphereLight;
                dirLight = gameScene.dirLight;
                backLight = gameScene.backLight;
                fillLight = gameScene.fillLight;
                rimLight = gameScene.rimLight;
                water = gameScene.water;
                flagUniforms = gameScene.flagUniforms;
                mirrorObj = gameScene.mirrorObj;
                mirrorOriginalPos = gameScene.mirrorOriginalPos;
                skyboxMaterial = gameScene.skyboxMaterial;
                
                triggerRender = gameScene.triggerRender;
                resetIdleTimer = gameScene.resetIdleTimer;
                
                Ex.init({
                    scene, camera, renderer, aiModel,
                    mirrorObj, mirrorOriginalPos,
                    enableStats: false
                });
                
                physics.position.y = camera.position.y;
                physics.velocity.y = 0;
                
                startLogicLoop();
            }

            function preWarmShoot(){
                if(!gunModel || !scene || !camera) return;
                camera.getWorldDirection(_dir);
                _dir.normalize();
                gunModel.localToWorld(muzzleLocal, _worldMuzzle);
                const light = new THREE.PointLight(0xff6600, 1.2, 6);
                light.position.copy(_worldMuzzle);
                scene.add(light);
                setTimeout(()=>scene.remove(light), 20);
                const bulletStart = camera.position.clone().add(_dir.clone().multiplyScalar(0.5));
                Ex.createBullet(bulletStart, _dir, playerVelocity).catch(e=>console.warn);
                immediateRender();
            }

            let lastLogicTime = 0;
            let animFrameId = null;
            function startLogicLoop(){
                function logicUpdate(now=0){
                    animFrameId = requestAnimationFrame(logicUpdate);
                    let dt = Math.min((now - lastLogicTime) / 1000, 0.033);
                    if(dt <= 0){
                        lastLogicTime = now;
                        return;
                    }
                    lastLogicTime = now;
                    
                    const nowSec = now / 1000;
                    if(nowSec - lastDayNightUpdate >= 0.5){
                        const delta = Math.min(0.1, nowSec - lastDayNightUpdate);
                        let t = (cycleTime + delta / cycleDuration) % 1;
                        cycleTime = t;
                        let adjusted = (t < 0.4) ? (t / 0.4 * 0.5) : (0.5 + (t - 0.4) / 0.6 * 0.5);
                        Gu.updateDayNight(adjusted, skyboxMaterial, scene, ambientLight, hemisphereLight, dirLight, backLight, fillLight, rimLight, water);
                        lastDayNightUpdate = nowSec;
                        immediateRender();
                    }
                    
                    if(mixer) mixer.update(dt);
                    if(aiMixer) aiMixer.update(dt);
                    
                    lowFreqCounter = (lowFreqCounter + 1) % LOW_FREQ_INTERVAL;
                    if(lowFreqCounter === 0){
                        if(flagUniforms) flagUniforms.uTime.value += 0.02 * LOW_FREQ_INTERVAL;
                        if(water?.material?.uniforms?.time) water.material.uniforms.time.value += (1/90) * LOW_FREQ_INTERVAL;
                        if(aiWorker && aiModel){
                            aiWorker.postMessage({
                                type: 'update', dt: dt * LOW_FREQ_INTERVAL,
                                playerX: camera.position.x, playerZ: camera.position.z,
                                aiX: aiModel.position.x, aiZ: aiModel.position.z
                            });
                        }
                        immediateRender();
                    }
                    
                    Ex.updateBullets(dt);
                    
                    physics.updateInput(dt);
                    physics.integrate(dt);
                    verticalVelocity = physics.velocity.y;
                    isGrounded = physics.grounded;
                    
                    curFOV += (targetFOV - curFOV) * dt * 12;
                    camera.fov = curFOV;
                    camera.updateProjectionMatrix();
                    
                    _target.copy(userBasePos);
                    if(isAiming.value) _target.add(Gu.aimOffsetVec);
                    curModelPos.lerp(_target, dt * 14);
                    if(gunModel) gunModel.position.copy(curModelPos);
                    
                    if(!state.shooting && !isReloading.value && !isEquipping.value && !isAiming.value){
                        let spd = Math.hypot(currentVel.x, currentVel.z);
                        let newAnim = '';
                        if(spd > state.moveSpeed * RUN_THRESHOLD && animations.run) newAnim = 'run';
                        else if(spd > 0.1 && animations.walk) newAnim = 'walk';
                        else newAnim = 'idle';
                        if(newAnim && newAnim !== state.curAnim) playAnim(newAnim, true);
                    }
                    
                    if(aiModel){
                        Gu.smoothUpdateAI(aiModel, targetAIPos, 0.28);
                        const angleDiff = targetAIAngle - aiModel.rotation.y;
                        const shortestAngle = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
                        aiModel.rotation.y += shortestAngle * 0.28;
                        immediateRender();
                    }
                    
                    if(triggerRender) triggerRender();
                }
                animFrameId = requestAnimationFrame(logicUpdate);
            }
            
            // 触摸事件（修复移动和视角）
            function onJoyStart(e){
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                const cx = rect.left + rect.width/2;
                const cy = rect.top + rect.height/2;
                Array.from(e.changedTouches).forEach(t => {
                    if(!joyFingers.has(t.identifier))
                        joyFingers.set(t.identifier, { cx, cy, lx: t.clientX, ly: t.clientY });
                    if(joyTouchId === null){
                        joyActive = true;
                        joyTouchId = t.identifier;
                        joyCenter = { x: cx, y: cy };
                        const dx = t.clientX - cx, dy = t.clientY - cy;
                        const dist = Math.min(Math.hypot(dx, dy), 35);
                        const ang = Math.atan2(dy, dx);
                        joyPos = { x: Math.cos(ang)*dist, y: Math.sin(ang)*dist };
                        const stick = document.getElementById('joystick-stick');
                        if(stick) stick.style.transform = `translate(calc(-50% + ${joyPos.x}px), calc(-50% + ${joyPos.y}px))`;
                        moveFlags.f = joyPos.y < -10;
                        moveFlags.b = joyPos.y > 10;
                        moveFlags.l = joyPos.x < -10;
                        moveFlags.r = joyPos.x > 10;
                        resetIdleTimer && resetIdleTimer();
                        immediateRender();
                    }
                });
            }
            function onJoyMove(e){
                if(!joyActive || joyTouchId===null) return;
                let touch = null;
                for(let i=0; i<e.touches.length; i++){
                    if(e.touches[i].identifier === joyTouchId){ touch = e.touches[i]; break; }
                }
                if(!touch){ joyActive=false; joyTouchId=null; return; }
                const dx = touch.clientX - joyCenter.x;
                const dy = touch.clientY - joyCenter.y;
                const dist = Math.min(Math.hypot(dx, dy), 35);
                const ang = Math.atan2(dy, dx);
                joyPos = { x: Math.cos(ang)*dist, y: Math.sin(ang)*dist };
                const stick = document.getElementById('joystick-stick');
                if(stick) stick.style.transform = `translate(calc(-50% + ${joyPos.x}px), calc(-50% + ${joyPos.y}px))`;
                moveFlags.f = joyPos.y < -10;
                moveFlags.b = joyPos.y > 10;
                moveFlags.l = joyPos.x < -10;
                moveFlags.r = joyPos.x > 10;
                resetIdleTimer && resetIdleTimer();
                immediateRender();
            }
            function onJoyEnd(e){
                Array.from(e.changedTouches).forEach(t => joyFingers.delete(t.identifier));
                if(joyFingers.size === 0){
                    joyActive = false;
                    joyTouchId = null;
                    joyPos = { x:0, y:0 };
                    const stick = document.getElementById('joystick-stick');
                    if(stick) stick.style.transform = 'translate(-50%, -50%)';
                    moveFlags.f = moveFlags.b = moveFlags.l = moveFlags.r = false;
                    resetIdleTimer && resetIdleTimer();
                    immediateRender();
                } else if(joyTouchId !== null && !joyFingers.has(joyTouchId)){
                    const newId = Array.from(joyFingers.keys())[0];
                    const data = joyFingers.get(newId);
                    joyTouchId = newId;
                    joyCenter = { x: data.cx, y: data.cy };
                    const dx = data.lx - data.cx, dy = data.ly - data.cy;
                    const dist = Math.min(Math.hypot(dx, dy), 35);
                    const ang = Math.atan2(dy, dx);
                    joyPos = { x: Math.cos(ang)*dist, y: Math.sin(ang)*dist };
                    const stick = document.getElementById('joystick-stick');
                    if(stick) stick.style.transform = `translate(calc(-50% + ${joyPos.x}px), calc(-50% + ${joyPos.y}px))`;
                    moveFlags.f = joyPos.y < -10;
                    moveFlags.b = joyPos.y > 10;
                    moveFlags.l = joyPos.x < -10;
                    moveFlags.r = joyPos.x > 10;
                    resetIdleTimer && resetIdleTimer();
                    immediateRender();
                }
            }
            function onGlobalStart(e){
                const rect = document.getElementById('joystick-container')?.getBoundingClientRect();
                Array.from(e.touches).forEach(t => {
                    if(rect && t.clientX >= rect.left && t.clientX <= rect.right && t.clientY >= rect.top && t.clientY <= rect.bottom) return;
                    if(t.clientX > window.innerWidth/2){
                        aimFingers.set(t.identifier, { lx: t.clientX, ly: t.clientY });
                        resetIdleTimer && resetIdleTimer();
                        immediateRender();
                    }
                });
            }
            function onGlobalMove(e){
                if(aimFingers.size === 0) return;
                e.preventDefault();
                let totalDx=0, totalDy=0;
                Array.from(e.touches).forEach(t => {
                    if(aimFingers.has(t.identifier)){
                        const d = aimFingers.get(t.identifier);
                        totalDx += t.clientX - d.lx;
                        totalDy += t.clientY - d.ly;
                        d.lx = t.clientX;
                        d.ly = t.clientY;
                    }
                });
                if(totalDx !== 0 || totalDy !== 0){
                    const sens = isAiming.value ? aimSens : hipSens;
                    camera.rotation.y -= totalDx * sens;
                    camera.rotation.x = Math.max(-Math.PI/2.3, Math.min(Math.PI/2.3, camera.rotation.x - totalDy * sens));
                    resetIdleTimer && resetIdleTimer();
                    immediateRender();
                }
            }
            function onGlobalEnd(e){
                Array.from(e.changedTouches).forEach(t => aimFingers.delete(t.identifier));
            }
            
            function setupControls(){
                const joyDiv = document.getElementById('joystick-container');
                if(joyDiv){
                    joyDiv.addEventListener('touchstart', onJoyStart, { passive: false });
                    joyDiv.addEventListener('touchmove', onJoyMove, { passive: false });
                    joyDiv.addEventListener('touchend', onJoyEnd);
                    joyDiv.addEventListener('touchcancel', onJoyEnd);
                }
                const fireBtn = document.getElementById('fire-button');
                function startShooting(){
                    if(isReloading.value || isEquipping.value) return;
                    if(ammo.value > 0){
                        burstShotCount = 0;
                        burstShoot();
                        const intervalTime = isAiming.value ? 100 : 80;
                        if(longPressInterval) clearInterval(longPressInterval);
                        longPressInterval = setInterval(()=>{
                            if(ammo.value>0 && !isReloading.value && !isEquipping.value) burstShoot();
                            else { clearInterval(longPressInterval); longPressInterval=null; }
                        }, intervalTime);
                    }
                }
                function stopShooting(){
                    if(longPressInterval){ clearInterval(longPressInterval); longPressInterval=null; }
                }
                if(fireBtn){
                    fireBtn.addEventListener('touchstart', (e)=>{ e.preventDefault(); if(isReloading.value||isEquipping.value)return; state.shooting=true; startShooting(); resetIdleTimer&&resetIdleTimer(); immediateRender(); }, { passive: false });
                    fireBtn.addEventListener('touchend', (e)=>{ e.preventDefault(); state.shooting=false; stopShooting(); resetIdleTimer&&resetIdleTimer(); immediateRender(); });
                    fireBtn.addEventListener('touchcancel', (e)=>{ e.preventDefault(); state.shooting=false; stopShooting(); });
                }
                const reloadBtn = document.getElementById('reload-button');
                if(reloadBtn) reloadBtn.addEventListener('touchstart', ()=>{ onReload(); resetIdleTimer&&resetIdleTimer(); immediateRender(); }, { passive: false });
                const equipBtn = document.getElementById('equip-button');
                if(equipBtn) equipBtn.addEventListener('touchstart', ()=>{ onEquip(); resetIdleTimer&&resetIdleTimer(); immediateRender(); }, { passive: false });
                const aimBtn = document.getElementById('aim-button');
                if(aimBtn){
                    aimBtn.addEventListener('touchstart', ()=>{ isAiming.value=true; immediateRender(); }, { passive: false });
                    aimBtn.addEventListener('touchend', ()=>{ isAiming.value=false; immediateRender(); });
                }
                const skyToggle = document.getElementById('sky-toggle');
                if(skyToggle) skyToggle.style.display = 'none';
                const togglePanel = document.getElementById('toggle-panel');
                if(togglePanel) togglePanel.addEventListener('click', ()=>{ customizePanelVisible.value = !customizePanelVisible.value; immediateRender(); });
                const jumpBtn = document.getElementById('btn-jump'), crouchBtn = document.getElementById('btn-crouch'), proneBtn = document.getElementById('btn-prone');
                function addAction(btn, handler){
                    if(!btn) return;
                    const wrap = (e)=>{ e.preventDefault(); e.stopPropagation(); handler(); resetIdleTimer&&resetIdleTimer(); immediateRender(); };
                    btn.addEventListener('click', wrap);
                    btn.addEventListener('touchstart', wrap, { passive: false });
                }
                addAction(jumpBtn, jump);
                addAction(crouchBtn, ()=>setPosture(posture==='crouch'?'stand':'crouch'));
                addAction(proneBtn, ()=>setPosture(posture==='prone'?'stand':'prone'));
                window.addEventListener('touchstart', onGlobalStart, { passive: false });
                window.addEventListener('touchmove', onGlobalMove, { passive: false });
                window.addEventListener('touchend', onGlobalEnd);
                window.addEventListener('resize', ()=>{
                    if(camera){
                        camera.aspect = window.innerWidth / window.innerHeight;
                        camera.updateProjectionMatrix();
                        if(renderer) renderer.setSize(window.innerWidth, window.innerHeight);
                        immediateRender();
                    }
                });
            }
            
            function resetToDefault(){
                weaponPos.value = { ...DEFAULT_POS };
                weaponRotDeg.value = { ...DEFAULT_ROT_DEG };
                weaponScale.value = { ...DEFAULT_SCALE };
                cameraHeight.value = 1.6;
                sensitivity.value = 1;
                immediateRender();
            }

            onMounted(()=>{
                loadStorage();
                updateSensitivity();
                updateNormalHeight();
                let loaded=0;
                function onExt(){ loaded++; if(loaded===2){ initScene(); setupControls(); updateAmmoUI(); } }
                Gu.loadExtension('Water', onExt);
                Gu.loadExtension('Reflector', onExt);
            });

            return {
                ammo, maxAmmo, health, isAiming, isReloading, isEquipping, isLoading,
                customizePanelVisible, weaponPos, weaponRotDeg, weaponScale, cameraHeight, sensitivity,
                resetToDefault
            };
        },
        template: Ui.template
    });

    const mp = document.createElement('div');
    mp.id = 'vue-app-mount';
    document.getElementById('game-container').appendChild(mp);
    app.mount(mp);
}
})();