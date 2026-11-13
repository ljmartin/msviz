# molstar viz

a visualizer using molstar, with a text input for loading structures, selection commands, showing/hiding representations, and structure superposition.

this was an experiment to test out Claude Fable. It's not intended for anyone to actually use except for fun.

live at https://ljmartin.github.io/msviz/

## Usage

Type commands into the box under the viewer. Enter runs them, Shift+Enter adds a line, and Up/Down recall earlier commands. `help` prints the reference below.

```
Commands (separate with ; or newlines, keywords are case-insensitive)

  load <PDBID> [as <alias>]            fetch a structure from RCSB
  select <selection> | select clear    set the current selection
  show <repr> [selection]              also: show <selection> <repr>
  hide [repr] [selection]              no repr hides every representation
  color <name|#hex> [selection]        also: color <selection> <color>
  color byhet [selection]              undo colouring on non-carbon atoms (back to element colours)
  color default [selection]            undo colouring on every atom
  transparency <0-100> [selection] [repr|all]   surfaces unless a repr is named; 0 is opaque
  align <mobile> to <reference> [method=sequence|tmalign|sifts|superpose]
  focus [selection]                    centre the camera
  close [model]                        remove one model, or all of them
  rock | spin | stop                   camera motion (off by default); also rock off, spin off
  camera [px,py,pz tx,ty,tz ux,uy,uz r]  print the current view, or restore one
  link                                 a URL that replays this session, including the current view

Representations
  cartoon  surface  ball-and-stick (sticks, atoms)  spacefill (vdw, spheres)  ribbon
  interactions (contacts)              non-covalent contacts involving the selection:
                                       H-bonds, ionic, pi-stacking, cation-pi, halogen,
                                       hydrophobic, metal; within one model

Selections (show/hide/color without one use the current selection, else everything)
  chain A residues 10-50 atoms CA      keyword form; add "model <id|alias>"
  #1/A:10-50@CA   /A,B   :HEM   @CA    ChimeraX form; #<number|alias>
  all  sel  protein  nucleic  polymer  ligand  solvent  ions  backbone  sidechain
  C  N  Fe   element C,N   @C*  @H?    elements (capitalised as shown); atom-name wildcards
  a & b   a | b   ~a   (a)             intersection, union, negation, grouping
  ligand :< 5     ligand @< 5          whole residues / atoms within 5 Å
```

## Examples

A ligand in its pocket, with the contacts it makes (1X7A, ligand `298`):

```
load 1X7A
hide
show cartoon
show sticks :298 :< 5
color salmon :298 & C
show interactions :298
focus :298
```

A see-through surface with the pocket residues picked out via the current selection:

```
load 1X7A
show surface protein
transparency 70
select :298 :< 6
show sticks sel
color gold sel & C
select clear
focus :298
```

One chain of a two-chain entry, with the ligand as spheres (4MBS, ligand `MRV`):

```
load 4MBS
hide
show cartoon /A
color steelblue /A
show spacefill :MRV
show sticks :MRV :< 4.5 & sidechain
show interactions :MRV
focus :MRV
```

Coloured everything by accident? `color byhet` puts the heteroatoms back to element colours and leaves the carbons alone:

```
color salmon :MRV :< 5
color byhet :MRV :< 5
```

Superposing two structures:

```
load 4HHB
load 1HHO as oxy
align oxy to 4HHB method=tmalign
```

## Sharing a view

`link` prints a URL (and copies it to the clipboard) that replays the session and restores the camera. Commands can also be written into a URL by hand with `?cmd=`, writing `&` as `%26`:

https://ljmartin.github.io/msviz/?cmd=load+1X7A;+hide;+show+cartoon;+show+sticks+:298+:%3C+5;+color+salmon+:298+%26+C;+show+interactions+:298;+focus+:298

## Development

```
npm install
npm run dev        # local dev server
npm test           # parser, selection and alignment tests (Node, no browser)
npm run build      # static site in dist/
```
