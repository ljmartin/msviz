/**
 * parseCommand(str) -> Command[]. Pure TypeScript: no molstar, no DOM.
 *
 * This is the only place where command strings are interpreted. The session,
 * the executor and the plugin bridge consume Command objects only.
 */

import { isSelectionWord, parseSelection } from './atomspec';
import { isColorToken, normalizeColor } from './colors';
import { splitKeyword, splitStatements, words } from './tokeniser';
import { ALIGN_METHODS, AlignMethod, Command, ParseError, Representation, SelExpr } from './types';

const REPR_ALIASES: Readonly<Record<string, Representation>> = {
    'cartoon': 'cartoon', 'cartoons': 'cartoon',
    'surface': 'surface', 'surfaces': 'surface',
    'ball-and-stick': 'ball-and-stick', 'ballandstick': 'ball-and-stick', 'bs': 'ball-and-stick',
    'stick': 'ball-and-stick', 'sticks': 'ball-and-stick', 'licorice': 'ball-and-stick',
    'spacefill': 'spacefill', 'vdw': 'spacefill', 'sphere': 'spacefill', 'spheres': 'spacefill',
    'ribbon': 'ribbon', 'ribbons': 'ribbon', 'trace': 'ribbon',
    'interactions': 'interactions', 'interaction': 'interactions', 'contacts': 'interactions',
};

const KEYWORD_ALIASES: Readonly<Record<string, Command['kind']>> = {
    load: 'load', open: 'load', fetch: 'load',
    select: 'select', sel: 'select',
    show: 'show', display: 'show',
    hide: 'hide',
    color: 'color', colour: 'color',
    transparency: 'transparency', transparent: 'transparency', alpha: 'transparency',
    align: 'align', matchmaker: 'align', mm: 'align', superpose: 'align',
    focus: 'focus', view: 'focus', zoom: 'focus',
    close: 'close', delete: 'close',
    rock: 'animate', spin: 'animate', stop: 'animate',
    camera: 'camera',
    link: 'link', share: 'link',
    help: 'help', '?': 'help',
};

const SOURCES = new WeakMap<Command, string>();

/** The statement text a command was parsed from; undefined for hand-built commands. */
export function sourceOf(command: Command): string | undefined {
    return SOURCES.get(command);
}

export function parseCommand(text: string): Command[] {
    return splitStatements(text).map(statement => {
        const command = parseStatement(statement);
        SOURCES.set(command, statement);
        return command;
    });
}

export function parseStatement(statement: string): Command {
    const { keyword, rest } = splitKeyword(statement);
    const kind = KEYWORD_ALIASES[keyword];
    switch (kind) {
        case 'load': return parseLoad(rest);
        case 'select': return parseSelect(rest);
        case 'show': return parseShowHide('show', rest);
        case 'hide': return parseShowHide('hide', rest);
        case 'color': return parseColor(rest);
        case 'transparency': return parseTransparency(rest);
        case 'align': return parseAlign(rest, keyword === 'superpose' ? 'superpose' : undefined);
        case 'focus': return rest ? { kind: 'focus', selection: parseSelection(rest) } : { kind: 'focus' };
        case 'close': return parseClose(rest);
        case 'animate': return parseAnimate(keyword, rest);
        case 'camera': return parseCamera(rest);
        case 'link':
            if (rest) throw new ParseError(`usage: ${keyword}`);
            return { kind: 'link' };
        case 'help': return { kind: 'help' };
        default:
            throw new ParseError(`unknown command "${keyword}" (try "help")`);
    }
}

function parseLoad(rest: string): Command {
    const m = /^(\S+)(?:\s+as\s+(\S+))?$/i.exec(rest);
    if (!m) throw new ParseError('usage: load <PDBID> [as <alias>]');
    const pdbId = m[1].toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(pdbId) && !/^PDB_[A-Z0-9]{8}$/.test(pdbId)) {
        throw new ParseError(`"${m[1]}" is not a PDB id`);
    }
    const alias = m[2];
    if (alias !== undefined) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
            throw new ParseError(`alias "${alias}" must start with a letter and contain only letters, digits and _`);
        }
        if (isSelectionWord(alias)) throw new ParseError(`alias "${alias}" is a reserved selection word`);
        return { kind: 'load', pdbId, alias };
    }
    return { kind: 'load', pdbId };
}

