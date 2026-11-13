# MolView — Design Document

A local structural biology viewer built on Mol*, with a text command interface
for selection, representation, and structural alignment.

---

## Goals

- Embed the Mol* (`molstar`) viewer in a local browser-based app
- Accept text commands to select atoms (by chain, residue range, etc.) and
  toggle their representations (cartoon, surface, ball-and-stick, etc.)
- Support structural alignment: sequence-guided (`alignAndSuperpose`),
  coordinate-only (`superpose`), structure-based (`tmAlign`), and
  SIFTS-guided (`alignAndSuperposeWithSIFTSMapping`)
- Keep the command parser in a pure TypeScript layer that is independently
  testable in Node.js with no browser dependency
- The same command strings that drive the text box also drive the test suite

---

## Non-Goals (for now)

- No backend server — everything runs locally in the browser or in Node for tests
- No native wrapper (no Swift/Electron) at this stage; a Vite dev server is sufficient
- No CDN sourcing until a working prototype is validated (npm install molstar)

---

## Architecture
```
┌──────────────────────────────────────────────┐
│              Command String                  │
│  &quot;load 1ABC; select chain A; show cartoon&quot;   │
└────────────────────┬─────────────────────────┘
                     │
             parseCommand(str)
              (pure TypeScript)
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
  Vitest test suite          Browser UI (Vite)
  (Node.js, no DOM)          drives PluginContext
  asserts atom count,        updates representations
  COM distance, RMSD         via mol-plugin API
```

The command parser is the shared contract between the test suite and the UI.
It is a pure TypeScript module with no dependency on the DOM, the Mol* plugin,
or any renderer. Both consumers feed it the same strings.

---

## Stack

| Layer | Technology |
|---|---|
| Viewer library | `molstar` (npm, full package) |
| Build / dev server | Vite + TypeScript |
| Test runner | Vitest (Node mode — no jsdom) |
| UI | Plain HTML + one `<textarea>` input box |
| Distribution | `npx vite` locally; Electron optional later |

```bash
npm create vite@latest molview -- --template vanilla-ts
cd molview
npm install molstar vitest
npx vite          # dev server
npx vitest        # test suite
```

---

## Mol* Layering — What Lives Where

Mol* has a clean internal split. Only the renderer needs a browser.

| Module | Needs DOM? | Used in |
|---|---|---|
| `mol-model` — Structure, Model, Selection | ❌ No | Parser, tests, UI |
| `mol-model-formats` — mmCIF/PDB parsers | ❌ No | Parser, tests, UI |
| `mol-script` — MolQL query builder | ❌ No | Parser, tests, UI |
| `mol-math` — linear algebra, TM-align | ❌ No | Parser, tests, UI |
| `mol-plugin` — PluginContext, state tree | ❌ No | UI only (drives renderer) |
| `mol-canvas3d` — WebGL renderer | ✅ Yes | UI only |
| `mol-plugin-ui` — React components | ✅ Yes | UI only (optional) |

The test suite imports only from the first four groups. The UI additionally
imports from `mol-plugin`.

---

## File Structure

```
molview/
├── src/
│   ├── parser/
│   │   ├── tokeniser.ts        # splits &quot;load 1ABC; select chain A&quot; into tokens
│   │   ├── command-parser.ts   # maps token trees → CommandAST
│   │   └── types.ts            # CommandAST type definitions
│   │
│   ├── executor/
│   │   ├── structure-executor.ts  # pure-TS: loads structures, runs selections,
│   │   │                          # superpositions — no DOM, no plugin
│   │   └── com-helper.ts          # centerOfMass() from a Loci
│   │
│   ├── plugin/
│   │   ├── plugin-bridge.ts    # translates CommandAST → PluginContext API calls
│   │   └── viewer-init.ts      # creates and mounts the Mol* PluginUIContext
│   │
│   ├── ui/
│   │   ├── index.html          # one div for the viewer, one textarea for commands
│   │   └── app.ts              # wires textarea → parseCommand → plugin-bridge
│   │
│   └── test-helpers/
│       └── structure-loader.ts # loadStructureFromString() for tests
│
└── tests/
    ├── selection.test.ts
    └── alignment.test.ts
```

