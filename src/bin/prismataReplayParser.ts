#!/usr/bin/env node

// tslint:disable:no-console

import { strict as assert } from 'assert';
import * as fs from 'fs';
import minimist from 'minimist';
import sourceMapSupport from 'source-map-support';
import * as zlib from 'zlib';

import { ActionType, EndCondition, GameFormat, NotImplementedError, Player, ReplayParser } from '..';

function loadSync(file: string): Buffer {
    if (file.endsWith('.gz')) {
        return zlib.gunzipSync(fs.readFileSync(file));
    }
    return fs.readFileSync(file);
}

interface ListGameplayEventsOptions {
    showCommands?: boolean;
    showUndoPoints?: boolean;
    strict?: boolean;
}

function listGameplayEvents(replayData: Buffer, options: ListGameplayEventsOptions = {}): void {
    function log(indentLevel: number, message: string): void {
        console.info(`${Array(indentLevel + 1).join('  ')}${message}`);
    }

    const parser = new ReplayParser(replayData, { strict: options.strict });
    const state = parser.state;

    console.info(`Code: ${parser.getCode()}`);
    console.info(`Start time: ${parser.getStartTime()}`);
    console.info(`End time: ${parser.getEndTime()}`);
    console.info(`Server version: ${parser.getServerVersion()}`);
    console.info(`P1: ${JSON.stringify(parser.getPlayerInfo(Player.First))}`);
    console.info(`P2: ${JSON.stringify(parser.getPlayerInfo(Player.Second))}`);
    console.info(`Game format: ${GameFormat[parser.getGameFormat()]}`);
    console.info(`Time control P1: ${JSON.stringify(parser.getTimeControl(Player.First))}`);
    console.info(`Time control P2: ${JSON.stringify(parser.getTimeControl(Player.Second))}`);
    console.info(`Deck P1: ${JSON.stringify(parser.getDeck(Player.First))}`);
    console.info(`Deck P2: ${JSON.stringify(parser.getDeck(Player.Second))}`);
    console.info(`Start position P1: ${JSON.stringify(parser.getStartPosition(Player.First))}`);
    console.info(`Start position P2: ${JSON.stringify(parser.getStartPosition(Player.Second))}`);

    if (options.showCommands) {
        parser.on('command', (command, id) => {
            if (id !== undefined) {
                log(1, `${command} ${id}`);
            } else {
                log(1, command);
            }
        });
    }

    parser.on('action', (type, data) => {
        if (data && data.unit !== undefined && data.target !== undefined) {
            log(options.showCommands ? 2 : 1, `Action: ${ActionType[type]} ${data.unit.name} -> ${data.target.name}`);
        } else if (data && data.unit !== undefined) {
            log(options.showCommands ? 2 : 1, `${ActionType[type]} ${data.unit.name}`);
        } else if (data && data.name !== undefined) {
            log(options.showCommands ? 2 : 1, `${ActionType[type]} ${data.name}`);
        } else {
            log(options.showCommands ? 2 : 1, ActionType[type]);
        }
    });

    if (options.showUndoPoints) {
        parser.on('undoSnapshot', () => {
            log(0, '-- undo point');
        });
    }

    state.on('turnStarted', (turnNumber: number, player: Player) => {
        log(0, `P${player + 1} turn ${turnNumber} started.`);
    });

    state.on('unitDestroyed', (unit, reason) => {
        log(options.showCommands ? 3 : 2, `Unit destroyed (${reason}): ${unit.name}`);
    });

    state.on('unitConstructed', unit => {
        log(options.showCommands ? 3 : 2, `Unit constructed: ${unit.name}`);
    });

    state.on('autoAction', (type, unit) => {
        log(options.showCommands ? 3 : 2, `Automatic action: ${type} ${unit.name}`);
    });

    state.on('assignAttackBlocker', unit => {
        log(options.showCommands ? 3 : 2, `Assigning attack to blocker: ${unit.name}`);
    });

    parser.run();

    const result = parser.getResult();
    switch (result.endCondition) {
    case EndCondition.Resign:
        if (result.winner === undefined) {
            throw new Error('Winner not set.');
        }
        console.info(
            `P${result.winner + 1} defeated P${(result.winner + 1) % 2 + 1} by resignation.`);
        break;
    case EndCondition.Elimination:
        if (result.winner === undefined) {
            throw new Error('Winner not set.');
        }
        console.info(
            `P${result.winner + 1} defeated P${(result.winner + 1) % 2 + 1} by elimination.`);
        break;
    case EndCondition.Defeated:
        if (result.winner === undefined) {
            throw new Error('Winner not set.');
        }
        console.info(`P${result.winner + 1} defeated P${(result.winner + 1) % 2 + 1}.`);
        break;
    case EndCondition.Repetition:
        assert(result.winner === undefined);
        console.info('Game ended in a draw by repetition.');
        break;
    case EndCondition.Disconnect:
        if (result.winner === undefined) {
            throw new Error('Winner not set.');
        }
        console.info(
            `P${result.winner + 1} defeated P${(result.winner + 1) % 2 + 1} by disconnect.`);
        break;
    case EndCondition.DoubleDisconnect:
        assert(result.winner === undefined);
        console.info('Game ended in a draw by double disconnect.');
        break;
    default:
        console.error('Unknown end condition.');
        break;
    }
}

// tslint:disable:no-unsafe-any
async function main(): Promise<void> {
    sourceMapSupport.install();
    const argv = minimist(process.argv.slice(2), { boolean: ['test', 'v', 'c', 'u', 'strict'] });

    if (argv._.length === 0) {
        console.error('No input files.');
    }

    let errorCount = 0;
    let notImplementedCount = 0;
    for (const filename of argv._) {
        let data: Buffer;
        try {
            data = loadSync(filename);
        } catch (e) {
            console.error(`Failed to load replay data ${filename}: ${e}`);
            break;
        }
        if (argv.test) {
            try {
                const parser = new ReplayParser(data, { strict: argv.strict });
                parser.getCode();
                parser.getStartTime();
                parser.getEndTime();
                parser.getServerVersion();
                parser.getPlayerInfo(Player.First);
                parser.getPlayerInfo(Player.Second);
                parser.getGameFormat();
                parser.getTimeControl(Player.First);
                parser.getTimeControl(Player.Second);
                parser.getDeck(Player.First);
                parser.getDeck(Player.Second);
                parser.getStartPosition(Player.First);
                parser.getStartPosition(Player.Second);
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
                listGameplayEvents(data, {
                    strict: argv.strict,
                    showCommands: argv.c,
                    showUndoPoints: argv.u,
                });
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
        .catch(e => {
            console.error(e);
            process.exit(1);
        });
}
