/**
 * Pure-TS structure layer: parsing mmCIF text into a Structure, running
 * selections, and computing superpositions.
 *
 * Imports only from the DOM-free Mol* modules (mol-io, mol-data, mol-math,
 * mol-model, mol-model-formats, mol-model-props, mol-script, mol-task,
 * mol-util). No mol-plugin, no mol-canvas3d, no DOM.
 */

import { OrderedSet } from 'molstar/lib/mol-data/int';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { MinimizeRmsd } from 'molstar/lib/mol-math/linear-algebra/3d/minimize-rmsd';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { SIFTSMapping } from 'molstar/lib/mol-model-props/sequence/sifts-mapping';
import { Structure, StructureElement, StructureProperties, StructureSelection, Unit } from 'molstar/lib/mol-model/structure';
import { NucleicBackboneAtoms, ProteinBackboneAtoms } from 'molstar/lib/mol-model/structure/model/types';
import { alignAndSuperpose } from 'molstar/lib/mol-model/structure/structure/util/superposition';
import { alignAndSuperposeWithSIFTSMapping } from 'molstar/lib/mol-model/structure/structure/util/superposition-sifts-mapping';
import { tmAlign } from 'molstar/lib/mol-model/structure/structure/util/tm-align';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { Expression } from 'molstar/lib/mol-script/language/expression';
import { Script } from 'molstar/lib/mol-script/script';
import { SyncRuntimeContext } from 'molstar/lib/mol-task/execution/synchronous';
import { AssetManager } from 'molstar/lib/mol-util/assets';
import { AlignMethod, NamedSelector, ResiduePart } from '../parser/types';

type Loci = StructureElement.Loci;

// ---------------------------------------------------------------- loading

/**
 * Parse mmCIF text into the first model's Structure (the deposited coordinates).
 * With `sifts`, the per-residue UniProt mapping is read from the file's
 * `_atom_site.pdbx_sifts_xref_db_*` columns, which method=sifts needs.
 */
export async function structureFromMmCIF(cifText: string, options: { sifts?: boolean } = {}): Promise<Structure> {
    const parsed = await CIF.parseText(cifText).run();
    if (parsed.isError) throw new Error(`mmCIF parse error: ${parsed.message}`);
    const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
    const model = trajectory.representative;
    if (options.sifts) {
        if (!SIFTSMapping.isAvailable(model)) throw new Error('this mmCIF file carries no SIFTS mapping');
        await SIFTSMapping.Provider.attach({ runtime: SyncRuntimeContext, assetManager: new AssetManager() }, model);
    }
    return Structure.ofModel(model);
}

export function rcsbCifUrl(pdbId: string): string {
    return `https://files.rcsb.org/download/${pdbId.toUpperCase()}.cif`;
}

/**
 * PDBe's "updated" mmCIF: same coordinates as the archive file, plus the
 * SIFTS columns that RCSB's download does not include.
 */
export function pdbeUpdatedCifUrl(pdbId: string): string {
    return `https://www.ebi.ac.uk/pdbe/entry-files/download/${pdbId.toLowerCase()}_updated.cif`;
}

