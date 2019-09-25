import * as vscode from 'vscode';
import * as path from 'path';
import * as util from './util';
import { TextDecoder } from 'util';

// allowed characters in key: `0-9a-zA-Z._-`

const DICTIONARY_KEY = 'ngx-translate-manager-dictionary';
const DEFAULT_LOCALE = '**/locale/**/en.json';
const DEFAULT_EXCLUDE = '**/node_modules/**';

let watcher: vscode.FileSystemWatcher | null = null;
let hoverProvider: vscode.Disposable | null = null;
let completionItemProvider: vscode.Disposable | null = null;

enum Action {
    Store,
    Search
}

function getConfig(): vscode.WorkspaceConfiguration {
    const uri = vscode.window.activeTextEditor!.document.uri;
    const config = vscode.workspace.getConfiguration('ngx-translate-manager', uri);

    return config;
}

async function showMessage(message: string, actions: string[] = []) {
    return await vscode.window.showInformationMessage(`${message}`, ...actions);
}

async function getLocaleUri(): Promise<vscode.Uri | undefined> {
    const config = getConfig();
    const uris = await vscode.workspace.findFiles(config.get('locale', DEFAULT_LOCALE), config.get('exclude', DEFAULT_EXCLUDE), 1);

    if (uris.length) {
        return uris[0];
    } else {
        setLocaleUri();
    }
}

async function setLocaleUri() {
    const action = await showMessage('Dictionary not found', ['Browse', 'Cancel']);

    if (action === 'Browse') {
        await vscode.commands.executeCommand('ngx-translate-manager.set-locale-file');
    }
}

async function readFile(uri: vscode.Uri): Promise<string | undefined> {
    try {
        const bytes: Uint8Array = await vscode.workspace.fs.readFile(uri);

        return new TextDecoder().decode(bytes);
    } catch (e) {
        console.log(e);
        vscode.window.showErrorMessage(`Reading the file ${uri.toString()} failed: ${e}`);
    }
}

async function parseJSON(content: string) {
    try {
        const parsed = JSON.parse(content);

        return parsed;
    } catch (e) {
        const action = await showMessage('Parsing the dictionary failed', ['Set new dictionary', 'Modify', 'Cancel']);

        if (action === 'Set new dictionary') {
            await vscode.commands.executeCommand('ngx-translate-manager.set-locale-file');
        } else if (action === 'Modify') {
            // TODO: open invalid document
        }
    }
}

async function updateCache(cache: vscode.Memento) {
    const uri = await getLocaleUri();

    if (!uri) {
        return;
    }

    const content = await readFile(uri);

    if (content === undefined) {
        return;
    }

    const obj = await parseJSON(content);

    if (obj === undefined) {
        return;
    }

    const dictionary = util.flattenObject(obj);

    await cache.update(DICTIONARY_KEY, dictionary);
}

async function setDictionaryWatcher(context: vscode.ExtensionContext) {
    if (watcher) {
        watcher.dispose();
    }

    const locale = getConfig().get('locale', DEFAULT_LOCALE);

    watcher = vscode.workspace.createFileSystemWatcher(locale);

    const update = async () => updateCache(context.workspaceState);

    watcher.onDidChange(update);
    watcher.onDidCreate(update);
    watcher.onDidDelete(update);
}

