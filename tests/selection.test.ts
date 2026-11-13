/**
 * Selection and representation state, driven by the same command strings as
 * the UI text box. Expected atom counts were computed independently with
 * gemmi from the same mmCIF files.
 */
import { StructureElement } from 'molstar/lib/mol-model/structure';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/executor/session';
import { selectByChainAndResidues } from '../src/executor/structure-executor';
import { createTestSession, loadStructureFromString } from '../src/test-helpers/structure-loader';

async function count(session: Session, command: string): Promise<number> {
    const results = await session.run(command);
    return results[results.length - 1].atomCount!;
}

function shown(session: Session, model: string, repr: Parameters<Session['models'][0]['visible']['get']>[0]): number {
    const loci = session.getModel(model).visible.get(repr);
    return loci ? StructureElement.Loci.size(loci) : 0;
}

describe('selection on crambin (1CRN)', () => {
    it('selects the correct number of atoms for chain A residues 10-20', async () => {
        const structure = await loadStructureFromString('1CRN');
        const loci = selectByChainAndResidues(structure, 'A', [10, 20]);
        expect(StructureElement.Loci.size(loci)).toBe(87);
    });

    it('gives the same counts through command strings', async () => {
        const s = createTestSession();
        expect(await count(s, 'load 1CRN')).toBe(327);
        expect(await count(s, 'select chain A')).toBe(327);
        expect(await count(s, 'select chain A residues 10-20')).toBe(87);
        expect(await count(s, 'select chain A residues 10-20 atoms CA')).toBe(11);
        expect(await count(s, 'select /A:10-20@CA')).toBe(11);
        expect(await count(s, 'select /a:10-20')).toBe(87); // chain ids fall back to case-insensitive
        expect(await count(s, 'select :PRO')).toBe(35);
        expect(await count(s, 'select backbone')).toBe(185);
        expect(await count(s, 'select sidechain')).toBe(327 - 185);
        expect(await count(s, 'select chain Z')).toBe(0);
    });

    it('combines selections with & | ~ and sel', async () => {
        const s = createTestSession();
        await s.run('load 1CRN');
        expect(await count(s, 'select :10-20 & @CA')).toBe(11);
        expect(await count(s, 'select :10-20 | :PRO')).toBe(87 + 35 - 7); // PRO 19 is in both
        expect(await count(s, 'select ~:10-20')).toBe(327 - 87);
        await s.run('select :10-20');
        expect(await count(s, 'select sel & backbone')).toBe(44);
        await s.run('select clear');
        expect(s.selection).toBeUndefined();
    });
});

describe('selection on haemoglobin (4HHB)', () => {
    it('resolves named selectors', async () => {
        const s = createTestSession();
        expect(await count(s, 'load 4HHB')).toBe(4779);
        expect(await count(s, 'select /A')).toBe(1168);
        expect(await count(s, 'select solvent')).toBe(221);
        expect(await count(s, 'select ligand')).toBe(172);
        expect(await count(s, 'select /A:HEM')).toBe(43);
        expect(await count(s, 'select protein | nucleic')).toBe(await count(s, 'select polymer'));
        expect(await count(s, 'select protein | ligand | ions | solvent')).toBe(4779);
    });

    it('selects by element and by atom-name wildcard', async () => {
        const s = createTestSession();
        await s.run('load 4HHB');
        // Haem is C34 H32 Fe N4 O4; hydrogens are not in this entry.
        expect(await count(s, 'select /A:HEM & C')).toBe(34);
        expect(await count(s, 'select /A:HEM & N')).toBe(4);
        expect(await count(s, 'select /A:HEM & Fe')).toBe(1);
        expect(await count(s, 'select /A:HEM & ~C')).toBe(43 - 34);
        expect(await count(s, 'select chain A residues HEM element C,N')).toBe(38);
        expect(await count(s, 'select /A:HEM@C*')).toBe(34);
        expect(await count(s, 'select /A:HEM@N?')).toBe(4); // NA NB NC ND
        expect(await count(s, 'select /A:HEM@FE,O*')).toBe(5);
        expect(await count(s, 'select Fe')).toBe(4);

        await s.run('color gold /A:HEM & C');
        const layers = s.getModel('4HHB').colors;
        expect(StructureElement.Loci.size(layers[layers.length - 1].loci)).toBe(34);
    });

    it('resolves distance zones', async () => {
        const s = createTestSession();
        await s.run('load 4HHB');
        expect(await count(s, 'select /A:HEM @< 5')).toBe(137);
        expect(await count(s, 'select /A:HEM :< 5')).toBe(243);
        expect(await count(s, 'select (/A:HEM :< 5) & protein')).toBeLessThan(243 - 43);
    });

    it('scopes selections to models by id, alias and PDB id', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; load 1CRN as crn');
        expect(await count(s, 'select #1')).toBe(4779);
        expect(await count(s, 'select #2')).toBe(327);
        expect(await count(s, 'select #crn')).toBe(327);
        expect(await count(s, 'select model 4HHB chain A')).toBe(1168);
        expect(await count(s, 'select #1-2')).toBe(4779 + 327);
        expect(await count(s, 'select /A')).toBe(1168 + 327);
        await expect(s.run('select #7')).rejects.toThrow(/no model "7"/);
    });
});

