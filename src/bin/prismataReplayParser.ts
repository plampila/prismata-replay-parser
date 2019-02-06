#!/usr/bin/env node

// tslint:disable:no-console

import { strict as assert } from 'assert';
import * as fs from 'fs';
import minimist from 'minimist';
import sourceMapSupport from 'source-map-support';
import * as zlib from 'zlib';

import { constants, NotImplementedError, ReplayParser } from '..';

function loadSync(file: string): Buffer {
    if (file.endsWith('.gz')) {
        return zlib.gunzipSync(fs.readFileSync(file));
    }
    return fs.readFileSync(file);
}

function listGameplayEvents(replayData: any, showCommands: boolean, showUndoPoints: boolean): void {
    function log(indentLevel: number, message: string): void {
        console.info(`${Array(indentLevel + 1).join('  ')}${message}`);
    }

    const parser = new ReplayParser(replayData);
    const state = parser.state;

    console.info(`Code: ${parser.getCode()}`);
    console.info(`Start time: ${parser.getStartTime()}`);
    console.info(`End time: ${parser.getEndTime()}`);
    console.info(`Server version: ${parser.getServerVersion()}`);
    console.info(`P1: ${JSON.stringify(parser.getPlayerInfo(0))}`);
    console.info(`P2: ${JSON.stringify(parser.getPlayerInfo(1))}`);
    console.info(`Game format: ${Symbol.keyFor(parser.getGameFormat())}`);
    console.info(`Time control P1: ${JSON.stringify(parser.getTimeControl(0))}`);
    console.info(`Time control P2: ${JSON.stringify(parser.getTimeControl(1))}`);
    console.info(`Deck P1: ${JSON.stringify(parser.getDeck(0))}`);
    console.info(`Deck P2: ${JSON.stringify(parser.getDeck(1))}`);
    console.info(`Start position P1: ${JSON.stringify(parser.getStartPosition(0))}`);
    console.info(`Start position P2: ${JSON.stringify(parser.getStartPosition(1))}`);

    if (showCommands) {
        parser.on('command', (command: symbol, id: string | undefined) => {
            if (id !== undefined) {
                log(1, `${Symbol.keyFor(command)} ${id}`);
            } else {
                const typeName = Symbol.keyFor(command);
                if (typeName === undefined) {
                    throw new Error('Command symbol has no key.');
                }
                log(1, typeName);
            }
        });
    }

    parser.on('action', (type, data) => {
        const typeName = Symbol.keyFor(type);
        if (typeName === undefined) {
            throw new Error('Action symbol has no key.');
        }
        if (data && data.target) {
            log(showCommands ? 2 : 1,
                `Action: ${typeName} ${data.unit.name} -> ${data.target.name}`);
        } else if (data && data.unit) {
            log(showCommands ? 2 : 1, `${typeName} ${data.unit.name}`);
        } else if (data && data.name) {
            log(showCommands ? 2 : 1, `${typeName} ${data.name}`);
        } else {
            log(showCommands ? 2 : 1, typeName);
        }
    });

    if (showUndoPoints) {
        parser.on('undoSnapshot', () => {
            log(0, '-- undo point');
        });
    }

    state.on('turnStarted', (turnNumber, player) => {
        log(0, `P${player + 1} turn ${turnNumber} started.`);
    });

    state.on('unitDestroyed', (unit, reason) => {
        log(showCommands ? 3 : 2, `Unit destroyed (${reason}): ${unit.name}`);
    });

    state.on('unitConstructed', unit => {
        log(showCommands ? 3 : 2, `Unit constructed: ${unit.name}`);
    });

    state.on('autoAction', (type, unit) => {
        log(showCommands ? 3 : 2, `Automatic action: ${type} ${unit.name}`);
    });

    state.on('assignAttackBlocker', unit => {
        log(showCommands ? 3 : 2, `Assigning attack to blocker: ${unit.name}`);
    });

    parser.run();

    const result = parser.getResult();
    switch (result.endCondition) {
    case constants.END_CONDITION_RESIGN:
        if (result.winner === null) {
            throw new Error('Winner not set.');
        }
        console.info(
            `P${result.winner + 1} defeated P${(result.winner + 1) % 2 + 1} by resignation.`);
        break;
    case constants.END_CONDITION_ELIMINATION:
        if (result.winner === null) {
            throw new Error('Winner not set.');
        }
        console.info(
            `P${result.winner + 1} defeated P${(result.winner + 1) % 2 + 1} by elimination.`);
        break;
    case constants.END_CONDITION_DEFEATED:
        if (result.winner === null) {
            throw new Error('Winner not set.');
        }
        console.info(`P${result.winner + 1} defeated P${(result.winner + 1) % 2 + 1}.`);
        break;
    case constants.END_CONDITION_REPETITION:
        assert(result.winner === null);
        console.info('Game ended in a draw by repetition.');
        break;
    case constants.END_CONDITION_DISCONNECT:
        if (result.winner === null) {
            throw new Error('Winner not set.');
        }
        console.info(
            `P${result.winner + 1} defeated P${(result.winner + 1) % 2 + 1} by disconnect.`);
        break;
    case constants.END_CONDITION_DOUBLE_DISCONNECT:
        assert(result.winner === null);
        console.info('Game ended in a draw by double disconnect.');
        break;
    default:
        console.error('Unknown end condition.');
        break;
    }
}

async function main(): Promise<void> {
    sourceMapSupport.install();
    const argv = minimist(process.argv.slice(2), { boolean: ['test', 'v', 'c', 'u'] });

    if (argv._.length === 0) {
        console.error('No input files.');
    }

    let errorCount = 0;
    let notImplementedCount = 0;
    for (const filename of argv._) {
        let data;
        try {
            data = loadSync(filename);
        } catch (e) {
            console.error(`Failed to load replay data ${filename}: ${e}`);
            break;
        }
        if (argv.test) {
            try {
                const parser = new ReplayParser(data);
                parser.getCode();
                parser.getStartTime();
                parser.getEndTime();
                parser.getServerVersion();
                parser.getPlayerInfo(0);
                parser.getPlayerInfo(1);
                parser.getGameFormat();
                parser.getTimeControl(0);
                parser.getTimeControl(1);
                parser.getDeck(0);
                parser.getDeck(1);
                parser.getStartPosition(0);
                parser.getStartPosition(1);
                parser.getResult();
                parser.run();
            } catch (e) {
                errorCount++;
                if (e instanceof NotImplementedError) {
                    notImplementedCount++;
                }
                if (argv.v) {
                    console.debug(`${filename}: ${e}`);
                }
            }
        } else {
            try {
                listGameplayEvents(data, argv.c, argv.u);
            } catch (e) {
                console.error(`${filename}:`, e);
                if (e.data) {
                    if (e.data.name) {
                        console.error(`Data: Unit: ${e.data.name} ${JSON.stringify(e.data)}`);
                    } else {
                        console.error(`Data: ${JSON.stringify(e.data)}`);
                    }
                }
            }
        }
    }
    if (argv.test) {
        console.info(`Ran into an error in ${errorCount - notImplementedCount} replays.`);
        console.info(`Found unimplemented feature in ${notImplementedCount} replays.`);
        console.info(`Succesfully parsed ${argv._.length - errorCount} replays.`);
    }
}

if (!module.parent) {
    main()
        .catch(console.error);
}