function getReplacement(context: string, isHTML: boolean): string {
    const attribute = /\[?([\w-]+)\]?\s*=\s*['"]\s*$/gi;

    if (new RegExp(attribute).test(context)) {
        const match = new RegExp(attribute, 'gi').exec(context);

        if (match) {
            if (match[0].includes('[')) { return "'${key}' | translate"; }

            return "{{ '${key}' | translate }}";
        }

        return '${key}';
    } else if (context.lastIndexOf('>') < context.lastIndexOf('<')) {
        return 'translate="${key}" [translateParams]="{ ${params} }"';
    } else {
        if (isHTML) { return "{{ '${key}' | translate : { ${params} } }}"; }

        return "'${key}'";
    }
}

function format(replacement: string, key: string, params: string | undefined): vscode.SnippetString {
    return new vscode.SnippetString(
        replacement
            .replace('${key}', key)
            .replace('${params}', params ? params : '')
            .replace('translate : {  }', 'translate')
            .replace(' [translateParams]="{  }"', '')
    );
}

function getCompletionItemProvider(cache: vscode.Memento): vscode.CompletionItemProvider {
    return {
        provideCompletionItems: async (document: vscode.TextDocument, position: vscode.Position) => {
            const editor = vscode.window.activeTextEditor;

            if (!editor) {
                return [];
            }

            const line = document.lineAt(position).text;
            const front = line.slice(0, position.character);
            const index = Math.max(...([`'`, `"`, `_`].map(c => front.lastIndexOf(c))));

            if (index === -1) {
                return [];
            }

            if (!front.endsWith('.')) {
                return [];
            }

            const intellisense = front.slice(index); // intellisense context

            let prefix = '';

            if (intellisense !== '_.') {
                if (intellisense.startsWith('_.')) {
                    prefix = intellisense.slice(2, -1);
                } else if (intellisense.startsWith("'") || intellisense.startsWith('"')) {
                    prefix = intellisense.slice(1, -1);

                    if (prefix.length === 0) {
                        return [];
                    }
                } else {
                    return [];
                }

                if (prefix.split('.').some((part) => new RegExp(/[^\w-]/g).test(part))) {
                    return [];
                }
            }

            const dictionary = cache.get(DICTIONARY_KEY) as any || {};

            if (Object.keys(dictionary).length === 0) {
                const action = await showMessage('Your dictionary is empty', ['Browse', 'Cancel']);

                if (action === 'Browse') {
                    await vscode.commands.executeCommand('ngx-translate-manager.set-locale-file');
                }
            }

            const context = front.slice(0, -intellisense.length);
            const placeholder = getReplacement(context, isHTML(document, position));

            return Object.keys(dictionary)
                .filter(key => key.startsWith(prefix))
                .map(key => {
                    let params = dictionary[key].match(/{{\s*([^{}\s]+)\s*}}/g);

                    if (params) {
                        params = params
                            .map((p: string, i: number) => "'" + p.slice(2, -2).trim() + "': $" + (i + 1))
                            .join(', ');
                    }

                    return {
                        label: key.slice(prefix.length).replace(/^\./gi, ''),
                        detail: dictionary[key],
                        insertText: format(placeholder, key, params),
                        kind: vscode.CompletionItemKind.Snippet,
                        additionalTextEdits: [
                            vscode.TextEdit.delete(new vscode.Range(new vscode.Position(position.line, index), position)),
                        ]
                    };
                });
        }
    };
}

function getHoverProvider(cache: vscode.Memento): vscode.HoverProvider {
    return {
        provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
            const pattern = /(?<quote>['"])[\.\w-]+\k<quote>/g;
            const range = document.getWordRangeAtPosition(position, pattern);

            if (!range) {
                return null;
            }

            const key = document.getText(range).slice(1, -1);
            const dictionary = cache.get(DICTIONARY_KEY) as any;

            if (dictionary.hasOwnProperty(key)) {
                return new vscode.Hover(new vscode.MarkdownString(`*${dictionary[key]}*`), range);
            } else {
                return null;
            }
        }
    };
}

function paste(str: string | vscode.SnippetString, range: vscode.Range | undefined = undefined): void {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return;
    }

    if (str instanceof vscode.SnippetString) {
        str = str.value;
    }

    if (!str.endsWith('$0')) {
        str += '$0';
    }

    editor.insertSnippet(new vscode.SnippetString(str), range || editor.selection);
}

function validateKey(dictionary: any) {
    return (input: string): string | null => {
        if (!input || input.startsWith('.') || input.endsWith('.') || input.includes('..')) {
            return 'Invalid key';
        }

        const disallowed = input.match(/[^\.\w\-]/g);

        if (disallowed) {
            return `Character '${disallowed}' is forbidden`;
        }

        const parts = input
            .split('.')
            .slice(0, -1);

        for (let i = 0; i < parts.length; i++) {
            const key = parts.slice(0, i + 1).join('.');

            if (dictionary.hasOwnProperty(key)) {
                return `Key ${key} is used and its value is '${dictionary[key]}'`;
            }
        }

        return null;
    };
}

async function store(translation: string, cache: vscode.Memento, context: string, html: boolean): Promise<void> {
    const localeUri = await getLocaleUri();
    const editor = vscode.window.activeTextEditor;

    if (!editor || !localeUri) {
        return;
    }

    const dictionary: any = cache.get(DICTIONARY_KEY);

    let key = await vscode.window.showInputBox({
        prompt: 'Enter the translation key',
        value: '',
        validateInput: validateKey(dictionary)
    });

    if (!key) {
        return;
    }

    translation = translation.replace(/\{\{\s*/gi, '{{ ').replace(/\s*\}\}/gi, ' }}');

    try {
        const content = await readFile(localeUri);
        if (!content) {
            return;
        }
        const json = JSON.parse(content);

        let ref = json;

        key.split('.').slice(0, -1).forEach((key) => {
            if (ref.hasOwnProperty(key)) {
                ref = ref[key];
            } else {
                ref[key] = {};
                ref = ref[key];
            }
        });

        const label = key.split('.').slice(-1)[0];

        if (typeof ref[label] === 'object') {
            ref[label]['self'] = translation;
            key = key + '.self';
        } else {
            ref[label] = translation;
        }

        dictionary[key] = translation;

        await cache.update(DICTIONARY_KEY, dictionary);
        await vscode.workspace.fs.writeFile(localeUri, Buffer.from(util.stringify(json), 'utf8'));

        const params = getParams(cache, key);
        const replacement = getReplacement(context, html);

        paste(format(replacement, key, params));

        vscode.window.setStatusBarMessage(`Successfully stored.`, 2000);
    } catch (e) {
        vscode.window.showErrorMessage('Storing the translation failed: ' + e);
    }
}

function getParams(cache: vscode.Memento, key: string): string | undefined {
    const dictionary: any = cache.get(DICTIONARY_KEY);

    if (!dictionary.hasOwnProperty(key)) {
        return;
    }

    const matches = dictionary[key].match(/{{\s*([^{}\s]+)\s*}}/g);

    if (matches) {
        return matches
            .map((param: string, index: number) => `'${param.slice(2, -2).trim()}': $${index + 1}`)
            .join(', ');
    }
}

function search(query: string, cache: vscode.Memento, context: string, html: boolean) {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return;
    }

    query = query.trim().toLowerCase();

    const dictionary = cache.get(DICTIONARY_KEY) as any;
    const items = Object.keys(dictionary)
        .filter((key) => {
            // TODO: optional fuzzy matching 
            return dictionary[key].toLowerCase().includes(query);
        })
        .map((key) => {
            return {
                label: key,
                detail: dictionary[key]
            };
        });

    if (items.length) {
        const select = vscode.window.createQuickPick();

        select.placeholder = 'Select translation';
        select.items = items;
        select.show();

        select.onDidChangeSelection(async (data) => {
            const key = data[0].label;
            const params = getParams(cache, key);
            const replacement = getReplacement(context, html);

            paste(format(replacement, key, params));

            select.hide();
            select.dispose();
        });
    } else {
        vscode.window.showInformationMessage('No translations found');
    }
}

