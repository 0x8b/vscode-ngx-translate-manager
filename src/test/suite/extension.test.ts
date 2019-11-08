import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as util from '../../util';
import * as extension from '../../extension';

suite('Extension Test Suite', async () => {
    interface IntellisenseTestCase {
        name: string;
        file: string;
        position: [number, number];
        lang: string;
        key: string;
    }

    const SEPARATOR = /💥\r?\n/;
    const LANG = {
        H: 'html',
        T: 'typescript',
    };

    const base = path.join(__dirname.substring(0, __dirname.lastIndexOf('out')), 'src/test/suite/test-cases');
    const translations = JSON.parse(fs.readFileSync(path.join(base, 'en.json'), 'utf8'));
    const memento = util.flattenObject(translations);
    const getCompletionItems = extension.provideCompletionItems(memento);

    const intellisenseTestCases: IntellisenseTestCase[] = [
        { name: 'Intellisense test 01', file: 'a01.case', position: [0,  2], lang: LANG.H, key: 'a' },
        { name: 'Intellisense test 02', file: 'a02.case', position: [0,  5], lang: LANG.H, key: 'b' },
        { name: 'Intellisense test 03', file: 'a03.case', position: [1, 15], lang: LANG.T, key: 'c.d' },
        { name: 'Intellisense test 04', file: 'a04.case', position: [3,  9], lang: LANG.T, key: 'a' },
        { name: 'Intellisense test 05', file: 'a05.case', position: [4,  9], lang: LANG.T, key: 'c.self' },
        { name: 'Intellisense test 06', file: 'a06.case', position: [0, 12], lang: LANG.H, key: 'a' },
        { name: 'Intellisense test 07', file: 'a07.case', position: [0,  5], lang: LANG.H, key: 'a' },
        { name: 'Intellisense test 08', file: 'a08.case', position: [0,  5], lang: LANG.H, key: 'c.d' },
        { name: 'Intellisense test 09', file: 'a09.case', position: [0, 10], lang: LANG.H, key: 'a' },
        { name: 'Intellisense test 10', file: 'a10.case', position: [0,  4], lang: LANG.H, key: 'self' },
        { name: 'Intellisense test 11', file: 'a11.case', position: [1, 17], lang: LANG.H, key: 'd' },
    ];

    intellisenseTestCases.forEach(tc => {
        test(tc.name, () => {
            return new Promise(async (resolve) => {
                const content = fs.readFileSync(path.join(base, tc.file), 'utf8');

                vscode.workspace
                    .openTextDocument({content, language: tc.lang})
                    .then(doc => vscode.window.showTextDocument(doc))
                    .then(async (editor) => {
                        const position = new vscode.Position(...tc.position);
                        const completions = await getCompletionItems(editor.document, position);
                        const item = completions.find(item => item.label === tc.key);

                        assert.notEqual(item, undefined, 'item');

                        const { insertText: snippet, additionalTextEdits } = item!;
                        const edits = new vscode.WorkspaceEdit();

                        edits.set(editor.document.uri, [
                            vscode.TextEdit.insert(position, snippet.value.replace(/\$\d+/g, '')),
                            ...additionalTextEdits
                        ]);

                        await vscode.workspace.applyEdit(edits);

                        const correct = content.split(SEPARATOR)[1];
                        const result = editor.document.getText().split(SEPARATOR)[0];

                        assert.equal(result, correct);
                        resolve();
                    });
            });
        });
    });

    interface SearchTestCase {
        name: string;
        file: string;
        range: [number, number, number, number];
        lang: string;
        key: string;
    }

    const searchTestCases: SearchTestCase[] = [
        { name: 'Search test 01', file: 'b01.case', range: [0,  0,  0,  4], lang: LANG.H, key: 'e' },
        { name: 'Search test 02', file: 'b02.case', range: [0,  5,  0, 10], lang: LANG.H, key: 'b' },
        { name: 'Search test 03', file: 'b03.case', range: [1, 13,  1, 21], lang: LANG.T, key: 'e' },
    ];

    searchTestCases.forEach(tc => {
        test(tc.name, () => {
            return new Promise(async (resolve) => {
                const content = fs.readFileSync(path.join(base, tc.file), 'utf8');

                vscode.workspace
                    .openTextDocument({content, language: tc.lang})
                    .then(doc => vscode.window.showTextDocument(doc))
                    .then(async (editor) => {
                        const query = editor.document.getText(new vscode.Range(...tc.range));
                        const items = extension.search(memento, query);
                        const item = items.find(item => item.description === tc.key);

                        assert.notEqual(item, undefined, 'item');

                        editor.selection = new vscode.Selection(...tc.range);

                        const key = item!.description;
                        const metadata = extension.getSelectionMetadata();

                        assert.notEqual(metadata, null, 'metadata');

                        await extension.paste(extension.prepareSnippet(memento, key!, metadata!));

                        const correct = content.split(SEPARATOR)[1];
                        const result = editor.document.getText().split(SEPARATOR)[0];

                        assert.equal(result, correct);
                        resolve();
                    });
            });
        });
    });
});