---

## The Selection DSL

A minimal command language. Commands are separated by semicolons or newlines.
All keywords are case-insensitive.

### Supported commands (initial scope)

```
load &lt;PDBID&gt;
load &lt;PDBID&gt; as &lt;alias&gt;

select chain &lt;ID&gt;
select chain &lt;ID&gt; residues &lt;start&gt;-&lt;end&gt;
select chain &lt;ID&gt; residues &lt;start&gt;-&lt;end&gt; atoms CA

show &lt;representation&gt; [selection]
hide &lt;representation&gt; [selection]

color &lt;colorname|#hex&gt; [selection]

align &lt;model2|alias&gt; to &lt;model1|alias&gt;
align &lt;model2|alias&gt; to &lt;model1|alias&gt; method=sequence
align &lt;model2|alias&gt; to &lt;model1|alias&gt; method=tmalign
align &lt;model2|alias&gt; to &lt;model1|alias&gt; method=sifts
```

### Representations
`cartoon` | `surface` | `ball-and-stick` | `spacefill` | `ribbon`

### Example session
```
load 1ABC
load 2XYZ as ref
align 1ABC to ref method=tmalign
select chain A residues 10-50
show cartoon
hide surface
color #ff4444
```

---

## The Command Parser

`parseCommand(str: string): CommandAST[]`

Located in `src/parser/command-parser.ts`. Pure TypeScript — no molstar
imports, no DOM. Takes a raw string, returns a typed AST.

```ts
// src/parser/types.ts

export type Command =
  | { kind: &#x27;load&#x27;;   pdbId: string; alias?: string }
  | { kind: &#x27;select&#x27;; chain: string; residues?: [number, number]; atoms?: string }
  | { kind: &#x27;show&#x27;;   repr: Representation; selection?: SelectionRef }
  | { kind: &#x27;hide&#x27;;   repr: Representation; selection?: SelectionRef }
  | { kind: &#x27;color&#x27;;  color: string;        selection?: SelectionRef }
  | { kind: &#x27;align&#x27;;  target: string; reference: string;
      method?: &#x27;sequence&#x27; | &#x27;tmalign&#x27; | &#x27;sifts&#x27; };

export type Representation = &#x27;cartoon&#x27; | &#x27;surface&#x27; | &#x27;ball-and-stick&#x27; | &#x27;spacefill&#x27; | &#x27;ribbon&#x27;;
export type SelectionRef   = { chain: string; residues?: [number, number] };
```

The parser is the only place where DSL strings are interpreted. The executor
and plugin-bridge consume only `Command` objects — never raw strings.

---

## The Structure Executor (Pure-TS Layer)

`src/executor/structure-executor.ts`

This module owns:
- Loading and caching `Structure` objects from mmCIF text
- Running MolQL selections → `StructureElement.Loci`
- Applying superposition transforms to coordinate arrays

It imports from `mol-model`, `mol-model-formats`, `mol-script`, and `mol-math`
only. No `mol-plugin`, no `mol-canvas3d`.

### Structure loader (also used in tests)

```ts
// src/test-helpers/structure-loader.ts
import { CIF } from &#x27;molstar/lib/mol-io/reader/cif&#x27;;
import { trajectoryFromMmCIF } from &#x27;molstar/lib/mol-model-formats/structure/mmcif&#x27;;
import { Model, Structure } from &#x27;molstar/lib/mol-model/structure&#x27;;

export async function loadStructureFromString(pdbId: string): Promise&lt;Structure&gt; {
  const url = `https://files.rcsb.org/download/${pdbId}.cif`;
  const cif = await fetch(url).then(r =&gt; r.text());
  const parsed = await CIF.parseText(cif).run();
  const traj = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const model = await Model.trajectoryFromModel(traj.representative).run();
  return Structure.ofModel(model);
}
```

### Selection (MolQL)

```ts
// src/executor/structure-executor.ts (excerpt)
import { Script } from &#x27;molstar/lib/mol-script/script&#x27;;
import { StructureSelection, StructureElement } from &#x27;molstar/lib/mol-model/structure&#x27;;