function parseSelect(rest: string): Command {
    if (!rest) throw new ParseError('usage: select <selection> | select clear');
    if (/^(clear|none)$/i.test(rest)) return { kind: 'select' };
    return { kind: 'select', selection: parseSelection(rest) };
}

/** True if a word can only begin a selection, never be an atom name. */
function startsSelection(word: string): boolean {
    return isSelectionWord(word) || /^[#/:@~(]/.test(word);
}

function optionalSelection(tokens: string[]): { selection?: SelExpr } {
    return tokens.length ? { selection: parseSelection(tokens.join(' ')) } : {};
}

/**
 * show|hide <representation> [selection]      (design-doc order)
 * show|hide <selection> <representation>      (ChimeraX order)
 *
 * `atoms` is also the keyword of the `atoms CA` selection clause. It names a
 * representation as the final word, or as the first word when a selection
 * (rather than an atom name) follows it.
 */
function parseShowHide(kind: 'show' | 'hide', rest: string): Command {
    const tokens = words(rest);
    let repr: Representation | undefined;
    const i = tokens.findIndex(t => t.toLowerCase() in REPR_ALIASES);
    if (i >= 0) {
        repr = REPR_ALIASES[tokens[i].toLowerCase()];
        tokens.splice(i, 1);
    } else if (tokens.length && /^atoms?$/i.test(tokens[tokens.length - 1])) {
        repr = 'ball-and-stick';
        tokens.pop();
    } else if (tokens.length > 1 && /^atoms?$/i.test(tokens[0]) && startsSelection(tokens[1])) {
        // `show atoms sel`: what follows is a selection, not a list of atom names.
        repr = 'ball-and-stick';
        tokens.shift();
    }
    const sel = optionalSelection(tokens);
    if (kind === 'hide') return repr ? { kind, repr, ...sel } : { kind, ...sel };
    // ChimeraX shows atoms when no target is named.
    return { kind, repr: repr ?? 'ball-and-stick', ...sel };
}

const UNCOLOR: Readonly<Record<string, 'het' | 'all'>> = {
    byhet: 'het', byhetero: 'het', default: 'all', reset: 'all',
};

/**
 * color byhet|default [selection]   remove colours again (also selection first)
 * color <color> [selection]      (design-doc order)
 * color <selection> <color>      (ChimeraX order)
 */
function parseColor(rest: string): Command {
    const tokens = words(rest);
    if (!tokens.length) throw new ParseError('usage: color <name|#hex> [selection]');
    const reset = (t: string) => UNCOLOR[t.toLowerCase()];
    if (reset(tokens[0])) {
        const scope = reset(tokens.shift()!);
        return { kind: 'uncolor', scope, ...optionalSelection(tokens) };
    }
    if (tokens.length > 1 && reset(tokens[tokens.length - 1])) {
        const scope = reset(tokens.pop()!);
        return { kind: 'uncolor', scope, ...optionalSelection(tokens) };
    }
    let token: string;
    if (isColorToken(tokens[0])) {
        token = tokens.shift()!;
    } else if (isColorToken(tokens[tokens.length - 1])) {
        token = tokens.pop()!;
    } else {
        throw new ParseError(`no colour found in "${rest}" (use a colour name or #rrggbb)`);
    }
    return { kind: 'color', color: normalizeColor(token)!, ...optionalSelection(tokens) };
}

/**
 * transparency <percent> [selection] [representation|all]      (design-doc order)
 * transparency <selection> <percent> [representation|all]      (ChimeraX order)
 *
 * Applies to surfaces unless a representation is named, as in ChimeraX.
 * The percent is the first word if that is a number, otherwise the last, so
 * a zone distance inside the selection is never mistaken for it.
 */
function parseTransparency(rest: string): Command {
    const usage = 'usage: transparency <0-100> [selection] [representation|all]';
    const tokens = words(rest);
    let repr: Representation | undefined = 'surface';
    const last = tokens[tokens.length - 1]?.toLowerCase();
    if (last !== undefined && last in REPR_ALIASES) {
        repr = REPR_ALIASES[last];
        tokens.pop();
    } else if (last === 'all' && tokens.length > 1) {
        repr = undefined;
        tokens.pop();
    } else {
        const i = tokens.findIndex(t => t.toLowerCase() in REPR_ALIASES);
        if (i >= 0) repr = REPR_ALIASES[tokens.splice(i, 1)[0].toLowerCase()];
    }
    const isPercent = (t: string | undefined) => t !== undefined && /^\d+(\.\d+)?%?$/.test(t);
    let token: string;
    if (isPercent(tokens[0])) token = tokens.shift()!;
    else if (isPercent(tokens[tokens.length - 1])) token = tokens.pop()!;
    else throw new ParseError(usage);
    const percent = parseFloat(token);
    if (percent > 100) throw new ParseError(`transparency ${token} is out of range (0-100)`);
    const sel = optionalSelection(tokens);
    return repr ? { kind: 'transparency', percent, repr, ...sel } : { kind: 'transparency', percent, ...sel };
}

/** align <mobile> to <reference> [method=sequence|tmalign|sifts|superpose] */
function parseAlign(rest: string, defaultMethod?: AlignMethod): Command {
    let method = defaultMethod;
    const body = rest.replace(/(^|\s)method\s*=\s*(\S+)/i, (_m, _pre, value: string) => {
        const v = value.toLowerCase();
        const canonical = v === 'tm-align' || v === 'tm' ? 'tmalign'
            : v === 'seq' ? 'sequence'
                : v === 'coords' || v === 'coordinates' ? 'superpose' : v;
        if (!(ALIGN_METHODS as readonly string[]).includes(canonical)) {
            throw new ParseError(`unknown alignment method "${value}" (use ${ALIGN_METHODS.join(', ')})`);
        }
        method = canonical as AlignMethod;
        return ' ';
    }).trim();
    const parts = body.split(/\s+to\s+/i);
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
        throw new ParseError('usage: align <mobile> to <reference> [method=sequence|tmalign|sifts|superpose]');
    }
    const target = parseSelection(parts[0], { bareWordsAreModels: true });
    const reference = parseSelection(parts[1], { bareWordsAreModels: true });
    return method ? { kind: 'align', target, reference, method } : { kind: 'align', target, reference };
}

