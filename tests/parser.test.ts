import { describe, expect, it } from 'vitest';
import { parseSelection } from '../src/parser/atomspec';
import { parseCommand } from '../src/parser/command-parser';
import { ParseError } from '../src/parser/types';

const one = (s: string) => {
    const cmds = parseCommand(s);
    expect(cmds).toHaveLength(1);
    return cmds[0];
};

describe('statements', () => {
    it('splits on semicolons and newlines, skips blanks and comments', () => {
        const cmds = parseCommand('load 1ABC; select chain A\n\n# a comment\nshow cartoon;');
        expect(cmds.map(c => c.kind)).toEqual(['load', 'select', 'show']);
    });

    it('is case-insensitive in keywords', () => {
        expect(one('LOAD 1abc AS ref')).toEqual({ kind: 'load', pdbId: '1ABC', alias: 'ref' });
        expect(one('Show Cartoon')).toEqual({ kind: 'show', repr: 'cartoon' });
    });

    it('rejects unknown commands', () => {
        expect(() => parseCommand('frobnicate 1ABC')).toThrow(ParseError);
    });
});

describe('load', () => {
    it('parses a PDB id, with and without alias', () => {
        expect(one('load 1ABC')).toEqual({ kind: 'load', pdbId: '1ABC' });
        expect(one('load 2XYZ as ref')).toEqual({ kind: 'load', pdbId: '2XYZ', alias: 'ref' });
    });

    it('rejects bad ids and reserved aliases', () => {
        expect(() => parseCommand('load')).toThrow(ParseError);
        expect(() => parseCommand('load hemoglobin')).toThrow(ParseError);
        expect(() => parseCommand('load 1ABC as protein')).toThrow(ParseError);
        expect(() => parseCommand('load 1ABC as 2')).toThrow(ParseError);
    });
});

describe('select: keyword form from the design doc', () => {
    it('select chain <ID>', () => {
        expect(one('select chain A')).toEqual({ kind: 'select', selection: { type: 'spec', chains: ['A'] } });
    });

    it('select chain <ID> residues <start>-<end>', () => {
        expect(one('select chain A residues 10-50')).toEqual({
            kind: 'select',
            selection: { type: 'spec', chains: ['A'], residues: [{ kind: 'range', start: 10, end: 50 }] },
        });
    });

    it('select chain <ID> residues <start>-<end> atoms CA', () => {
        expect(one('select chain A residues 10-50 atoms CA')).toEqual({
            kind: 'select',
            selection: {
                type: 'spec', chains: ['A'],
                residues: [{ kind: 'range', start: 10, end: 50 }], atoms: ['CA'],
            },
        });
    });

    it('accepts a model clause and lists', () => {
        expect(parseSelection('model ref chain A,B residues 5,10-12,HEM')).toEqual({
            type: 'spec', models: ['ref'], chains: ['A', 'B'],
            residues: [
                { kind: 'range', start: 5, end: 5 },
                { kind: 'range', start: 10, end: 12 },
                { kind: 'name', name: 'HEM' },
            ],
        });
    });

    it('select clear', () => {
        expect(one('select clear')).toEqual({ kind: 'select' });
    });
});

