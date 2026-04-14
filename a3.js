// VUEUI管理（移动端优化版）
window.GameUI = (function() {
    // 基础样式（无 backdrop-filter，使用纯色半透明背景）
    const compactStyles = `
        #customize-panel {
            padding: 3px 6px;
            width: 170px;
            font-size: 10px;
            max-height: 85vh;
            overflow-y: auto;
            box-sizing: border-box;
            background: rgba(0, 0, 0, 0.65);  /* 纯色半透明，无模糊 */
            border-radius: 12px;
            color: #e0e0e0;
            transform: translateZ(0);
            backface-visibility: hidden;
            will-change: transform;
            contain: layout style paint;
            border: 1px solid rgba(255, 255, 255, 0.15);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }
        /* 性能模式下进一步降低背景透明度（减少 overdraw） */
        body.performance-mode #customize-panel {
            background: rgba(0, 0, 0, 0.85);
            backdrop-filter: none !important;
        }
        #customize-panel::-webkit-scrollbar { width: 3px; }
        #customize-panel::-webkit-scrollbar-track { background: rgba(255,255,255,0.1); }
        #customize-panel::-webkit-scrollbar-thumb { background: #ff9900; border-radius: 2px; }
        #customize-panel h3 {
            font-size: 10px;
            margin: 0 0 2px 0;
            text-align: center;
            color: #ff9900;
            font-weight: 500;
            letter-spacing: 1px;
        }
        #customize-panel .section h4 {
            font-size: 9px;
            margin: 0 0 1px 0;
            border-left: 2px solid #ff9900;
            padding-left: 4px;
            color: #ff9900;
            font-weight: normal;
        }
        #customize-panel .slider-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
        }
        #customize-panel .slider-row label {
            width: 20px;
            font-size: 9px;
            font-weight: bold;
            color: #ddd;
        }
        #customize-panel .slider-row input {
            width: 100px;
            height: 3px;
            margin: 0 4px;
            cursor: pointer;
            background: #2a2f36;
            border-radius: 2px;
        }
        #customize-panel .slider-row input:focus { outline: none; }
        #customize-panel .slider-row span {
            width: 28px;
            font-size: 9px;
            text-align: right;
            font-family: monospace;
            color: #ff9900;
        }
        #customize-panel .reset-btn {
            padding: 2px 0;
            font-size: 9px;
            margin-top: 4px;
            width: 100%;
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,153,0,0.5);
            border-radius: 6px;
            color: #ff9900;
            cursor: pointer;
            transition: all 0.1s ease;
        }
        #customize-panel .reset-btn:hover {
            background: #ff9900;
            color: #1a1f26;
        }
        @media (orientation: landscape) and (max-height: 480px) {
            #customize-panel h3 { display: none; }
            #customize-panel { padding: 2px 4px; max-height: 80vh; }
            #customize-panel .slider-row { margin-bottom: 8px; }
            #customize-panel .section h4 { margin: 0 0 0px 0; font-size: 8px; }
            #customize-panel .reset-btn { margin-top: 2px; padding: 1px 0; }
        }
        @media (orientation: landscape) and (max-height: 360px) {
            #customize-panel .slider-row input { width: 85px; }
            #customize-panel .slider-row { margin-bottom: 6px; }
        }
    `;

    const template = `
        <div id="vue-ui">
            <div id="customize-panel" :class="{ hidden: !customizePanelVisible }">
                <h3>武器位置自定义</h3>
                <div class="section">
                    <div class="slider-row">
                        <label>X</label>
                        <input type="range" min="-5" max="5" step="0.01" v-model.number="weaponPos.x">
                        <span>{{ weaponPos.x.toFixed(2) }}</span>
                    </div>
                    <div class="slider-row">
                        <label>Y</label>
                        <input type="range" min="-5" max="5" step="0.01" v-model.number="weaponPos.y">
                        <span>{{ weaponPos.y.toFixed(2) }}</span>
                    </div>
                    <div class="slider-row">
                        <label>Z</label>
                        <input type="range" min="-5" max="5" step="0.01" v-model.number="weaponPos.z">
                        <span>{{ weaponPos.z.toFixed(2) }}</span>
                    </div>
                </div>
                <div class="section">
                    <div class="slider-row">
                        <label>X</label>
                        <input type="range" min="-180" max="180" step="1" v-model.number="weaponRotDeg.x">
                        <span>{{ weaponRotDeg.x }}°</span>
                    </div>
                    <div class="slider-row">
                        <label>Y</label>
                        <input type="range" min="-180" max="180" step="1" v-model.number="weaponRotDeg.y">
                        <span>{{ weaponRotDeg.y }}°</span>
                    </div>
                    <div class="slider-row">
                        <label>Z</label>
                        <input type="range" min="-180" max="180" step="1" v-model.number="weaponRotDeg.z">
                        <span>{{ weaponRotDeg.z }}°</span>
                    </div>
                </div>
                <div class="section">
                    <div class="slider-row">
                        <label>X</label>
                        <input type="range" min="0.2" max="1.5" step="0.01" v-model.number="weaponScale.x">
                        <span>{{ weaponScale.x.toFixed(2) }}</span>
                    </div>
                    <div class="slider-row">
                        <label>Y</label>
                        <input type="range" min="0.2" max="1.5" step="0.01" v-model.number="weaponScale.y">
                        <span>{{ weaponScale.y.toFixed(2) }}</span>
                    </div>
                    <div class="slider-row">
                        <label>Z</label>
                        <input type="range" min="0.2" max="1.5" step="0.01" v-model.number="weaponScale.z">
                        <span>{{ weaponScale.z.toFixed(2) }}</span>
                    </div>
                </div>
                <div class="divider"></div>
                <div class="section">
                    <h4>相机高度</h4>
                    <div class="slider-row">
                        <label>H</label>
                        <input type="range" min="0.8" max="2.2" step="0.02" v-model.number="cameraHeight">
                        <span>{{ cameraHeight.toFixed(2) }}m</span>
                    </div>
                </div>
                <div class="section">
                    <h4>视角灵敏度</h4>
                    <div class="slider-row">
                        <label>S</label>
                        <input type="range" min="0.5" max="2.0" step="0.02" v-model.number="sensitivity">
                        <span>{{ sensitivity.toFixed(2) }}x</span>
                    </div>
                </div>
                <button class="reset-btn" @click="resetToDefault">重置默认</button>
            </div>
        </div>
    `;

    function injectStyles() {
        const styleEl = document.createElement('style');
        styleEl.textContent = compactStyles;
        document.head.appendChild(styleEl);
    }

    return {
        template,
        injectStyles
    };
})();