function parseClose(rest: string): Command {
    if (!rest || /^all$/i.test(rest)) return { kind: 'close' };
    const tokens = words(rest);
    if (tokens.length !== 1) throw new ParseError('usage: close [model]');
    return { kind: 'close', model: tokens[0].replace(/^#/, '') };
}

/** camera [px,py,pz tx,ty,tz ux,uy,uz radius] */
function parseCamera(rest: string): Command {
    if (!rest) return { kind: 'camera' };
    const view = rest.split(/[\s,]+/).filter(Boolean).map(Number);
    if (view.length !== 10 || view.some(v => !Number.isFinite(v)) || view[9] <= 0) {
        throw new ParseError('usage: camera [px,py,pz tx,ty,tz ux,uy,uz radius]');
    }
    return { kind: 'camera', view };
}

/** rock [on|off] | spin [on|off] | stop */
function parseAnimate(keyword: string, rest: string): Command {
    if (keyword === 'stop') {
        if (rest) throw new ParseError('usage: stop');
        return { kind: 'animate', mode: 'off' };
    }
    if (!rest || /^on$/i.test(rest)) return { kind: 'animate', mode: keyword as 'rock' | 'spin' };
    if (/^(off|stop)$/i.test(rest)) return { kind: 'animate', mode: 'off' };
    throw new ParseError(`usage: ${keyword} [on|off]`);
}

export const HELP_TEXT = `Commands (separate with ; or newlines, keywords are case-insensitive)

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

Examples
  load 4HHB; load 1HHO as oxy; align oxy to 4HHB method=tmalign
  hide; show cartoon; show sticks ligand :< 5; color gold ligand
  show surface /A; transparency 60 /A
  color gold :HEM & C
  show interactions ligand; show sticks ligand :< 5`;
