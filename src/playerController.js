var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import * as THREE from "three";
import { MeshBVH, MeshBVHHelper, acceleratedRaycast } from "three-mesh-bvh";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AnimationSystem } from "./systems/AnimationSystem.js";
import { CameraSystem } from "./systems/CameraSystem.js";
import { InputSystem } from "./systems/InputSystem.js";
import { applyCapsuleCollision, createCollisionTemps } from "./utils/capsuleCollision.js";
THREE.Mesh.prototype.raycast = acceleratedRaycast;
const clock = new THREE.Clock();
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}
class playerController {
  // 载具系统
  constructor() {
    // ==================== 场景引用 ====================
    __publicField(this, "loader", new GLTFLoader());
    // GLTF加载器
    __publicField(this, "scene");
    // 三维场景
    __publicField(this, "camera");
    // 透视相机
    __publicField(this, "controls");
    // 轨道控制器
    // ==================== 玩家配置 ====================
    __publicField(this, "playerModelConfig");
    // 模型配置项
    __publicField(this, "initPos", new THREE.Vector3(0, 0, 0));
    // 初始出生位置
    __publicField(this, "gravity", -2400);
    // 重力加速度
    __publicField(this, "jumpHeight", 600);
    // 跳跃初速度
    __publicField(this, "playerSpeed", 200);
    // 行走速度
    __publicField(this, "playerFlySpeed", 2100);
    // 飞行速度
    __publicField(this, "curPlayerSpeed", 0);
    // 当前实际速度
    __publicField(this, "enableOverShoulderView", false);
    // 越肩视角开关
    // ==================== 玩家胶囊体 ====================
    __publicField(this, "playerCapsuleRadius", 30);
    // 胶囊体半径
    __publicField(this, "playerCapsuleRadiusRatio", 1);
    // 半径缩放比
    __publicField(this, "playerCapsuleHeight", 180);
    // 胶囊体高度
    __publicField(this, "isFirstPerson", false);
    // 第一人称状态
    // ==================== 运行状态 ====================
    __publicField(this, "controllerMode", 0);
    // 0步行 1载具
    __publicField(this, "playerIsOnGround", false);
    // 是否在地面
    __publicField(this, "isupdate", true);
    // 帧更新开关
    __publicField(this, "timeScale", 1);
    // 时间缩放系数
    __publicField(this, "currentDelta", 0);
    // 本帧实际使用的 delta（已钳制 + timeScale）
    __publicField(this, "isFlying", false);
    // 飞行状态
    __publicField(this, "skipCapsuleCollision", false);
    // 临时跳过玩家胶囊碰撞检测
    __publicField(this, "isChangeControllerTransitionTimer", null);
    // 模式切换计时器
    __publicField(this, "enableToward", true);
    // 启用朝向输入
    // ==================== 玩家物体 ====================
    __publicField(this, "playerCapsule");
    // 玩家碰撞胶囊
    __publicField(this, "playerModel", null);
    // 模型根节点
    __publicField(this, "playerModelHead", null);
    // 头骨节点
    // ==================== 碰撞体 ====================
    __publicField(this, "collider", null);
    // 静态碰撞体
    __publicField(this, "visualizer", null);
    // BVH可视化
    __publicField(this, "collected", []);
    // 静态几何收集
    __publicField(this, "dynamicColliders", []);
    // 动态碰撞体列表
    __publicField(this, "activeDynamicCollider", null);
    // 当前站立的动态碰撞体
    // ==================== 碰撞阈值 ====================
    __publicField(this, "rideHeight", 40);
    // 悬空胶囊离地高度
    // 站立 / 落地阈值
    __publicField(this, "snapH", 0);
    // 站立时胶囊原点应离地的高度
    __publicField(this, "maxH", 0);
    // 离地超过此值判为悬空、施加重力
    // ==================== 台阶视觉平滑 ====================
    __publicField(this, "stepSmoothFactor", 10);
    // 插值追赶速度，越大追得越快
    __publicField(this, "modelBaseY", 0);
    // 模型相对胶囊的基准 Y
    __publicField(this, "minFloorNormalY", Math.cos(8 * Math.PI / 180));
    // 最小法线 Y 分量，地面法线与竖直夹角 ≤ 8° 视为台阶/平地（注入平滑）
    // ==================== 调试 ====================
    __publicField(this, "displayPlayer", false);
    // 显示玩家碰撞体
    __publicField(this, "displayCollider", false);
    // 显示场景碰撞体
    __publicField(this, "displayVisualizer", false);
    // 显示BVH辅助
    // ==================== 方向常量 & 复用向量 ====================
    __publicField(this, "rotationSpeed", 10);
    // 朝向旋转速度
    __publicField(this, "upVector", new THREE.Vector3(0, 1, 0));
    // 世界上方向
    __publicField(this, "DIR_FWD", new THREE.Vector3(0, 0, -1));
    // 前
    __publicField(this, "DIR_RGT", new THREE.Vector3(1, 0, 0));
    // 右
    __publicField(this, "playerAcceleration", 30);
    // XZ 加速响应速度
    __publicField(this, "playerDeceleration", 30);
    // XZ 减速响应速度
    __publicField(this, "decelBase", 300);
    // 减速基准速度
    __publicField(this, "playerVelocity", new THREE.Vector3());
    // 玩家速度
    __publicField(this, "camDir", new THREE.Vector3());
    // 相机方向缓存
    __publicField(this, "moveDir", new THREE.Vector3());
    // 移动方向缓存
    __publicField(this, "xzDir", new THREE.Vector3());
    // 步进方向缓存
    __publicField(this, "targetQuat", new THREE.Quaternion());
    // 目标四元数
    __publicField(this, "targetMat", new THREE.Matrix4());
    // 目标变换矩阵
    __publicField(this, "staticTemps", createCollisionTemps());
    // 静态碰撞临时对象
    __publicField(this, "dynTemps", createCollisionTemps());
    // 动态碰撞临时对象
    __publicField(this, "groundRaycaster", new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0)));
    // 地面检测射线
    // ==================== 事件回调 ====================
    __publicField(this, "onAnimationChange");
    // 动画切换回调
    __publicField(this, "onBeforeViewChange");
    // 视角切换前回调
    __publicField(this, "onViewChange");
    // 视角切换后回调
    __publicField(this, "onGroundChange");
    // 落地状态回调
    __publicField(this, "onVehicleEnter");
    // 上车回调
    __publicField(this, "onVehicleExit");
    // 下车回调
    __publicField(this, "onTowardChange");
    // 朝向变化回调
    // ==================== 子系统 ====================
    __publicField(this, "animation", new AnimationSystem(this));
    // 动画系统
    __publicField(this, "cam", new CameraSystem(this));
    // 相机系统
    __publicField(this, "input", new InputSystem(this));
    // 输入系统
    this.groundRaycaster.firstHitOnly = true;
  }
  // ==================== 初始化 ====================
  // 主初始化入口
  async init(opts, callback) {
    const m = opts.playerModelConfig;
    const s = m.scale ?? 1;
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.camera.rotation.order = "YXZ";
    this.controls = opts.controls;
    this.playerModelConfig = m;
    this.initPos = opts.initPos ? opts.initPos.clone() : this.initPos;
    const pm = this.playerModelConfig;
    this.gravity = (pm.gravity ?? this.gravity) * s;
    this.jumpHeight = (pm.jumpHeight ?? this.jumpHeight) * s;
    this.playerSpeed = (pm.speed ?? this.playerSpeed) * s;
    this.playerFlySpeed = (pm.flySpeed ?? this.playerFlySpeed) * s;
    this.curPlayerSpeed = this.playerSpeed;
    this.playerCapsuleRadiusRatio = pm.capsuleRadiusRatio ?? this.playerCapsuleRadiusRatio;
    this.playerAcceleration = pm.acceleration ?? this.playerAcceleration;
    this.playerDeceleration = pm.deceleration ?? this.playerDeceleration;
    this.decelBase = this.playerSpeed;
    this.cam.sensitivity = opts.mouseSensitivity ?? this.cam.sensitivity;
    this.cam.mouseMode = opts.thirdMouseMode ?? this.cam.mouseMode;
    this.cam.enableSpringCamera = opts.enableSpringCamera ?? this.cam.enableSpringCamera;
    this.cam.springCameraTime = opts.springCameraTime ?? this.cam.springCameraTime;
    this.cam.zoomEnabled = opts.enableZoom ?? this.cam.zoomEnabled;
    this.cam.minDist = (opts.minCamDistance ?? this.cam.minDist) * s;
    this.cam.maxDist = (opts.maxCamDistance ?? this.cam.maxDist) * s;
    this.cam.lookAtHeightRatio = opts.camLookAtHeightRatio ?? this.cam.lookAtHeightRatio;
    this.cam.originMaxDist = this.cam.maxDist;
    this.cam.epsilon = this.cam.epsilon * s;
    this.enableOverShoulderView = opts.enableOverShoulderView ?? this.enableOverShoulderView;
    this.isFirstPerson = opts.isFirstPerson ?? this.isFirstPerson;
    this.timeScale = opts.timeScale ?? this.timeScale;
    if (opts.keyMap) this.input.buildKeyMap(opts.keyMap);
    await this.initLoader();
    this.buildStaticCollider(opts.staticCollider);
    await this.loadPlayerModelGLB();
    if (opts.dynamicCollider) {
      const list = Array.isArray(opts.dynamicCollider) ? opts.dynamicCollider : [opts.dynamicCollider];
      for (const obj of list) this.addDynamicCollider(obj);
    }
    this.input.bindEvents();
    this.cam.setCamPos();
    this.cam.initControls();
    this.cam.setOverShoulder(this.isFirstPerson ? false : this.enableOverShoulderView);
    callback?.();
  }
  // 初始化加载器
  async initLoader() {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath("https://unpkg.com/three@0.182.0/examples/jsm/libs/draco/gltf/");
    this.loader.setDRACOLoader(dracoLoader);
  }
  // ==================== 玩家模型 ====================
  // 加载模型与动画
  async loadPlayerModelGLB() {
    try {
      const gltf = await this.loader.loadAsync(this.playerModelConfig.url);
      this._lastLoadedGLTF = gltf;
      this.playerModel = gltf.scene;
      this.animation.mixer = new THREE.AnimationMixer(this.playerModel);
      const animations = gltf.animations ?? [];
      this.animation.clips = animations;
      this.animation.actions = /* @__PURE__ */ new Map();
      const mc = this.playerModelConfig;
      const isThreePartJump = Array.isArray(mc.jumpAnim);
      this.animation.hasThreePartJump = isThreePartJump;
      const mappings = [
        [mc.idleAnim, "idle"],
        [mc.walkAnim, "walking"],
        [mc.leftWalkAnim || mc.walkAnim, "left_walking"],
        [mc.rightWalkAnim || mc.walkAnim, "right_walking"],
        [mc.backwardAnim || mc.walkAnim, "walking_backward"],
        ...isThreePartJump ? [] : [[mc.jumpAnim, "jumping"]],
        [mc.runAnim, "running"],
        [mc.flyIdleAnim || mc.idleAnim, "flyidle"],
        [mc.flyAnim || mc.idleAnim, "flying"],
        [mc.flyHoverForwardAnim || mc.flyAnim || mc.idleAnim, "flyHoverForward"],
        [mc.flyHoverBackAnim || mc.flyIdleAnim || mc.idleAnim, "flyHoverBack"],
        [mc.flyHoverLeftAnim || mc.flyIdleAnim || mc.idleAnim, "flyHoverLeft"],
        [mc.flyHoverRightAnim || mc.flyIdleAnim || mc.idleAnim, "flyHoverRight"],
        [mc.flyHoverUpAnim || mc.flyIdleAnim || mc.idleAnim, "flyHoverUp"],
        [mc.flyHoverDownAnim || mc.flyIdleAnim || mc.idleAnim, "flyHoverDown"],
        [mc.enterCarAnim || mc.idleAnim, "enterCar"],
        [mc.exitCarAnim || mc.idleAnim, "exitCar"]
      ];
      for (const [clipName, actionName] of mappings) {
        const clip = animations.find((a) => a.name === clipName);
        if (!clip) continue;
        const action = this.animation.mixer.clipAction(clip);
        if (actionName === "jumping") {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
          action.setEffectiveTimeScale(1.2);
        } else {
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.setEffectiveTimeScale(1);
        }
        action.enabled = true;
        action.setEffectiveWeight(0);
        this.animation.actions.set(actionName, action);
      }
      if (isThreePartJump) {
        const [startClip, loopClip, endClip] = mc.jumpAnim;
        const jumpDefs = [
          [startClip, "jumpStart", THREE.LoopOnce, true],
          [loopClip, "jumpLoop", THREE.LoopRepeat, false],
          [endClip, "jumpEnd", THREE.LoopOnce, true]
        ];
        for (const [clipName, key, loop, clamp] of jumpDefs) {
          const clip = animations.find((a) => a.name === clipName);
          if (!clip) {
            console.warn(`\u627E\u4E0D\u5230\u8DF3\u8DC3\u52A8\u753B clip: "${clipName}"`);
            continue;
          }
          const action = this.animation.mixer.clipAction(clip);
          action.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
          action.clampWhenFinished = clamp;
          action.setEffectiveTimeScale(key === "jumpStart" ? 1.2 : 1);
          action.enabled = true;
          action.setEffectiveWeight(0);
          this.animation.actions.set(key, action);
        }
      }
      const defaultSet = /* @__PURE__ */ new Map();
      for (const key of ["idle", "walking", "walking_backward", "running", "jumping", "flyidle", "flying"]) {
        const action = this.animation.actions.get(key);
        if (action) defaultSet.set(key, action);
      }
      this.animation.sets.set("default", defaultSet);
      this.animation.actions.get("idle")?.setEffectiveWeight(1);
      this.animation.actions.get("idle")?.play();
      this.animation.state = this.animation.actions.get("idle");
      this.animation.mixerCb = (ev) => {
        const done = ev.action;
        const resolveGroundAnim = () => {
          if (this.input.fwd) {
            this.animation.playByName(this.input.shift ? "running" : "walking");
            return;
          }
          if (this.input.bkd) {
            this.animation.playByName("walking_backward");
            return;
          }
          if (this.input.rgt || this.input.lft) {
            this.animation.playByName("walking");
            return;
          }
          this.animation.playByName("idle");
        };
        if (done === this.animation.actions?.get("jumping")) {
          resolveGroundAnim();
          return;
        }
        if (done === this.animation.actions?.get("jumpStart")) {
          this.animation.playByName("jumpLoop");
          return;
        }
        if (done === this.animation.actions?.get("jumpEnd")) {
          resolveGroundAnim();
          return;
        }
      };
      this.animation.mixer.addEventListener("finished", this.animation.mixerCb);
      this.animation.mixer.update(0);
      this.playerModel.updateMatrixWorld(true);
      const { size } = this.getBbox(this.playerModel);
      const modelScale = this.playerCapsuleHeight / size.y;
      const s = this.playerModelConfig.scale;
      const r = this.playerCapsuleRadius * s * this.playerCapsuleRadiusRatio;
      const h = this.playerCapsuleHeight * s;
      const rideHeightScaled = this.rideHeight * s;
      const colliderHeight = h - rideHeightScaled;
      this.playerCapsule = new THREE.Mesh(
        new RoundedBoxGeometry(r * 2, colliderHeight, r * 2, 1, 75),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(1, 0, 0),
          shadowSide: THREE.DoubleSide,
          depthTest: false,
          wireframe: true,
          depthWrite: false
        })
      );
      const segmentLength = colliderHeight - 2 * r;
      this.playerCapsule.geometry.translate(0, -segmentLength / 2, 0);
      this.playerCapsule.capsuleInfo = {
        radius: r,
        segment: new THREE.Line3(new THREE.Vector3(), new THREE.Vector3(0, -segmentLength, 0))
      };
      this.recomputeGroundThresholds();
      this.playerCapsule.name = "capsule";
      this.playerCapsule.material.visible = this.displayPlayer;
      this.scene.add(this.playerCapsule);
      this.reset();
      this.playerCapsule.rotateY(this.playerModelConfig.rotateY ?? 0);
      this.playerModel.scale.multiplyScalar(modelScale * s);
      this.modelBaseY = -segmentLength - r - rideHeightScaled;
      this.playerModel.position.set(0, this.modelBaseY, 0);
      this.playerModel.traverse((child) => {
        if (child.name === this.playerModelConfig?.headBoneName) this.playerModelHead = child;
      });
      this.playerCapsule.add(this.playerModel);
      this.reset();
    } catch (e) {
      console.error("\u52A0\u8F7D\u73A9\u5BB6\u6A21\u578B\u5931\u8D25:", e);
    }
  }
  // 切换玩家模型（同步，使用预加载的 scene）
  switchPlayerModelSync(scene, animations) {
    const savedPos = this.playerCapsule.position.clone();
    const savedQuat = this.playerCapsule.quaternion.clone();
    const wasFirstPerson = this.isFirstPerson;
    if (wasFirstPerson) this.scene.attach(this.camera);
    // 移除旧胶囊体和模型
    if (this.playerCapsule) this.scene.remove(this.playerCapsule);
    if (this.playerModel) {
      this.playerCapsule.remove(this.playerModel);
      this.playerModel = null;
      this.playerModelHead = null;
    }
    // 清理旧动画
    const anim = this.animation;
    if (anim.mixer) {
      if (anim.mixerCb) {
        anim.mixer.removeEventListener("finished", anim.mixerCb);
        anim.mixerCb = void 0;
      }
      anim.mixer.stopAllAction();
      anim.mixer.uncacheRoot(anim.mixer.getRoot());
      anim.mixer = void 0;
      anim.actions = void 0;
    }
    // 使用预加载的 scene
    this.playerModel = scene;
    this.animation.mixer = new THREE.AnimationMixer(this.playerModel);
    this.animation.clips = animations ?? [];
    this.animation.actions = /* @__PURE__ */ new Map();
    const mc = this.playerModelConfig;
    const isThreePartJump = Array.isArray(mc.jumpAnim);
    if (mc.idleAnim) {
      const clip = this.animation.clips.find((c) => c.name === mc.idleAnim);
      if (clip) this.animation.actions.set("idle", this.animation.mixer.clipAction(clip));
    }
    if (mc.walkAnim) {
      const clip = this.animation.clips.find((c) => c.name === mc.walkAnim);
      if (clip) this.animation.actions.set("walk", this.animation.mixer.clipAction(clip));
    }
    if (mc.runAnim) {
      const clip = this.animation.clips.find((c) => c.name === mc.runAnim);
      if (clip) this.animation.actions.set("run", this.animation.mixer.clipAction(clip));
    }
    if (isThreePartJump) {
      const [jc, jc2, jc3] = mc.jumpAnim;
      const c1 = this.animation.clips.find((c) => c.name === jc);
      const c2 = this.animation.clips.find((c) => c.name === jc2);
      const c3 = this.animation.clips.find((c) => c.name === jc3);
      if (c1) this.animation.actions.set("jump", this.animation.mixer.clipAction(c1));
      if (c2) this.animation.actions.set("jumpFall", this.animation.mixer.clipAction(c2));
      if (c3) this.animation.actions.set("jumpEnd", this.animation.mixer.clipAction(c3));
    } else if (mc.jumpAnim) {
      const clip = this.animation.clips.find((c) => c.name === mc.jumpAnim);
      if (clip) this.animation.actions.set("jump", this.animation.mixer.clipAction(clip));
    }
    // 计算缩放和位置（先重置缩放，确保 bbox 正确）
    this.playerModel.scale.set(1, 1, 1);
    this.playerModel.position.set(0, 0, 0);
    const s = this.playerModelConfig.scale;
    const { size } = this.getBbox(this.playerModel);
    const modelScale = this.playerCapsuleHeight / size.y;
    const r = this.playerRadius;
    const rideHeightScaled = this.rideHeight * s;
    const h = this.playerCapsuleHeight * s;
    const colliderHeight = h - rideHeightScaled;
    this.playerCapsule = new THREE.Mesh(
      new RoundedBoxGeometry(r * 2, colliderHeight, r * 2, 1, 75),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(1, 0, 0),
        shadowSide: THREE.DoubleSide,
        depthTest: false,
        wireframe: true,
        depthWrite: false
      })
    );
    const segmentLength = colliderHeight - 2 * r;
    this.playerCapsule.geometry.translate(0, -segmentLength / 2, 0);
    this.playerCapsule.capsuleInfo = {
      radius: r,
      segment: new THREE.Line3(new THREE.Vector3(), new THREE.Vector3(0, -segmentLength, 0))
    };
    this.recomputeGroundThresholds();
    this.playerCapsule.name = "capsule";
    this.playerCapsule.material.visible = this.displayPlayer;
    this.scene.add(this.playerCapsule);
    this.reset();
    this.playerCapsule.rotateY(this.playerModelConfig.rotateY ?? 0);
    this.playerModel.scale.multiplyScalar(modelScale * s);
    this.modelBaseY = -segmentLength - r - rideHeightScaled;
    this.playerModel.position.set(0, this.modelBaseY, 0);
    this.playerModel.traverse((child) => {
      if (child.name === this.playerModelConfig?.headBoneName) this.playerModelHead = child;
    });
    this.playerCapsule.add(this.playerModel);
    this.reset();
    // 恢复位置和朝向
    this.playerCapsule.position.copy(savedPos);
    this.playerCapsule.quaternion.copy(savedQuat);
    if (wasFirstPerson) this.cam.setFirstPerson();
    this.setDebug(this.displayCollider);
  }
  // 切换玩家模型
  async switchPlayerModel(newPlayerModel) {
    const savedPos = this.playerCapsule.position.clone();
    const savedQuat = this.playerCapsule.quaternion.clone();
    const wasFirstPerson = this.isFirstPerson;
    if (wasFirstPerson) this.scene.attach(this.camera);
    if (this.playerCapsule) this.scene.remove(this.playerCapsule);
    if (this.playerModel) {
      this.playerCapsule.remove(this.playerModel);
      this.playerModel = null;
      this.playerModelHead = null;
    }
    const anim = this.animation;
    if (anim.mixer) {
      if (anim.mixerCb) {
        anim.mixer.removeEventListener("finished", anim.mixerCb);
        anim.mixerCb = void 0;
      }
      anim.mixer.stopAllAction();
      anim.mixer.uncacheRoot(anim.mixer.getRoot());
      anim.mixer = void 0;
      anim.actions = void 0;
    }
    const ratio = newPlayerModel.scale / this.playerModelConfig.scale;
    this.playerModelConfig = { ...this.playerModelConfig, ...newPlayerModel };
    this.gravity *= ratio;
    this.jumpHeight *= ratio;
    this.playerSpeed *= ratio;
    this.playerFlySpeed *= ratio;
    this.curPlayerSpeed *= ratio;
    this.cam.epsilon *= ratio;
    this.cam.minDist *= ratio;
    this.cam.maxDist *= ratio;
    this.cam.originMaxDist *= ratio;
    await this.loadPlayerModelGLB();
    this.playerCapsule.position.copy(savedPos);
    this.playerCapsule.quaternion.copy(savedQuat);
    if (wasFirstPerson) this.cam.setFirstPerson();
    this.setDebug(this.displayCollider);
  }
  // ==================== 碰撞体构建和查询 ====================
  // 获取包围盒
  getBbox(object) {
    const bbox = new THREE.Box3().setFromObject(object);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    bbox.getCenter(center);
    bbox.getSize(size);
    return { bbox, center, size };
  }
  // 补全必要属性
  ensureAttributesMinimal(geom) {
    if (!geom.attributes.position) return null;
    if (!geom.attributes.normal) geom.computeVertexNormals();
    if (!geom.attributes.uv) {
      const count = geom.attributes.position.count;
      geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    return geom;
  }
  // 统一属性格式
  unifiedAttribute(collected) {
    const attrMap = /* @__PURE__ */ new Map();
    const attrConflict = /* @__PURE__ */ new Set();
    const required = /* @__PURE__ */ new Set(["position", "normal", "uv"]);
    for (const g of collected)
      for (const name of Object.keys(g.attributes))
        if (!required.has(name)) g.deleteAttribute(name);
    for (const g of collected) {
      for (const name of Object.keys(g.attributes)) {
        const attr = g.attributes[name];
        const ctor = attr.array.constructor;
        if (!attrMap.has(name)) {
          attrMap.set(name, { itemSize: attr.itemSize, arrayCtor: ctor, examples: 1, normalized: attr.normalized });
        } else {
          const m = attrMap.get(name);
          if (m.itemSize !== attr.itemSize || m.arrayCtor !== ctor || m.normalized !== attr.normalized) attrConflict.add(name);
          else m.examples++;
        }
      }
    }
    for (const name of attrConflict) {
      for (const g of collected) if (g.attributes[name]) g.deleteAttribute(name);
      attrMap.delete(name);
    }
    for (const [name, meta] of attrMap) {
      for (const g of collected) {
        if (!g.attributes[name]) {
          const count = g.attributes.position.count;
          g.setAttribute(name, new THREE.BufferAttribute(new meta.arrayCtor(count * meta.itemSize), meta.itemSize, meta.normalized));
        }
      }
    }
    return collected;
  }
  // 构建静态碰撞体
  buildStaticCollider(sources) {
    this.collected = [];
    if (this.collider) {
      this.scene.remove(this.collider);
      this.collider = null;
    }
    const collectMesh = (mesh) => {
      try {
        let geom = mesh.geometry.clone();
        geom.applyMatrix4(mesh.matrixWorld);
        if (geom.index) geom = geom.toNonIndexed();
        const safe = this.ensureAttributesMinimal(geom);
        if (safe) this.collected.push(safe);
      } catch (e) {
        console.warn("\u5904\u7406\u7F51\u683C\u65F6\u51FA\u9519\uFF1A", mesh, e);
      }
    };
    if (sources) {
      const list = Array.isArray(sources) ? sources : [sources];
      for (const obj of list) {
        obj.updateMatrixWorld(true);
        obj.traverse((c) => {
          const a = c;
          if ((a.isMesh || a.isLineSegments) && a.geometry && c.name !== "capsule") collectMesh(a);
        });
      }
    } else {
      this.scene.traverse((c) => {
        const m = c;
        if (m?.isMesh && m.geometry && c.name !== "capsule") collectMesh(m);
      });
    }
    if (!this.collected.length) return;
    this.collected = this.unifiedAttribute(this.collected);
    const merged = BufferGeometryUtils.mergeGeometries(this.collected, false);
    if (!merged) {
      console.error("\u5408\u5E76\u51E0\u4F55\u5931\u8D25");
      return;
    }
    merged.boundsTree = new MeshBVH(merged, { maxDepth: 100 });
    this.collider = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ opacity: 0.5, transparent: true, wireframe: true, depthTest: true, side: THREE.DoubleSide }));
    this.collider.layers.enable(1);
    if (this.displayCollider) this.scene.add(this.collider);
    if (this.displayVisualizer) {
      if (this.visualizer) this.scene.remove(this.visualizer);
      this.visualizer = new MeshBVHHelper(this.collider, 10);
      this.scene.add(this.visualizer);
    }
  }
  // 注册动态碰撞体
  addDynamicCollider(source) {
    if (this.dynamicColliders.find((e) => e.source === source)) return;
    source.updateMatrixWorld(true);
    const collected = [];
    const invSource = new THREE.Matrix4().copy(source.matrixWorld).invert();
    source.traverse((c) => {
      const m = c;
      if (!m?.isMesh || !m.geometry || c.name === "capsule") return;
      try {
        let geom = m.geometry.clone();
        geom.applyMatrix4(new THREE.Matrix4().multiplyMatrices(invSource, m.matrixWorld));
        if (geom.index) geom = geom.toNonIndexed();
        const safe = this.ensureAttributesMinimal(geom);
        if (safe) collected.push(safe);
      } catch (e) {
        console.warn("\u5904\u7406\u52A8\u6001\u7F51\u683C\u51FA\u9519\uFF1A", m, e);
      }
    });
    if (!collected.length) return;
    const unified = this.unifiedAttribute(collected);
    const merged = BufferGeometryUtils.mergeGeometries(unified, false);
    if (!merged) {
      console.error("\u5408\u5E76\u52A8\u6001\u51E0\u4F55\u5931\u8D25");
      return;
    }
    merged.boundsTree = new MeshBVH(merged);
    const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ opacity: 0.5, transparent: true, wireframe: true, depthTest: true, side: THREE.DoubleSide }));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(source.matrixWorld);
    mesh.updateMatrixWorld(true);
    this.dynamicColliders.push({ source, mesh, prevWorldMatrix: new THREE.Matrix4().copy(source.matrixWorld), deltaPos: new THREE.Vector3(), deltaRotY: 0 });
    if (this.displayCollider) this.scene.add(mesh);
  }
  // 注销动态碰撞体
  removeDynamicCollider(source) {
    const idx = this.dynamicColliders.findIndex((e) => e.source === source);
    if (idx === -1) return;
    const entry = this.dynamicColliders[idx];
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.dispose();
    if (this.activeDynamicCollider === entry) this.activeDynamicCollider = null;
    this.dynamicColliders.splice(idx, 1);
  }
  // 清除所有动态碰撞体
  clearDynamicColliders() {
    for (const entry of this.dynamicColliders) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
    }
    this.dynamicColliders = [];
    this.activeDynamicCollider = null;
  }
  // 更新动态碰撞体
  updateDynamicColliders() {
    if (!this.playerCapsule) return;
    const playerWorldPos = this.playerCapsule.position.clone();
    for (const entry of this.dynamicColliders) {
      const prevInv = new THREE.Matrix4().copy(entry.prevWorldMatrix).invert();
      const playerInLocal = playerWorldPos.clone().applyMatrix4(prevInv);
      entry.source.updateMatrixWorld(true);
      entry.mesh.matrix.copy(entry.source.matrixWorld);
      entry.mesh.updateMatrixWorld(true);
      const playerInNewWorld = playerInLocal.clone().applyMatrix4(entry.source.matrixWorld);
      entry.deltaPos.subVectors(playerInNewWorld, playerWorldPos);
      const prevEuler = new THREE.Euler().setFromRotationMatrix(entry.prevWorldMatrix, "YXZ");
      const curEuler = new THREE.Euler().setFromRotationMatrix(entry.source.matrixWorld, "YXZ");
      entry.deltaRotY = curEuler.y - prevEuler.y;
      entry.prevWorldMatrix.copy(entry.source.matrixWorld);
    }
  }
  // ==================== 主循环 ====================
  // 主循环
  async update(delta = clock.getDelta()) {
    if (!this.isupdate || !this.playerCapsule || !this.collider) return;
    delta = Math.min(delta, 1 / 40) * this.timeScale;
    this.currentDelta = delta;
    if (this.controllerMode === 1) {
      // 载具模式已移除
    } else {
      this.updatePlayer(delta);
    }
  }
  // 玩家帧更新
  updatePlayer(delta) {
    this.updateDynamicColliders();
    this.camera.getWorldDirection(this.camDir);
    const angle = 2 * Math.PI - (Math.atan2(this.camDir.z, this.camDir.x) + Math.PI / 2);
    const moveAxes = this.input.getMoveAxes();
    this.moveDir.copy(this.DIR_RGT).multiplyScalar(moveAxes.x).addScaledVector(this.DIR_FWD, moveAxes.y);
    if (this.isFlying) {
      if (this.input.fwd || moveAxes.isAnalog) this.moveDir.copy(this.camDir);
      if (this.input.space) this.moveDir.y += 1;
      this.curPlayerSpeed = this.input.shift ? this.playerFlySpeed * 2 : this.playerFlySpeed;
    } else {
      this.curPlayerSpeed = this.input.shift ? this.playerSpeed * 3 : this.playerSpeed;
    }
    this.moveDir.normalize();
    if (!this.isFlying || !moveAxes.isAnalog && !this.input.fwd) this.moveDir.applyAxisAngle(this.upVector, angle);
    const accelStep = this.playerAcceleration * this.decelBase * delta;
    const decelStep = this.playerDeceleration * this.decelBase * delta;
    const targetX = this.moveDir.x * this.curPlayerSpeed;
    const targetZ = this.moveDir.z * this.curPlayerSpeed;
    const diffX = targetX - this.playerVelocity.x;
    const diffZ = targetZ - this.playerVelocity.z;
    const hasXZInput = this.moveDir.x !== 0 || this.moveDir.z !== 0;
    const xzDiffLen = Math.hypot(diffX, diffZ);
    if (xzDiffLen > 0) {
      const xzApplied = Math.min(xzDiffLen, hasXZInput ? accelStep : decelStep);
      this.playerVelocity.x += diffX / xzDiffLen * xzApplied;
      this.playerVelocity.z += diffZ / xzDiffLen * xzApplied;
    }
    if (this.isFlying) {
      const targetY = this.moveDir.y * this.curPlayerSpeed;
      const diffY = targetY - this.playerVelocity.y;
      this.playerVelocity.y += Math.sign(diffY) * Math.min(Math.abs(diffY), this.moveDir.y !== 0 ? accelStep : decelStep);
    }
    this.groundRaycaster.ray.origin.copy(this.playerCapsule.position);
    const staticHits = this.groundRaycaster.intersectObject(this.collider, false);
    let bestHit = staticHits[0];
    let hitEntry = null;
    for (const entry of this.dynamicColliders) {
      const dynHits = this.groundRaycaster.intersectObject(entry.mesh, false);
      if (dynHits.length > 0 && (!bestHit || dynHits[0].point.y > bestHit.point.y)) {
        bestHit = dynHits[0];
        hitEntry = entry;
      }
    }
    this.activeDynamicCollider = hitEntry;
    if (!this.isFlying) {
      if (bestHit) {
        const snapY = bestHit.point.y + this.snapH;
        const dist = this.playerCapsule.position.y - bestHit.point.y;
        if (dist > this.maxH) {
          this.applyGravity(delta);
        } else if (this.playerVelocity.y <= 0) {
          if (this.playerIsOnGround) {
            this.snapToGround(snapY, this.isFlatFloor(bestHit), delta);
          } else {
            const predictedY = this.playerCapsule.position.y + this.playerVelocity.y * delta;
            if (predictedY <= snapY) {
              this.snapToGround(snapY);
            } else {
              this.applyGravity(delta);
            }
          }
        }
      } else {
        this.applyGravity(delta);
      }
      this.playerCapsule.position.y += this.playerVelocity.y * delta;
    }
    const capsuleInfo = this.playerCapsule.capsuleInfo;
    const xzSpeed = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    const totalDist = this.isFlying ? this.playerVelocity.length() * delta : xzSpeed * delta;
    this.xzDir.set(this.playerVelocity.x, this.isFlying ? this.playerVelocity.y : 0, this.playerVelocity.z).normalize();
    const maxStep = capsuleInfo.radius * 0.8;
    const steps = Math.ceil(totalDist / maxStep) || 1;
    const stepDist = totalDist / steps;
    for (let i = 0; i < steps; i++) {
      this.playerCapsule.position.addScaledVector(this.xzDir, stepDist);
      this.playerCapsule.updateMatrixWorld();
      if (!this.skipCapsuleCollision) {
        applyCapsuleCollision(
          this.playerCapsule,
          capsuleInfo,
          this.collider,
          this.staticTemps
        );
        for (const dynEntry of this.dynamicColliders) {
          this.playerCapsule.updateMatrixWorld();
          applyCapsuleCollision(
            this.playerCapsule,
            capsuleInfo,
            dynEntry.mesh,
            this.dynTemps
          );
        }
      }
    }
    if (this.activeDynamicCollider && this.playerIsOnGround && !this.isFlying) {
      this.playerCapsule.position.add(this.activeDynamicCollider.deltaPos);
      if (this.activeDynamicCollider.deltaRotY !== 0) {
        this.playerCapsule.rotateY(this.activeDynamicCollider.deltaRotY);
      }
    }
    if (!this.isFirstPerson) {
      const camDirFlat = this.camDir.clone().setY(0).normalize().negate();
      const moveDirFlat = this.moveDir.clone().normalize().negate();
      if (!this.isFlying) {
        if (this.cam.mouseMode === 4 || this.cam.mouseMode === 5) {
          this.targetMat.lookAt(this.playerCapsule.position, this.playerCapsule.position.clone().add(camDirFlat), this.playerCapsule.up);
          this.playerCapsule.quaternion.copy(this.targetQuat.setFromRotationMatrix(this.targetMat));
        } else if (this.cam.mouseMode === 0 || this.cam.mouseMode === 2) {
          const lookTarget = this.playerCapsule.position.clone().add(moveDirFlat.lengthSq() > 0 ? moveDirFlat : camDirFlat);
          this.targetMat.lookAt(this.playerCapsule.position, lookTarget, this.playerCapsule.up);
          this.playerCapsule.quaternion.slerp(this.targetQuat.setFromRotationMatrix(this.targetMat), Math.min(1, this.rotationSpeed * delta));
        } else if (moveDirFlat.lengthSq() > 0) {
          this.targetMat.lookAt(this.playerCapsule.position, this.playerCapsule.position.clone().add(moveDirFlat), this.playerCapsule.up);
          this.playerCapsule.quaternion.slerp(this.targetQuat.setFromRotationMatrix(this.targetMat), Math.min(1, this.rotationSpeed * delta));
        }
      } else {
        const lookTarget = this.playerCapsule.position.clone().add(this.input.fwd ? moveDirFlat : camDirFlat);
        this.targetMat.lookAt(this.playerCapsule.position, lookTarget, this.playerCapsule.up);
        this.playerCapsule.quaternion.slerp(this.targetQuat.setFromRotationMatrix(this.targetMat), Math.min(1, this.rotationSpeed * delta));
      }
    }
    if (!this.isFirstPerson) {
      const lookTarget = this.cam.springTarget(this.cam.getLookAtPoint(), delta);
      this.camera.position.sub(this.controls.target);
      this.camera.position.add(lookTarget);
      this.controls.target.copy(lookTarget);
      this.controls.update();
      if (!this.cam.zoomEnabled) {
        this.cam.updateWithRaycast(
          this.controls.target
        );
      }
    }
    this.animation.setAnimationByPressed();
    this.animation.updateMixers(delta);
  }
  // ==================== 内部辅助 ====================
  // 同步 debug 可见性
  syncDebugVisibility() {
    if (!this.playerCapsule) return;
    const dbg = this.displayCollider;
    const isVehicle = this.controllerMode === 1;
    if (this.collider) {
      if (dbg) {
        if (!this.scene.children.includes(this.collider)) this.scene.add(this.collider);
      } else this.scene.remove(this.collider);
    }
    this.playerCapsule.material.visible = dbg && !isVehicle;
    for (const entry of this.dynamicColliders) {
      if (dbg && !isVehicle) {
        if (!this.scene.children.includes(entry.mesh)) this.scene.add(entry.mesh);
      } else this.scene.remove(entry.mesh);
    }
  }
  // 设置落地状态
  setOnGround(val) {
    if (this.playerIsOnGround === val) return;
    this.playerIsOnGround = val;
    this.onGroundChange?.(val);
    if (val) this.animation.onLand();
    else this.animation.onBecomeAirborne();
  }
  // 应用重力
  applyGravity(delta) {
    this.playerVelocity.y += delta * this.gravity;
    this.setOnGround(false);
  }
  // 判断脚下地面是否为水平台面（法线接近竖直）
  isFlatFloor(hit) {
    const n = hit.face?.normal;
    if (!n) return true;
    return n.y >= this.minFloorNormalY;
  }
  // 吸附到地面
  snapToGround(groundY, smooth = false, delta = 0) {
    this.playerVelocity.y = 0;
    const dy = groundY - this.playerCapsule.position.y;
    if (smooth && Math.abs(dy) <= this.rideHeight * this.playerModelConfig.scale) {
      this.playerCapsule.position.y += dy * Math.min(1, this.stepSmoothFactor * delta);
    } else {
      this.playerCapsule.position.y = groundY;
    }
    this.setOnGround(true);
  }
  // 重算站立 / 落地阈值（snapH / maxH）。仅在胶囊创建、缩放后调用。
  recomputeGroundThresholds() {
    const info = this.playerCapsule?.capsuleInfo;
    if (!info) return;
    const rideHeightScaled = this.rideHeight * this.playerModelConfig.scale;
    this.snapH = -info.segment.end.y + info.radius + rideHeightScaled;
    this.maxH = this.snapH + rideHeightScaled;
  }
  // 动态修改缩放
  setPlayerScale(newScale) {
    if (newScale <= 0) return;
    const ratio = newScale / this.playerModelConfig.scale;
    this.playerModelConfig.scale = newScale;
    this.gravity *= ratio;
    this.jumpHeight *= ratio;
    this.playerSpeed *= ratio;
    this.playerFlySpeed *= ratio;
    this.curPlayerSpeed *= ratio;
    this.cam.epsilon *= ratio;
    this.cam.minDist *= ratio;
    this.controls.minDistance *= ratio;
    this.cam.maxDist *= ratio;
    this.cam.originMaxDist *= ratio;
    if (this.isFirstPerson) this.scene.attach(this.camera);
    this.playerCapsule?.scale.multiplyScalar(ratio);
    if (this.playerCapsule?.capsuleInfo) {
      this.playerCapsule.capsuleInfo.radius *= ratio;
      this.playerCapsule.capsuleInfo.segment.end.y *= ratio;
      this.recomputeGroundThresholds();
    }
    if (this.isFirstPerson) this.cam.setFirstPerson();
  }
  // 重置玩家位置
  reset(position) {
    if (!this.playerCapsule) return;
    this.playerVelocity.set(0, 0, 0);
    this.playerCapsule.position.copy(position ?? this.initPos);
  }
  // ==================== API ====================
  // 获取当前位置
  getPosition() {
    return this.playerCapsule?.position;
  }
  // 获取速度
  getVelocity() {
    return this.playerVelocity.clone();
  }
  // 获取第一人称状态
  getIsFirstPerson() {
    return this.isFirstPerson;
  }
  // 获取飞行状态
  getIsFlying() {
    return this.isFlying;
  }
  // 获取落地状态
  getIsOnGround() {
    return this.playerIsOnGround;
  }
  // 获取本帧实际使用的 delta（已钳制 + timeScale）
  getCurrentDelta() {
    return this.currentDelta;
  }
  // 获取控制器模式
  getControllerMode() {
    return this.controllerMode;
  }
  // 获取玩家模型
  getPlayerModel() {
    return this.playerModel;
  }
  // 获取胶囊体
  getPlayerCapsule() {
    return this.playerCapsule;
  }
  // 获取碰撞体
  getCollider() {
    return this.collider;
  }
  // 获取当前站立的动态碰撞体
  getActiveDynamicCollider() {
    return this.activeDynamicCollider;
  }
  // 设置鼠标灵敏度
  setMouseSensitivity(value) {
    this.cam.sensitivity = value;
    this.controls.rotateSpeed = value * 0.05;
  }
  // --- 玩家参数 ---
  // 设置重力
  setGravity(gravity) {
    this.gravity = gravity * this.playerModelConfig.scale;
  }
  // 设置跳跃高度
  setJumpHeight(jumpHeight) {
    this.jumpHeight = jumpHeight * this.playerModelConfig.scale;
  }
  // 设置行走速度
  setPlayerSpeed(speed) {
    this.playerSpeed = speed * this.playerModelConfig.scale;
    this.curPlayerSpeed = this.playerSpeed;
  }
  // 设置飞行速度
  setPlayerFlySpeed(flySpeed) {
    this.playerFlySpeed = flySpeed * this.playerModelConfig.scale;
  }
  // 设置朝向开关
  setEnableToward(v) {
    this.enableToward = v;
  }
  // --- 相机参数 ---
  // 设置相机最近距
  setMinCamDistance(dist) {
    this.cam.minDist = dist * this.playerModelConfig.scale;
  }
  // 设置相机最远距
  setMaxCamDistance(dist) {
    this.cam.maxDist = dist * this.playerModelConfig.scale;
    this.cam.originMaxDist = this.cam.maxDist;
  }
  // 设置相机看向点高度比例
  setCamLookAtHeightRatio(ratio) {
    this.cam.lookAtHeightRatio = ratio;
  }
  // 设置鼠标模式
  setThirdMouseMode(mode) {
    this.cam.mouseMode = mode;
    this.cam.setPointerLock();
  }
  // 设置缩放开关
  setEnableZoom(enable) {
    this.cam.zoomEnabled = enable;
    this.controls.enableZoom = enable;
  }
  // --- 调试 ---
  // 切换调试显示
  setDebug(debug) {
    this.displayCollider = debug;
    this.syncDebugVisibility();
  }
  // 临时跳过玩家胶囊碰撞检测
  setSkipCapsuleCollision(skip) {
    this.skipCapsuleCollision = skip;
  }
  // --- 动画 ---
  // 按名播放动画
  playPlayerAnimationByName(name, fade) {
    this.animation.playByName(name, fade);
  }
  // 注册自定义动画
  registerAnimation(key, clipName, opts) {
    this.animation.register(key, clipName, opts);
  }
  // 播放已注册动画
  playAnimation(key, opts) {
    this.animation.play(key, opts);
  }
  // 注册移动动作组
  registerLocomotionSet(setName, map) {
    this.animation.registerLocomotionSet(setName, map);
  }
  // 切换移动动作组
  switchLocomotionSet(setName, fade) {
    this.animation.switchLocomotionSet(setName, fade);
  }
  // 获取当前动画名
  getCurrentPlayerAnimationName() {
    return this.animation.getCurrentName();
  }
  // 获取当前移动动作组名
  getCurrentLocomotionSet() {
    return this.animation.currentLocomotionSet;
  }
  // --- 相机 ---
  // 切换视角模式
  changeView() {
    this.cam.changeView();
  }
  // 设置第一人称
  setFirstPersonCamera(v = 0) {
    this.cam.setFirstPerson(v);
  }
  // 设置越肩视角
  setOverShoulderView(v) {
    this.cam.setOverShoulder(v);
    this.enableOverShoulderView = v;
  }
  // 屏幕中心检测
  getCenterScreenRaycastHit() {
    return this.cam.getCenterHit();
  }
  // --- 输入 ---
  // 设置输入状态
  setInput(input) {
    this.input.setInput(input);
  }
  // 运行时自定义键位
  setKeyMap(map) {
    this.input.buildKeyMap(map);
  }
  // 绑定输入事件
  onAllEvent() {
    this.input.bindEvents();
  }
  // 解绑输入事件
  offAllEvent() {
    this.input.unbindEvents();
  }
  // --- 销毁 ---
  destroy() {
    this.input.unbindEvents();
    if (this.playerCapsule) {
      this.playerCapsule.remove(this.camera);
      this.scene.remove(this.playerCapsule);
    }
    this.playerCapsule = null;
    if (this.playerModel) {
      this.scene.remove(this.playerModel);
      this.playerModel = null;
    }
    this.cam.resetControls();
    if (this.visualizer) {
      this.scene.remove(this.visualizer);
      this.visualizer = null;
    }
    if (this.collider) {
      this.scene.remove(this.collider);
      this.collider = null;
    }
    this.clearDynamicColliders();
  }
}
export {
  playerController
};
