import * as vscode from 'vscode';
import * as path from 'path';
import * as util from './util';
import { TextDecoder } from 'util';

const DEFAULT_LOCALE  = '**/assets/i18n/en.json';
const DEFAULT_EXCLUDE = '**/node_modules/**';
const DICTIONARY_KEY  = 'ngx-translate-manager-dictionary';

let watcher: vscode.FileSystemWatcher | null = null;
let hoverProvider: vscode.Disposable | null = null;
let completionItemProvider: vscode.Disposable | null = null;

interface SelectionMetadata {
    text: string;
    context: string;
    filetype: string;
}

function getConfig(): vscode.WorkspaceConfiguration {
    const uri = vscode.window.activeTextEditor!.document.uri;
    const config = vscode.workspace.getConfiguration('ngx-translate-manager', uri);

    return config;
}

async function showMessage(message: string, actions: string[] = []) {
    return await vscode.window.showInformationMessage(`${message}`, ...actions);
}

async function setLocaleUri() {
    const action = await showMessage('File with translations not found', ['Browse', 'Cancel']);

    if (action === 'Browse') {
        await vscode.commands.executeCommand('ngx-translate-manager.set-locale-file');
    }
}

async function getTranslationsUri(): Promise<vscode.Uri | undefined> {
    const config = getConfig();
    const uris = await vscode.workspace.findFiles(
        config.get('locale', DEFAULT_LOCALE),
        config.get('exclude', DEFAULT_EXCLUDE), 1);

    if (uris.length) {
        return uris[0];
    } else {
        setLocaleUri();
    }
}

async function readFile(uri: vscode.Uri): Promise<string | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);

        return new TextDecoder().decode(bytes);
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to read the file: ${e}`);
    }
}

function getTemplate(context: string, filetype: string): string {
    const attribute = /\[?([\w-]+)\]?\s*=\s*['"]\s*$/gi;

    if (new RegExp(attribute).test(context)) {
        const match = new RegExp(attribute, 'gi').exec(context);

        if (match) {
            if (match[0].includes('[')) {
                return "'#key' | translate";
            }

            return "{{ '#key' | translate }}";
        }

        return '#key';
    } else if (context.lastIndexOf('>') < context.lastIndexOf('<')) {
        return 'translate="#key" [translateParams]="#params"';
    } else {
        if (filetype === 'html') {
            return "{{ '#key' | translate : #params }}";
        }

        return "'#key'";
    }
}

function getSnippet(template: string, key: string, params: string | undefined): vscode.SnippetString {
    let snippet = template
        .replace('#key', key)
        .replace('#params', params ? '${1:{ ' + params + ' \\}}' : '')
        .replace('translate :  ', 'translate ')
        .replace(' [translateParams]=""', '');

    return new vscode.SnippetString(snippet + '$0');
}

export async function paste(snippet: vscode.SnippetString, range: vscode.Range | undefined = undefined): Promise<void> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return;
    }

    let value = snippet.value;

    if (!value.endsWith('$0')) {
        value += '$0';
    }

    await editor.insertSnippet(new vscode.SnippetString(value), range || editor.selection);
}

function format(param: string, index: number): string {
    return `'${param.slice(2, -2).trim()}': $${index + 2}`;
}

function getParams(cache: any, key: string): string | undefined {
    const dictionary = (typeof cache.get === 'function' && cache.get(DICTIONARY_KEY)) || cache as any || {};

    if (!dictionary.hasOwnProperty(key)) {
        return;
    }

    const matches = dictionary[key].match(/{{\s*([^{}\s]+)\s*}}/g);

    if (matches) {
        return matches
            .map(format)
            .join(', ');
    }
}

export function search(cache: any, query: string): vscode.QuickPickItem[] {
    const dictionary = (typeof cache.get === 'function' && cache.get(DICTIONARY_KEY)) || cache as any || {};

    query = query.replace(/\s/g, '').toLowerCase();

    return Object.keys(dictionary)
        .filter(key => util.fuzzysearch(query, dictionary[key].toLowerCase()))
        .map(key => {
            return {
                label: dictionary[key],
                description: key,
            };
        });
}

async function store(cache: vscode.Memento, metadata: SelectionMetadata): Promise<void> {
    const dictionary: any = cache.get(DICTIONARY_KEY);

    let key = await vscode.window.showInputBox({
        prompt: 'Enter the translation key',
        value: '',
        validateInput: validateKey(dictionary)
    });

    if (!key) {
        return;
    }

    const translation = metadata.text
        .replace(/\{\{\s*/gi, '{{ ')
        .replace(/\s*\}\}/gi, ' }}');

    paste(prepareSnippet({[key]: translation}, key, metadata));

    await updateTranslations(key, translation);
}

async function getTranslations() {
    const uri = await getTranslationsUri();

    if (!uri) {
        return;
    }

    const content = await readFile(uri);

    if (!content) {
        return;
    }

    try {
        const translations = JSON.parse(content);

        return translations;
    } catch (e) {
        const action = await showMessage('Parsing file with translations failed', ['Set new file', 'Modify', 'Cancel']);

        if (action === 'Set new file') {
            await vscode.commands.executeCommand('ngx-translate-manager.set-locale-file');
        } else if (action === 'Modify') {
            // TODO: open invalid document
        }
    }
}

async function updateTranslations(key: string, translation: string): Promise<void> {
    const translations = await getTranslations();

    let ref = translations;

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

    const uri = await getTranslationsUri();

    if (!uri) {
        return;
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(util.stringify(translations), 'utf8'));
}

export function prepareSnippet(cache: any, key: string, metadata: SelectionMetadata): vscode.SnippetString {
    const template = getTemplate(metadata.context, metadata.filetype);
    const params = getParams(cache, key);

    return getSnippet(template, key, params);
}

function getFileType(document: vscode.TextDocument, position: vscode.Position): string {
    if (document.languageId === 'typescript') {
        const template = /(template\s*:\s*`)([^`]*)`/gi;
        const text = document.getText();

        let match = null;

        while ((match = template.exec(text)) !== null) {
            const from = document.positionAt(match.index + match[1].length);
            const to = document.positionAt(match.index + match[1].length + match[2].length);

            if (new vscode.Range(from, to).contains(position)) {
                return 'html';
            }
        }
    }

    return document.languageId;
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

async function updateCache(cache: vscode.Memento) {
    const translations = await getTranslations();
    const dictionary = util.flattenObject(translations);

    await cache.update(DICTIONARY_KEY, dictionary);
}

export function provideCompletionItems(cache: any) {
    return async (document: vscode.TextDocument, position: vscode.Position) => {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            return [];
        }

        const line = document.lineAt(position).text;
        const before = line.slice(0, position.character);

        if (!/_(\.[\w-]+)*\.$/g.test(before)) {
            return [];
        }

        const underscore = before.lastIndexOf('_');
        const prefix = before.slice(underscore).slice(2, -1);

        const dictionary = (typeof cache.get === 'function' && cache.get(DICTIONARY_KEY)) || cache as any || {};
        const context = before.slice(0, underscore);
        const filetype = getFileType(document, position);
        const template = getTemplate(context, filetype);

        return Object.keys(dictionary)
            .filter(key => key.startsWith(prefix))
            .map(key => {
                let params = dictionary[key].match(/{{\s*([^{}\s]+)\s*}}/g);

                if (params) {
                    params = params
                        .map(format)
                        .join(', ');
                }

                return {
                    label: key.slice(prefix.length).replace(/^\./gi, ''),
                    detail: dictionary[key],
                    insertText: getSnippet(template, key, params),
                    kind: vscode.CompletionItemKind.Snippet,
                    additionalTextEdits: [
                        vscode.TextEdit.delete(
                            new vscode.Range(new vscode.Position(position.line, underscore), position)),
                    ]
                };
            });
    };
}

