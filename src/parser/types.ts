/**
 * CommandAST type definitions. Pure TypeScript: no molstar, no DOM.
 */

/**
 * `interactions` draws the non-covalent contacts (hydrogen bonds, ionic,
 * pi-stacking, cation-pi, halogen bonds, hydrophobic, metal coordination)
 * that involve the atoms it is shown for.
 */
export type Representation = 'cartoon' | 'surface' | 'ball-and-stick' | 'spacefill' | 'ribbon' | 'interactions';

export const REPRESENTATIONS: readonly Representation[] =
    ['cartoon', 'surface', 'ball-and-stick', 'spacefill', 'ribbon', 'interactions'];

export type AlignMethod = 'sequence' | 'tmalign' | 'sifts' | 'superpose';

export const ALIGN_METHODS: readonly AlignMethod[] = ['sequence', 'tmalign', 'sifts', 'superpose'];

export type NamedSelector =
    | 'protein' | 'nucleic' | 'polymer' | 'ligand' | 'solvent' | 'ions' | 'backbone' | 'sidechain';

/** One item of a residue list: a number range (inclusive) or a residue name. */
export type ResiduePart =
    | { kind: 'range'; start: number; end: number }
    | { kind: 'name'; name: string };

/**
 * Selection expression tree.
 *
 * `spec` is one hierarchical specifier (model / chain / residue / atom); every
 * level that is present must match. `models` holds raw references: a numeric
 * id ("1"), an id range ("1-3"), an alias or a PDB id. `atoms` are atom names,
 * where * and ? are wildcards; `elements` are upper-case element symbols.
 */
export type SelExpr =
    | { type: 'all' }
    | { type: 'current' }
    | { type: 'named'; name: NamedSelector }
    | { type: 'spec'; models?: string[]; chains?: string[]; residues?: ResiduePart[]; atoms?: string[]; elements?: string[] }
    | { type: 'and'; left: SelExpr; right: SelExpr }
    | { type: 'or'; left: SelExpr; right: SelExpr }
    | { type: 'not'; expr: SelExpr }
    | { type: 'zone'; expr: SelExpr; level: 'atom' | 'residue'; distance: number };

export type Command =
    | { kind: 'load'; pdbId: string; alias?: string }
    /** `selection` undefined means clear the current selection. */
    | { kind: 'select'; selection?: SelExpr }
    | { kind: 'show'; repr: Representation; selection?: SelExpr }
    /** `repr` undefined means hide every representation. */
    | { kind: 'hide'; repr?: Representation; selection?: SelExpr }
    | { kind: 'color'; color: string; selection?: SelExpr }
    /** `percent` 0 is opaque, 100 invisible. `repr` undefined means every representation. */
    | { kind: 'transparency'; percent: number; repr?: Representation; selection?: SelExpr }
    | { kind: 'align'; target: SelExpr; reference: SelExpr; method?: AlignMethod }
    | { kind: 'focus'; selection?: SelExpr }
    | { kind: 'close'; model?: string }
    /** Continuous camera motion; 'off' stops it. */
    | { kind: 'animate'; mode: 'rock' | 'spin' | 'off' }
    /**
     * Remove colours set by `color`, so atoms return to their default colouring
     * (heteroatoms by element; carbons, cartoons and surfaces in the model colour).
     * 'het' leaves carbon atoms as they are.
     */
    | { kind: 'uncolor'; scope: 'het' | 'all'; selection?: SelExpr }
    /**
     * Camera placement in scene coordinates: position, target, up (three
     * numbers each) and clipping radius. `view` undefined reports the current one.
     */
    | { kind: 'camera'; view?: number[] }
    /** Report the commands that reproduce the current scene. */
    | { kind: 'link' }
    | { kind: 'help' };

export class ParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ParseError';
    }
}
