import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import { StructureElement } from 'molstar/lib/mol-model/structure';
import { lociPositions } from './structure-executor';

export type Point = [number, number, number];

/** Unweighted centroid of the atoms in a Loci, optionally after a transform. */
export function centerOfMass(loci: StructureElement.Loci, transform?: Mat4): Point {
    const pos = lociPositions(loci, transform);
    const n = pos.length / 3;
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < n; i++) { x += pos[3 * i]; y += pos[3 * i + 1]; z += pos[3 * i + 2]; }
    return [x / n, y / n, z / n];
}

export function euclidean(a: Point, b: Point): number {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}