export function selectByChainAndResidues(
  structure: Structure,
  chain: string,
  residues?: [number, number]
): StructureElement.Loci {

  const sel = Script.getStructureSelection(Q =&gt; {
    const tests: Record&lt;string, any&gt; = {
      &#x27;chain-test&#x27;: Q.core.rel.eq([
        Q.struct.atomProperty.macromolecular.auth_asym_id(), chain
      ])
    };
    if (residues) {
      tests[&#x27;residue-test&#x27;] = Q.core.rel.inRange([
        Q.struct.atomProperty.macromolecular.auth_seq_id(),
        residues[0], residues[1]
      ]);
    }
    return Q.struct.generator.atomGroups(tests);
  }, structure);

  return StructureSelection.toLociWithSourceUnits(sel);
}
```

### Alignment

```ts
import { alignAndSuperpose } from &#x27;molstar/lib/mol-model/structure/structure/util/superposition&#x27;;
import { tmAlign }           from &#x27;molstar/lib/mol-model/structure/structure/util/tm-align&#x27;;

export function alignStructures(
  sel1: StructureElement.Loci,
  sel2: StructureElement.Loci,
  method: &#x27;sequence&#x27; | &#x27;tmalign&#x27; | &#x27;sifts&#x27; = &#x27;sequence&#x27;
) {
  if (method === &#x27;tmalign&#x27;) return tmAlign(sel1, sel2);
  return alignAndSuperpose([sel1, sel2]);
  // result.transforms[0].bTransform — the 4×4 matrix to apply to sel2&#x27;s model
  // result.transforms[0].rmsd      — RMSD of the superposition
}
```

---

## The Plugin Bridge (Browser Only)

`src/plugin/plugin-bridge.ts`

Translates `Command` objects into `PluginContext` API calls. This is the only
file that imports from `mol-plugin` or `mol-canvas3d`.

```ts
// apply a superposition transform to a structure in the plugin state tree
import { Mat4 } from &#x27;molstar/lib/mol-math/linear-algebra&#x27;;
import { StateTransforms } from &#x27;molstar/lib/mol-plugin-state/transforms&#x27;;

async function applyTransform(plugin: PluginContext, structureRef: string, matrix: Mat4) {
  await plugin.build()
    .to(structureRef)
    .insert(StateTransforms.Model.TransformStructureConformation, { transform: { name: &#x27;matrix&#x27;, params: { data: matrix, transpose: false } } })
    .commit();
}
```

Representations and visibility:

```ts
// hide/show a component by its state-tree ref
import { setSubtreeVisibility } from &#x27;molstar/lib/mol-plugin/behavior/static/state&#x27;;

setSubtreeVisibility(plugin.state.data, componentRef, isHidden);

// add a representation to a component
await plugin.managers.structure.component.addRepresentation(component, {
  type: &#x27;cartoon&#x27;   // or &#x27;surface&#x27;, &#x27;ball-and-stick&#x27;, etc.
});
```

---

## Test Strategy

Tests live in `tests/` and run with `npx vitest` in Node mode.
They import only from `src/parser`, `src/executor`, and `src/test-helpers`.
No plugin, no DOM, no browser.

The key principle: **tests use the same command strings as the UI text box.**
`runCommands(str)` is the shared entry point for both.

### Test 1 — Selection: assert atom count

```ts
// tests/selection.test.ts
import { describe, it, expect } from &#x27;vitest&#x27;;
import { loadStructureFromString } from &#x27;../src/test-helpers/structure-loader&#x27;;
import { selectByChainAndResidues } from &#x27;../src/executor/structure-executor&#x27;;
import { StructureElement } from &#x27;molstar/lib/mol-model/structure&#x27;;

describe(&#x27;selection&#x27;, () =&gt; {
  it(&#x27;selects the correct number of atoms for chain A residues 10-50&#x27;, async () =&gt; {
    const structure = await loadStructureFromString(&#x27;1ABC&#x27;);
    const loci = selectByChainAndResidues(structure, &#x27;A&#x27;, [10, 50]);

    const atomCount = StructureElement.Loci.size(loci);
    expect(atomCount).toBeGreaterThan(0);
    // once you know the expected count from a reference tool, pin it:
    // expect(atomCount).toBe(412);
  });
});
```

### Test 2 — Alignment: assert COM overlap and RMSD

```ts
// tests/alignment.test.ts
import { describe, it, expect } from &#x27;vitest&#x27;;
import { loadStructureFromString } from &#x27;../src/test-helpers/structure-loader&#x27;;
import { selectCAlphas, alignStructures } from &#x27;../src/executor/structure-executor&#x27;;
import { StructureElement } from &#x27;molstar/lib/mol-model/structure&#x27;;

// COM helper — lives in src/executor/com-helper.ts
function centerOfMass(loci: StructureElement.Loci): [number, number, number] {
  const n = StructureElement.Loci.size(loci);
  const pos = StructureElement.Loci.toPositionsArray(loci, new Float32Array(3 * n));
  let x = 0, y = 0, z = 0;
  for (let i = 0; i &lt; n; i++) { x += pos[3*i]; y += pos[3*i+1]; z += pos[3*i+2]; }
  return [x/n, y/n, z/n];
}

function euclidean(a: [number,number,number], b: [number,number,number]): number {
  return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
}

describe(&#x27;alignment&#x27;, () =&gt; {
  it(&#x27;COMs overlap within 5Å and RMSD is reasonable after sequence alignment&#x27;, async () =&gt; {
    // This is the same string you would type in the UI text box:
    const s1 = await loadStructureFromString(&#x27;1ABC&#x27;);
    const s2 = await loadStructureFromString(&#x27;2XYZ&#x27;);

    const sel1 = selectCAlphas(s1, &#x27;A&#x27;);
    const sel2 = selectCAlphas(s2, &#x27;A&#x27;);

    const result = alignStructures(sel1, sel2, &#x27;sequence&#x27;);
    const { rmsd, bTransform } = result.transforms[0];

    // Apply bTransform to s2&#x27;s coordinates, then recompute COM
    const com1 = centerOfMass(sel1);
    const com2Aligned = centerOfMass(applyTransformToLoci(sel2, bTransform));

    expect(euclidean(com1, com2Aligned)).toBeLessThan(5.0);  // co-located
    expect(rmsd).toBeLessThan(3.0);                          // meaningful alignment
  });
});
```

### Running tests

```bash
npx vitest run          # run once
npx vitest              # watch mode
npx vitest --reporter=verbose
```

---

## Wiring the UI Text Box

`src/ui/app.ts` — the entire browser-side entry point:

```ts
import { createPlugin } from &#x27;./plugin/viewer-init&#x27;;
import { parseCommand } from &#x27;./parser/command-parser&#x27;;
import { executeCommand } from &#x27;./plugin/plugin-bridge&#x27;;

const plugin = await createPlugin(document.getElementById(&#x27;viewer&#x27;)!);

document.getElementById(&#x27;cmd-input&#x27;)!
  .addEventListener(&#x27;keydown&#x27;, async (e: KeyboardEvent) =&gt; {
    if (e.key !== &#x27;Enter&#x27;) return;
    const input = e.currentTarget as HTMLTextAreaElement;
    const commands = parseCommand(input.value);   // same parser as tests
    for (const cmd of commands) {
      await executeCommand(plugin, cmd);           // plugin-bridge drives Mol*
    }
    input.value = &#x27;&#x27;;
  });
```

The `index.html` is minimal:

```html
&lt;!DOCTYPE html&gt;
&lt;html&gt;
&lt;head&gt;
  &lt;link rel=&quot;stylesheet&quot; href=&quot;./node_modules/molstar/build/viewer/molstar.css&quot;&gt;
&lt;/head&gt;
&lt;body&gt;
  &lt;div id=&quot;viewer&quot; style=&quot;width:100%;height:80vh;&quot;&gt;&lt;/div&gt;
  &lt;textarea id=&quot;cmd-input&quot; rows=&quot;3&quot;
    placeholder=&quot;load 1ABC; select chain A residues 10-50; show cartoon&quot;&gt;
  &lt;/textarea&gt;
  &lt;script type=&quot;module&quot; src=&quot;/src/ui/app.ts&quot;&gt;&lt;/script&gt;
&lt;/body&gt;
&lt;/html&gt;
```

---

## Development Phases

| Phase | Deliverable | Tests |
|---|---|---|
| 1 | Command parser + type definitions | Unit tests: parse strings → correct AST |
| 2 | Structure executor: load, select | `StructureElement.Loci.size()` assertions |
| 3 | Plugin bridge: viewer init, show/hide | Manual in browser |
| 4 | Alignment executor: all 4 methods | RMSD + COM assertions |
| 5 | Full UI: text box → parse → execute | End-to-end: type in browser, see result |
| 6 | CDN eval | Load `molstar.js` from jsDelivr; check `molstar.lib.structure` exposes needed symbols |

---

## Key Mol* Imports Reference

```ts
// Selection
import { Script }                    from &#x27;molstar/lib/mol-script/script&#x27;;
import { StructureSelection,
         StructureElement,
         Structure, Model }          from &#x27;molstar/lib/mol-model/structure&#x27;;

// Parsing / loading
import { CIF }                       from &#x27;molstar/lib/mol-io/reader/cif&#x27;;
import { trajectoryFromMmCIF }       from &#x27;molstar/lib/mol-model-formats/structure/mmcif&#x27;;

// Alignment
import { alignAndSuperpose,
         superpose,
         alignAndSuperposeWithSIFTSMapping }
                                     from &#x27;molstar/lib/mol-model/structure/structure/util/superposition&#x27;;
import { tmAlign }                   from &#x27;molstar/lib/mol-model/structure/structure/util/tm-align&#x27;;
import { TMAlign }                   from &#x27;molstar/lib/mol-math/linear-algebra/3d/tm-align&#x27;;

// Plugin (browser only — do not import in executor or tests)
import { PluginUIContext }            from &#x27;molstar/lib/mol-plugin-ui/context&#x27;;
import { setSubtreeVisibility }      from &#x27;molstar/lib/mol-plugin/behavior/static/state&#x27;;
import { StateTransforms }           from &#x27;molstar/lib/mol-plugin-state/transforms&#x27;;
import { Mat4 }                      from &#x27;molstar/lib/mol-math/linear-algebra&#x27;;
```

---

## Notes for the Coding Session

1. **Start with the parser and types.** Get `parseCommand` returning correct ASTs
   for all DSL forms before touching Mol*. This is pure TS with no dependencies.

2. **Write the selection test first, before the executor.** The test defines the
   contract; the executor just has to satisfy it.

3. **The executor imports from `mol-model` only.** If you find yourself importing
   from `mol-plugin` inside `structure-executor.ts`, something has gone wrong.

4. **`StructureElement.Loci.size(loci)`** is your primary assertion primitive.

5. **`transforms[0].rmsd`** is a direct return value of `alignAndSuperpose` and
   `tmAlign` — assert on it directly rather than recomputing from coordinates
   where possible.

6. **CDN evaluation (Phase 6):** load the CDN build in a plain HTML file and
   run `console.log(Object.keys(molstar.lib.structure))` in the browser console.
   If `alignAndSuperpose` and `tmAlign` are present, the CDN build is sufficient
   for production. If not, keep npm + Vite.
