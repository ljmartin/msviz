/**
 * Session: the viewer's whole state as plain data, with no renderer.
 *
 * It owns the loaded models, the current selection, which atoms show which
 * representation, colour layers, and each model's superposition transform.
 * The test suite drives it directly; the browser drives the same object and
 * then mirrors its state into Mol* through the plugin bridge.
 *
 * Coordinates: each model keeps its original Structure forever. A model's
 * `transform` maps those original coordinates into the shared scene, so every
 * Loci stays valid across alignments.
 */

import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure';
import { colorToNumber } from '../parser/colors';
import { HELP_TEXT, parseCommand, sourceOf } from '../parser/command-parser';
import { Command, REPRESENTATIONS, Representation, SelExpr } from '../parser/types';
import {
    AlignmentSummary, alignStructures, allLoci, atomsWithin, chainIds, emptyLoci, fetchSiftsStructure, lociPositions,
    lociSize, selectNamed, selectSpec, wholeResidues,
} from './structure-executor';

type Loci = StructureElement.Loci;

export type StructureLoader = (pdbId: string) => Promise<Structure>;

export interface ColorLayer {
    loci: Loci;
    /** 0xRRGGBB */
    color: number;
}

export interface TransparencyLayer {
    loci: Loci;
    /** 0 opaque .. 1 invisible */
    value: number;
}

export interface ModelEntry {
    readonly id: number;
    /** Alias if one was given, otherwise the PDB id. */
    readonly name: string;
    readonly pdbId: string;
    readonly structure: Structure;
    readonly chainIds: string[];
    /** Default colour of the model, 0xRRGGBB. */
    readonly baseColor: number;
    /** Original coordinates -> scene coordinates. Replaced, never mutated. */
    transform: Mat4;
    /** Atoms displayed in each representation. Values are replaced, never mutated. */
    visible: Map<Representation, Loci>;
    /** Colour overrides, later layers on top. Replaced, never mutated. */
    colors: ColorLayer[];
    /** Transparency per representation, later layers on top. Arrays are replaced, never mutated. */
    transparency: Map<Representation, TransparencyLayer[]>;
}

export interface CommandResult {
    command: Command;
    message: string;
    /** Atoms the command acted on. */
    atomCount?: number;
    alignment?: AlignmentSummary & { mobile: ModelEntry; reference: ModelEntry };
    /** Camera target requested by `focus` or a first `load`; 'all' means everything. */
    focus?: Map<ModelEntry, Loci> | 'all';
    /** For `link`: the commands that reproduce the current scene, joined with "; ". */
    script?: string;
    /** For `camera` with arguments: the view to restore. */
    camera?: number[];
}

const MODEL_COLORS = [0x8fb3d9, 0xe0a66b, 0x8fc49a, 0xd98f9f, 0xb39ad6, 0xd6cf7a, 0x7fc8c8, 0xc79a7f];

const TRACE_BASED: ReadonlySet<Representation> = new Set<Representation>(['cartoon', 'ribbon']);

function union(a: Loci, b: Loci) { return StructureElement.Loci.union(a, b); }
function subtract(a: Loci, b: Loci) { return StructureElement.Loci.subtract(a, b); }
function intersect(a: Loci, b: Loci) { return StructureElement.Loci.intersect(a, b); }

export class Session {
    readonly models: ModelEntry[] = [];
    /** Current selection; undefined when nothing is selected. */
    selection: Map<ModelEntry, Loci> | undefined;
    /** Continuous camera motion. Off until a rock or spin command asks for it. */
    animation: 'rock' | 'spin' | 'off' = 'off';
    /** Statements that have succeeded since the scene was last empty, in order. */
    private readonly script: string[] = [];
    private readonly siftsStructures = new Map<ModelEntry, Promise<Structure>>();

    /**
     * @param loader       fetches the structure for `load`
     * @param siftsLoader  fetches the same entry with its SIFTS mapping, on
     *                     the first `align ... method=sifts` that needs it
     */
    constructor(
        private readonly loader: StructureLoader,
        private readonly siftsLoader: StructureLoader = fetchSiftsStructure,
    ) { }

