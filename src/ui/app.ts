/**
 * Browser entry point: wires the command box to parseCommand and the plugin bridge.
 */

import { CommandResult, ModelEntry } from '../executor/session';
import { PluginBridge } from '../plugin/plugin-bridge';
import { createPlugin } from '../plugin/viewer-init';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const log = $('log');
const input = $<HTMLTextAreaElement>('cmd-input');
const hover = $('hover');
const modelList = $('models');

function print(text: string, kind: 'cmd' | 'out' | 'info' | 'err') {
    const line = document.createElement('div');
    line.className = kind;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
}

function renderModels(models: readonly ModelEntry[]) {
    modelList.replaceChildren(...models.map(m => {
        const li = document.createElement('li');
        li.textContent = `#${m.id} ${m.name}`;
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = '#' + m.baseColor.toString(16).padStart(6, '0');
        li.appendChild(swatch);
        return li;
    }));
}

/** A URL of this page that replays `script` on load. */
function shareUrl(script: string): string {
    // Keep the characters that are safe in a query string readable; # & + < > stay encoded.
    const query = encodeURIComponent(script)
        .replace(/%20/g, '+').replace(/%3A/g, ':').replace(/%2F/g, '/')
        .replace(/%3B/g, ';').replace(/%2C/g, ',').replace(/%40/g, '@');
    return `${location.origin}${location.pathname}?cmd=${query}`;
}

async function report(result: CommandResult) {
    if (result.command.kind !== 'link' || !result.script) return print(result.message, 'out');
    const url = shareUrl(result.script);
    print(url, 'out');
    try {
        await navigator.clipboard.writeText(url);
        print('copied to clipboard', 'info');
    } catch {
        // Clipboard access can be refused; the URL is in the log either way.
    }
}

function fitInput() {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
}

async function main() {
    const plugin = await createPlugin($('viewer'));
    const bridge = new PluginBridge(plugin);

    // Hover label: Mol* produces HTML; show it as plain text.
    plugin.behaviors.labels.highlight.subscribe(({ labels }) => {
        const scratch = document.createElement('div');
        scratch.innerHTML = labels.filter(l => typeof l === 'string').join(' | ');
        const text = scratch.textContent ?? '';
        hover.textContent = text;
        hover.hidden = !text;
    });

    const history: string[] = [];
    let cursor = 0;
    let draft = '';

    // Commands run one at a time in the order submitted. The input stays
    // enabled throughout, so it never loses keyboard focus.
    let queue: Promise<void> = Promise.resolve();

    function submit(text: string): Promise<void> {
        if (!text.trim()) return queue;
        history.push(text);
        cursor = history.length;
        input.value = '';
        fitInput();
        queue = queue.then(async () => {
            print(text, 'cmd');
            try {
                await bridge.run(text, r => void report(r));
            } catch (e) {
                print(e instanceof Error ? e.message : String(e), 'err');
            } finally {
                renderModels(bridge.session.models);
            }
        });
        return queue;
    }

    // Mol* listens for single-key shortcuts on the window (O rocks, I spins,
    // W/A/S/D move the camera). Keys typed into the command box must not reach it.
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
        input.addEventListener(type, e => e.stopPropagation());
    }

    input.addEventListener('input', fitInput);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit(input.value);
        } else if (e.key === 'ArrowUp' && !input.value.includes('\n') && cursor > 0) {
            e.preventDefault();
            if (cursor === history.length) draft = input.value;
            input.value = history[--cursor];
            fitInput();
        } else if (e.key === 'ArrowDown' && !input.value.includes('\n') && cursor < history.length) {
            e.preventDefault();
            cursor++;
            input.value = cursor === history.length ? draft : history[cursor];
            fitInput();
        }
    });

    // For poking at the session from the browser console.
    Object.assign(window, { molview: bridge });

    print('MolView ready. Enter runs a command, Shift+Enter adds a line, Up/Down recall history. Type "help".', 'info');
    input.focus();

    // ?cmd=... runs commands on start, e.g. /?cmd=load 4HHB; show surface /A
    const initial = new URLSearchParams(location.search).get('cmd');
    if (initial) await submit(initial);
}

main().catch(e => print(`startup failed: ${e instanceof Error ? e.message : e}`, 'err'));
