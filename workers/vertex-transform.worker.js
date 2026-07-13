// vertex-transform.worker.js
self.onmessage = function(e) {
    const data = e.data;
    
    if (data.type === 'build') {
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
    }
};