    /** Parse and execute command text. Shared entry point of the UI and the tests. */
    async run(text: string): Promise<CommandResult[]> {
        const results: CommandResult[] = [];
        for (const command of parseCommand(text)) results.push(await this.execute(command));
        return results;
    }

    async execute(command: Command): Promise<CommandResult> {
        const result = await this.dispatch(command);
        const source = sourceOf(command);
        if (command.kind === 'close' && this.models.length === 0) this.script.length = 0;
        else if (source !== undefined && changesScene(command)) this.script.push(source);
        return result;
    }

    private async dispatch(command: Command): Promise<CommandResult> {
        switch (command.kind) {
            case 'load': return this.load(command);
            case 'select': return this.select(command);
            case 'show': return this.showHide(command, command.repr, true);
            case 'hide': return this.showHide(command, command.repr, false);
            case 'color': return this.color(command);
            case 'transparency': return this.transparency(command);
            case 'align': return this.align(command);
            case 'focus': return this.focus(command);
            case 'close': return this.close(command);
            case 'animate':
                this.animation = command.mode;
                return { command, message: command.mode === 'off' ? 'camera motion stopped' : `${command.mode} on ("stop" to end)` };
            case 'uncolor': return this.uncolor(command);
            case 'camera':
                return command.view
                    ? { command, message: 'camera set', camera: command.view }
                    : { command, message: 'no viewer to read the camera from' };
            case 'link': {
                const script = this.script.join('; ');
                return { command, message: script || 'nothing to link to yet', script };
            }
            case 'help': return { command, message: HELP_TEXT };
        }
    }

    // ------------------------------------------------------------ models