describe('select: ChimeraX atomspec form', () => {
    it('parses the full hierarchy', () => {
        expect(parseSelection('#1/A:10-50@CA')).toEqual({
            type: 'spec', models: ['1'], chains: ['A'],
            residues: [{ kind: 'range', start: 10, end: 50 }], atoms: ['CA'],
        });
    });

    it('is the same tree as the keyword form', () => {
        expect(parseSelection('/A:10-50@CA')).toEqual(parseSelection('chain A residues 10-50 atoms CA'));
    });

    it('parses partial specifiers', () => {
        expect(parseSelection('#1,2')).toEqual({ type: 'spec', models: ['1', '2'] });
        expect(parseSelection('#1-3')).toEqual({ type: 'spec', models: ['1-3'] });
        expect(parseSelection('#ref/B')).toEqual({ type: 'spec', models: ['ref'], chains: ['B'] });
        expect(parseSelection(':HEM')).toEqual({ type: 'spec', residues: [{ kind: 'name', name: 'HEM' }] });
        expect(parseSelection('@ca,cb')).toEqual({ type: 'spec', atoms: ['CA', 'CB'] });
        expect(parseSelection(':-5--1')).toEqual({ type: 'spec', residues: [{ kind: 'range', start: -5, end: -1 }] });
    });

    it('repeated levels inherit the levels above', () => {
        expect(parseSelection('#1/A:10/B:20')).toEqual({
            type: 'or',
            left: { type: 'spec', models: ['1'], chains: ['A'], residues: [{ kind: 'range', start: 10, end: 10 }] },
            right: { type: 'spec', models: ['1'], chains: ['B'], residues: [{ kind: 'range', start: 20, end: 20 }] },
        });
    });

    it('parses operators with & binding tighter than |', () => {
        expect(parseSelection('protein & /A | ligand')).toEqual({
            type: 'or',
            left: { type: 'and', left: { type: 'named', name: 'protein' }, right: { type: 'spec', chains: ['A'] } },
            right: { type: 'named', name: 'ligand' },
        });
        expect(parseSelection('~(solvent | ions)')).toEqual({
            type: 'not',
            expr: { type: 'or', left: { type: 'named', name: 'solvent' }, right: { type: 'named', name: 'ions' } },
        });
    });

    it('treats juxtaposition as union', () => {
        expect(parseSelection('/A /B')).toEqual({
            type: 'or', left: { type: 'spec', chains: ['A'] }, right: { type: 'spec', chains: ['B'] },
        });
    });

    it('parses zones', () => {
        expect(parseSelection('ligand :< 5')).toEqual({
            type: 'zone', expr: { type: 'named', name: 'ligand' }, level: 'residue', distance: 5,
        });
        expect(parseSelection('#1:HEM @<4.5')).toEqual({
            type: 'zone',
            expr: { type: 'spec', models: ['1'], residues: [{ kind: 'name', name: 'HEM' }] },
            level: 'atom', distance: 4.5,
        });
    });

    it('parses element selectors and atom-name wildcards', () => {
        expect(parseSelection('C')).toEqual({ type: 'spec', elements: ['C'] });
        expect(parseSelection('Fe')).toEqual({ type: 'spec', elements: ['FE'] });
        expect(parseSelection('element c,n')).toEqual({ type: 'spec', elements: ['C', 'N'] });
        expect(parseSelection(':EJE & C')).toEqual({
            type: 'and',
            left: { type: 'spec', residues: [{ kind: 'name', name: 'EJE' }] },
            right: { type: 'spec', elements: ['C'] },
        });
        expect(parseSelection('chain A element C')).toEqual({ type: 'spec', chains: ['A'], elements: ['C'] });
        expect(parseSelection('@C*,H?')).toEqual({ type: 'spec', atoms: ['C*', 'H?'] });
        // Bare symbols need standard capitalisation, so CA is never calcium.
        expect(() => parseSelection('CA')).toThrow(/write "Ca" or "element Ca"/);
        expect(() => parseSelection('element Xx')).toThrow(/not an element/);
    });

    it('parses all, sel and aliases of named selectors', () => {
        expect(parseSelection('all')).toEqual({ type: 'all' });
        expect(parseSelection('sel')).toEqual({ type: 'current' });
        expect(parseSelection('water')).toEqual({ type: 'named', name: 'solvent' });
    });

    it('reports errors', () => {
        expect(() => parseSelection('banana')).toThrow(/unknown selector "banana"/);
        expect(() => parseSelection('(protein')).toThrow(/missing "\)"/);
        expect(() => parseSelection(':50-10')).toThrow(/backwards/);
        expect(() => parseSelection('ligand :<')).toThrow(/distance/);
        expect(() => parseSelection('ligand :> 5')).toThrow(/not supported/);
        expect(() => parseSelection('/')).toThrow(/chain id/);
    });
});

