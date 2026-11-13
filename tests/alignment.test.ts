/**
 * Superposition, driven by the same command strings as the UI text box.
 *
 *   4HHB  deoxy haemoglobin, chains A/C (alpha) and B/D (beta)
 *   1HHO  oxy haemoglobin, chains A (alpha) and B (beta)
 *   1MBN  myoglobin: same fold, about 25% sequence identity to the globins above
 */
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import { describe, expect, it } from 'vitest';
import { centerOfMass, euclidean } from '../src/executor/com-helper';
import { Session } from '../src/executor/session';
import { alignStructures, selectCAlphas } from '../src/executor/structure-executor';
import { createTestSession, loadStructureFromString } from '../src/test-helpers/structure-loader';

async function align(session: Session, command: string) {
    const [result] = await session.run(command);
    return result.alignment!;
}

/** Distance between the C-alpha centroids of two chains, in scene coordinates. */
function comDistance(session: Session, a: [string, string], b: [string, string]): number {
    const ma = session.getModel(a[0]), mb = session.getModel(b[0]);
    return euclidean(
        centerOfMass(selectCAlphas(ma.structure, a[1]), ma.transform),
        centerOfMass(selectCAlphas(mb.structure, b[1]), mb.transform));
}

describe('alignStructures (direct API)', () => {
    it('COMs overlap within 5 Å and RMSD is reasonable after sequence alignment', async () => {
        const s1 = await loadStructureFromString('4HHB');
        const s2 = await loadStructureFromString('1HHO');
        const sel1 = selectCAlphas(s1, 'A');
        const sel2 = selectCAlphas(s2, 'A');

        expect(euclidean(centerOfMass(sel1), centerOfMass(sel2))).toBeGreaterThan(5.0); // apart before

        const { rmsd, bTransform, alignedLength } = alignStructures(sel1, sel2, 'sequence');
        expect(euclidean(centerOfMass(sel1), centerOfMass(sel2, bTransform))).toBeLessThan(5.0);
        expect(rmsd).toBeLessThan(3.0);
        expect(alignedLength).toBe(141);
    });
});

describe('align command: all four methods', () => {
    it('method=sequence picks the best chain pair', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1HHO as oxy');
        const a = await align(s, 'align oxy to 4HHB');
        expect(a.method).toBe('sequence');
        expect(a.rmsd).toBeLessThan(1.5);
        expect(a.alignedLength).toBeGreaterThan(130);
        // Whichever globin chain matched, it was paired with the same type.
        expect(['A', 'C'].includes(a.referenceChain!)).toBe(a.mobileChain === 'A');
        expect(comDistance(s, ['4HHB', a.referenceChain!], ['oxy', a.mobileChain!])).toBeLessThan(1.0);
    });

    it('method=tmalign superposes a remote homologue', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1MBN as mb');
        const a = await align(s, 'align mb to 4HHB method=tmalign');
        expect(a.method).toBe('tmalign');
        expect(a.tmScore).toBeGreaterThan(0.8);
        expect(a.rmsd).toBeLessThan(3.0);
        expect(comDistance(s, ['4HHB', a.referenceChain!], ['mb', 'A'])).toBeLessThan(5.0);
    });

    it('method=sifts pairs residues through the UniProt mapping', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1HHO as oxy');
        const a = await align(s, 'align oxy to 4HHB method=sifts');
        expect(a.method).toBe('sifts');
        expect(a.alignedLength).toBe(141 + 146); // one alpha and one beta chain
        expect(a.rmsd).toBeLessThan(3.0);
        expect(comDistance(s, ['4HHB', 'A'], ['oxy', 'A'])).toBeLessThan(5.0);
    });

    it('method=sifts fails clearly for different proteins', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1MBN as mb');
        await expect(s.run('align mb to 4HHB method=sifts')).rejects.toThrow(/no UniProt-mapped residues/);
    });

    it('method=superpose fits equal-length selections by coordinates only', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1HHO as oxy');
        const a = await align(s, 'align #2/A to #1/A method=superpose');
        expect(a.method).toBe('superpose');
        expect(a.alignedLength).toBe(141);
        expect(a.rmsd).toBeLessThan(1.5);
        expect(comDistance(s, ['4HHB', 'A'], ['oxy', 'A'])).toBeLessThan(1.0);
        await expect(s.run('align #2/A:1-50 to #1/A:1-60 method=superpose')).rejects.toThrow(/equal counts/);
    });
});

describe('align command: behaviour', () => {
    it('honours an explicit chain on either side', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1HHO as oxy');
        const a = await align(s, 'align #2/A to #1/B');
        expect(a.referenceChain).toBe('B');
        expect(a.mobileChain).toBe('A');
        expect(comDistance(s, ['4HHB', 'B'], ['oxy', 'A'])).toBeLessThan(5.0);
    });

    it('moves only the mobile model', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1HHO as oxy; align oxy to 4HHB');
        expect(Mat4.isIdentity(s.getModel('4HHB').transform)).toBe(true);
        expect(Mat4.isIdentity(s.getModel('oxy').transform)).toBe(false);
    });

    it('chains alignments through an already-moved reference', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1HHO as oxy; load 1MBN as mb');
        await s.run('align #2/A to #1/A method=superpose; align mb to #2/A method=tmalign');
        // mb was fitted to oxy chain A, which itself sits on 4HHB chain A.
        expect(comDistance(s, ['4HHB', 'A'], ['mb', 'A'])).toBeLessThan(5.0);
    });

    it('zones follow the aligned coordinates across models', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1HHO as oxy');
        const before = (await s.run('select (#1/A:HEM :< 5) & #2'))[0].atomCount!;
        await s.run('align #2/A to #1/A');
        const after = (await s.run('select (#1/A:HEM :< 5) & #2'))[0].atomCount!;
        expect(after).toBeGreaterThan(200); // the oxy haem pocket now overlaps the deoxy haem
        expect(after).not.toBe(before);
    });

    it('rejects ambiguous or self alignments', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1HHO as oxy');
        await expect(s.run('align #1 to #1')).rejects.toThrow(/itself/);
        await expect(s.run('align /A to #1')).rejects.toThrow(/spans 2 models/);
        await expect(s.run('align nope to #1')).rejects.toThrow(/no model "nope"/);
    });
});
