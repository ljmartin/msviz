/**
 * Creates the Mol* plugin and mounts its canvas. Browser only.
 *
 * This is a bare PluginContext (canvas and state tree, no React control
 * panels): the command box is the whole interface.
 */

import { StructureFocusRepresentation } from 'molstar/lib/mol-plugin/behavior/dynamic/selection/structure-focus-representation';
import { PluginBehaviors } from 'molstar/lib/mol-plugin/behavior';
import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec';
import { Color } from 'molstar/lib/mol-util/color';

export async function createPlugin(target: HTMLElement, backgroundColor = 0x14161a): Promise<PluginContext> {
    const spec = DefaultPluginSpec();
    // Clicking a residue would otherwise add Mol*'s own "focus" representations,
    // which would fight with the show/hide state owned by the session.
    spec.behaviors = spec.behaviors.filter(b =>
        b.transformer !== PluginBehaviors.Representation.FocusLoci &&
        b.transformer !== StructureFocusRepresentation);

    const plugin = new PluginContext(spec);
    await plugin.init();
    if (!await plugin.mountAsync(target)) {
        throw new Error('could not create a WebGL canvas');
    }
    plugin.canvas3d?.setProps({
        renderer: { backgroundColor: Color(backgroundColor) },
        camera: { helper: { axes: { name: 'off', params: {} } } },
    });
    return plugin;
}
