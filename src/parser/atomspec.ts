/**
 * Selection (atom specifier) parser. Pure TypeScript.
 *
 * Two surface syntaxes produce the same SelExpr tree:
 *
 *   keyword form      chain A residues 10-50 atoms CA
 *                     model ref chain A,B
 *   ChimeraX form     #1/A:10-50@CA      /A,B      :HEM      @CA,CB
 *
 * and both can be combined with
 *
 *   &  |  ~  ( )      intersection, union, negation, grouping
 *   juxtaposition     union            (/A /B)
 *   named selectors   all sel protein nucleic polymer ligand solvent ions backbone sidechain
 *   elements          C  N  Fe         element symbols, written with that capitalisation
 *                     element C,N      keyword form
 *   atom wildcards    @C*  @H?         * is any run of characters, ? is one
 *   zones             <expr> :< 5      whole residues within 5 Å of expr
 *                     <expr> @< 5      atoms within 5 Å of expr
 *
 * The ChimeraX subset follows src/bundles/core/src/commands/_atomspec.peg in
 * the ChimeraX source; attribute tests (##, //, ::, @@) and the "beyond"
 * zones (:> and @>) are not implemented.
 */

import { NamedSelector, ParseError, ResiduePart, SelExpr } from './types';

const NAMED: Readonly<Record<string, NamedSelector>> = {
    protein: 'protein',
    nucleic: 'nucleic',
    polymer: 'polymer',
    ligand: 'ligand', ligands: 'ligand',
    solvent: 'solvent', water: 'solvent', waters: 'solvent',
    ions: 'ions', ion: 'ions',
    backbone: 'backbone',
    sidechain: 'sidechain', sidechains: 'sidechain',
};

/**
 * Element symbols usable as bare selectors. They must be written in standard
 * capitalisation (C, Fe, Zn), so that `CA` is never read as calcium.
 */
const ELEMENTS: ReadonlySet<string> = new Set((
    'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr ' +
    'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu ' +
    'Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am D'
).split(' '));

const KEYWORDS: Readonly<Record<string, 'model' | 'chain' | 'residues' | 'atoms' | 'elements'>> = {
    model: 'model', models: 'model',
    chain: 'chain', chains: 'chain',
    residue: 'residues', residues: 'residues', resid: 'residues',
    atom: 'atoms', atoms: 'atoms', name: 'atoms',
    element: 'elements', elements: 'elements',
};

/** Words that the selection grammar reserves; used by the command parser. */
export function isSelectionWord(word: string): boolean {
    const w = word.toLowerCase();
    return w === 'all' || w === 'sel' || w in NAMED || w in KEYWORDS;
}

export interface AtomspecOptions {
    /**
     * Treat an unrecognised bare word as a model reference. Used for the
     * operands of `align`, where `align 1ABC to ref` names models directly.
     */
    bareWordsAreModels?: boolean;
}

export function parseSelection(text: string, options: AtomspecOptions = {}): SelExpr {
    const p = new Parser(text, options);
    const expr = p.parseUnion();
    p.skipWs();
    if (!p.eof()) throw p.error(`unexpected "${p.rest()}"`);
    return expr;
}

function parseResiduePart(item: string): ResiduePart {
    const m = /^(-?\d+)(?:-(-?\d+))?$/.exec(item);
    if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] === undefined ? start : parseInt(m[2], 10);
        if (end < start) throw new ParseError(`residue range "${item}" runs backwards`);
        return { kind: 'range', start, end };
    }
    if (/^[A-Za-z0-9]+$/.test(item)) return { kind: 'name', name: item.toUpperCase() };
    throw new ParseError(`bad residue specifier "${item}"`);
}

class Parser {
    private pos = 0;

    constructor(private readonly text: string, private readonly options: AtomspecOptions) { }

    eof() { return this.pos >= this.text.length; }
    rest() { return this.text.slice(this.pos); }
    error(msg: string) { return new ParseError(`selection "${this.text.trim()}": ${msg}`); }

    skipWs() {
        while (!this.eof() && /\s/.test(this.text[this.pos])) this.pos++;
    }