export async function fetchText(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not fetch ${url}: HTTP ${response.status}`);
    return response.text();
}

/** Fetch a structure with its SIFTS mapping attached. Works in Node and in the browser. */
export async function fetchSiftsStructure(pdbId: string): Promise<Structure> {
    return structureFromMmCIF(await fetchText(pdbeUpdatedCifUrl(pdbId)), { sifts: true });
}

// -------------------------------------------------------------- selection

export function emptyLoci(structure: Structure): Loci {
    return StructureElement.Loci(structure, []);
}

export function allLoci(structure: Structure): Loci {
    return StructureElement.Loci.all(structure);
}

export function lociSize(loci: Loci): number {
    return StructureElement.Loci.size(loci);
}

export function runQuery(structure: Structure, expression: Expression): Loci {
    const selection = Script.getStructureSelection(expression, structure);
    return StructureSelection.toLociWithSourceUnits(selection);
}

/** auth_asym_id of every chain, in file order, without duplicates. */
export function chainIds(structure: Structure): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const loc = StructureElement.Location.create(structure);
    for (const unit of structure.units) {
        loc.unit = unit;
        loc.element = unit.elements[0];
        const id = StructureProperties.chain.auth_asym_id(loc);
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids;
}

export interface SpecLevels {
    chains?: string[];
    residues?: ResiduePart[];
    /** Atom names; * and ? are wildcards. */
    atoms?: string[];
    /** Upper-case element symbols. */
    elements?: string[];
}

/** Test for a list of atom names, any of which may contain * or ? wildcards. */
function atomNameTest(names: string[]): Expression | undefined {
    if (names.includes('*')) return undefined;
    const exact = names.filter(n => !/[*?]/.test(n));
    const patterns = names.filter(n => /[*?]/.test(n));
    const parts: Expression[] = [];
    if (exact.length) parts.push(has(exact, MS.ammp('label_atom_id')));
    if (patterns.length) {
        const body = patterns
            .map(p => p.replace(/[^A-Za-z0-9*?]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'))
            .join('|');
        parts.push(MS.core.str.match([MS.re(`^(${body})$`, 'i'), MS.ammp('label_atom_id')]));
    }
    return parts.length === 1 ? parts[0] : MS.core.logic.or(parts);
}

function has(values: string[], property: Expression): Expression {
    return values.length === 1
        ? MS.core.rel.eq([property, values[0]])
        : MS.core.set.has([MS.set(...values), property]);
}

/**
 * Atoms matching every given level. Chains are auth_asym_id, residue numbers
 * are auth_seq_id, residue names are label_comp_id, atom names are
 * label_atom_id (with * and ? wildcards), elements are type_symbol.
 */
export function selectSpec(structure: Structure, spec: SpecLevels): Loci {
    const tests: Record<string, Expression> = {};
    if (spec.chains) tests['chain-test'] = has(spec.chains, MS.ammp('auth_asym_id'));
    if (spec.residues) {
        const names = spec.residues.flatMap(r => r.kind === 'name' ? [r.name] : []);
        const parts: Expression[] = spec.residues.flatMap(r => r.kind === 'range'
            ? [r.start === r.end
                ? MS.core.rel.eq([MS.ammp('auth_seq_id'), r.start])
                : MS.core.rel.inRange([MS.ammp('auth_seq_id'), r.start, r.end])]
            : []);
        if (names.length) parts.push(has(names, MS.ammp('label_comp_id')));
        tests['residue-test'] = parts.length === 1 ? parts[0] : MS.core.logic.or(parts);
    }
    const atomTests: Expression[] = [];
    const nameTest = spec.atoms && atomNameTest(spec.atoms);
    if (nameTest) atomTests.push(nameTest);
    if (spec.elements) {
        const symbol = MS.acp('elementSymbol');
        atomTests.push(spec.elements.length === 1
            ? MS.core.rel.eq([symbol, MS.es(spec.elements[0])])
            : MS.core.set.has([MS.set(...spec.elements.map(e => MS.es(e))), symbol]));
    }
    if (atomTests.length) tests['atom-test'] = atomTests.length === 1 ? atomTests[0] : MS.core.logic.and(atomTests);
    return runQuery(structure, MS.struct.generator.atomGroups(tests));
}

/** The selection named in the design doc: one chain, optionally a residue range. */
export function selectByChainAndResidues(structure: Structure, chain: string, residues?: [number, number]): Loci {
    return selectSpec(structure, {
        chains: [chain],
        residues: residues ? [{ kind: 'range', start: residues[0], end: residues[1] }] : undefined,
    });
}

/** C-alpha atoms, of one chain or of the whole structure. */
export function selectCAlphas(structure: Structure, chain?: string): Loci {
    return selectSpec(structure, { chains: chain ? [chain] : undefined, atoms: ['CA'] });
}

const isPolymer = MS.core.rel.eq([MS.ammp('entityType'), 'polymer']);
const isProtein = MS.core.logic.and([
    isPolymer,
    MS.core.str.match([MS.re('(polypeptide|cyclic-pseudo-peptide)', 'i'), MS.ammp('entitySubtype')]),
]);
const isNucleic = MS.core.logic.and([
    isPolymer,
    MS.core.str.match([MS.re('(nucleotide|peptide nucleic acid)', 'i'), MS.ammp('entitySubtype')]),
]);
const proteinBackboneNames = MS.set(...Array.from(ProteinBackboneAtoms));
const nucleicBackboneNames = MS.set(...Array.from(NucleicBackboneAtoms));

function merge(...groups: Expression[]): Expression {
    return MS.struct.modifier.union([MS.struct.combinator.merge(groups.map(g => MS.struct.modifier.union([g])))]);
}

function namedExpression(name: NamedSelector): Expression {
    switch (name) {
        case 'protein': return MS.struct.generator.atomGroups({ 'entity-test': isProtein });
        case 'nucleic': return MS.struct.generator.atomGroups({ 'entity-test': isNucleic });
        case 'polymer': return MS.struct.generator.atomGroups({ 'entity-test': isPolymer });
        case 'solvent': return MS.struct.generator.atomGroups({
            'entity-test': MS.core.rel.eq([MS.ammp('entityType'), 'water']),
        });
        case 'ions': return MS.struct.generator.atomGroups({
            'entity-test': MS.core.rel.eq([MS.ammp('entitySubtype'), 'ion']),
        });
        case 'ligand': return MS.struct.generator.atomGroups({
            'entity-test': MS.core.logic.or([
                MS.core.rel.eq([MS.ammp('entityType'), 'branched']),
                MS.core.logic.and([
                    MS.core.rel.eq([MS.ammp('entityType'), 'non-polymer']),
                    MS.core.rel.neq([MS.ammp('entitySubtype'), 'ion']),
                ]),
            ]),
        });
        case 'backbone': return merge(
            MS.struct.generator.atomGroups({
                'entity-test': isProtein,
                'atom-test': MS.core.set.has([proteinBackboneNames, MS.ammp('label_atom_id')]),
            }),
            MS.struct.generator.atomGroups({
                'entity-test': isNucleic,
                'atom-test': MS.core.set.has([nucleicBackboneNames, MS.ammp('label_atom_id')]),
            }));
        case 'sidechain': return merge(
            MS.struct.generator.atomGroups({
                'entity-test': isProtein,
                'atom-test': MS.core.logic.not([MS.core.set.has([proteinBackboneNames, MS.ammp('label_atom_id')])]),
            }),
            MS.struct.generator.atomGroups({
                'entity-test': isNucleic,
                'atom-test': MS.core.logic.not([MS.core.set.has([nucleicBackboneNames, MS.ammp('label_atom_id')])]),
            }));
    }
}

export function selectNamed(structure: Structure, name: NamedSelector): Loci {
    return runQuery(structure, namedExpression(name));
}

/** One trace atom per polymer residue: CA for proteins, P for nucleic acids. */
export function selectTrace(structure: Structure): Loci {
    return runQuery(structure, merge(
        MS.struct.generator.atomGroups({
            'entity-test': isProtein,
            'atom-test': MS.core.rel.eq([MS.ammp('label_atom_id'), 'CA']),
        }),
        MS.struct.generator.atomGroups({
            'entity-test': isNucleic,
            'atom-test': MS.core.rel.eq([MS.ammp('label_atom_id'), 'P']),
        })));
}

export function wholeResidues(loci: Loci): Loci {
    return StructureElement.Loci.extendToWholeResidues(loci);
}

// ------------------------------------------------------------ coordinates

/** xyz triples of every atom in the loci, optionally transformed. */
export function lociPositions(loci: Loci, transform?: Mat4): Float64Array {
    const out = new Float64Array(3 * lociSize(loci));
    const v = Vec3();
    let o = 0;
    for (const { unit, indices } of loci.elements) {
        const { elements, conformation } = unit;
        for (let i = 0, n = OrderedSet.size(indices); i < n; i++) {
            const e = elements[OrderedSet.getAt(indices, i)];
            Vec3.set(v, conformation.x(e), conformation.y(e), conformation.z(e));
            if (transform) Vec3.transformMat4(v, v, transform);
            out[o++] = v[0]; out[o++] = v[1]; out[o++] = v[2];
        }
    }
    return out;
}

/** Atoms of `structure` within `radius` of any of the given xyz points. */
export function atomsWithin(structure: Structure, points: ArrayLike<number>, radius: number): Loci {
    const hits = new Map<number, Set<number>>();
    const lookup = structure.lookup3d;
    for (let p = 0; p < points.length; p += 3) {
        const { count, units, indices } = lookup.find(points[p], points[p + 1], points[p + 2], radius);
        for (let i = 0; i < count; i++) {
            const id = units[i].id;
            let set = hits.get(id);
            if (!set) hits.set(id, set = new Set());
            set.add(indices[i]);
        }
    }
    const elements: Loci['elements'][0][] = [];
    for (const unit of structure.units) {
        const set = hits.get(unit.id);
        if (!set) continue;
        const sorted = Int32Array.from(set).sort();
        elements.push({ unit, indices: OrderedSet.ofSortedArray(sorted as any) });
    }
    return StructureElement.Loci(structure, elements);
}

// -------------------------------------------------------------- alignment

export interface AlignmentSummary {
    method: AlignMethod;
    /** Maps the mobile structure's coordinates onto the reference. */
    bTransform: Mat4;
    /** RMSD in Å over the paired atoms. */
    rmsd: number;
    /** Number of atom pairs the superposition was computed over. */
    alignedLength: number;
    /** TM-score normalised by the reference length (tmalign only). */
    tmScore?: number;
    /** Sequence alignment score (sequence only). */
    alignmentScore?: number;
    referenceChain?: string;
    mobileChain?: string;
}

const MAX_CHAINS_PER_SIDE = 6;

function chainLabel(loci: Loci): string {
    const loc = StructureElement.Loci.getFirstLocation(loci);
    return loc ? StructureProperties.chain.auth_asym_id(loc) : '?';
}

/** Trace atoms of the loci, one Loci per chain, longest chains first. */
function traceChains(loci: Loci): Loci[] {
    const trace = StructureElement.Loci.intersect(loci, selectTrace(loci.structure));
    return trace.elements
        .filter(e => Unit.isAtomic(e.unit) && OrderedSet.size(e.indices) >= 3)
        .map(e => StructureElement.Loci(loci.structure, [e]))
        .sort((a, b) => lociSize(b) - lociSize(a))
        .slice(0, MAX_CHAINS_PER_SIDE);
}

function requireChains(loci: Loci, role: string): Loci[] {
    const chains = traceChains(loci);
    if (!chains.length) throw new Error(`the ${role} selection has no polymer chain with at least 3 trace atoms`);
    return chains;
}

function alignBySequence(reference: Loci, mobile: Loci): AlignmentSummary {
    let best: AlignmentSummary | undefined;
    for (const a of requireChains(reference, 'reference')) {
        for (const b of requireChains(mobile, 'mobile')) {
            const [r] = alignAndSuperpose([a, b]);
            if (!r || r.nAlignedElements < 3 || Number.isNaN(r.rmsd)) continue;
            if (!best || r.alignmentScore > best.alignmentScore!) {
                best = {
                    method: 'sequence', bTransform: r.bTransform, rmsd: r.rmsd,
                    alignedLength: r.nAlignedElements, alignmentScore: r.alignmentScore,
                    referenceChain: chainLabel(a), mobileChain: chainLabel(b),
                };
            }
        }
    }
    if (!best) throw new Error('sequence alignment found fewer than 3 matching residues');
    return best;
}

function alignByTMAlign(reference: Loci, mobile: Loci): AlignmentSummary {
    let best: AlignmentSummary | undefined;
    for (const a of requireChains(reference, 'reference')) {
        for (const b of requireChains(mobile, 'mobile')) {
            const r = tmAlign(a, b);
            if (r.alignedLength < 3) continue;
            if (!best || r.tmScoreA > best.tmScore!) {
                best = {
                    method: 'tmalign', bTransform: r.bTransform, rmsd: r.rmsd,
                    alignedLength: r.alignedLength, tmScore: r.tmScoreA,
                    referenceChain: chainLabel(a), mobileChain: chainLabel(b),
                };
            }
        }
    }
    if (!best) throw new Error('TM-align found fewer than 3 aligned residues');
    return best;
}

function splitXyz(xyz: Float64Array): MinimizeRmsd.Positions {
    const n = xyz.length / 3;
    const p = MinimizeRmsd.Positions.empty(n);
    for (let i = 0; i < n; i++) { p.x[i] = xyz[3 * i]; p.y[i] = xyz[3 * i + 1]; p.z[i] = xyz[3 * i + 2]; }
    return p;
}

/** Coordinate-only fit: atoms are paired in file order, so both sides need the same count. */
function alignByCoordinates(reference: Loci, mobile: Loci): AlignmentSummary {
    let a = reference, b = mobile;
    if (lociSize(a) !== lociSize(b)) {
        a = StructureElement.Loci.intersect(reference, selectTrace(reference.structure));
        b = StructureElement.Loci.intersect(mobile, selectTrace(mobile.structure));
    }
    const n = lociSize(a);
    if (n !== lociSize(b) || n < 3) {
        throw new Error(
            `method=superpose pairs atoms in order and needs equal counts of at least 3: ` +
            `reference has ${lociSize(reference)} atoms (${lociSize(a)} trace), ` +
            `mobile has ${lociSize(mobile)} atoms (${lociSize(b)} trace)`);
    }
    const r = MinimizeRmsd.compute({ a: splitXyz(lociPositions(a)), b: splitXyz(lociPositions(b)) });
    return { method: 'superpose', bTransform: r.bTransform, rmsd: r.rmsd, alignedLength: n };
}

/**
 * Residue pairing from the SIFTS UniProt mapping; works on whole structures,
 * which must have been built with `structureFromMmCIF(text, { sifts: true })`.
 */
function alignBySIFTS(reference: Loci, mobile: Loci): AlignmentSummary {
    for (const s of [reference.structure, mobile.structure]) {
        if (!SIFTSMapping.Provider.get(s.model).value) {
            throw new Error('method=sifts needs structures loaded with their SIFTS mapping');
        }
    }
    const result = alignAndSuperposeWithSIFTSMapping([reference.structure, mobile.structure], { traceOnly: true });
    const entry = result.entries[0];
    if (!entry) {
        throw new Error(result.zeroOverlapPairs.length
            ? 'method=sifts: the two structures share no UniProt-mapped residues'
            : 'method=sifts: superposition failed');
    }
    const { bTransform, rmsd, nAlignedElements } = entry.transform;
    return { method: 'sifts', bTransform, rmsd, alignedLength: nAlignedElements };
}

/**
 * Superpose `mobile` onto `reference`. For `sequence` and `tmalign` the best
 * scoring chain pair among the selections is used.
 */
export function alignStructures(reference: Loci, mobile: Loci, method: AlignMethod = 'sequence'): AlignmentSummary {
    switch (method) {
        case 'sequence': return alignBySequence(reference, mobile);
        case 'tmalign': return alignByTMAlign(reference, mobile);
        case 'superpose': return alignByCoordinates(reference, mobile);
        case 'sifts': return alignBySIFTS(reference, mobile);
    }
}
