/**
 * Node-side structure loading for the test suite: fetches mmCIF text from
 * RCSB and keeps a copy on disk so repeated runs do not hit the network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Structure } from 'molstar/lib/mol-model/structure';
import { Session } from '../executor/session';
import { fetchText, pdbeUpdatedCifUrl, rcsbCifUrl, structureFromMmCIF } from '../executor/structure-executor';

const CACHE_DIR = join(process.cwd(), '.cache', 'cif');

async function cached(file: string, url: string): Promise<string> {
    const path = join(CACHE_DIR, file);
    if (existsSync(path)) return readFileSync(path, 'utf8');
    const text = await fetchText(url);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, text);
    return text;
}

export async function loadStructureFromString(pdbId: string): Promise<Structure> {
    const id = pdbId.toUpperCase();
    return structureFromMmCIF(await cached(`${id}.cif`, rcsbCifUrl(id)));
}

export async function loadSiftsStructure(pdbId: string): Promise<Structure> {
    const id = pdbId.toUpperCase();
    return structureFromMmCIF(await cached(`${id}_updated.cif`, pdbeUpdatedCifUrl(id)), { sifts: true });
}

/** A Session wired to the Node loaders; tests feed it the same strings as the UI text box. */
export function createTestSession(): Session {
    return new Session(loadStructureFromString, loadSiftsStructure);
}
