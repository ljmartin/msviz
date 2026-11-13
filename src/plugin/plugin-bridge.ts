/**
 * Plugin bridge: mirrors the Session's state into the Mol* state tree.
 * Browser only, and the only module that drives the plugin.
 *
 * Commands are executed by the Session (the same code the tests run); the
 * bridge then diffs the session against what it last pushed and issues one
 * state-tree update. Per model the tree is
 *
 *   download -> cif -> trajectory -> model -> structure
 *     -> transform (superposition matrix)
 *          -> component "cartoon"        -> representation [-> overpaint] [-> transparency]
 *          -> component "ball-and-stick" -> representation [-> overpaint] [-> transparency]
 *          ...
 *
 * with one component per representation type, holding exactly the atoms the
 * session says are shown in that representation.
 */

import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { InteractionsRepresentationProvider } from 'molstar/lib/mol-model-props/computed/representations/interactions';
import { InteractionTypeColorThemeProvider } from 'molstar/lib/mol-model-props/computed/themes/interaction-type';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure';
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { Color } from 'molstar/lib/mol-util/color';
import { ColorLayer, CommandResult, ModelEntry, Session, TransparencyLayer } from '../executor/session';
import { lociSize, rcsbCifUrl } from '../executor/structure-executor';
import { parseCommand } from '../parser/command-parser';
import { Command, REPRESENTATIONS, Representation } from '../parser/types';

type Loci = StructureElement.Loci;

interface ModelNodes {
    /** Root of this model's subtree; deleting it removes everything. */
    dataRef: string;
    transformRef: string;
    prefix: string;
    /** What was last pushed to the plugin, compared by identity. */
    transform: Mat4;
    visible: Map<Representation, Loci>;
    colors: ColorLayer[];
    painted: Set<Representation>;
    /** Transparency layers last pushed per representation; a key exists only while its node does. */
    transparency: Map<Representation, TransparencyLayer[]>;
}

function matrixParams(m: Mat4) {
    return { transform: { name: 'matrix' as const, params: { data: Mat4.copy(Mat4(), m), transpose: false } } };
}

export class PluginBridge {
    readonly session: Session;
    private readonly nodes = new Map<Structure, ModelNodes>();
    private readonly bundles = new WeakMap<ColorLayer | TransparencyLayer, StructureElement.Bundle>();
    private uid = 0;

    constructor(readonly plugin: PluginContext) {
        this.session = new Session(pdbId => this.load(pdbId));
    }

    /** Parse and execute command text, reporting each result as it completes. */
    async run(text: string, onResult?: (result: CommandResult) => void): Promise<CommandResult[]> {
        const results: CommandResult[] = [];
        for (const command of parseCommand(text)) {
            const result = await this.execute(command);
            results.push(result);
            onResult?.(result);
        }
        return results;
    }

    async execute(command: Command): Promise<CommandResult> {
        try {
            const result = await this.session.execute(command);
            await this.sync();
            this.applyFocus(result);
            return result;
        } catch (e) {
            // Keep the scene consistent with the session even after a failure.
            await this.sync();
            throw e;
        }
    }

    // ---------------------------------------------------------- loading

    /** The Session's loader: the plugin downloads and parses, and hands back its Structure. */
    private async load(pdbId: string): Promise<Structure> {
        const { plugin } = this;
        const data = await plugin.builders.data.download({ url: rcsbCifUrl(pdbId), isBinary: false, label: pdbId });
        try {
            const trajectory = await plugin.builders.structure.parseTrajectory(data, 'mmcif');
            const model = await plugin.builders.structure.createModel(trajectory);
            const structure = await plugin.builders.structure.createStructure(model, { name: 'model', params: {} });
            const transform = Mat4.identity();
            const transformed = await plugin.build().to(structure)
                .apply(StateTransforms.Model.TransformStructureConformation, matrixParams(transform))
                .commit();
            const source = structure.data;
            if (!source) throw new Error(`could not build a structure for ${pdbId}`);
            this.nodes.set(source, {
                dataRef: data.ref, transformRef: transformed.ref, prefix: `mv${++this.uid}`,
                transform, visible: new Map(), colors: [], painted: new Set(), transparency: new Map(),
            });
            return source;
        } catch (e) {
            await plugin.build().delete(data.ref).commit();
            throw e;
        }
    }

