import * as THREE from "three";
function createCollisionTemps() {
  return {
    invMat: new THREE.Matrix4(),
    localSeg: new THREE.Line3(),
    localBox: new THREE.Box3(),
    closestSeg: new THREE.Vector3(),
    closestTri: new THREE.Vector3()
  };
}
function applyCapsuleCollision(capsule, capsuleInfo, collider, temps, skipTri) {
  temps.invMat.copy(collider.matrixWorld).invert();
  temps.localSeg.start.copy(capsuleInfo.segment.start).applyMatrix4(capsule.matrixWorld).applyMatrix4(temps.invMat);
  temps.localSeg.end.copy(capsuleInfo.segment.end).applyMatrix4(capsule.matrixWorld).applyMatrix4(temps.invMat);
  temps.localBox.makeEmpty();
  temps.localBox.expandByPoint(temps.localSeg.start).expandByPoint(temps.localSeg.end);
  temps.localBox.expandByScalar(capsuleInfo.radius);
  collider.geometry?.boundsTree?.shapecast({
    intersectsBounds: (box) => box.intersectsBox(temps.localBox),
    intersectsTriangle: (tri) => {
      const distance = tri.closestPointToSegment(temps.localSeg, temps.closestSeg, temps.closestTri);
      if (distance >= capsuleInfo.radius) return;
      const dir = temps.closestTri.clone().sub(temps.closestSeg).normalize();
      if (skipTri?.(tri, dir)) return;
      temps.localSeg.start.addScaledVector(dir, capsuleInfo.radius - distance);
      temps.localSeg.end.addScaledVector(dir, capsuleInfo.radius - distance);
    }
  });
  const newPos = temps.closestSeg.copy(temps.localSeg.start).applyMatrix4(collider.matrixWorld);
  const delta = temps.closestTri.subVectors(newPos, capsule.position);
  const offset = Math.max(0, delta.length() - 1e-5);
  capsule.position.add(delta.normalize().multiplyScalar(offset));
}
export {
  applyCapsuleCollision,
  createCollisionTemps
};