    private peek(n = 1) { return this.text.substr(this.pos, n); }

    private match(re: RegExp): string | undefined {
        re.lastIndex = this.pos;
        const m = re.exec(this.text);
        if (!m || m.index !== this.pos) return undefined;
        this.pos += m[0].length;
        return m[0];
    }

    /** union := intersection ( '|' intersection | <juxtaposed> intersection )* */
    parseUnion(): SelExpr {
        let left = this.parseIntersection();
        for (;;) {
            this.skipWs();
            if (this.peek() === '|') {
                this.pos++;
                left = { type: 'or', left, right: this.parseIntersection() };
            } else if (!this.eof() && this.peek() !== ')' && this.peek() !== '&') {
                left = { type: 'or', left, right: this.parseIntersection() };
            } else {
                return left;
            }
        }
    }

    /** intersection := term ( '&' term )* */
    private parseIntersection(): SelExpr {
        let left = this.parseTerm();
        for (;;) {
            this.skipWs();
            if (this.peek() !== '&') return left;
            this.pos++;
            left = { type: 'and', left, right: this.parseTerm() };
        }
    }

    /** term := ( '~' term | '(' union ')' | hierarchy | keyword-spec | name ) zone* */
    private parseTerm(): SelExpr {
        this.skipWs();
        if (this.eof()) throw this.error('expected a selection');
        let expr: SelExpr;
        const c = this.peek();
        if (c === '~') {
            this.pos++;
            expr = { type: 'not', expr: this.parseTerm() };
        } else if (c === '(') {
            this.pos++;
            expr = this.parseUnion();
            this.skipWs();
            if (this.peek() !== ')') throw this.error('missing ")"');
            this.pos++;
        } else if (c === '#' || c === '/' || c === ':' || c === '@') {
            if (this.isZoneAhead()) throw this.error('a zone needs a selection before it');
            expr = this.parseHierarchy();
        } else {
            expr = this.parseWord();
        }
        return this.parseZones(expr);
    }

    private isZoneAhead() {
        const two = this.peek(2);
        return two === ':<' || two === '@<' || two === ':>' || two === '@>';
    }

    private parseZones(expr: SelExpr): SelExpr {
        for (;;) {
            this.skipWs();
            const op = this.peek(2);
            if (op === ':>' || op === '@>') throw this.error(`the "${op}" zone is not supported`);
            if (op !== ':<' && op !== '@<') return expr;
            this.pos += 2;
            this.skipWs();
            const num = this.match(/[0-9]*\.?[0-9]+/y);
            if (num === undefined) throw this.error(`expected a distance after "${op}"`);
            expr = { type: 'zone', expr, level: op === ':<' ? 'residue' : 'atom', distance: parseFloat(num) };
        }
    }

    private parseList(what: string, re: RegExp): string[] {
        const items: string[] = [];
        for (;;) {
            const item = this.match(re);
            if (item === undefined) throw this.error(`expected ${what}`);
            items.push(item);
            if (this.peek() !== ',') return items;
            this.pos++;
        }
    }