function provideHover(cache: vscode.Memento): vscode.HoverProvider {
    return {
        provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
            const pattern = /(?<quote>['"])[\w-\.]+\k<quote>/g;
            const range = document.getWordRangeAtPosition(position, pattern);

            if (range === undefined) {
                return null;
            }

            const key = document.getText(range).slice(1, -1);
            const dict = cache.get(DICTIONARY_KEY) as any;

            if (dict.hasOwnProperty(key)) {
                return new vscode.Hover(new vscode.MarkdownString(`*${dict[key]}*`), range);
            } else {
                return null;
            }
        }
    };
}

export function getSelectionMetadata(): SelectionMetadata | null {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return null;
    }

    if (editor.selection.isEmpty) {
        return null;
    }

    const document = editor.document;
    const start = editor.selection.start;

    return {
        text: document.getText(editor.selection),
        context: document.lineAt(start).text.slice(0, start.character),
        filetype: getFileType(document, start),
    };
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

export async function activate(context: vscode.ExtensionContext) {
    const registerProviders = () => {
        const pattern = getConfig().get('pattern') as string;

        hoverProvider = vscode.languages.registerHoverProvider(
            { scheme: 'file', pattern },
            provideHover(context.workspaceState));

        completionItemProvider = vscode.languages.registerCompletionItemProvider(
            { scheme: 'file', pattern },
            { provideCompletionItems: provideCompletionItems(context.workspaceState) },
            '.');

        context.subscriptions.push(hoverProvider, completionItemProvider);
    };

    await updateCache(context.workspaceState);
    await setDictionaryWatcher(context);

    context.subscriptions.push(vscode.commands.registerCommand('ngx-translate-manager.store', () => {
        const metadata = getSelectionMetadata();

        if (!metadata) {
            return;
        }

        store(context.workspaceState, metadata);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('ngx-translate-manager.search', () => {
        const metadata = getSelectionMetadata();

        if (!metadata) {
            return;
        }

        const items = search(context.workspaceState, metadata.text);

        if (items.length === 0) {
            vscode.window.showInformationMessage('No translations found');
            return;
        }

        const picker = vscode.window.createQuickPick();

        picker.placeholder = 'Select translation';
        picker.items = items;

        picker.onDidChangeSelection(async (data) => {
            const key = data[0].description;

            if (!key) {
                return;
            }

            const snippet = prepareSnippet(context.workspaceState, key, metadata);

            paste(snippet);

            picker.hide();
            picker.dispose();
        });

        picker.show();
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