describe('show / hide', () => {
    it('show <representation> [selection]', () => {
        expect(one('show cartoon')).toEqual({ kind: 'show', repr: 'cartoon' });
        expect(one('show surface chain A residues 10-50')).toEqual({
            kind: 'show', repr: 'surface',
            selection: { type: 'spec', chains: ['A'], residues: [{ kind: 'range', start: 10, end: 50 }] },
        });
    });

    it('accepts ChimeraX order and representation aliases', () => {
        expect(one('show /A cartoons')).toEqual({ kind: 'show', repr: 'cartoon', selection: { type: 'spec', chains: ['A'] } });
        expect(one('show vdw ligand')).toEqual({ kind: 'show', repr: 'spacefill', selection: { type: 'named', name: 'ligand' } });
        expect(one('show sticks')).toEqual({ kind: 'show', repr: 'ball-and-stick' });
        expect(one('hide ribbon')).toEqual({ kind: 'hide', repr: 'ribbon' });
    });

    it('keeps "atoms" as a selection keyword unless it is the last word', () => {
        expect(one('show spacefill chain A atoms CA')).toEqual({
            kind: 'show', repr: 'spacefill', selection: { type: 'spec', chains: ['A'], atoms: ['CA'] },
        });
        expect(one('show ligand atoms')).toEqual({
            kind: 'show', repr: 'ball-and-stick', selection: { type: 'named', name: 'ligand' },
        });
    });

    it('reads a leading "atoms" as the representation when a selection follows', () => {
        expect(one('show atoms sel')).toEqual({ kind: 'show', repr: 'ball-and-stick', selection: { type: 'current' } });
        expect(one('show atoms ligand :< 5')).toEqual(one('show sticks ligand :< 5'));
        expect(one('hide atoms /A')).toEqual({ kind: 'hide', repr: 'ball-and-stick', selection: { type: 'spec', chains: ['A'] } });
        expect(one('show atoms chain A')).toEqual({ kind: 'show', repr: 'ball-and-stick', selection: { type: 'spec', chains: ['A'] } });
        // An atom name after it keeps the selection-clause meaning.
        expect(one('show atoms CA')).toEqual({ kind: 'show', repr: 'ball-and-stick', selection: { type: 'spec', atoms: ['CA'] } });
    });

    it('parses the interactions representation', () => {
        expect(one('show interactions sel')).toEqual({ kind: 'show', repr: 'interactions', selection: { type: 'current' } });
        expect(one('show :EJE contacts')).toEqual({
            kind: 'show', repr: 'interactions', selection: { type: 'spec', residues: [{ kind: 'name', name: 'EJE' }] },
        });
        expect(one('hide interactions')).toEqual({ kind: 'hide', repr: 'interactions' });
    });

    it('hide with no representation hides everything', () => {
        expect(one('hide')).toEqual({ kind: 'hide' });
        expect(one('hide solvent')).toEqual({ kind: 'hide', selection: { type: 'named', name: 'solvent' } });
    });
});

describe('color', () => {
    it('color <colorname|#hex> [selection]', () => {
        expect(one('color #ff4444')).toEqual({ kind: 'color', color: '#ff4444' });
        expect(one('color red chain A')).toEqual({ kind: 'color', color: '#ff0000', selection: { type: 'spec', chains: ['A'] } });
    });

    it('accepts ChimeraX order', () => {
        expect(one('color /A gold')).toEqual({ kind: 'color', color: '#ffd700', selection: { type: 'spec', chains: ['A'] } });
        expect(one('color protein #00F0f0')).toEqual({ kind: 'color', color: '#00f0f0', selection: { type: 'named', name: 'protein' } });
    });

    it('tells a hex colour from a model number', () => {
        expect(one('color #1 #ff4444')).toEqual({ kind: 'color', color: '#ff4444', selection: { type: 'spec', models: ['1'] } });
        expect(one('color #fa0 #123')).toEqual({ kind: 'color', color: '#ffaa00', selection: { type: 'spec', models: ['123'] } });
    });

    it('rejects a missing colour', () => {
        expect(() => parseCommand('color chain A')).toThrow(ParseError);
    });
});

