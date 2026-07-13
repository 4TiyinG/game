let staticData = null;

self.onmessage = function(e) {
    const data = e.data;
    
    // === 1. 初始碰撞体构建 (世界矩阵转换) ===
    if (data.type === 'build') {
        if (!data.localPositions || !data.worldMatrices || !data.vertexOffsets) {
            self.postMessage({ type: 'error', message: 'Build data missing' });
            return;
        }
        const localPositions = data.localPositions;
        const worldMatrices = data.worldMatrices;
        const vertexOffsets = data.vertexOffsets;
        const totalVerts = localPositions.length / 3;
        const output = new Float32Array(totalVerts * 3);
        for (let mIdx = 0; mIdx < vertexOffsets.length - 1; mIdx++) {
            const start = vertexOffsets[mIdx];
            const end = vertexOffsets[mIdx + 1];
            const matStart = mIdx * 16;
            const m = worldMatrices;
            const mx0 = m[matStart], mx1 = m[matStart+1], mx2 = m[matStart+2], mx3 = m[matStart+3];
            const my0 = m[matStart+4], my1 = m[matStart+5], my2 = m[matStart+6], my3 = m[matStart+7];
            const mz0 = m[matStart+8], mz1 = m[matStart+9], mz2 = m[matStart+10], mz3 = m[matStart+11];
            const mw0 = m[matStart+12], mw1 = m[matStart+13], mw2 = m[matStart+14], mw3 = m[matStart+15];
            for (let i = start; i < end; i++) {
                const i3 = i * 3;
                const vx = localPositions[i3];
                const vy = localPositions[i3 + 1];
                const vz = localPositions[i3 + 2];
                output[i3]     = vx * mx0 + vy * my0 + vz * mz0 + mw0;
                output[i3 + 1] = vx * mx1 + vy * my1 + vz * mz1 + mw1;
                output[i3 + 2] = vx * mx2 + vy * my2 + vz * mz2 + mw2;
            }
        }
        self.postMessage({ type: 'buildResult', vertices: output }, [output.buffer]);
        return;
    }

    // === 2. 静态缓存初始化 ===
    if (data.type === 'init') {
        if (!data.positions || !data.skinIndices || !data.vertexOffsets) {
            console.error('Worker Init failed: Missing essential skeletal data.');
            return;
        }
        staticData = {
            positions: new Float32Array(data.positions),
            skinIndices: new Uint16Array(data.skinIndices),
            skinWeights: new Float32Array(data.skinWeights),
            combinedIndices: data.combinedIndices ? new Uint32Array(data.combinedIndices) : null,
            meshCount: data.meshCount,
            vertexOffsets: new Uint32Array(data.vertexOffsets)
        };
        return;
    }

    // === 3. 极致动态骨骼变形计算 (四骨骼蒙皮) ===
    if (data.type === 'update') {
        if (!staticData || !data.boneMatrices || data.boneMatrices.length === 0) {
            self.postMessage({ type: 'result', vertices: new Float32Array(0) });
            return;
        }
        const boneMatrices = data.boneMatrices;
        const totalCount = staticData.positions.length / 3;
        // 【核心优化3】：直接分配结果数组，交由 JS 引擎高速内存管理，避免频繁上下文的交换污染
        const output = new Float32Array(totalCount * 3);
        const pos = staticData.positions;
        const skinIdx = staticData.skinIndices;
        const skinW = staticData.skinWeights;
        const m = boneMatrices;
        const offsets = staticData.vertexOffsets;
        let globalOffset = 0;

        for (let mIdx = 0; mIdx < staticData.meshCount; mIdx++) {
            const start = offsets[mIdx];
            const end = offsets[mIdx + 1];
            let i3 = start * 3; 
            for (let i = start; i < end; i++) {
                const vx = pos[i3];
                const vy = pos[i3 + 1];
                const vz = pos[i3 + 2];
                const idx = i * 4;
                let i0 = skinIdx[idx];
                let i1 = skinIdx[idx + 1];
                let i2 = skinIdx[idx + 2];
                let i3s = skinIdx[idx + 3];
                const w0 = skinW[idx];
                const w1 = skinW[idx + 1];
                const w2 = skinW[idx + 2];
                const w3 = skinW[idx + 3];
                if (i0 < 0) i0 = 0;
                if (i1 < 0) i1 = 0;
                if (i2 < 0) i2 = 0;
                if (i3s < 0) i3s = 0;
                const idx0 = i0 << 4;
                const idx1 = i1 << 4;
                const idx2 = i2 << 4;
                const idx3 = i3s << 4;
                let ax = (vx * m[idx0] + vy * m[idx0 + 4] + vz * m[idx0 + 8] + m[idx0 + 12]) * w0;
                let ay = (vx * m[idx0 + 1] + vy * m[idx0 + 5] + vz * m[idx0 + 9] + m[idx0 + 13]) * w0;
                let az = (vx * m[idx0 + 2] + vy * m[idx0 + 6] + vz * m[idx0 + 10] + m[idx0 + 14]) * w0;
                ax += (vx * m[idx1] + vy * m[idx1 + 4] + vz * m[idx1 + 8] + m[idx1 + 12]) * w1;
                ay += (vx * m[idx1 + 1] + vy * m[idx1 + 5] + vz * m[idx1 + 9] + m[idx1 + 13]) * w1;
                az += (vx * m[idx1 + 2] + vy * m[idx1 + 6] + vz * m[idx1 + 10] + m[idx1 + 14]) * w1;
                ax += (vx * m[idx2] + vy * m[idx2 + 4] + vz * m[idx2 + 8] + m[idx2 + 12]) * w2;
                ay += (vx * m[idx2 + 1] + vy * m[idx2 + 5] + vz * m[idx2 + 9] + m[idx2 + 13]) * w2;
                az += (vx * m[idx2 + 2] + vy * m[idx2 + 6] + vz * m[idx2 + 10] + m[idx2 + 14]) * w2;
                ax += (vx * m[idx3] + vy * m[idx3 + 4] + vz * m[idx3 + 8] + m[idx3 + 12]) * w3;
                ay += (vx * m[idx3 + 1] + vy * m[idx3 + 5] + vz * m[idx3 + 9] + m[idx3 + 13]) * w3;
                az += (vx * m[idx3 + 2] + vy * m[idx3 + 6] + vz * m[idx3 + 10] + m[idx3 + 14]) * w3;
                const o3 = globalOffset * 3;
                output[o3] = ax;
                output[o3 + 1] = ay;
                output[o3 + 2] = az;
                globalOffset++;
                i3 += 3;
            }
        }
        self.postMessage({ type: 'result', vertices: output }, [output.buffer]);
    }
};