    /**
     * hierarchy := ['#' models] ( '/' chains | ':' residues | '@' atoms )*
     * A repeated level starts a new specifier that inherits the levels above
     * it, so `#1/A:10/B:20` is (#1/A:10 | #1/B:20).
     */
    private parseHierarchy(): SelExpr {
        type Spec = Extract<SelExpr, { type: 'spec' }>;
        const specs: Spec[] = [];
        let models: string[] | undefined;
        let chains: string[] | undefined;
        let residues: ResiduePart[] | undefined;
        let atoms: string[] | undefined;
        let dirty = false;

        const flush = () => {
            if (!dirty) return;
            const s: Spec = { type: 'spec' };
            if (models) s.models = models;
            if (chains) s.chains = chains;
            if (residues) s.residues = residues;
            if (atoms) s.atoms = atoms;
            specs.push(s);
            dirty = false;
        };

        if (this.peek() === '#') {
            this.pos++;
            models = this.parseList('a model id', /[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)?/y);
            dirty = true;
        }
        for (;;) {
            if (this.isZoneAhead()) break;
            const c = this.peek();
            if (c === '/') {
                this.pos++;
                if (chains || residues || atoms) flush();
                chains = this.parseList('a chain id', /[A-Za-z0-9_]+/y);
                residues = undefined; atoms = undefined;
                dirty = true;
            } else if (c === ':') {
                this.pos++;
                if (residues || atoms) flush();
                residues = this.parseList('a residue number, range or name', /-?[A-Za-z0-9]+(?:--?[0-9]+)?/y)
                    .map(parseResiduePart);
                atoms = undefined;
                dirty = true;
            } else if (c === '@') {
                this.pos++;
                if (atoms) flush();
                atoms = this.parseList('an atom name', /[A-Za-z0-9'*?]+/y).map(a => a.toUpperCase());
                dirty = true;
            } else {
                break;
            }
        }
        flush();
        return specs.reduce<SelExpr>((acc, s, i) => i === 0 ? s : { type: 'or', left: acc, right: s }, specs[0]);
    }

    private readWord(): string | undefined {
        return this.match(/[A-Za-z0-9_.][A-Za-z0-9_.+-]*/y);
    }

    /** A bare word: `all`, `sel`, a named selector, or the start of a keyword spec. */
    private parseWord(): SelExpr {
        const start = this.pos;
        const word = this.readWord();
        if (word === undefined) throw this.error(`unexpected "${this.rest()}"`);
        const w = word.toLowerCase();
        if (w === 'all') return { type: 'all' };
        if (w === 'sel') return { type: 'current' };
        if (w in NAMED) return { type: 'named', name: NAMED[w] };
        if (w in KEYWORDS) {
            this.pos = start;
            return this.parseKeywordSpec();
        }
        if (this.options.bareWordsAreModels) return { type: 'spec', models: [word] };
        if (ELEMENTS.has(word)) return { type: 'spec', elements: [word.toUpperCase()] };
        const symbol = word[0].toUpperCase() + word.slice(1).toLowerCase();
        if (ELEMENTS.has(symbol)) {
            throw this.error(`unknown selector "${word}" (for the element, write "${symbol}" or "element ${symbol}")`);
        }
        throw this.error(`unknown selector "${word}"`);
    }

    /** keyword-spec := ( model <list> | chain <list> | residues <list> | atoms <list> )+ */
    private parseKeywordSpec(): SelExpr {
        const spec: Extract<SelExpr, { type: 'spec' }> = { type: 'spec' };
        for (;;) {
            this.skipWs();
            const start = this.pos;
            const word = this.readWord();
            const key = word === undefined ? undefined : KEYWORDS[word.toLowerCase()];
            if (!key) { this.pos = start; break; }
            this.skipWs();
            if (key === 'model') {
                if (spec.models) throw this.error('"model" given twice');
                spec.models = this.parseList('a model id', /[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)?/y);
            } else if (key === 'chain') {
                if (spec.chains) throw this.error('"chain" given twice');
                spec.chains = this.parseList('a chain id', /[A-Za-z0-9_]+/y);
            } else if (key === 'residues') {
                if (spec.residues) throw this.error('"residues" given twice');
                spec.residues = this.parseList('a residue number, range or name', /-?[A-Za-z0-9]+(?:--?[0-9]+)?/y)
                    .map(parseResiduePart);
            } else if (key === 'elements') {
                if (spec.elements) throw this.error('"element" given twice');
                spec.elements = this.parseList('an element symbol', /[A-Za-z]+/y).map(e => {
                    const symbol = e[0].toUpperCase() + e.slice(1).toLowerCase();
                    if (!ELEMENTS.has(symbol)) throw this.error(`"${e}" is not an element symbol`);
                    return symbol.toUpperCase();
                });
            } else {
                if (spec.atoms) throw this.error('"atoms" given twice');
                spec.atoms = this.parseList('an atom name', /[A-Za-z0-9'*?]+/y).map(a => a.toUpperCase());
            }
        }
        return spec;
    }
}