describe('show / hide', () => {
    it('starts with cartoon for polymer and ball-and-stick for ligands', async () => {
        const s = createTestSession();
        await s.run('load 4HHB');
        expect(shown(s, '4HHB', 'cartoon')).toBe(4779 - 221 - 172 - 2);
        expect(shown(s, '4HHB', 'ball-and-stick')).toBe(172 + 2);
        expect(shown(s, '4HHB', 'surface')).toBe(0);
    });

    it('adds and removes atoms per representation', async () => {
        const s = createTestSession();
        await s.run('load 1CRN; hide');
        expect(shown(s, '1CRN', 'cartoon')).toBe(0);

        await s.run('show surface chain A residues 10-20');
        expect(shown(s, '1CRN', 'surface')).toBe(87);
        await s.run('show surface :PRO');
        expect(shown(s, '1CRN', 'surface')).toBe(87 + 35 - 7);
        await s.run('hide surface :10-20');
        expect(shown(s, '1CRN', 'surface')).toBe(35 - 7);
        expect(shown(s, '1CRN', 'spacefill')).toBe(0);
    });

    it('acts on the current selection when no selection is given (design-doc session)', async () => {
        const s = createTestSession();
        await s.run('load 1CRN; hide; select chain A residues 10-20; show spacefill; color #ff4444');
        expect(shown(s, '1CRN', 'spacefill')).toBe(87);
        const layers = s.getModel('1CRN').colors;
        expect(layers).toHaveLength(1);
        expect(layers[0].color).toBe(0xff4444);
        expect(StructureElement.Loci.size(layers[0].loci)).toBe(87);
    });

    it('tracks the atoms whose interactions are shown', async () => {
        const s = createTestSession();
        await s.run('load 4HHB; show interactions /A:HEM');
        expect(shown(s, '4HHB', 'interactions')).toBe(43);
        await s.run('hide interactions');
        expect(shown(s, '4HHB', 'interactions')).toBe(0);
        await s.run('show interactions ligand; hide');
        expect(shown(s, '4HHB', 'interactions')).toBe(0);
    });

    it('shows cartoon by whole residue', async () => {
        const s = createTestSession();
        await s.run('load 1CRN; hide; show cartoon :10-20@CA');
        expect(shown(s, '1CRN', 'cartoon')).toBe(87);
    });

    it('only touches the models a selection names', async () => {
        const s = createTestSession();
        await s.run('load 1CRN; load 4HHB as hb; hide #1');
        expect(shown(s, '1CRN', 'cartoon')).toBe(0);
        expect(shown(s, 'hb', 'cartoon')).toBeGreaterThan(0);
    });
});

describe('transparency', () => {
    it('layers per representation, surfaces by default', async () => {
        const s = createTestSession();
        await s.run('load 1CRN; show surface; transparency 60');
        const m = s.getModel('1CRN');
        expect(m.transparency.get('surface')).toHaveLength(1);
        expect(m.transparency.get('surface')![0].value).toBeCloseTo(0.6);
        expect(m.transparency.get('cartoon')).toBeUndefined();

        await s.run('transparency 20 :10-20');
        const layers = m.transparency.get('surface')!;
        expect(layers).toHaveLength(2);
        expect(StructureElement.Loci.size(layers[1].loci)).toBe(87);

        await s.run('transparency 0'); // whole model back to opaque clears the layers
        expect(m.transparency.get('surface')).toEqual([]);

        await s.run('transparency 40 all');
        expect(m.transparency.get('cartoon')).toHaveLength(1);
        expect(m.transparency.get('spacefill')).toHaveLength(1);
    });
});

describe('camera motion', () => {
    it('is off by default and follows rock / spin / stop', async () => {
        const s = createTestSession();
        expect(s.animation).toBe('off');
        await s.run('load 1CRN; color gold; show surface');
        expect(s.animation).toBe('off');
        await s.run('rock');
        expect(s.animation).toBe('rock');
        await s.run('spin');
        expect(s.animation).toBe('spin');
        await s.run('stop');
        expect(s.animation).toBe('off');
    });
});

describe('models', () => {
    it('rejects duplicate names and reuses freed ids', async () => {
        const s = createTestSession();
        await s.run('load 1CRN');
        await expect(s.run('load 1CRN')).rejects.toThrow(/already loaded/);
        await s.run('load 1CRN as second; close 1CRN');
        expect(s.models.map(m => m.id)).toEqual([2]);
        await s.run('load 1CRN as third');
        expect(s.getModel('third').id).toBe(1);
        await s.run('close');
        expect(s.models).toHaveLength(0);
    });
});

describe('link', () => {
    it('reports the successful commands and resets when everything is closed', async () => {
        const session = createTestSession();
        await session.run('load 1CRN; show sticks :PRO');
        await expect(session.run('show sticks :PRO :> 5')).rejects.toThrow();
        await session.run('help; color gold :PRO & C');
        const [first] = await session.run('link');
        expect(first.script).toBe('load 1CRN; show sticks :PRO; color gold :PRO & C');

        const replay = createTestSession();
        await replay.run(first.script!);
        expect((await replay.run('link'))[0].script).toBe(first.script);

        await session.run('close; load 1CRN');
        expect((await session.run('link'))[0].script).toBe('load 1CRN');
    });
});

describe('colour reset', () => {
    it('byhet clears colour from non-carbon atoms only; default clears the rest', async () => {
        const session = createTestSession();
        await session.run('load 4HHB; color salmon /A:HEM');
        const model = session.models[0];
        const painted = () => model.colors.reduce((n, l) => n + Session.count(new Map([[model, l.loci]])), 0);
        expect(painted()).toBe(43);
        const [r] = await session.run('color byhet /A:HEM :< 5');
        expect(painted()).toBe(34);
        expect(r.atomCount).toBeGreaterThan(9);
        await session.run('color default /A');
        expect(model.colors).toHaveLength(0);
    });
});
