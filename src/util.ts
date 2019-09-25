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
    return Object.keys(obj).reduce((flat: any, key: string) => {
        if (typeof obj[key] === 'object') {
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