function isHTML(document: vscode.TextDocument, position: vscode.Position): boolean {
    if (document.languageId === 'html') {
        return true;
    }

    const template = /(template\s*:\s*`)([^`]*)`/gi;
    const text = document.getText();

    let match = null;

    while ((match = template.exec(text)) !== null) {
        const offset = match.index + match[1].length;
        const from = document.positionAt(offset);
        const to = document.positionAt(offset + match[2].length);

        if (new vscode.Range(from, to).contains(position)) {
            return true;
        }
    }

    return false;
}

export async function activate(context: vscode.ExtensionContext) {
    const fromSelectedText = (action: Action) => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            return;
        }

        const selection = editor.selection;
        const document = editor.document;
        const text = document.getText(selection);

        if (!text) {
            showMessage('Nothing selected');
            return;
        }

        const pre = document.lineAt(selection.start).text.slice(0, selection.start.character);
        const html = isHTML(document, selection.start);

        switch (action) {
            case Action.Store:
                store(text, context.workspaceState, pre, html);
                break;
            case Action.Search:
                search(text, context.workspaceState, pre, html);
                break;
        }
    };

    const registerProviders = () => {
        const pattern = getConfig().get('pattern') as string;

        hoverProvider = vscode.languages.registerHoverProvider(
            { scheme: 'file', pattern },
            getHoverProvider(context.workspaceState));

        completionItemProvider = vscode.languages.registerCompletionItemProvider(
            { scheme: 'file', pattern },
            getCompletionItemProvider(context.workspaceState),
            '.');

        context.subscriptions.push(hoverProvider, completionItemProvider);
    };

    await updateCache(context.workspaceState);
    await setDictionaryWatcher(context);

    context.subscriptions.push(vscode.commands.registerCommand('ngx-translate-manager.store', async () => {
        fromSelectedText(Action.Store);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ngx-translate-manager.search', () => {
        fromSelectedText(Action.Search);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ngx-translate-manager.set-locale-file', async () => {
        const uri = await vscode.window.showOpenDialog({
            canSelectFolders: false,
            canSelectFiles: true,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(DEFAULT_LOCALE),
            filters: {
                'JSON': ['json']
            }
        });

        if (!uri) {
            return;
        }

        const wfs = vscode.workspace.workspaceFolders;
        const relative = path.relative(wfs ? wfs[0].uri.path : '', uri[0].path);

        await getConfig().update('locale', '**/' + relative.replace(/\\/gi, '/'));
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (evt) => {
        if (evt.affectsConfiguration('ngx-translate-manager.pattern')) {
            [hoverProvider, completionItemProvider].forEach((disposable) => {
                if (disposable instanceof vscode.Disposable) {
                    const index = context.subscriptions.lastIndexOf(disposable);

                    if (index > -1) {
                        context.subscriptions.splice(index, 1)[0].dispose();
                    }
                }
            });

            registerProviders();
        } else if (evt.affectsConfiguration('ngx-translate-manager.locale') || evt.affectsConfiguration('ngx-translate-manager.exclude')) {
            await updateCache(context.workspaceState);
            await setDictionaryWatcher(context);
        }
    }));

    registerProviders();
}

export function deactivate() {
    if (watcher) {
        watcher.dispose();
    }
}