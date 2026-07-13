var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import * as THREE from "three";
class AnimationSystem {
  // 覆盖动画播放时的输入快照，用于检测打断
  constructor(ctrl) {
    __publicField(this, "ctrl");
    // 主控制器引用
    __publicField(this, "mixer");
    // 动画混合器
    __publicField(this, "mixerCb");
    // 完成事件回调
    __publicField(this, "actions");
    // 动作映射表
    __publicField(this, "state");
    // 当前播放状态
    __publicField(this, "sets", /* @__PURE__ */ new Map());
    // 动作集合组
    __publicField(this, "currentLocomotionSet", null);
    // 当前激活的动作集合名
    __publicField(this, "recheckTimer", null);
    // 延迟重检定时器
    __publicField(this, "clips", []);
    // 原始动画片段
    __publicField(this, "hasThreePartJump", false);
    // 是否使用三段跳跃动画
    __publicField(this, "isOverrideAnimationPlaying", false);
    // 动画锁，用于防止覆盖型动画被移动动画打断
    __publicField(this, "overrideInputSnapshot", null);
    this.ctrl = ctrl;
  }
  // 按名切换动画
  playByName(name, fade = 0.18) {
    if (!this.actions) return;
    const next = this.actions.get(name);
    if (!next || this.state === next) return;
    const prev = this.state;
    next.reset();
    next.setEffectiveWeight(1);
    next.play();
    if (prev && prev !== next) {
      prev.fadeOut(fade);
      next.fadeIn(fade);
    } else next.fadeIn(fade);
    this.state = next;
    this.ctrl.onAnimationChange?.(name, next);
  }
  // 注册自定义动画
  register(key, clipName, opts) {
    if (!this.mixer || !this.actions) return;
    const clip = this.clips.find((c) => c.name === clipName);
    if (!clip) {
      console.warn(`\u627E\u4E0D\u5230 "${clipName}" \u52A8\u753B`);
      return;
    }
    const action = this.mixer.clipAction(clip);
    const timeScale = opts?.duration ? clip.duration / opts.duration : opts?.timeScale ?? 1;
    action.setLoop(opts?.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = opts?.clampWhenFinished ?? false;
    action.setEffectiveTimeScale(timeScale);
    action.enabled = true;
    action.setEffectiveWeight(0);
    this.actions.set(key, action);
    if (opts?.onFinished) {
      this.mixer.addEventListener("finished", (ev) => {
        if (ev.action === action) opts.onFinished();
      });
    }
  }
  // 注册移动动作组
  registerLocomotionSet(setName, map) {
    if (!this.mixer) return;
    const set = /* @__PURE__ */ new Map();
    for (const [key, clipName] of Object.entries(map)) {
      const clip = this.clips.find((c) => c.name === clipName);
      if (!clip) {
        console.warn(`registerLocomotionSet: \u627E\u4E0D\u5230 "${clipName}"`);
        continue;
      }
      const action = this.mixer.clipAction(clip);
      if (key === "jumping") {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.setEffectiveTimeScale(1.2);
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.setEffectiveTimeScale(1);
      }
      action.enabled = true;
      action.setEffectiveWeight(0);
      set.set(key, action);
    }
    this.sets.set(setName, set);
  }
  // 切换移动动作组
  switchLocomotionSet(setName, fade = 0.18) {
    if (!this.actions) return;
    const set = this.sets.get(setName);
    if (!set) {
      console.warn(`switchLocomotionSet: \u672A\u627E\u5230\u96C6\u5408 "${setName}"`);
      return;
    }
    this.currentLocomotionSet = setName;
    for (const [key, newAction] of set.entries()) {
      const oldAction = this.actions.get(key);
      if (oldAction === newAction) continue;
      if (oldAction) oldAction.fadeOut(fade);
      this.actions.set(key, newAction);
      if (this.state === oldAction) {
        newAction.reset();
        newAction.setEffectiveWeight(1);
        newAction.fadeIn(fade);
        newAction.play();
        this.state = newAction;
        this.ctrl.onAnimationChange?.(key, newAction);
      }
    }
  }
  // 播放已注册动画
  play(key, opts) {
    if (!this.actions) return;
    const action = this.actions.get(key);
    if (!action) {
      console.warn(`playAnimation: "${key}" \u672A\u6CE8\u518C`);
      return;
    }
    if (action.loop === THREE.LoopOnce) {
      this.isOverrideAnimationPlaying = true;
      this.overrideInputSnapshot = { ...this.ctrl.input };
      const onFinish = (e) => {
        if (e.action === action) {
          if (this.isOverrideAnimationPlaying && this.overrideInputSnapshot) {
            this.isOverrideAnimationPlaying = false;
            this.overrideInputSnapshot = null;
          }
          this.mixer.removeEventListener("finished", onFinish);
        }
      };
      this.mixer.addEventListener("finished", onFinish);
    }
    if (opts?.force) action.reset();
    const prevState = opts?.returnToPrev ? this.state : null;
    this.playByName(key, opts?.fade ?? 0.18);
    if (opts?.returnToPrev && prevState && this.mixer) {
      const action2 = this.actions.get(key);
      const fade = opts?.fade ?? 0.18;
      const handler = (ev) => {
        if (ev.action === action2 && this.state === action2) {
          this.mixer.removeEventListener("finished", handler);
          const cur = this.state;
          cur.stop();
          prevState.reset();
          prevState.setEffectiveWeight(1);
          prevState.play();
          this.state = prevState;
          this.ctrl.onAnimationChange?.(prevState.getClip().name, prevState);
        }
      };
      this.mixer.addEventListener("finished", handler);
    }
  }
  // 触发跳跃动画（统一入口）
  startJump(inAir = false) {
    if (this.hasThreePartJump) {
      this.playByName(inAir ? "jumpLoop" : "jumpStart");
    } else {
      this.playByName("jumping");
    }
  }
  // 离地时触发 jumpLoop（三段模式专用）
  onBecomeAirborne() {
    if (!this.hasThreePartJump) return;
    const s = this.state;
    const a = this.actions;
    if (s === a?.get("jumpStart") || s === a?.get("jumpLoop") || s === a?.get("jumpEnd")) return;
    this.playByName("jumpLoop");
  }
  // 落地时触发 jumpEnd（三段模式专用）
  onLand() {
    if (!this.hasThreePartJump) return;
    const s = this.state;
    const a = this.actions;
    if (s === a?.get("jumpStart") || s === a?.get("jumpLoop")) {
      this.playByName("jumpEnd");
    }
  }
  // 是否处于任意跳跃动画中（用于防止在跳跃动画播放时重复起跳）
  isJumping() {
    const s = this.state;
    const a = this.actions;
    if (!a) return false;
    return s === a.get("jumping") || s === a.get("jumpStart") || s === a.get("jumpLoop") || s === a.get("jumpEnd");
  }
  // 获取当前动画名
  getCurrentName() {
    return this.state?.getClip()?.name ?? null;
  }
  // 更新所有混合器
  updateMixers(delta) {
    this.mixer?.update(delta);
  }
  // 按键状态触发动画
  setAnimationByPressed() {
    if (this.isOverrideAnimationPlaying) {
      const currentInput = this.ctrl.input;
      const snapshot = this.overrideInputSnapshot;
      let inputChanged = false;
      if (snapshot) {
        for (const key in snapshot) {
          if (snapshot[key] !== currentInput[key]) {
            inputChanged = true;
            break;
          }
        }
      }
      if (inputChanged) {
        this.isOverrideAnimationPlaying = false;
        this.overrideInputSnapshot = null;
      } else {
        return;
      }
    }
    this.ctrl.cam.maxDist = this.ctrl.cam.originMaxDist;
    const { fwd, bkd, lft, rgt, shift, space } = this.ctrl.input;
    if (this.ctrl.isFlying) {
      if (fwd) {
        if (shift) {
          this.playByName("flying");
          if (!this.ctrl.cam.enableSpringCamera) this.ctrl.cam.maxDist = this.ctrl.cam.originMaxDist * 2;
        } else {
          this.playByName("flyHoverForward");
        }
        return;
      }
      if (bkd) {
        this.playByName("flyHoverBack");
        return;
      }
      if (lft) {
        this.playByName("flyHoverLeft");
        return;
      }
      if (rgt) {
        this.playByName("flyHoverRight");
        return;
      }
      if (space) {
        this.playByName("flyHoverUp");
        return;
      }
      this.playByName("flyidle");
      return;
    }
    if (this.ctrl.playerIsOnGround) {
      if (this.hasThreePartJump && this.state === this.actions?.get("jumpEnd")) return;
      if (!fwd && !bkd && !lft && !rgt) {
        this.playByName("idle");
        return;
      }
      if (fwd) {
        this.playByName(shift ? "running" : "walking");
        return;
      }
      if (!this.ctrl.isFirstPerson && (lft || rgt || bkd)) {
        this.playByName(shift ? "running" : "walking");
        return;
      }
      if (lft) {
        this.playByName("left_walking");
        return;
      }
      if (rgt) {
        this.playByName("right_walking");
        return;
      }
      if (bkd) {
        this.playByName("walking_backward");
        return;
      }
    }
  }
}
export {
  AnimationSystem
};