describe('align', () => {
    it('align <model2|alias> to <model1|alias>', () => {
        expect(one('align 1ABC to ref')).toEqual({
            kind: 'align',
            target: { type: 'spec', models: ['1ABC'] },
            reference: { type: 'spec', models: ['ref'] },
        });
    });

    it('parses every method', () => {
        for (const method of ['sequence', 'tmalign', 'sifts', 'superpose'] as const) {
            expect(one(`align 1ABC to ref method=${method}`)).toMatchObject({ kind: 'align', method });
        }
        expect(() => parseCommand('align a to b method=magic')).toThrow(ParseError);
    });

    it('accepts atomspecs on either side', () => {
        expect(one('align #2/B to #1/A method=tmalign')).toEqual({
            kind: 'align', method: 'tmalign',
            target: { type: 'spec', models: ['2'], chains: ['B'] },
            reference: { type: 'spec', models: ['1'], chains: ['A'] },
        });
    });

    it('needs both sides', () => {
        expect(() => parseCommand('align 1ABC')).toThrow(ParseError);
    });
});

describe('transparency', () => {
    it('defaults to surfaces and accepts either order', () => {
        expect(one('transparency 50')).toEqual({ kind: 'transparency', percent: 50, repr: 'surface' });
        expect(one('transparency 60 /A')).toEqual({
            kind: 'transparency', percent: 60, repr: 'surface', selection: { type: 'spec', chains: ['A'] },
        });
        expect(one('transparency /A 60%')).toEqual(one('transparency 60 /A'));
    });

    it('takes a representation or all', () => {
        expect(one('transparency 30 cartoon')).toEqual({ kind: 'transparency', percent: 30, repr: 'cartoon' });
        expect(one('transparency 30 protein all')).toEqual({
            kind: 'transparency', percent: 30, selection: { type: 'named', name: 'protein' },
        });
    });

    it('does not confuse a zone distance with the percent', () => {
        const zone = { type: 'zone', expr: { type: 'named', name: 'ligand' }, level: 'residue', distance: 5 };
        expect(one('transparency 70 ligand :< 5')).toEqual({ kind: 'transparency', percent: 70, repr: 'surface', selection: zone });
        expect(one('transparency ligand :< 5 70')).toEqual({ kind: 'transparency', percent: 70, repr: 'surface', selection: zone });
    });

    it('rejects a missing or out-of-range percent', () => {
        expect(() => parseCommand('transparency /A')).toThrow(ParseError);
        expect(() => parseCommand('transparency 150')).toThrow(ParseError);
    });
});

describe('rock / spin / stop', () => {
    it('parses camera motion commands', () => {
        expect(one('rock')).toEqual({ kind: 'animate', mode: 'rock' });
        expect(one('spin on')).toEqual({ kind: 'animate', mode: 'spin' });
        expect(one('rock off')).toEqual({ kind: 'animate', mode: 'off' });
        expect(one('stop')).toEqual({ kind: 'animate', mode: 'off' });
        expect(() => parseCommand('rock sideways')).toThrow(ParseError);
    });
});

describe('the example session from the design doc', () => {
    it('parses to the expected command kinds', () => {
        const cmds = parseCommand(`
            load 1ABC
            load 2XYZ as ref
            align 1ABC to ref method=tmalign
            select chain A residues 10-50
            show cartoon
            hide surface
            color #ff4444
        `);
        expect(cmds.map(c => c.kind)).toEqual(['load', 'load', 'align', 'select', 'show', 'hide', 'color']);
    });
});

describe('link', () => {
    it('parses link and share', () => {
        expect(parseCommand('link; share')).toEqual([{ kind: 'link' }, { kind: 'link' }]);
        expect(() => parseCommand('link foo')).toThrow();
    });
});

describe('camera and colour reset', () => {
    it('parses camera', () => {
        expect(parseCommand('camera')).toEqual([{ kind: 'camera' }]);
        expect(parseCommand('camera 1,2,3 4,5,6 0,1,0 30.5')).toEqual(
            [{ kind: 'camera', view: [1, 2, 3, 4, 5, 6, 0, 1, 0, 30.5] }]);
        expect(() => parseCommand('camera 1,2,3')).toThrow(ParseError);
    });
    it('parses color byhet and color default in both orders', () => {
        expect(parseCommand('color byhet')).toEqual([{ kind: 'uncolor', scope: 'het' }]);
        expect(parseCommand('color byhet :EJE')).toEqual(parseCommand('color :EJE byhet'));
        expect(parseCommand('color default :EJE')[0]).toMatchObject({ kind: 'uncolor', scope: 'all' });
    });
});
