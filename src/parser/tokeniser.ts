/**
 * Splits raw command text into statements and words. Pure TypeScript.
 */

/**
 * Split text into individual statements. Statements are separated by
 * semicolons or newlines. A line whose first character is `#` followed by
 * whitespace (or nothing) is a comment; `#1/A` style atomspecs never start a
 * statement, so this is unambiguous.
 */
export function splitStatements(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*#(\s|$)/.test(line)) continue;
        for (const part of line.split(';')) {
            const s = part.trim();
            if (s) out.push(s);
        }
    }
    return out;
}

/** Split a statement into its leading keyword (lower-cased) and the remainder. */
export function splitKeyword(statement: string): { keyword: string; rest: string } {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(statement.trim());
    if (!m) return { keyword: '', rest: '' };
    return { keyword: m[1].toLowerCase(), rest: m[2].trim() };
}

export function words(text: string): string[] {
    const t = text.trim();
    return t ? t.split(/\s+/) : [];
}
