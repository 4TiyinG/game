var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const defaultKeyMap = {
  forward: ["KeyW", "ArrowUp"],
  backward: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  sprint: ["ShiftLeft", "ShiftRight"],
  jump: ["Space"],
  toggleView: ["KeyV"],
  toggleFly: ["KeyF"],
  toggleVehicle: ["KeyE"]
};
class InputSystem {
  // 键码 -> 动作 反查表
  constructor(ctrl) {
    __publicField(this, "ctrl");
    // 主控制器引用
    __publicField(this, "fwd", false);
    // 前进键
    __publicField(this, "bkd", false);
    // 后退键
    __publicField(this, "lft", false);
    // 左移键
    __publicField(this, "rgt", false);
    // 右移键
    __publicField(this, "space", false);
    // 跳跃键
    __publicField(this, "shift", false);
    // 加速键
    __publicField(this, "keyFwd", false);
    __publicField(this, "keyBkd", false);
    __publicField(this, "keyLft", false);
    __publicField(this, "keyRgt", false);
    __publicField(this, "analogMoveX", 0);
    __publicField(this, "analogMoveY", 0);
    __publicField(this, "boundKeydown", async (e) => this.onKeydown(e));
    // 键盘按下绑定
    __publicField(this, "boundKeyup", (e) => this.onKeyup(e));
    // 键盘抬起绑定
    __publicField(this, "boundMouseMove", (e) => this.onMouseMove(e));
    // 鼠标移动绑定
    __publicField(this, "boundMouseClick", (e) => {
      if (e.target === this.ctrl.controls.domElement) this.ctrl.cam.setPointerLock();
    });
    __publicField(this, "boundBlur", () => this.resetKeys());
    // 页面失焦时重置按键状态
    __publicField(this, "codeToAction", /* @__PURE__ */ new Map());
    this.ctrl = ctrl;
    this.buildKeyMap();
  }
  // 构建键码：动作 反查表：未传的动作用默认键，传 string/数组则覆盖，传 null 则禁用
  buildKeyMap(userMap) {
    this.codeToAction.clear();
    for (const action of Object.keys(defaultKeyMap)) {
      let codes;
      if (userMap && action in userMap) {
        const v = userMap[action];
        if (v == null) continue;
        codes = Array.isArray(v) ? v : [v];
      } else {
        codes = defaultKeyMap[action];
      }
      for (const code of codes) this.codeToAction.set(code, action);
    }
  }
  // 程序化输入接口
  setInput(input) {
    const c = this.ctrl;
    const prevFwd = this.fwd;
    const prevBkd = this.bkd;
    const prevLft = this.lft;
    const prevRgt = this.rgt;
    let moveChanged = false;
    if (typeof input.moveX === "number") {
      this.analogMoveX = Math.max(-1, Math.min(1, input.moveX));
      moveChanged = true;
    }
    if (typeof input.moveY === "number") {
      this.analogMoveY = Math.max(-1, Math.min(1, input.moveY));
      moveChanged = true;
    }
    if (moveChanged) {
      this.syncDirectionFlags();
      if (prevFwd !== this.fwd || prevBkd !== this.bkd || prevLft !== this.lft || prevRgt !== this.rgt) {
        c.animation.setAnimationByPressed();
      }
    }
    if (typeof input.lookDeltaX === "number" && typeof input.lookDeltaY === "number") {
      c.cam.setToward(input.lookDeltaX, input.lookDeltaY, 2e-3);
    }
    if (typeof input.jump === "boolean") this.applyAction("jump", input.jump);
    if (typeof input.shift === "boolean") this.applyAction("sprint", input.shift);
    if (input.toggleView) this.applyAction("toggleView", true);
    if (input.toggleFly) this.applyAction("toggleFly", true);
  }
  // 绑定输入事件
  bindEvents() {
    this.ctrl.isupdate = true;
    this.ctrl.cam.setPointerLock();
    window.addEventListener("keydown", this.boundKeydown);
    window.addEventListener("keyup", this.boundKeyup);
    window.addEventListener("mousemove", this.boundMouseMove);
    window.addEventListener("click", this.boundMouseClick);
    window.addEventListener("blur", this.boundBlur);
  }
  // 解绑输入事件
  unbindEvents() {
    this.ctrl.isupdate = false;
    document.exitPointerLock();
    window.removeEventListener("keydown", this.boundKeydown);
    window.removeEventListener("keyup", this.boundKeyup);
    window.removeEventListener("mousemove", this.boundMouseMove);
    window.removeEventListener("click", this.boundMouseClick);
    window.removeEventListener("blur", this.boundBlur);
  }
  // 重置所有按键状态
  resetKeys() {
    const c = this.ctrl;
    this.keyFwd = false;
    this.keyBkd = false;
    this.keyLft = false;
    this.keyRgt = false;
    this.analogMoveX = 0;
    this.analogMoveY = 0;
    this.syncDirectionFlags();
    this.space = false;
    this.shift = false;
    c.controls.mouseButtons = { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
    c.animation.setAnimationByPressed();
  }
  // 统一动作派发
  applyAction(action, pressed) {
    const c = this.ctrl;
    switch (action) {
      // 前进
      case "forward":
        this.keyFwd = pressed;
        this.syncDirectionFlags();
        c.animation.setAnimationByPressed();
        break;
      // 后退
      case "backward":
        this.keyBkd = pressed;
        this.syncDirectionFlags();
        c.animation.setAnimationByPressed();
        break;
      // 左移
      case "left":
        this.keyLft = pressed;
        this.syncDirectionFlags();
        c.animation.setAnimationByPressed();
        break;
      // 右移
      case "right":
        this.keyRgt = pressed;
        this.syncDirectionFlags();
        c.animation.setAnimationByPressed();
        break;
      // 冲刺
      case "sprint":
        this.shift = pressed;
        c.animation.setAnimationByPressed();
        c.controls.mouseButtons = pressed ? { LEFT: 2, MIDDLE: 1, RIGHT: 0 } : { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
        break;
      // 跳跃
      case "jump":
        if (pressed) {
          this.space = true;
          if (c.controllerMode === 1) return;
          if (c.isFlying) {
            c.animation.setAnimationByPressed();
            return;
          }
          if (!c.playerIsOnGround) return;
          if (c.animation.isJumping()) return;
          c.animation.startJump();
          c.playerVelocity.y = c.jumpHeight;
          c.setOnGround(false);
        } else {
          this.space = false;
          if (c.isFlying) c.animation.setAnimationByPressed();
        }
        break;
      // 切换第一 / 第三人称视角
      case "toggleView":
        if (pressed) c.cam.changeView();
        break;
      // 切换飞行模式
      case "toggleFly":
        if (pressed && c.controllerMode === 0) {
          c.isFlying = !c.isFlying;
          if (c.isFlying) c.playerVelocity.set(0, 0, 0);
          c.animation.setAnimationByPressed();
          if (!c.isFlying && !c.playerIsOnGround) c.animation.startJump(true);
        }
        break;
    }
  }
  // 获取最终移动轴：模拟输入优先，否则使用键盘八方向
  getMoveAxes() {
    const hasAnalogInput = this.analogMoveX !== 0 || this.analogMoveY !== 0;
    if (hasAnalogInput) return { x: this.analogMoveX, y: this.analogMoveY, isAnalog: true };
    return {
      x: Number(this.keyRgt) - Number(this.keyLft),
      y: Number(this.keyFwd) - Number(this.keyBkd),
      isAnalog: false
    };
  }
  // 合并键盘与模拟输入，供动画和车辆等现有布尔逻辑使用
  syncDirectionFlags() {
    const threshold = 0.2;
    this.fwd = this.keyFwd || this.analogMoveY > threshold;
    this.bkd = this.keyBkd || this.analogMoveY < -threshold;
    this.lft = this.keyLft || this.analogMoveX < -threshold;
    this.rgt = this.keyRgt || this.analogMoveX > threshold;
  }
  // 键盘按下处理
  onKeydown(e) {
    const action = this.codeToAction.get(e.code);
    if (action) this.applyAction(action, true);
  }
  // 键盘抬起处理
  onKeyup(e) {
    const action = this.codeToAction.get(e.code);
    if (action) this.applyAction(action, false);
  }
  // 鼠标移动处理
  onMouseMove(e) {
    if (document.pointerLockElement === document.body) {
      this.ctrl.cam.setToward(e.movementX, e.movementY, 1e-4);
    }
  }
}
export {
  InputSystem
};
