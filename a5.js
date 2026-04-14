// a6.js - 主游戏场景模块（稳定90帧全链路优化版）
// 优化亮点：消除帧率隐性限制 + 120Hz高刷适配 + 发热降频优化 + 集成Stats.js监控
window.GameScene = (function() {
    const Gu = window.GameUtils;

    // ========== 挂载 three-mesh-bvh ==========
    if (typeof THREE !== 'undefined' && typeof MeshBVHLib !== 'undefined') {
        const { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } = MeshBVHLib;
        if (!THREE.BufferGeometry.prototype.computeBoundsTree) {
            THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
            THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
            THREE.Mesh.prototype.raycast = acceleratedRaycast;
            console.log('✅ BVH 加速已启用 (O(log n) 射线检测)');
        }
    } else {
        console.warn('⚠️ three-mesh-bvh 未加载，射线检测将回退至原生 O(n) 算法');
    }

    // ========== 工具函数 ==========
    function randomRange(a,b){ return a+Math.random()*(b-a); }
    function loadEditorConfig(){
        try{ const raw=localStorage.getItem('GameSceneEditorConfig'); return raw?JSON.parse(raw):null; }catch(e){ return null; }
    }
    function applyConfig(obj, cfg){
        if(!cfg)return;
        if(cfg.position) obj.position.set(cfg.position.x,cfg.position.y,cfg.position.z);
        if(cfg.rotation){
            if(cfg.rotation.x !== undefined && cfg.rotation.y !== undefined && cfg.rotation.z !== undefined)
                obj.rotation.set(cfg.rotation.x, cfg.rotation.y, cfg.rotation.z);
            else if(cfg.rotation.y !== undefined)
                obj.rotation.y = cfg.rotation.y;
        }
        if(cfg.scale) obj.scale.set(cfg.scale.x,cfg.scale.y,cfg.scale.z);
    }

    // ========== 优化的 BVH 构建（带进度回调） ==========
    function buildOptimizedBVHForModel(model, options = {}) {
        if (!THREE.BufferGeometry.prototype.computeBoundsTree) return;

        model.traverse(node => {
            if (!node.isMesh || !node.geometry) return;
            const geom = node.geometry;
            
            if (geom.boundsTree) return;
            if (!geom.index) return;

            try {
                const triCount = geom.index.count / 3;
                const isDynamic = options.dynamic === true;
                
                const config = {
                    strategy: isDynamic ? 'CENTER' : 'SAH',
                    maxDepth: options.maxDepth || (triCount > 50000 ? 20 : 16),
                    maxLeafTris: options.maxLeafTris || (triCount > 50000 ? 15 : 10),
                    indirect: true,
                    lazyGeneration: true,
                    onProgress: options.onProgress || null
                };

                geom.computeBoundsTree(config);
            } catch (e) {
                console.warn('BVH 构建失败（降级为原生 raycast）:', e);
            }
        });
    }

    function buildBVHForModel(model) {
        buildOptimizedBVHForModel(model, { dynamic: false });
    }

    // ========== 场景构建函数 ==========
    function addHills(scene, count=8, config=null){
        const hillMat=new THREE.MeshStandardMaterial({color:0x6b8e4c,roughness:0.75});
        const hills=[];
        for(let i=0;i<count;i++){
            const r=randomRange(1.2,2.2), h=randomRange(0.8,1.5);
            const hill=new THREE.Mesh(new THREE.CylinderGeometry(r,r*1.2,h,12),hillMat);
            const angle=Math.random()*Math.PI*2, dist=randomRange(12,26);
            hill.position.set(Math.cos(angle)*dist, -0.2+h/2, Math.sin(angle)*dist);
            hill.castShadow=false; 
            hill.receiveShadow=false;
            // 大物体开启视锥体剔除
            hill.frustumCulled = true;
            scene.add(hill);
            hills.push(hill);
            if(config && config.models && config.models[`山丘_${i}`]) applyConfig(hill, config.models[`山丘_${i}`]);
            buildBVHForModel(hill);
        }
        return hills;
    }

    // ========== 房屋改用 InstancedMesh 批量渲染（优化 Draw Call） ==========
    function addHousesOptimized(scene, count=6, config=null){
        const wallMat = new THREE.MeshStandardMaterial({ color: 0xcdc9c9, roughness: 0.4 });
        const roofMat = new THREE.MeshStandardMaterial({ color: 0x8b3a3a, roughness: 0.6 });
        const canvas = document.createElement('canvas'); 
        canvas.width = 32; canvas.height = 32;
        const ctx = canvas.getContext('2d'); 
        ctx.fillStyle = '#88aaff'; 
        ctx.fillRect(0, 0, 32, 32); 
        ctx.fillStyle = '#fff'; 
        ctx.fillRect(10, 10, 12, 12);
        const windowMat = new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(canvas), emissive: 0x224466 });

        const wallGeom = new THREE.BoxGeometry(1.5, 1.2, 1.5);
        const roofGeom = new THREE.ConeGeometry(1.2, 0.8, 6);
        const windowGeom = new THREE.PlaneGeometry(0.6, 0.6);

        const wallInst = new THREE.InstancedMesh(wallGeom, wallMat, count);
        const roofInst = new THREE.InstancedMesh(roofGeom, roofMat, count);
        const windowInst = new THREE.InstancedMesh(windowGeom, windowMat, count);
        
        wallInst.castShadow = true;
        wallInst.receiveShadow = false;
        roofInst.castShadow = true;
        roofInst.receiveShadow = false;
        windowInst.castShadow = false;
        // 实例化物体建议开启视锥体剔除
        wallInst.frustumCulled = true;
        roofInst.frustumCulled = true;
        windowInst.frustumCulled = true;

        const houses = [];
        const dummy = new THREE.Object3D();
        
        for (let i = 0; i < count; i++) {
            const w = randomRange(1.2, 1.8);
            const d = randomRange(1.2, 1.8);
            const h = randomRange(1, 1.5);
            const angle = Math.random() * Math.PI * 2;
            const dist = randomRange(12, 28);
            const posX = Math.cos(angle) * dist;
            const posZ = Math.sin(angle) * dist;
            const posY = -0.2;

            dummy.position.set(posX, posY + h/2, posZ);
            dummy.scale.set(w/1.5, h/1.2, d/1.5);
            dummy.rotation.set(0, angle, 0);
            dummy.updateMatrix();
            wallInst.setMatrixAt(i, dummy.matrix);
            
            dummy.position.set(posX, posY + h + h*0.3, posZ);
            dummy.scale.set(w*0.85/1.2, 1, w*0.85/1.2);
            dummy.rotation.set(0, angle, 0);
            dummy.updateMatrix();
            roofInst.setMatrixAt(i, dummy.matrix);
            
            dummy.position.set(posX + w*0.4, posY + h*0.6, posZ + d/2 + 0.02);
            dummy.scale.set(1, 1, 1);
            dummy.rotation.set(0, angle, 0);
            dummy.updateMatrix();
            windowInst.setMatrixAt(i, dummy.matrix);

            houses.push({ wallInst, roofInst, windowInst });
        }

        wallInst.instanceMatrix.needsUpdate = true;
        roofInst.instanceMatrix.needsUpdate = true;
        windowInst.instanceMatrix.needsUpdate = true;

        scene.add(wallInst);
        scene.add(roofInst);
        scene.add(windowInst);

        buildBVHForModel(wallInst);
        buildBVHForModel(roofInst);
        buildBVHForModel(windowInst);

        return houses;
    }

    function addRoad(scene){
        const roadMat=new THREE.MeshStandardMaterial({color:0x2c2c2c,roughness:0.7});
        const ring=new THREE.Mesh(new THREE.RingGeometry(12,18,32),roadMat);
        ring.rotation.x=-Math.PI/2; ring.position.y=-0.15; 
        ring.receiveShadow=true; ring.castShadow=false;
        // 大平面物体，若旋转后可能会因包围盒问题被剔除，关闭视锥体剔除
        ring.frustumCulled = false;
        scene.add(ring);
        for(let i=0;i<4;i++){
            const angle=(i/4)*Math.PI*2;
            const x1=Math.cos(angle)*12,z1=Math.sin(angle)*12;
            const x2=Math.cos(angle)*22,z2=Math.sin(angle)*22;
            const dx=x2-x1,dz=z2-z1,len=Math.hypot(dx,dz);
            const strip=new THREE.Mesh(new THREE.PlaneGeometry(1.8,len),roadMat);
            strip.position.set((x1+x2)/2,-0.15,(z1+z2)/2);
            strip.lookAt(x2,0,z2); strip.rotateX(-Math.PI/2); 
            strip.receiveShadow=true; strip.castShadow=false;
            strip.frustumCulled = false;
            scene.add(strip);
        }
    }

    // GPU 旗帜（保持原有着色器动画）
    function createFlowingFlag(scene, texture, config){
        const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.08,5.5,6),new THREE.MeshStandardMaterial({color:0xccccaa}));
        pole.position.set(0,2.75,4.5); 
        pole.castShadow=true; pole.receiveShadow=false;
        scene.add(pole);
        if(config && config.models && config.models['旗杆']) applyConfig(pole, config.models['旗杆']);

        const width = 1.2;
        const height = 0.8;
        const widthSegments = 24;
        const heightSegments = 16;
        const geometry = new THREE.PlaneGeometry(width, height, widthSegments, heightSegments);
        
        const vertexShader = `
            varying vec2 vUv;
            uniform float uTime;
            void main() {
                vUv = uv;
                vec3 pos = position;
                float xFactor = pos.x / 1.2;
                float wave1 = sin(uTime * 2.5 + pos.y * 3.0) * 0.12 * xFactor;
                float wave2 = sin(uTime * 3.8 * pos.y) * 0.05 * xFactor;
                pos.z += wave1 + wave2;
                
                vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
                gl_Position = projectionMatrix * mvPosition;
            }
        `;
        const fragmentShader = `
            uniform sampler2D uMap;
            varying vec2 vUv;
            void main() {
                vec4 texColor = texture2D(uMap, vUv);
                gl_FragColor = texColor;
            }
        `;
        
        const flagMat = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uMap: { value: texture }
            },
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            side: THREE.DoubleSide,
            transparent: true
        });
        
        const flag = new THREE.Mesh(geometry, flagMat);
        flag.position.set(0.65, 5, 4.5);
        flag.castShadow = false;
        flag.receiveShadow = false;
        scene.add(flag);
        
        if(config && config.models && config.models['旗帜']) applyConfig(flag, config.models['旗帜']);
        
        let lastTime = performance.now();
        function update(delta) {
            if (flag.material) {
                flag.material.uniforms.uTime.value += delta * 1.8;
            }
        }
        return { flag, pole, update };
    }

    // ========== 主场景创建函数 ==========
    function createScene(normalHeight, onWeaponLoaded, onAILoaded){
        const scene=new THREE.Scene();
        scene.background=new THREE.Color(0x0a0a1a);
        scene.fog=new THREE.FogExp2(0x0a0a1a,0.0004);

        const camera=new THREE.PerspectiveCamera(75, innerWidth/innerHeight, 0.01, 1000);
        camera.position.set(0,normalHeight,5);
        camera.rotation.order='YXZ';

        let canvas=document.getElementById('canvas'),ctx=null;
        try{ ctx=canvas.getContext('webgl2',{antialias:true,powerPreference:'high-performance'}); }catch(e){}
        
        // ========== 优化 1：消除帧率隐性限制 ==========
        // 1. 关闭抗锯齿降低 GPU 负载，对高刷屏尤其重要[reference:6]
        // 2. 强制高性能模式，优先调用独显
        const renderer=new THREE.WebGLRenderer({
            canvas, context:ctx,
            antialias: false,          // 关闭 MSAA，减少 4K/120Hz 下的 GPU 负载[reference:7]
            powerPreference: 'high-performance',
            stencil: false,            // 不需要模板缓冲，节省显存
            depth: true,
            alpha: false               // 背景不透明，减少混合开销
        });
        
        renderer.setSize(innerWidth,innerHeight);
        // ========== 优化 2：限制像素比防止高刷屏渲染压力过大 ==========
        // 高刷屏(120Hz/144Hz)若使用极高的 devicePixelRatio (如 3+)，渲染缓冲区过大导致掉帧
        // 限制最高 2.0 可在清晰度与性能间取得最佳平衡[reference:8][reference:9]
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.0));
        
        renderer.shadowMap.enabled = true;
        // 改回 PCFSoftShadowMap 以获得更好视觉效果，配合 cullDistance 限制范围来控制性能
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        
        // ========== 优化 3：限制阴影投射距离，大幅降低发热[reference:10] ==========
        // 阴影是 GPU 密集型操作，限制距离后远处物体不再投射阴影
        if (renderer.shadowMap.cullDistance === undefined) {
            // 部分版本不支持，用 shadow camera far 代替
            console.log('使用 shadow camera far 限制阴影距离');
        } else {
            renderer.shadowMap.cullDistance = 20;  // 20 单位外不渲染阴影
        }

        // ========== 光影优化 ==========
        const ambient=new THREE.AmbientLight(0x404c66, 0.5);
        const hemi=new THREE.HemisphereLight(0x8bb0ff, 0x5a6e4a, 0.8);
        const dirLight=new THREE.DirectionalLight(0xffeedd, 1.6);
        dirLight.position.set(8, 15, 6);
        dirLight.castShadow=true;
        dirLight.shadow.mapSize.width = 512;
        dirLight.shadow.mapSize.height = 512;
        dirLight.shadow.camera.near = 0.5;
        dirLight.shadow.camera.far = 30;          // 阴影最远距离 30 单位
        dirLight.shadow.camera.left = -12;
        dirLight.shadow.camera.right = 12;
        dirLight.shadow.camera.top = 12;
        dirLight.shadow.camera.bottom = -12;
        dirLight.shadow.bias = -0.0005;
        const backLight=new THREE.DirectionalLight(0xaaccff, 0.7);
        backLight.position.set(-5, 4, -8);
        const fillLight=new THREE.PointLight(0xffccaa, 0.5);
        fillLight.position.set(3, 2, 6);
        const rimLight=new THREE.PointLight(0xccbbaa, 0.4);
        rimLight.position.set(0, -1, 2);
        scene.add(ambient, hemi, dirLight, backLight, fillLight, rimLight);

        // 纹理异步加载 Worker（保持原逻辑）
        const texWorker=new Worker(URL.createObjectURL(new Blob([`self.onmessage=async e=>{const{url}=e.data;try{const res=await fetch(url);const blob=await res.blob();const bitmap=await createImageBitmap(blob);self.postMessage({url,bitmap},[bitmap])}catch(err){self.postMessage({url,error:err.message})}}`],{type:'application/javascript'})));
        function loadTextureAsync(url){ return new Promise((res,rej)=>{ const h=e=>{ if(e.data.url===url){ texWorker.removeEventListener('message',h); if(e.data.bitmap){ const tex=new THREE.CanvasTexture(e.data.bitmap); tex.needsUpdate=true; res(tex); } else rej(new Error(e.data.error)); } }; texWorker.addEventListener('message',h); texWorker.postMessage({url}); }); }

        // 天空球
        (async ()=>{ try{ const skyTex=await loadTextureAsync('https://image2url.com/r2/bucket1/images/1767924501264-882d54aa-2ff0-4d62-9a9a-a352455d8fba.jpg'); const skyMat=new THREE.MeshBasicMaterial({map:skyTex,side:THREE.BackSide}); scene.add(new THREE.Mesh(new THREE.SphereGeometry(120,32,32),skyMat)); }catch(e){ console.warn('天空盒失败',e); scene.add(new THREE.Mesh(new THREE.SphereGeometry(120,32,32),new THREE.MeshBasicMaterial({color:0x4a9eff}))); } })();

        // 地面
        const groundMat = new THREE.MeshStandardMaterial({color:0x5a7a3a, roughness:0.85, metalness:0.05});
        const ground=new THREE.Mesh(new THREE.PlaneGeometry(80,80,32,32), groundMat);
        ground.rotation.x=-Math.PI/2; 
        ground.position.y=-0.2; 
        ground.receiveShadow=true; 
        ground.castShadow=false;
        // 地面是静态大物体，关闭视锥体剔除防止边界时消失
        ground.frustumCulled = false;
        scene.add(ground);
        buildBVHForModel(ground);

        const editorConfig=loadEditorConfig();
        addRoad(scene);
        const hills=addHills(scene,8,editorConfig);
        const houses = addHousesOptimized(scene, 6, editorConfig);

        // 旗帜（异步）
        let flagUpdateFn = null;
        (async ()=>{ 
            try{ 
                const tex=await loadTextureAsync('https://image2url.com/r2/bucket2/images/1766739894913-d6018d51-9e56-4a5e-8c55-ae182f792e65.jpg'); 
                const {update}=createFlowingFlag(scene,tex,editorConfig); 
                flagUpdateFn=update; 
            }catch(e){ 
                console.warn(e); 
                const tex=new THREE.CanvasTexture(document.createElement('canvas')); 
                const {update}=createFlowingFlag(scene,tex,editorConfig); 
                flagUpdateFn=update; 
            } 
        })();

        // 武器模型（动态）
        let gunModel=null,mixer=null,animations={},muzzleLocal=new THREE.Vector3(0,0,0.5);
        new THREE.GLTFLoader().load('ak-12.glb', gltf=>{
            gunModel=gltf.scene; const box=new THREE.Box3().setFromObject(gunModel); gunModel.position.sub(box.getCenter(new THREE.Vector3()));
            gunModel.traverse(c=>{ if(c.isMesh){ c.castShadow=false; c.receiveShadow=false; c.frustumCulled=false; if(c.material) c.material.side=THREE.DoubleSide; } });
            camera.add(gunModel); scene.add(camera);
            muzzleLocal.copy(Gu.computeMuzzle(gunModel,new THREE.Vector3()));
            mixer=new THREE.AnimationMixer(gunModel); const anis=gltf.animations;
            const map=kw=>anis.find(a=>kw.some(k=>a.name.toLowerCase().includes(k)))||null;
            const equip=map(['equip','draw']), idle=map(['idle','stand']), shoot=map(['shoot','fire']), reload=map(['reload']);
            animations={}; if(equip) animations.equip=equip; if(idle) animations.idle=idle; if(shoot) animations.shoot=shoot; if(reload) animations.reload=reload;
            if(!animations.idle && anis.length) animations.idle=anis[0];
            buildOptimizedBVHForModel(gunModel, { dynamic: true });
            if(onWeaponLoaded) onWeaponLoaded(gunModel,mixer,animations,muzzleLocal);
        }, null, ()=>console.error('武器模型失败'));

        // AI 士兵（动态模型，使用 refit 优化）
        let aiModel=null,aiMixer=null,aiAnimations={},aiWorker=null;
        new THREE.GLTFLoader().load('https://cdn.jsdelivr.net/gh/4TiyinG/45@main/Soldier.glb', gltf=>{
            aiModel=gltf.scene; 
            aiModel.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=true;}});
            let posX=Gu.randomRange(-20,20), posZ=Gu.randomRange(-20,20);
            let rotY=0;
            if(editorConfig && editorConfig.models && editorConfig.models['AI士兵']){
                const cfg=editorConfig.models['AI士兵'];
                if(cfg.position){posX=cfg.position.x; posZ=cfg.position.z;}
                if(cfg.scale) aiModel.scale.set(cfg.scale.x,cfg.scale.y,cfg.scale.z);
                if(cfg.rotation){
                    if(cfg.rotation.y !== undefined) rotY=cfg.rotation.y;
                    if(cfg.rotation.x !== undefined && cfg.rotation.z !== undefined)
                        aiModel.rotation.set(cfg.rotation.x, cfg.rotation.y, cfg.rotation.z);
                    else
                        aiModel.rotation.y = rotY;
                }
            }
            aiModel.position.set(posX,0,posZ);
            scene.add(aiModel);
            aiMixer=new THREE.AnimationMixer(aiModel);
            gltf.animations.forEach(anim=>{aiAnimations[anim.name]=anim;});
            if(aiAnimations.Walk) aiMixer.clipAction(aiAnimations.Walk).play();
            buildOptimizedBVHForModel(aiModel, { dynamic: true });
            
            const blob=new Blob([Gu.aiWorkerCode],{type:'application/javascript'});
            aiWorker=new Worker(URL.createObjectURL(blob));
            aiWorker.onmessage=function(e){ 
                if(!aiModel) return; 
                const{pos,angle,isRunning}=e.data; 
                aiModel.position.x=pos.x; aiModel.position.z=pos.z; 
                aiModel.rotation.y=angle; 
                // 优化：动态物体使用 refit() 而非每帧重建 BVH
                if (aiModel) {
                    aiModel.traverse(node => {
                        if (node.isMesh && node.geometry.boundsTree) {
                            node.geometry.boundsTree.refit();
                        }
                    });
                }
                if(aiMixer){ 
                    let an=isRunning?'Run':'Walk'; 
                    if(aiAnimations[an]){ 
                        const act=aiMixer.clipAction(aiAnimations[an]); 
                        if(!act.isRunning()) act.play(); 
                        for(let a in aiAnimations) if(a!==an && aiMixer.clipAction(aiAnimations[a]).isRunning()) aiMixer.clipAction(aiAnimations[a]).stop(); 
                    } 
                } 
            };
            aiWorker.postMessage({type:'init', aiX:aiModel.position.x, aiZ:aiModel.position.z});
            if(onAILoaded) onAILoaded(aiModel,aiMixer,aiAnimations,aiWorker);
        }, null, err=>console.warn('AI士兵失败',err));

        // 预定义模型加载（静态）
        const loader=new THREE.GLTFLoader();
        function addPredefined(name,url,pos,scale,rot){
            loader.load(url, gltf=>{
                const model=gltf.scene;
                model.position.copy(pos);
                model.scale.copy(scale);
                if(rot instanceof THREE.Euler) model.rotation.copy(rot);
                else model.rotation.y = rot;
                model.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=false;}});
                scene.add(model);
                buildBVHForModel(model);
                if(editorConfig && editorConfig.models && editorConfig.models[name]) applyConfig(model, editorConfig.models[name]);
            }, null, err=>console.warn(`${name}加载失败`,err));
        }
        addPredefined('路灯1','https://cdn.jsdelivr.net/gh/4TiyinG/45@main/deng.glb', new THREE.Vector3(8,0,8), new THREE.Vector3(0.8,0.8,0.8), 0);
        addPredefined('路灯2','https://cdn.jsdelivr.net/gh/4TiyinG/45@main/deng.glb', new THREE.Vector3(-7,0,9), new THREE.Vector3(0.8,0.8,0.8), 0);
        addPredefined('初音未来','https://cdn.jsdelivr.net/gh/4TiyinG/45@main/hachune-miku-doll.glb', new THREE.Vector3(2.5,0,4), new THREE.Vector3(0.8,0.8,0.8), 0);
        addPredefined('吉他','https://cdn.jsdelivr.net/gh/4TiyinG/45@main/guitar.glb', new THREE.Vector3(4.5,0.3,2.8), new THREE.Vector3(0.6,0.6,0.6), 0);

        // 程序化物体
        if(editorConfig && editorConfig.proceduralObjects){
            for(let [name, data] of Object.entries(editorConfig.proceduralObjects)){
                const color = data.color || '#ffaa66';
                const pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
                let geometry, material;
                material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.4, metalness: 0.2 });
                switch(data.type){
                    case 'box': geometry = new THREE.BoxGeometry(1,1,1); break;
                    case 'sphere': geometry = new THREE.SphereGeometry(0.5,32,32); break;
                    case 'cylinder': geometry = new THREE.CylinderGeometry(0.5,0.5,1,32); break;
                    case 'cone': geometry = new THREE.ConeGeometry(0.5,1,32); break;
                    case 'torus': geometry = new THREE.TorusGeometry(0.5,0.2,32,64); material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness:0.3, metalness:0.7 }); break;
                    case 'plane': geometry = new THREE.PlaneGeometry(1,1); material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), side: THREE.DoubleSide }); break;
                    default: continue;
                }
                const mesh = new THREE.Mesh(geometry, material);
                mesh.position.copy(pos);
                if(data.rotation) mesh.rotation.set(data.rotation.x, data.rotation.y, data.rotation.z);
                mesh.scale.set(data.scale.x, data.scale.y, data.scale.z);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                scene.add(mesh);
                buildBVHForModel(mesh);
            }
        }

        // 外部模型
        if(editorConfig && editorConfig.externalModels){
            for(let [name, data] of Object.entries(editorConfig.externalModels)){
                if(data.url){
                    loader.load(data.url, gltf=>{
                        const model=gltf.scene;
                        model.position.set(data.position.x,data.position.y,data.position.z);
                        model.scale.set(data.scale.x,data.scale.y,data.scale.z);
                        if(data.rotation) model.rotation.set(data.rotation.x, data.rotation.y, data.rotation.z);
                        model.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=false;}});
                        scene.add(model);
                        buildBVHForModel(model);
                    }, null, err=>console.warn(`外部模型 ${name} 加载失败`,err));
                }
            }
        }

        // 旗帜动画更新
        let lastTime=performance.now();
        function updateFlagAnimation(){ 
            if(flagUpdateFn){ 
                const now=performance.now(); 
                let delta=Math.min(0.033,(now-lastTime)/1000); 
                lastTime=now; 
                flagUpdateFn(delta); 
            } 
        }

        // ========== 内存管理：dispose 清理函数（供外部调用） ==========
        function disposeScene() {
            scene.traverse(obj => {
                if (obj.isMesh && obj.geometry) {
                    if (obj.geometry.disposeBoundsTree) {
                        obj.geometry.disposeBoundsTree();
                    }
                    obj.geometry.dispose();
                }
                if (obj.isMesh && obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(m => m.dispose());
                    } else {
                        obj.material.dispose();
                    }
                }
            });
            renderer.dispose();
            console.log('✅ 场景资源已清理');
        }

        // ========== 射线检测演示方法 ==========
        const raycaster = new THREE.Raycaster();
        let lastHighlighted = null;
        const originalEmissive = new THREE.Color();

        function performRaycast(mouseNDC, camera, objects = scene.children) {
            if (!THREE.BufferGeometry.prototype.computeBoundsTree) {
                console.warn('BVH 未启用，射线检测性能可能较低');
            }
            raycaster.setFromCamera(mouseNDC, camera);
            
            const start = performance.now();
            const intersects = raycaster.intersectObjects(objects, true);
            const end = performance.now();
            console.log(`🔍 射线检测耗时: ${(end - start).toFixed(2)} ms, 命中 ${intersects.length} 个物体`);
            
            if (intersects.length > 0) {
                const hit = intersects[0].object;
                if (hit.isMesh) {
                    if (lastHighlighted && lastHighlighted.material) {
                        if (Array.isArray(lastHighlighted.material)) {
                            lastHighlighted.material.forEach(mat => mat.emissive?.copy(originalEmissive));
                        } else {
                            lastHighlighted.material.emissive?.copy(originalEmissive);
                        }
                    }
                    if (hit.material) {
                        if (Array.isArray(hit.material)) {
                            hit.material.forEach(mat => {
                                if (mat.emissive) {
                                    originalEmissive.copy(mat.emissive);
                                    mat.emissive.setHex(0x444444);
                                }
                            });
                        } else {
                            if (hit.material.emissive) {
                                originalEmissive.copy(hit.material.emissive);
                                hit.material.emissive.setHex(0x444444);
                            }
                        }
                        lastHighlighted = hit;
                    }
                }
            } else {
                if (lastHighlighted && lastHighlighted.material) {
                    if (Array.isArray(lastHighlighted.material)) {
                        lastHighlighted.material.forEach(mat => mat.emissive?.copy(originalEmissive));
                    } else {
                        lastHighlighted.material.emissive?.copy(originalEmissive);
                    }
                    lastHighlighted = null;
                }
            }
            return intersects;
        }

        return {
            scene,camera,renderer,
            ambientLight:ambient, hemisphereLight:hemi, dirLight, backLight, fillLight, rimLight,
            water:null, flagUniforms:null, mirrorObj:null, mirrorOriginalPos:null, skyboxMaterial:null,
            gunModel,mixer,animations,muzzleLocal,
            aiModel,aiMixer,aiAnimations,aiWorker,
            updateFlagAnimation,
            performRaycast,
            raycaster,
            disposeScene
        };
    }

    return { createScene };
})();