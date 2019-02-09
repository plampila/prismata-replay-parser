#!/usr/bin/env node

// tslint:disable:no-console

import * as fs from 'fs';
import stringify from 'json-stable-stringify'; // tslint:disable-line:no-implicit-dependencies
import { basename } from 'path';
import * as TJS from 'typescript-json-schema'; // tslint:disable-line:no-implicit-dependencies

const SETTINGS: TJS.PartialArgs = {
    ref: true,
    aliasRef: true,
    noExtraProps: true,
    required: true,
    strictNullChecks: true,
};

function main(): void {
    let types: string[];
    if (process.argv[2] === '--update') {
        types = fs.readdirSync('src/schemas/')
            .filter(x => x.endsWith('.schema.json'))
            .map(x => basename(x, '.schema.json'));
    } else {
        types = process.argv.slice(2);
    }
    if (types.length === 0) {
        console.error('No types to process.');
        return process.exit(1);
    }

    const program = TJS.programFromConfig('tsconfig.json');

    for (const type of types) {
        if (!/^[A-Za-z0-9]+$/.test(type)) {
            console.error('Invalid type name.');
            return process.exit(1);
        }
        console.info(`Generating schema for: ${type}`);
        const schema = TJS.generateSchema(program, type, SETTINGS);
        if (!schema) {
            console.error('Failed to generate schema.');
            return process.exit(1);
        }
        fs.writeFileSync(`src/schemas/${type}.schema.json`, `${stringify(schema, { space: 4 })}\n\n`);
    }
}

if (!module.parent) {
    main();
}