    // ------------------------------------------------------------- sync

    private representationParams(model: ModelEntry, repr: Representation) {
        const value = Color(model.baseColor);
        const uniform = { color: 'uniform' as const, colorParams: { value } };
        const byElement = {
            color: 'element-symbol' as const,
            colorParams: { carbonColor: { name: 'uniform' as const, params: { value, saturation: 0, lightness: 0 } } },
        };
        const { plugin } = this;
        const s = model.structure;
        switch (repr) {
            case 'cartoon': return createStructureRepresentationParams(plugin, s, { type: 'cartoon', ...uniform });
            case 'ribbon': return createStructureRepresentationParams(plugin, s, { type: 'backbone', ...uniform });
            case 'surface': return createStructureRepresentationParams(plugin, s, { type: 'molecular-surface', ...uniform });
            case 'ball-and-stick': return createStructureRepresentationParams(plugin, s, { type: 'ball-and-stick', ...byElement });
            case 'spacefill': return createStructureRepresentationParams(plugin, s, { type: 'spacefill', ...byElement });
            // The detector Mol*'s focus mode uses. The component holds the atoms
            // of interest; includeParent lets it find partners in the rest of the
            // model, and 'full' draws every contact with at least one end in the
            // component.
            case 'interactions': return createStructureRepresentationParams(plugin, s, {
                type: InteractionsRepresentationProvider,
                color: InteractionTypeColorThemeProvider,
                typeParams: { includeParent: true, parentDisplay: 'full' },
            });
        }
    }

    private bundle(layer: ColorLayer | TransparencyLayer): StructureElement.Bundle {
        let bundle = this.bundles.get(layer);
        if (!bundle) this.bundles.set(layer, bundle = StructureElement.Bundle.fromLoci(layer.loci));
        return bundle;
    }

    private paintLayers(model: ModelEntry) {
        return model.colors.map(layer => ({ bundle: this.bundle(layer), color: Color(layer.color), clear: false }));
    }

    private alphaLayers(layers: TransparencyLayer[]) {
        return layers.map(layer => ({ bundle: this.bundle(layer), value: layer.value }));
    }

