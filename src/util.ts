'use strict';

export function stringify(node: any, level: number = 1) {
    if (typeof node !== 'object') {
        return JSON.stringify(node);
    }

    const out: any[] = [];
    const keys = Object.keys(node).sort();
    const selfIndex = keys.indexOf('self');

    if (selfIndex > -1) {
        const tmp = keys[0];
        keys[0] = keys[selfIndex];
        keys[selfIndex] = tmp;
    }

    keys.forEach((key) => {
        const value = stringify(node[key], level + 1);

        out.push('\n' + ' '.repeat(4 * level) + '"' + key + '": ' + value);
    });

    return '{' + out.join(',') + '\n' + ' '.repeat(4 * (level - 1)) + '}';
}

export function flattenObject(obj: any): any {
    if (!obj) {
        return {};
    }

    return Object.keys(obj).reduce((flat: any, key: string) => {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
            const nested = flattenObject(obj[key]);

            Object.keys(nested).forEach((nKey: string) => {
                flat[key + '.' + nKey] = nested[nKey];
            });
        } else {
            flat[key] = obj[key];
        }

        return flat;
    }, {});
}

export function fuzzysearch(query: string, phrase: string): boolean {
    const qlen = query.length;
    const plen = phrase.length;

    if (qlen > plen) {
        return false;
    }

    if (qlen === plen) {
        return query === phrase;
    }

    outer: for (let i = 0, j = 0; i < qlen; i++) {
        const qch = query.charCodeAt(i);

        while (j < plen) {
            if (phrase.charCodeAt(j++) === qch) {
                continue outer;
            }
        }

        return false;
    }

    return true;
}
