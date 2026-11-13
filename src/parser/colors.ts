/**
 * Colour names understood by the `color` command. Pure TypeScript.
 */

export const COLOR_NAMES: Readonly<Record<string, string>> = {
    white: '#ffffff', black: '#000000', gray: '#808080', grey: '#808080',
    lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#555555', darkgrey: '#555555',
    silver: '#c0c0c0',
    red: '#ff0000', firebrick: '#b22222', crimson: '#dc143c', salmon: '#fa8072', tomato: '#ff6347',
    pink: '#ffc0cb', hotpink: '#ff69b4', magenta: '#ff00ff', purple: '#800080', violet: '#ee82ee',
    orchid: '#da70d6', plum: '#dda0dd', indigo: '#4b0082',
    orange: '#ffa500', darkorange: '#ff8c00', coral: '#ff7f50', gold: '#ffd700', yellow: '#ffff00',
    khaki: '#f0e68c', tan: '#d2b48c', brown: '#a52a2a', wheat: '#f5deb3', beige: '#f5f5dc',
    green: '#008000', lime: '#00ff00', forestgreen: '#228b22', seagreen: '#2e8b57', olive: '#808000',
    lightgreen: '#90ee90', teal: '#008080', turquoise: '#40e0d0',
    cyan: '#00ffff', aquamarine: '#7fffd4', skyblue: '#87ceeb', lightblue: '#add8e6',
    blue: '#0000ff', navy: '#000080', royalblue: '#4169e1', steelblue: '#4682b4',
    cornflowerblue: '#6495ed', dodgerblue: '#1e90ff', slateblue: '#6a5acd',
};

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;

/**
 * True for a colour name or a hex colour. A three-digit hex colour must
 * contain a letter, because `#123` is a model number.
 */
export function isColorToken(token: string): boolean {
    if (HEX6.test(token)) return true;
    if (HEX3.test(token) && /[a-f]/i.test(token)) return true;
    return token.toLowerCase() in COLOR_NAMES;
}

/** Normalise a colour token to lower-case `#rrggbb`, or undefined if it is not a colour. */
export function normalizeColor(token: string): string | undefined {
    if (!isColorToken(token)) return undefined;
    const t = token.toLowerCase();
    if (HEX6.test(t)) return t;
    if (HEX3.test(t)) return '#' + t[1] + t[1] + t[2] + t[2] + t[3] + t[3];
    return COLOR_NAMES[t];
}

export function colorToNumber(hex: string): number {
    return parseInt(hex.slice(1), 16);
}