    /** Push every difference between the session and the plugin in one state update. */
    private async sync(): Promise<void> {
        const { plugin, session } = this;
        const update = plugin.build();
        let dirty = false;

        const live = new Set(session.models.map(m => m.structure));
        for (const [structure, n] of this.nodes) {
            if (live.has(structure)) continue;
            update.delete(n.dataRef);
            this.nodes.delete(structure);
            dirty = true;
        }

        for (const model of session.models) {
            const n = this.nodes.get(model.structure);
            if (!n) continue;

            if (n.transform !== model.transform) {
                update.to(n.transformRef).update(matrixParams(model.transform));
                n.transform = model.transform;
                dirty = true;
            }

            const colorsChanged = n.colors !== model.colors;
            n.colors = model.colors;

            for (const repr of REPRESENTATIONS) {
                const loci = model.visible.get(repr);
                const shown = loci !== undefined && lociSize(loci) > 0;
                const exists = n.visible.has(repr);
                const component = `${n.prefix}-${repr}`;
                const representation = `${component}-repr`;
                const paint = `${component}-paint`;
                const alpha = `${component}-alpha`;
                // Interaction lines keep their per-type colours; colour and
                // transparency commands address atoms, not contacts.
                const styled = repr !== 'interactions';

                if (!shown) {
                    if (exists) {
                        update.delete(component);
                        n.visible.delete(repr);
                        n.painted.delete(repr);
                        n.transparency.delete(repr);
                        dirty = true;
                    }
                    continue;
                }

                const type = { name: 'bundle' as const, params: StructureElement.Bundle.fromLoci(loci) };
                if (!exists) {
                    const r = update.to(n.transformRef)
                        .apply(StateTransforms.Model.StructureComponent, { type, label: repr }, { ref: component })
                        .apply(StateTransforms.Representation.StructureRepresentation3D,
                            this.representationParams(model, repr), { ref: representation });
                    if (styled && model.colors.length) {
                        r.apply(StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle,
                            { layers: this.paintLayers(model) }, { ref: paint });
                        n.painted.add(repr);
                    }
                    const alphaLayers = styled ? model.transparency.get(repr) ?? [] : [];
                    if (alphaLayers.length) {
                        r.apply(StateTransforms.Representation.TransparencyStructureRepresentation3DFromBundle,
                            { layers: this.alphaLayers(alphaLayers) }, { ref: alpha });
                        n.transparency.set(repr, alphaLayers);
                    }
                    n.visible.set(repr, loci);
                    dirty = true;
                    continue;
                }

                const wantAlpha = styled ? model.transparency.get(repr) ?? [] : [];
                const haveAlpha = n.transparency.get(repr);
                if (wantAlpha !== haveAlpha && (wantAlpha.length || haveAlpha)) {
                    if (!wantAlpha.length) {
                        update.delete(alpha);
                        n.transparency.delete(repr);
                    } else if (haveAlpha) {
                        update.to(alpha).update({ layers: this.alphaLayers(wantAlpha) });
                        n.transparency.set(repr, wantAlpha);
                    } else {
                        update.to(representation).apply(
                            StateTransforms.Representation.TransparencyStructureRepresentation3DFromBundle,
                            { layers: this.alphaLayers(wantAlpha) }, { ref: alpha });
                        n.transparency.set(repr, wantAlpha);
                    }
                    dirty = true;
                }

                if (n.visible.get(repr) !== loci) {
                    update.to(component).update(StateTransforms.Model.StructureComponent, old => ({ ...old, type }));
                    n.visible.set(repr, loci);
                    dirty = true;
                }
                if (colorsChanged && styled) {
                    const layers = this.paintLayers(model);
                    if (n.painted.has(repr)) {
                        update.to(paint).update({ layers });
                    } else {
                        update.to(representation).apply(
                            StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle,
                            { layers }, { ref: paint });
                        n.painted.add(repr);
                    }
                    dirty = true;
                }
            }
        }

        if (dirty) await update.commit();
        this.markSelection();
        this.applyAnimation();
    }

    /**
     * Set the camera motion from the session. Applied after every command, so
     * the session stays the single owner of this setting.
     */
    private applyAnimation() {
        const canvas = this.plugin.canvas3d;
        if (!canvas) return;
        const want = this.session.animation;
        if (canvas.props.trackball.animate.name === want) return;
        const animate = want === 'rock' ? { name: 'rock' as const, params: { speed: 0.3, angle: 10, axis: Vec3.create(0, -1, 0) } }
            : want === 'spin' ? { name: 'spin' as const, params: { speed: 0.1, axis: Vec3.create(0, -1, 0) } }
                : { name: 'off' as const, params: {} };
        canvas.setProps({ trackball: { animate } });
    }

    // ------------------------------------------- selection mark, camera

    /** The structure as placed in the scene (after the superposition transform). */
    private sceneStructure(model: ModelEntry): Structure | undefined {
        const n = this.nodes.get(model.structure);
        return n && this.plugin.state.data.cells.get(n.transformRef)?.obj?.data;
    }

    private toScene(model: ModelEntry, loci: Loci): Loci | undefined {
        const s = this.sceneStructure(model);
        return s && StructureElement.Loci.remap(loci, s);
    }

    /** Outline the session's current selection in the viewport. */
    private markSelection() {
        const selects = this.plugin.managers.interactivity.lociSelects;
        selects.deselectAll();
        this.session.selection?.forEach((loci, model) => {
            const scene = lociSize(loci) ? this.toScene(model, loci) : undefined;
            if (scene) selects.select({ loci: scene }, false);
        });
    }

    private applyFocus(result: CommandResult) {
        const { camera } = this.plugin.managers;
        if (result.focus === 'all') {
            camera.reset();
        } else if (result.focus) {
            const targets: Loci[] = [];
            result.focus.forEach((loci, model) => {
                const scene = lociSize(loci) ? this.toScene(model, loci) : undefined;
                if (scene) targets.push(scene);
            });
            if (targets.length) camera.focusLoci(targets);
        }
    }
}

/** Execute one parsed command against the viewer. */
export function executeCommand(bridge: PluginBridge, command: Command): Promise<CommandResult> {
    return bridge.execute(command);
}
