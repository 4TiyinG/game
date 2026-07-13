// app-env.js
// 场景、相机、渲染器、物理世界已在 main-state.js / physics.js 中定义，直接使用

// =========================================================
// 灯光
// =========================================================
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
var dirLight = new THREE.DirectionalLight(0xfff4e6, 1.2); // 暖色调平行光
dirLight.position.set(5, 10, 7);
dirLight.castShadow = true;
// 阴影图 512x512（256 过于模糊）
dirLight.shadow.mapSize.width = 512;
dirLight.shadow.mapSize.height = 512;
// 阴影范围优化：仅渲染角色周围的阴影，减少 ShadowMap 绘制开销
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 30;
dirLight.shadow.camera.left = -15;
dirLight.shadow.camera.right = 15;
dirLight.shadow.camera.top = 15;
dirLight.shadow.camera.bottom = -15;
dirLight.shadow.bias = -0.0005;
dirLight.shadow.normalBias = 0.02;
scene.add(dirLight);
// 补光：冷色调半球光，增强环境感
scene.add(new THREE.HemisphereLight(0xb0c4de, 0x3a3a3c, 0.3));
var fillLight = new THREE.DirectionalLight(0x8ecae6, 0.5);
fillLight.position.set(-5, 2, -5);
scene.add(fillLight);

// =========================================================
// 地面与装饰圆环
// =========================================================
// 使用本地纹理重新设计地面
var groundTextureUrl = './assets/textures/hardwood2_diffuse.jpg';
var groundTexture = new THREE.TextureLoader().load(groundTextureUrl);
groundTexture.wrapS = THREE.RepeatWrapping;
groundTexture.wrapT = THREE.RepeatWrapping;
groundTexture.repeat.set(8, 8);
groundTexture.colorSpace = THREE.SRGBColorSpace;
// 各向异性过滤：消除倾斜视角的纹理模糊
groundTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
groundTexture.minFilter = THREE.LinearMipmapLinearFilter;
groundTexture.generateMipmaps = true;

var groundGeometry = new THREE.PlaneGeometry(40, 40);
var groundMaterial = new THREE.MeshStandardMaterial({
    map: groundTexture,
    roughness: 0.8,
    metalness: 0.1
});
var ground = new THREE.Mesh(groundGeometry, groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0;
ground.receiveShadow = true;
scene.add(ground);

// =========================================================
// 【优化】固定物理斜坡（标准斜坡几何体 + 物理碰撞体）
// =========================================================
// 使用标准斜坡几何体：长度 3.4、宽度 1.8、高度 1.2、角度约 19.5°
// 顶点顺序确保法线朝上，射线检测和物理碰撞稳定
var rampLength = 3.4, rampWidth = 1.8, rampHeight = 1.2;
var rampVerts = new Float32Array([
    -rampLength/2, 0, -rampWidth/2,   // 0: 底面左前
     rampLength/2, 0, -rampWidth/2,   // 1: 底面右前
     rampLength/2, rampHeight, -rampWidth/2,  // 2: 顶面右前（高）
    -rampLength/2, 0,  rampWidth/2,   // 3: 底面左后
     rampLength/2, 0,  rampWidth/2,   // 4: 底面右后
     rampLength/2, rampHeight,  rampWidth/2   // 5: 顶面右后（高）
]);
var rampIdx = [
    0, 1, 4,  0, 4, 3, // 底面
    1, 2, 5,  1, 5, 4, // 右侧面（含斜面）
    0, 3, 5,  0, 5, 2, // 左侧面
    0, 2, 1             // 顶面（斜面）
];

var rampGeo = new THREE.BufferGeometry();
rampGeo.setAttribute('position', new THREE.BufferAttribute(rampVerts, 3));
rampGeo.setIndex(rampIdx);
rampGeo.computeVertexNormals();

var rampMat = new THREE.MeshStandardMaterial({ 
    color: 0x88aaff, 
    roughness: 0.4, 
    metalness: 0.2, 
    side: THREE.DoubleSide 
});
var rampMesh = new THREE.Mesh(rampGeo, rampMat);
// 放置在初始位置右侧，方便测试
rampMesh.position.set(5, 0, 2);
rampMesh.receiveShadow = true;
rampMesh.castShadow = true;
scene.add(rampMesh);

// 斜坡注册为物理碰撞体（使用凸包形状精确表示斜面几何）
if (typeof physicsModule !== 'undefined' && physicsModule.registerWalkable) {
    physicsModule.registerWalkable(rampMesh, true);
}