    /** Models named by a reference: an alias, a PDB id, a numeric id or an id range. */
    findModels(ref: string): ModelEntry[] {
        const lower = ref.toLowerCase();
        const byName = this.models.filter(m => m.name.toLowerCase() === lower);
        if (byName.length) return byName;
        const byPdb = this.models.filter(m => m.pdbId.toLowerCase() === lower);
        if (byPdb.length) return byPdb;
        const range = /^(\d+)(?:-(\d+))?$/.exec(ref);
        if (range) {
            const start = parseInt(range[1], 10);
            const end = range[2] === undefined ? start : parseInt(range[2], 10);
            const found = this.models.filter(m => m.id >= start && m.id <= end);
            if (found.length) return found;
        }
        throw new Error(`no model "${ref}" (loaded: ${this.models.map(m => `#${m.id} ${m.name}`).join(', ') || 'none'})`);
    }

    getModel(ref: string): ModelEntry {
        const found = this.findModels(ref);
        if (found.length !== 1) throw new Error(`"${ref}" names ${found.length} models; expected one`);
        return found[0];
    }

    private async load(command: Extract<Command, { kind: 'load' }>): Promise<CommandResult> {
        const name = command.alias ?? command.pdbId;
        if (this.models.some(m => m.name.toLowerCase() === name.toLowerCase())) {
            throw new Error(`a model named "${name}" is already loaded; use "load ${command.pdbId} as <alias>"`);
        }
        const structure = await this.loader(command.pdbId);
        let id = 1;
        while (this.models.some(m => m.id === id)) id++;
        const model: ModelEntry = {
            id, name, pdbId: command.pdbId, structure,
            chainIds: chainIds(structure).sort(),
            baseColor: MODEL_COLORS[(id - 1) % MODEL_COLORS.length],
            transform: Mat4.identity(),
            visible: new Map(),
            colors: [],
            transparency: new Map(),
        };
        // Default display: cartoon for polymers, ball-and-stick for ligands and ions.
        model.visible.set('cartoon', wholeResidues(selectNamed(structure, 'polymer')));
        model.visible.set('ball-and-stick', union(selectNamed(structure, 'ligand'), selectNamed(structure, 'ions')));
        const first = this.models.length === 0;
        this.models.push(model);
        return {
            command,
            message: `#${id} ${name}: ${structure.elementCount} atoms, chains ${model.chainIds.join(' ')}`,
            atomCount: structure.elementCount,
            focus: first ? 'all' : undefined,
        };
    }

    private close(command: Extract<Command, { kind: 'close' }>): CommandResult {
        const doomed = command.model === undefined ? [...this.models] : this.findModels(command.model);
        for (const m of doomed) {
            this.models.splice(this.models.indexOf(m), 1);
            this.selection?.delete(m);
            this.siftsStructures.delete(m);
        }
        if (this.selection && this.selection.size === 0) this.selection = undefined;
        return { command, message: doomed.length ? `closed ${doomed.map(m => `#${m.id} ${m.name}`).join(', ')}` : 'nothing to close' };
    }

    // --------------------------------------------------------- selection

    /** Evaluate a selection expression: one Loci per loaded model (possibly empty). */
    resolve(expr: SelExpr): Map<ModelEntry, Loci> {
        const perModel = (f: (m: ModelEntry) => Loci) => new Map(this.models.map(m => [m, f(m)] as const));
        switch (expr.type) {
            case 'all':
                return perModel(m => allLoci(m.structure));
            case 'current':
                return perModel(m => this.selection?.get(m) ?? emptyLoci(m.structure));
            case 'named':
                return perModel(m => selectNamed(m.structure, expr.name));
            case 'spec': {
                const wanted = expr.models && new Set(expr.models.flatMap(ref => this.findModels(ref)));
                return perModel(m => {
                    if (wanted && !wanted.has(m)) return emptyLoci(m.structure);
                    if (!expr.chains && !expr.residues && !expr.atoms && !expr.elements) return allLoci(m.structure);
                    return selectSpec(m.structure, {
                        chains: expr.chains?.map(c => matchChainId(m, c)),
                        residues: expr.residues,
                        atoms: expr.atoms,
                        elements: expr.elements,
                    });
                });
            }
            case 'and': {
                const l = this.resolve(expr.left), r = this.resolve(expr.right);
                return perModel(m => intersect(l.get(m)!, r.get(m)!));
            }
            case 'or': {
                const l = this.resolve(expr.left), r = this.resolve(expr.right);
                return perModel(m => union(l.get(m)!, r.get(m)!));
            }
            case 'not': {
                const inner = this.resolve(expr.expr);
                return perModel(m => subtract(allLoci(m.structure), inner.get(m)!));
            }
            case 'zone': {
                // Zones span models, so distances are measured in scene coordinates.
                const inner = this.resolve(expr.expr);
                const scene: Float64Array[] = [];
                inner.forEach((loci, m) => { if (lociSize(loci)) scene.push(lociPositions(loci, m.transform)); });
                return perModel(m => {
                    const toModel = Mat4.invert(Mat4(), m.transform);
                    let hits = emptyLoci(m.structure);
                    for (const points of scene) {
                        const local = transformPoints(points, toModel);
                        hits = union(hits, atomsWithin(m.structure, local, expr.distance));
                    }
                    return expr.level === 'residue' ? wholeResidues(hits) : hits;
                });
            }
        }
    }

    /** Total atom count of a resolved selection. */
    static count(resolved: Map<ModelEntry, Loci>): number {
        let n = 0;
        resolved.forEach(loci => { n += lociSize(loci); });
        return n;
    }

    /** What show/hide/color act on: the given selection, else the current one, else everything. */
    private target(selection: SelExpr | undefined): { resolved: Map<ModelEntry, Loci>; scope: string } {
        if (selection) return { resolved: this.resolve(selection), scope: '' };
        if (this.selection) return { resolved: this.resolve({ type: 'current' }), scope: ' of the current selection' };
        return { resolved: this.resolve({ type: 'all' }), scope: '' };
    }

    private select(command: Extract<Command, { kind: 'select' }>): CommandResult {
        if (!command.selection) {
            this.selection = undefined;
            return { command, message: 'selection cleared', atomCount: 0 };
        }
        const resolved = this.resolve(command.selection);
        const atomCount = Session.count(resolved);
        this.selection = atomCount ? resolved : undefined;
        return { command, message: `${atomCount} atoms selected${describeModels(resolved)}`, atomCount };
    }

    // ----------------------------------------------- representations, colour

    private showHide(command: Command, repr: Representation | undefined, show: boolean): CommandResult {
        const { resolved, scope } = this.target((command as { selection?: SelExpr }).selection);
        const reprs = repr ? [repr] : REPRESENTATIONS;
        resolved.forEach((loci, m) => {
            if (!lociSize(loci)) return;
            for (const r of reprs) {
                const atoms = TRACE_BASED.has(r) ? wholeResidues(loci) : loci;
                const old = m.visible.get(r) ?? emptyLoci(m.structure);
                m.visible.set(r, show ? union(old, atoms) : subtract(old, atoms));
            }
        });
        const atomCount = Session.count(resolved);
        return {
            command, atomCount,
            message: `${show ? 'show' : 'hide'} ${repr ?? 'everything'}: ${atomCount} atoms${scope}${describeModels(resolved)}`,
        };
    }

    private color(command: Extract<Command, { kind: 'color' }>): CommandResult {
        const { resolved, scope } = this.target(command.selection);
        const color = colorToNumber(command.color);
        resolved.forEach((loci, m) => {
            const n = lociSize(loci);
            if (!n) return;
            // A layer covering the whole model makes every earlier layer invisible.
            m.colors = n === m.structure.elementCount ? [{ loci, color }] : [...m.colors, { loci, color }];
        });
        const atomCount = Session.count(resolved);
        return { command, atomCount, message: `color ${command.color}: ${atomCount} atoms${scope}${describeModels(resolved)}` };
    }

    private uncolor(command: Extract<Command, { kind: 'uncolor' }>): CommandResult {
        const { resolved, scope } = this.target(command.selection);
        const nonCarbon = command.scope === 'het'
            ? this.resolve({ type: 'not', expr: { type: 'spec', elements: ['C'] } }) : undefined;
        let atomCount = 0;
        resolved.forEach((loci, m) => {
            const target = nonCarbon ? intersect(loci, nonCarbon.get(m)!) : loci;
            const n = lociSize(target);
            if (!n) return;
            atomCount += n;
            m.colors = m.colors
                .map(layer => ({ loci: subtract(layer.loci, target), color: layer.color }))
                .filter(layer => lociSize(layer.loci) > 0);
        });
        const what = command.scope === 'het' ? 'non-carbon atoms' : 'atoms';
        return { command, atomCount, message: `default colours restored: ${atomCount} ${what}${scope}` };
    }

    private transparency(command: Extract<Command, { kind: 'transparency' }>): CommandResult {
        const { resolved, scope } = this.target(command.selection);
        const value = command.percent / 100;
        const reprs = command.repr ? [command.repr] : REPRESENTATIONS;
        resolved.forEach((loci, m) => {
            const n = lociSize(loci);
            if (!n) return;
            for (const r of reprs) {
                const layer = { loci, value };
                // A layer covering the whole model replaces every earlier one.
                const whole = n === m.structure.elementCount;
                const next = whole ? (value === 0 ? [] : [layer]) : [...(m.transparency.get(r) ?? []), layer];
                m.transparency.set(r, next);
            }
        });
        const atomCount = Session.count(resolved);
        return {
            command, atomCount,
            message: `transparency ${command.percent}% on ${command.repr ?? 'every representation'}: ` +
                `${atomCount} atoms${scope}${describeModels(resolved)}`,
        };
    }

    // ---------------------------------------------------------- alignment

    private singleModel(expr: SelExpr, role: string): { model: ModelEntry; loci: Loci } {
        const hits = [...this.resolve(expr)].filter(([, loci]) => lociSize(loci) > 0);
        if (hits.length === 0) throw new Error(`the ${role} selection is empty`);
        if (hits.length > 1) {
            throw new Error(`the ${role} selection spans ${hits.length} models (${hits.map(([m]) => `#${m.id}`).join(', ')}); name one`);
        }
        return { model: hits[0][0], loci: hits[0][1] };
    }

    private siftsStructure(model: ModelEntry): Promise<Structure> {
        let pending = this.siftsStructures.get(model);
        if (!pending) {
            pending = this.siftsLoader(model.pdbId);
            this.siftsStructures.set(model, pending);
            pending.catch(() => this.siftsStructures.delete(model));
        }
        return pending;
    }

    private async align(command: Extract<Command, { kind: 'align' }>): Promise<CommandResult> {
        const mobile = this.singleModel(command.target, 'mobile');
        const reference = this.singleModel(command.reference, 'reference');
        if (mobile.model === reference.model) throw new Error('cannot align a model to itself');

        // Computed on original coordinates, then composed with the reference's
        // own placement so chains of alignments stay consistent.
        const method = command.method ?? 'sequence';
        let summary: AlignmentSummary;
        if (method === 'sifts') {
            // The SIFTS mapping lives in a different file of the same entry
            // (same coordinates), fetched the first time it is needed.
            const [r, m] = await Promise.all([this.siftsStructure(reference.model), this.siftsStructure(mobile.model)]);
            summary = alignStructures(allLoci(r), allLoci(m), 'sifts');
        } else {
            summary = alignStructures(reference.loci, mobile.loci, method);
        }
        mobile.model.transform = Mat4.mul(Mat4(), reference.model.transform, summary.bTransform);

        const chains = summary.mobileChain
            ? ` (chain ${summary.mobileChain} onto chain ${summary.referenceChain})` : '';
        const extra = summary.tmScore !== undefined ? `, TM-score ${summary.tmScore.toFixed(3)}`
            : summary.alignmentScore !== undefined ? `, alignment score ${summary.alignmentScore.toFixed(0)}` : '';
        return {
            command,
            alignment: { ...summary, mobile: mobile.model, reference: reference.model },
            message: `aligned #${mobile.model.id} ${mobile.model.name} to #${reference.model.id} ${reference.model.name} ` +
                `by ${summary.method}${chains}: RMSD ${summary.rmsd.toFixed(2)} Å over ${summary.alignedLength} pairs${extra}`,
        };
    }

    private focus(command: Extract<Command, { kind: 'focus' }>): CommandResult {
        if (!command.selection) return { command, message: 'focus on everything', focus: 'all' };
        const resolved = this.resolve(command.selection);
        const atomCount = Session.count(resolved);
        if (!atomCount) throw new Error('nothing to focus on: the selection is empty');
        return { command, atomCount, focus: resolved, message: `focus on ${atomCount} atoms` };
    }
}

/** Exact chain id if the model has it, otherwise a case-insensitive match. */
function matchChainId(model: ModelEntry, id: string): string {
    if (model.chainIds.includes(id)) return id;
    const lower = id.toLowerCase();
    return model.chainIds.find(c => c.toLowerCase() === lower) ?? id;
}

/** False for commands that only report something. */
function changesScene(command: Command): boolean {
    return command.kind !== 'help' && command.kind !== 'link' && !(command.kind === 'camera' && !command.view);
}

function describeModels(resolved: Map<ModelEntry, Loci>): string {
    if (resolved.size < 2) return '';
    const parts: string[] = [];
    resolved.forEach((loci, m) => { if (lociSize(loci)) parts.push(`#${m.id}: ${lociSize(loci)}`); });
    return parts.length ? ` (${parts.join(', ')})` : '';
}

function transformPoints(points: Float64Array, m: Mat4): Float64Array {
    const out = new Float64Array(points.length);
    for (let i = 0; i < points.length; i += 3) {
        const x = points[i], y = points[i + 1], z = points[i + 2];
        out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    return out;
}
