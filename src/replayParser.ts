import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as timsort from 'timsort';

import constants from './constants';
import { DataError, InvalidStateError, NotImplementedError } from './customErrors';
import { GameState } from './gameState';
import {
    deepClone, parseResources, targetingIsUseful, blocking, frozen, purchasedThisTurn, validTarget
} from './util';

const GAME_FORMATS = {
    200: constants.GAME_FORMAT_RANKED,
    201: constants.GAME_FORMAT_VERSUS_BOT,
    202: constants.GAME_FORMAT_VERSUS,
    203: constants.GAME_FORMAT_EVENT,
    204: constants.GAME_FORMAT_CASUAL,
};

const END_CONDITIONS = {
    0: constants.END_CONDITION_RESIGN,
    1: constants.END_CONDITION_ELIMINATION,
    2: constants.END_CONDITION_DEFEATED,
    11: constants.END_CONDITION_REPETITION,
    30: constants.END_CONDITION_DISCONNECT,
    31: constants.END_CONDITION_DOUBLE_DISCONNECT,
    32: constants.END_CONDITION_DRAW, // is this some specific type of draw?
};
const DRAW_END_CONDITIONS = [constants.END_CONDITION_REPETITION,
    constants.END_CONDITION_DOUBLE_DISCONNECT, constants.END_CONDITION_DRAW];

const ACTION_TO_GAME_STATE_METHOD = {
    [constants.ACTION_ASSIGN_DEFENSE.toString()]: 'assignDefense',
    [constants.ACTION_CANCEL_ASSIGN_DEFENSE.toString()]: 'cancelAssignDefense',
    [constants.ACTION_CANCEL_PURCHASE.toString()]: 'cancelPurchase',
    [constants.ACTION_CANCEL_USE_ABILITY.toString()]: 'cancelUseAbility',
    [constants.ACTION_ASSIGN_ATTACK.toString()]: 'assignAttack',
    [constants.ACTION_CANCEL_ASSIGN_ATTACK.toString()]: 'cancelAssignAttack',
};

const ACTION_TO_GAME_STATE_UNIT_TEST_METHOD = {
    [constants.ACTION_ASSIGN_DEFENSE.toString()]: 'canAssignDefense',
    [constants.ACTION_CANCEL_ASSIGN_DEFENSE.toString()]: 'canCancelAssignDefense',
    [constants.ACTION_CANCEL_PURCHASE.toString()]: 'canCancelPurchase',
    [constants.ACTION_ASSIGN_ATTACK.toString()]: 'canAssignAttack',
    [constants.ACTION_CANCEL_ASSIGN_ATTACK.toString()]: 'canCancelAssignAttack',
    [constants.ACTION_USE_ABILITY.toString()]: 'canUseAbility',
    [constants.ACTION_CANCEL_USE_ABILITY.toString()]: 'canCancelUseAbility',
};

function sortShiftClickMatches(action, units) {
    function sortUnits(rules, offset?: number) {
        if (offset !== undefined && offset < 0) {
            offset = undefined;
        }
        timsort.sort(units, (a, b) => {
            for (let i = 0; i < rules.length; i++) {
                const key = rules[i].slice(1);
                let aVal;
                let bVal;
                if (key === 'delay-1') {
                    aVal = a['delay'] ? a['delay'] - 1 : 0;
                    bVal = b['delay'] ? b['delay'] - 1 : 0;
                } else if (key === 'lifespan+delay') {
                    aVal = a['lifespan'] ? a['lifespan'] + (a['delay'] || 0) : 0;
                    bVal = b['lifespan'] ? b['lifespan'] + (b['delay'] || 0) : 0;
                } else {
                    if (key === 'lifespan') {
                        aVal = a[key] || Infinity;
                        bVal = b[key] || Infinity;
                    } else {
                        aVal = a[key] || 0;
                        bVal = b[key] || 0;
                    }
                }
                if (aVal === bVal) {
                    continue;
                }
                if (rules[i][0] === '>') {
                    return bVal - aVal;
                }
                return aVal - bVal;
            }
            return 0;
        }, offset);
    }

    switch (action) {
    case constants.ACTION_SELECT_FOR_TARGETING:
        sortUnits(['<lifespan', '>toughness', '>charge']);
        break;
    case constants.ACTION_USE_ABILITY:
    case constants.ACTION_CANCEL_USE_ABILITY:
        if (units[0].defaultBlocking) {
            sortUnits(['>lifespan', '<toughness', '>charge']);
        } else if (units[0].HPUsed) {
            sortUnits(['<lifespan', '>toughness', '>charge']);
        } else {
            sortUnits(['<lifespan', '<toughness', '>charge']);
        }
        break;
    case constants.ACTION_ASSIGN_DEFENSE:
    case constants.ACTION_CANCEL_ASSIGN_DEFENSE:
        sortUnits(['<assignedAttack', '<lifespan', '<toughness', '<charge']);
        break;
    case constants.ACTION_ASSIGN_ATTACK:
    case constants.ACTION_CANCEL_ASSIGN_ATTACK:
        if (units[0].defaultBlocking) {
            // Sort blockers and non-blockers separately
            sortUnits(['<delay', '<abilityUsed', '<lifespan', '>toughness', '>charge']);
            sortUnits(['<assignedAttack', '<delay-1', '>lifespan+delay', '<toughness', '>charge'],
                units.findIndex(x => x.abilityUsed || x.delay));
        } else {
            sortUnits(['<assignedAttack', '<delay-1', '>lifespan+delay', '<toughness', '>charge']);
        }
        break;
    case constants.ACTION_PURCHASE:
    case constants.ACTION_CANCEL_PURCHASE:
        break;
    default:
        throw new Error(`Unsupported action: ${action}`);
    }
    return units;
}

function parseCommand(data) {
    if (data._type.startsWith('emote')) {
        if (!data.hasOwnProperty('_id') && !data.hasOwnProperty('_params')) {
            throw new DataError('Missing properties.', data);
        }
        if (Object.keys(data).length !== 2 &&
            (Object.keys(data).length !== 3 || !data.hasOwnProperty('_type'))) {
            throw new DataError('Unknown properties.', data);
        }
        return {
            command: constants.REPLAY_COMMAND_EMOTE,
            player: data._id,
            params: data._params,
        };
    }

    if (!data.hasOwnProperty('_type') || !data.hasOwnProperty('_id')) {
        throw new DataError('Missing properties.', data);
    }
    if (Object.keys(data).length !== 2) {
        throw new DataError('Unknown properties.', data);
    }

    const id = data._id;
    switch (data._type) {
    case 'inst clicked':
        return { command: constants.REPLAY_COMMAND_CLICK_UNIT, id };
    case 'inst shift clicked':
        return { command: constants.REPLAY_COMMAND_SHIFT_CLICK_UNIT, id };
    case 'card clicked':
        return { command: constants.REPLAY_COMMAND_CLICK_BLUEPRINT, id };
    case 'card shift clicked':
        return { command: constants.REPLAY_COMMAND_SHIFT_CLICK_BLUEPRINT, id };
    case 'space clicked':
        if (id !== -1 && id !== 0) {
            throw new DataError('Unknown ID for space.', id);
        }
        return { command: constants.REPLAY_COMMAND_CLICK_SPACE };
    case 'revert clicked':
        if (id !== -1) {
            throw new DataError('Unknown ID.', data);
        }
        return { command: constants.REPLAY_COMMAND_CLICK_REVERT };
    case 'undo clicked':
        if (id !== -1) {
            throw new DataError('Unknown ID.', data);
        }
        return { command: constants.REPLAY_COMMAND_CLICK_UNDO };
    case 'redo clicked':
        if (id !== -1) {
            throw new DataError('Unknown ID.', data);
        }
        return { command: constants.REPLAY_COMMAND_CLICK_REDO };
    case 'cancel target processed':
        if (id !== -1) {
            throw new DataError('Unknown ID.', data);
        }
        return { command: constants.REPLAY_COMMAND_CANCEL_TARGETING };
    case 'end swipe processed':
        if (id !== -1 && id !== 0) {
            throw new DataError('Unknown ID.', data);
        }
        return { command: constants.REPLAY_COMMAND_END_COMBINED_ACTION };
    default:
        throw new DataError('Unknown command type', data);
    }
}

function parseDeckAndInitInfo(data) {
    if (!data.versionInfo) {
        throw new DataError('Version info missing.');
    }
    if (!data.deckInfo) {
        throw new DataError('Deck info missing.');
    }
    if (!data.initInfo) {
        throw new DataError('Init info missing.');
    }

    const info: any = {};
    if (data.versionInfo.serverVersion <= 153) {
        info.baseSets = [data.deckInfo.whiteBase, data.deckInfo.blackBase];
        info.randomSets = [data.deckInfo.whiteDominion, data.deckInfo.blackDominion];
        info.initCards = [data.initInfo.whiteInitCards, data.initInfo.blackInitCards];
        info.initResources = [data.initInfo.whiteInitResources, data.initInfo.blackInitResources];
    } else {
        info.baseSets = data.deckInfo.base;
        info.randomSets = data.deckInfo.randomizer;
        info.initCards = data.initInfo.initCards;
        info.initResources = data.initInfo.initResources;
    }
    info.infiniteSupplies = data.initInfo.infiniteSupplies;

    info.deck = deepClone(data.deckInfo.mergedDeck);

    // Renames are used even in new replays for some event units
    const renames = info.deck.filter(x => x.UIName && x.UIName !== x.name).reduce((list, x) => {
        list[x.name] = x.UIName;
        x.originalName = x.name;
        x.name = x.UIName;
        delete x.UIName;
        return list;
    }, {});
    if (Object.keys(renames).length > 0) {
        info.deck.forEach(x => {
            ['resonate', 'goldResonate'].forEach(key => {
                if (renames[x[key]]) {
                    x[key] = renames[x[key]];
                }
            });

            ['abilityScript', 'buyScript', 'beginOwnTurnScript']
                .filter(key => x[key] && x[key].create)
                .forEach(key => {
                    x[key].create.forEach(rule => {
                        if (renames[rule[0]]) {
                            rule[0] = renames[rule[0]];
                        }
                    });
                });

            ['abilitySac', 'buySac'].filter(key => x[key]).forEach(key => {
                x[key].forEach(rule => {
                    if (renames[rule[0]]) {
                        rule[0] = renames[rule[0]];
                    }
                });
            });
        });

        info.initCards.forEach(initCardsForPlayer => {
            initCardsForPlayer.forEach(x => {
                if (renames[x[1]]) {
                    x[1] = renames[x[1]];
                }
            });
        });

        info.baseSets.forEach(baseSetForPlayer => {
            for (let i = 0; i < baseSetForPlayer.length; i++) {
                if (renames[baseSetForPlayer[i]]) {
                    baseSetForPlayer[i] = renames[baseSetForPlayer[i]];
                }
            }
        });

        info.randomSets.forEach(randomSetForPlayer => {
            for (let i = 0; i < randomSetForPlayer.length; i++) {
                if (renames[randomSetForPlayer[i]]) {
                    randomSetForPlayer[i] = renames[randomSetForPlayer[i]];
                }
            }
        });
    }

    return info;
}

export class ReplayParser extends EventEmitter {
    private readonly data: any;
    public readonly state: GameState = new GameState();
    private inConfirmPhase: boolean = false;
    private inDamagePhase: boolean = false;
    private targetingUnits: any[] = [];

    private undoSnapshots: any = null;
    private combinedAction: any = null;
    private startTurnSnapshot: any = null;
    private endDefenseSnapshot: any = null;
    private endActionSnapshot: any = null;

    constructor(replayData) {
        super();

        if (Buffer.isBuffer(replayData)) {
            this.data = JSON.parse(replayData.toString());
        } else if (typeof replayData === 'string') {
            this.data = JSON.parse(replayData);
        } else if (replayData !== null && typeof replayData === 'object') {
            this.data = replayData;
        } else {
            throw new Error('Invalid replay data.');
        }
    }

    getSnapshot() {
        return {
            inConfirmPhase: this.inConfirmPhase,
            inDamagePhase: this.inDamagePhase,
            targetingUnits: this.targetingUnits.slice(),
            endDefenseSnapshot: this.endDefenseSnapshot,
            endActionSnapshot: this.endActionSnapshot,
            stateSnapshot: this.state.getSnapshot(),
        };
    }

    restoreSnapshot(snapshot) {
        this.inConfirmPhase = snapshot.inConfirmPhase;
        this.inDamagePhase = snapshot.inDamagePhase;
        this.targetingUnits = snapshot.targetingUnits.slice();
        this.endDefenseSnapshot = snapshot.endDefenseSnapshot;
        this.endActionSnapshot = snapshot.endActionSnapshot;
        this.state.restoreSnapshot(snapshot.stateSnapshot);
    }

    addUndoSnapshot() {
        this.stopCombinedAction();
        this.emit('undoSnapshot');
        this.undoSnapshots.push(this.getSnapshot());
    }

    startCombinedAction() {
        this.combinedAction = true;
    }

    stopCombinedAction() {
        this.combinedAction = false;
    }

    getClickAction(unit) {
        assert(this.targetingUnits.length === 0, 'In targeting mode.');
        assert(!this.inConfirmPhase, 'In confirm phase.');

        if (unit.destroyed) {
            return {};
        }

        if (this.state.inDefensePhase) {
            assert(this.targetingUnits.length === 0, 'Targeting in defense phase.');
            if (unit.player !== this.state.activePlayer || !blocking(unit) || frozen(unit)) {
                return {};
            }
            if (unit.assignedAttack) {
                if (this.state.attack(this.state.villain()) === 0 && this.state.absorber()) {
                    return {
                        action: constants.ACTION_CANCEL_ASSIGN_DEFENSE,
                        unit: this.state.absorber(),
                    };
                }
                return { action: constants.ACTION_CANCEL_ASSIGN_DEFENSE, unit };
            }
            if (this.state.attack(this.state.villain()) <= 0) {
                return {};
            }
            return { action: constants.ACTION_ASSIGN_DEFENSE, unit };
        }

        if (unit.constructedBy && purchasedThisTurn(this.state.units[unit.constructedBy])) {
            return {
                action: constants.ACTION_CANCEL_PURCHASE,
                unit: this.state.units[unit.constructedBy],
            };
        }

        if (unit.player !== this.state.activePlayer) {
            if (unit.targetedBy) {
                const sources = unit.targetedBy.map(x => this.state.units[x]);
                for (let i = 0; i < sources.length; i++) {
                    const source = sources[i];
                    switch (source.targetAction) {
                    case 'disrupt':
                        if (!unit.sacrificed) {
                            if (!this.inDamagePhase) {
                                return {
                                    action: constants.ACTION_CANCEL_USE_ABILITY,
                                    unit: source,
                                };
                            }
                            if (!this.state.breaching() && !unit.fragile && !unit.assignedAttack &&
                                    this.state.attack() < unit.toughness) {
                                return {
                                    action: constants.ACTION_CANCEL_USE_ABILITY,
                                    unit: source,
                                };
                            }
                        }
                        break;
                    case 'snipe':
                        if (unit.assignedAttack) {
                            return { action: constants.ACTION_CANCEL_ASSIGN_ATTACK, unit };
                        }
                        return { action: constants.ACTION_CANCEL_USE_ABILITY, unit: source };
                    }
                }
            }

            if (unit.sacrificed) {
                return {};
            }

            if (unit.assignedAttack) {
                if (this.state.attack() === 0 && this.state.breachAbsorber() &&
                    unit !== this.state.breachAbsorber()) {
                    return {
                        action: constants.ACTION_CANCEL_ASSIGN_ATTACK,
                        unit: this.state.breachAbsorber(),
                    };
                }
                if (this.state.defensesOverran() && blocking(unit)) {
                    if (frozen(unit)) {
                        return { action: constants.ACTION_CANCEL_ASSIGN_ATTACK, unit };
                    }
                    if (this.state.breaching() || unit.defensesBypassed) {
                        return {};
                    }
                    return { action: constants.ACTION_CANCEL_OVERRUN_DEFENSES };
                }
                return { action: constants.ACTION_CANCEL_ASSIGN_ATTACK, unit };
            }

            if (unit.undefendable && !unit.delay) {
                return { action: constants.ACTION_ASSIGN_ATTACK, unit };
            }
            if (this.state.defensesOverran()) {
                if ((unit.delay && unit.purchased && !blocking(unit)) &&
                    !this.state.canOverKill()) {
                    return {};
                }
                if (!unit.fragile && this.state.attack() < unit.toughness) {
                    return {};
                }
                return { action: constants.ACTION_ASSIGN_ATTACK, unit };
            }
            if (!blocking(unit) || !this.state.canOverrunDefenses()) {
                return {};
            }
            return { action: constants.ACTION_OVERRUN_DEFENSES };
        }

        if (purchasedThisTurn(unit)) {
            return { action: constants.ACTION_CANCEL_PURCHASE, unit };
        }
        if (unit.constructedBy) {
            return {
                action: constants.ACTION_CANCEL_USE_ABILITY,
                unit: this.state.units[unit.constructedBy],
            };
        }

        if (!unit.abilityScript && !unit.targetAction) {
            return {};
        }
        if (unit.abilityUsed) {
            if (unit.sacrificed && (!unit.abilityScript || !unit.abilityScript.selfsac)) {
                return {};
            }
            return { action: constants.ACTION_CANCEL_USE_ABILITY, unit };
        }
        if (unit.sacrificed || unit.delay || unit.charge === 0 ||
            (unit.HPUsed && unit.toughness < unit.HPUsed)) {
            return {};
        }
        if (unit.targetAction) {
            // TODO: Check if there are legal targets
            return { action: constants.ACTION_SELECT_FOR_TARGETING, unit };
        }
        return { action: constants.ACTION_USE_ABILITY, unit };
    }

    runAction(action: symbol, data?: any) {
        if (!action) {
            throw new Error('No action given.');
        }
        this.emit('action', action, data);

        switch (action) {
        case constants.ACTION_END_DEFENSE:
            this.endDefenseSnapshot = this.getSnapshot();
            this.state.endDefense();
            break;
        case constants.ACTION_SELECT_FOR_TARGETING:
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }
            this.targetingUnits.push(data.unit);
            break;
        case constants.ACTION_CANCEL_TARGETING:
            if (this.targetingUnits.length === 0) {
                throw new InvalidStateError('Not targeting.');
            }
            this.targetingUnits = [];
            this.stopCombinedAction();
            break;
        case constants.ACTION_USE_ABILITY:
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }
            this.state.useAbility(data.unit, data.target);
            break;
        case constants.ACTION_PURCHASE:
            if (!data.name) {
                throw new DataError('Action requires a unit name.', action);
            }
            this.state.purchase(data.name);
            break;
        case constants.ACTION_ASSIGN_DEFENSE:
        case constants.ACTION_CANCEL_ASSIGN_DEFENSE:
        case constants.ACTION_CANCEL_PURCHASE:
        case constants.ACTION_CANCEL_USE_ABILITY:
        case constants.ACTION_ASSIGN_ATTACK:
        case constants.ACTION_CANCEL_ASSIGN_ATTACK: {
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }

            this.state[ACTION_TO_GAME_STATE_METHOD[action.toString()]](data.unit);

            if (action === constants.ACTION_ASSIGN_ATTACK && !data.unit.undefendable &&
                !this.state.blockers(this.state.villain()).some(x => !x.assignedAttack)) {
                this.inDamagePhase = true;
            }
            if (action === constants.ACTION_CANCEL_USE_ABILITY &&
                data.unit.targetAction === 'disrupt' && !this.state.defensesOverran()) {
                this.inDamagePhase = false;
            }
            break;
        }
        case constants.ACTION_PROCEED_TO_DAMAGE:
            if (this.inDamagePhase) {
                throw new InvalidStateError('Already proceeded to damage.');
            }
            this.inDamagePhase = true;
            break;
        case constants.ACTION_OVERRUN_DEFENSES:
            this.state.overrunDefenses();
            this.inDamagePhase = true;
            break;
        case constants.ACTION_CANCEL_OVERRUN_DEFENSES:
            this.state.cancelOverrunDefenses();
            this.inDamagePhase = false;
            break;
        case constants.ACTION_END_TURN:
            if (this.inConfirmPhase) {
                throw new InvalidStateError('Already in confirm phase.');
            }
            this.endActionSnapshot = this.getSnapshot();
            this.state.endTurn();
            this.inDamagePhase = false;
            this.inConfirmPhase = true;
            break;
        case constants.ACTION_COMMIT_TURN:
            this.stopCombinedAction();
            this.inConfirmPhase = false;
            this.state.startTurn();
            this.endDefenseSnapshot = null;
            this.endActionSnapshot = null;
            this.undoSnapshots = [];
            this.startTurnSnapshot = this.getSnapshot();
            break;
        case constants.ACTION_UNDO: {
            if (this.undoSnapshots.length === 0) {
                throw new InvalidStateError('No undo available.');
            }
            const firstFreeId = this.state.units.length;
            const wasInDefensePhase = this.state.inDefensePhase;
            this.restoreSnapshot(this.undoSnapshots.pop());
            if (wasInDefensePhase === this.state.inDefensePhase) {
                for (let i = this.state.units.length; i < firstFreeId; i++) {
                    this.state.units.push({ name: 'UNDO', destroyed: true });
                }
            }
            break;
        }
        case constants.ACTION_REDO:
            throw new NotImplementedError('Redo');
        case constants.ACTION_REVERT:
            if (this.endActionSnapshot) {
                this.restoreSnapshot(this.endActionSnapshot);
                assert(this.endActionSnapshot === null);
            } else if (this.endDefenseSnapshot) {
                this.restoreSnapshot(this.endDefenseSnapshot);
                assert(this.endDefenseSnapshot === null);
            } else {
                this.restoreSnapshot(this.startTurnSnapshot);
            }
            break;
        default:
            throw new DataError('Unknown action.', action);
        }

        this.emit('actionDone', action, data);
    }

    runTargetClick(clickedUnit, shiftClick) {
        assert(!this.state.inDefensePhase, 'In defense phase.');
        assert(!this.inConfirmPhase, 'In confirm phase.');
        assert(this.combinedAction, 'Not combined action.');

        if (this.targetingUnits.includes(clickedUnit)) {
            // Clicking one of the targeters results in canceling targeting, but it's not written to
            // the replay as clicking the unit
            throw new InvalidStateError('Invalid target, targeter.', clickedUnit);
        }
        if (clickedUnit.player === this.state.activePlayer) {
            throw new InvalidStateError('Invalid target, friendly unit.', clickedUnit);
        }
        const targetAction = this.targetingUnits[0].targetAction;
        const condition = this.targetingUnits[0].condition;
        if (!validTarget(clickedUnit, targetAction, condition)) {
            throw new InvalidStateError('Invalid target.', clickedUnit);
        }
        switch (targetAction) {
        case 'disrupt':
            if (frozen(clickedUnit)) {
                throw new InvalidStateError('Invalid target, already frozen.', clickedUnit);
            }
            break;
        case 'snipe':
            if (clickedUnit.sacrificed) {
                throw new InvalidStateError('Invalid target, already sacrificed.', clickedUnit);
            }
            break;
        default:
            throw new DataError('Unknown target action.', targetAction);
        }

        let targets;
        if (shiftClick) {
            targets = this.state.slate(clickedUnit.player).filter(x => {
                if (x.name !== clickedUnit.name) {
                    return false;
                }
                if (!validTarget(x, targetAction, condition)) {
                    return false;
                }
                switch (targetAction) {
                case 'disrupt':
                    return !frozen(x) && x.assignedAttack === clickedUnit.assignedAttack;
                case 'snipe':
                    return !x.sacrificed;
                default:
                    throw new DataError('Unknown target action.', targetAction);
                }
            });
            timsort.sort<any>(targets, (a, b) => b.toughness - a.toughness);
        } else {
            targets = [clickedUnit];
        }

        for (let targetNum = 0; targetNum < targets.length; targetNum++) {
            const target = targets[targetNum];
            if (targetNum > 0 && !targetingIsUseful(this.targetingUnits, target)) {
                break;
            }
            let i;
            for (i = 0; i < this.targetingUnits.length; i++) {
                if (i > 0 && !this.state.canUseAbility(this.targetingUnits[i], target)) {
                    break;
                }
                this.runAction(constants.ACTION_USE_ABILITY, {
                    unit: this.targetingUnits[i],
                    target: target,
                });
            }
            this.targetingUnits.splice(0, i);
            if (this.targetingUnits.length === 0) {
                this.stopCombinedAction();
                break;
            }
        }
        // Cancel targeting when no more valid targets remain
        if (this.targetingUnits.length > 0 && !this.state.slate(this.state.villain()).some(x => {
            if (!validTarget(x, targetAction, condition)) {
                return false;
            }
            switch (targetAction) {
            case 'disrupt':
                return !frozen(x);
            case 'snipe':
                return !x.sacrificed;
            default:
                throw new DataError('Unknown target action.', targetAction);
            }
        })) {
            this.runAction(constants.ACTION_CANCEL_TARGETING);
        }
    }

    runClickUnit(clickedUnit) {
        if (this.inConfirmPhase) {
            assert(!this.state.inDefensePhase, 'Overlapping defense and confirm phases.');
            if (this.targetingUnits.length > 0) {
                throw new InvalidStateError('Targeting in confirm phase.');
            }
            this.runAction(constants.ACTION_UNDO);
            return;
        }

        if (this.targetingUnits.length > 0) {
            if (this.state.inDefensePhase) {
                throw new InvalidStateError('Targeting in defense phase.');
            }
            this.runTargetClick(clickedUnit, false);
            return;
        }

        const { action, unit } = this.getClickAction(clickedUnit);
        if (!action) {
            throw new InvalidStateError('No click action.', clickedUnit);
        }

        if (action === constants.ACTION_CANCEL_ASSIGN_ATTACK &&
            unit.assignedAttack < unit.toughness) {
            this.addUndoSnapshot();
            if (unit === clickedUnit && this.state.slate(clickedUnit.player)
                .some(x => x !== clickedUnit && x.name === clickedUnit.name && !x.delay)) {
                this.startCombinedAction();
            }
        } else if (action === constants.ACTION_CANCEL_ASSIGN_DEFENSE &&
            unit.assignedAttack < unit.toughness) {
            this.addUndoSnapshot();
        } else if ((ACTION_TO_GAME_STATE_UNIT_TEST_METHOD[action.toString()] &&
            action !== constants.ACTION_CANCEL_PURCHASE) ||
            action === constants.ACTION_SELECT_FOR_TARGETING) {
            if (!this.combinedAction) {
                this.addUndoSnapshot();
                this.startCombinedAction();
            }
        } else if (action !== constants.ACTION_UNDO) {
            this.addUndoSnapshot();
        }

        if (action === constants.ACTION_CANCEL_USE_ABILITY && unit.targetAction &&
            clickedUnit !== unit) {
            clickedUnit.targetedBy.map(x => this.state.units[x]).forEach(x => {
                this.runAction(action, { unit: x });
            });
            return;
        }

        this.runAction(action, { unit });
    }

    runShiftClickUnit(clickedUnit) {
        if (this.inConfirmPhase) {
            assert(!this.state.inDefensePhase, 'Overlapping defense and confirm phases.');
            if (this.targetingUnits.length > 0) {
                throw new InvalidStateError('Targeting in confirm phase.');
            }
            this.runAction(constants.ACTION_UNDO);
            return;
        }

        if (this.targetingUnits.length > 0) {
            if (this.state.inDefensePhase) {
                throw new InvalidStateError('Targeting in defense phase.');
            }
            this.runTargetClick(clickedUnit, true);
            return;
        }

        const { action, unit } = this.getClickAction(clickedUnit);
        if (!action) {
            throw new InvalidStateError('No click action.', clickedUnit);
        }

        if (action === constants.ACTION_SELECT_FOR_TARGETING) {
            if (!this.combinedAction) {
                this.addUndoSnapshot();
                this.startCombinedAction();
            }
        } else if (action !== constants.ACTION_UNDO) {
            this.addUndoSnapshot();
        }

        if (!unit) {
            this.runAction(action);
            return;
        }

        if (action === constants.ACTION_CANCEL_USE_ABILITY && unit.targetAction &&
            clickedUnit !== unit) {
            const targets = this.state.slate(clickedUnit.player).filter(x => {
                if (x.name !== clickedUnit.name) {
                    return false;
                }
                const xClick = this.getClickAction(x);
                if (xClick.action !== action) {
                    return false;
                }
                // Completely chilled and partly chilled units are considered different
                if (unit.targetAction === 'disrupt' && frozen(clickedUnit) !== frozen(x)) {
                    return false;
                }
                return true;
            });
            targets.reduce((s, x) => s.concat(x.targetedBy), []).map(x => this.state.units[x])
                .forEach(x => {
                    this.runAction(constants.ACTION_CANCEL_USE_ABILITY, { unit: x });
                });
            return;
        }

        if ([constants.ACTION_CANCEL_ASSIGN_DEFENSE, constants.ACTION_CANCEL_ASSIGN_ATTACK]
            .includes(action) && unit.name !== clickedUnit.name) {
            this.runAction(action, { unit });
            return;
        }

        const matching = this.state.slate(unit.player).filter(x => {
            if (x.name !== unit.name) {
                return false;
            }
            // Frontline units are in different groups based on blocking status
            if (action === constants.ACTION_ASSIGN_ATTACK && x.undefendable &&
                blocking(x) !== blocking(unit)) {
                return false;
            }
            const xClick = this.getClickAction(x);
            if (xClick.action !== action || !xClick.unit) {
                return false;
            }
            if (xClick.unit !== x) {
                // Allow redirected action as long as it's the same unit type, shift clicking
                // defenders where first one removes absorber, same for breaching
                if (![constants.ACTION_CANCEL_ASSIGN_DEFENSE,
                    constants.ACTION_CANCEL_ASSIGN_ATTACK].includes(action) ||
                    xClick.unit.name !== x.name) {
                    return false;
                }
            }
            return true;
        });
        if (matching.length === 0) {
            throw new InvalidStateError('Shift-click with no matches.', clickedUnit);
        }
        sortShiftClickMatches(action, matching);
        // make sure to undo breachAbsorber first
        if (action === constants.ACTION_CANCEL_ASSIGN_ATTACK && this.state.breachAbsorber() &&
            matching.includes(this.state.breachAbsorber())) {
            const i = matching.indexOf(this.state.breachAbsorber());
            if (i !== 0) {
                matching[i] = matching[0];
                matching[0] = this.state.breachAbsorber();
            }
        }
        this.runAction(action, { unit: matching[0] });
        matching.slice(1).some(x => {
            if (action !== constants.ACTION_SELECT_FOR_TARGETING &&
                !this.state[ACTION_TO_GAME_STATE_UNIT_TEST_METHOD[action.toString()]](x)) {
                return true;
            }
            this.runAction(action, { unit: x });
            return false;
        });
    }

    runCommand(command, id) {
        this.emit('command', command, id);

        switch (command) {
        case constants.REPLAY_COMMAND_CLICK_UNIT: {
            const unit = this.state.units[id];
            if (!unit) {
                throw new InvalidStateError('Unit not found.', id);
            }
            if (unit.destroyed) {
                throw new InvalidStateError('Destroyed unit.', unit);
            }
            this.runClickUnit(unit);
            break;
        }
        case constants.REPLAY_COMMAND_SHIFT_CLICK_UNIT: {
            const unit = this.state.units[id];
            if (!unit) {
                throw new InvalidStateError('Unit not found.', id);
            }
            if (unit.destroyed) {
                throw new InvalidStateError('Destroyed unit.', unit);
            }
            this.runShiftClickUnit(unit);
            break;
        }
        case constants.REPLAY_COMMAND_CLICK_BLUEPRINT:
        case constants.REPLAY_COMMAND_SHIFT_CLICK_BLUEPRINT: {
            const blueprint = this.state.deck[id];
            if (!blueprint) {
                throw new InvalidStateError('Blueprint not found', id);
            }
            if (this.inConfirmPhase) {
                this.runAction(constants.ACTION_UNDO);
                break;
            }
            if (this.targetingUnits.length > 0) {
                this.runAction(constants.ACTION_CANCEL_TARGETING);
                // continue
            }
            this.addUndoSnapshot();
            do {
                this.runAction(constants.ACTION_PURCHASE, { name: blueprint.name });
            } while (command === constants.REPLAY_COMMAND_SHIFT_CLICK_BLUEPRINT &&
                this.state.canPurchase(blueprint.name));
            break;
        }
        case constants.REPLAY_COMMAND_CLICK_SPACE:
            if (this.inConfirmPhase) {
                this.runAction(constants.ACTION_COMMIT_TURN);
                break;
            }

            if (this.targetingUnits.length > 0) {
                this.runAction(constants.ACTION_CANCEL_TARGETING);
                // continue
            }

            this.addUndoSnapshot();

            if (this.state.inDefensePhase) {
                this.runAction(constants.ACTION_END_DEFENSE);
                break;
            }
            if (!this.state.defensesOverran() && this.state.canOverrunDefenses()) {
                this.runAction(constants.ACTION_OVERRUN_DEFENSES);
                break;
            }
            if (this.state.attack() > 0 && !this.inDamagePhase &&
                    !this.state.blockers(this.state.villain()).some(x => !x.assignedAttack)) {
                this.runAction(constants.ACTION_PROCEED_TO_DAMAGE);
                break;
            }
            // TODO: Check that attack is spent
            this.runAction(constants.ACTION_END_TURN);
            break;
        case constants.REPLAY_COMMAND_CANCEL_TARGETING:
            this.runAction(constants.ACTION_CANCEL_TARGETING);
            break;
        case constants.REPLAY_COMMAND_END_COMBINED_ACTION:
            if (!this.combinedAction) {
                throw new InvalidStateError('Not in combined action.');
            }
            if (this.targetingUnits.length === 0) {
                this.stopCombinedAction();
            }
            break;
        case constants.REPLAY_COMMAND_CLICK_REVERT:
            this.addUndoSnapshot();
            this.runAction(constants.ACTION_REVERT);
            break;
        case constants.REPLAY_COMMAND_CLICK_UNDO:
            this.runAction(constants.ACTION_UNDO);
            break;
        case constants.REPLAY_COMMAND_CLICK_REDO:
            this.runAction(constants.ACTION_REDO);
            break;
        case constants.REPLAY_COMMAND_EMOTE:
            break;
        default:
            throw new DataError('Unknown command type.', command);
        }

        this.emit('commandDone', command, id);
    }

    getCommandList() {
        return this.data.commandInfo.commandList;
    }

    initGame() {
        this.state.init(parseDeckAndInitInfo(this.data));

        this.undoSnapshots = [];
        this.combinedAction = false;
        this.startTurnSnapshot = this.getSnapshot();
        this.endDefenseSnapshot = null;
        this.endActionSnapshot = null;
    }

    // Publicly usable methods

    run() {
        this.emit('initGame');
        this.initGame();
        this.emit('initGameDone');
        this.getCommandList().forEach(x => {
            const { command, id } = parseCommand(x);
            this.runCommand(command, id);
        });
    }

    getCode() {
        return this.data.code;
    }

    getStartTime() {
        return new Date(this.data.startTime * 1000);
    }

    getEndTime() {
        return new Date(this.data.endTime * 1000);
    }

    getServerVersion() {
        if (!this.data.versionInfo) {
            throw new DataError('Version info missing.');
        }
        return this.data.versionInfo.serverVersion;
    }

    getGameFormat() {
        if (GAME_FORMATS[this.data.format] === undefined) {
            throw new DataError(`Unknown game format: ${this.data.format}`);
        }
        return GAME_FORMATS[this.data.format];
    }

    getPlayerInfo(player) {
        function formatRating(value) {
            return parseFloat(value.toFixed(2));
        }

        function formatTierPercent(value) {
            return parseFloat((value * 100).toFixed(1));
        }

        function getRating(obj) {
            if (!obj.displayRating && (!obj.score || !obj.score[23])) {
                return null;
            }
            const rating: any = {};
            rating.value = formatRating(obj.displayRating ? obj.displayRating : obj.score[23]);
            if (obj.tier !== undefined) {
                rating.tier = obj.tier;
                if (rating.tier !== 10) {
                    rating.tierPercent = formatTierPercent(obj.tierPercent);
                }
            }
            return rating;
        }

        const playerInfo = this.data.playerInfo;
        if (!playerInfo) {
            throw new DataError('Player info missing.');
        }
        const ratingInfo = this.data.ratingInfo;
        if (!ratingInfo) {
            throw new DataError('Rating info missing.');
        }

        const info: any = {};

        if (this.getServerVersion() <= 153) {
            info.name = playerInfo.playerNames[player];
            info.bot = playerInfo.playerBots[player] ? true : false;
        } else {
            info.name = playerInfo[player].name;
            info.bot = playerInfo[player].bot ? true : false;
            if (playerInfo[player].name !== playerInfo[player].displayName) {
                info.displayName = playerInfo[player].displayName;
            }
        }

        info.rating = getRating(ratingInfo.initialRatings[player]);
        if (this.getGameFormat() === constants.GAME_FORMAT_RANKED &&
            ratingInfo.finalRatings[player] !== null) {
            info.finalRating = getRating(ratingInfo.finalRatings[player]);
        }
        return info;
    }

    getTimeControl(player) {
        const timeInfo = this.data.timeInfo;
        if (!timeInfo) {
            throw new DataError('Time info missing.');
        }
        if (timeInfo.correspondence) {
            throw new NotImplementedError('Correspondence time info');
        }
        if (!timeInfo.useClocks) {
            throw new NotImplementedError('useClocks off in time info');
        }
        if (this.getServerVersion() <= 153) {
            return {
                bankDilution: timeInfo.playerTimeBankDilutions[player],
                initial: player === 1 ? timeInfo.whiteInitialTime : timeInfo.blackInitialTime,
                bank: timeInfo.playerInitialTimeBanks[player],
                increment: timeInfo.playerIncrements[player],
            };
        }
        return {
            bankDilution: timeInfo.playerTime[player].bankDilution,
            initial: timeInfo.playerTime[player].initial,
            bank: timeInfo.playerTime[player].bank,
            increment: timeInfo.playerTime[player].increment,
        };
    }

    getDeck(player) {
        const info = parseDeckAndInitInfo(this.data);

        const deck: any = {
            baseSet: info.baseSets[player].map(x => Array.isArray(x) ? x[0] : x),
            randomSet: info.randomSets[player].map(x => Array.isArray(x) ? x[0] : x),
        };

        const customSupplies = {};
        info.baseSets[player].forEach(x => {
            if (Array.isArray(x)) {
                customSupplies[x[0]] = x[1];
            }
        });
        info.randomSets[player].forEach(x => {
            if (Array.isArray(x)) {
                customSupplies[x[0]] = x[1];
            }
        });
        if (Object.keys(customSupplies).length > 0) {
            deck.customSupplies = customSupplies;
        }
        return deck;
    }

    getStartPosition(player) {
        const info = parseDeckAndInitInfo(this.data);

        const startPosition: any = {
            units: {},
        };

        info.initCards[player].forEach(rule => {
            startPosition.units[rule[1]] = rule[0];
        });

        if (info.initResources[player] && info.initResources[player] !== '0') {
            startPosition.resources = parseResources(info.initResources[player]);
        }

        return startPosition;
    }

    getResult() {
        if (this.data.result === undefined || this.data.result === null) {
            throw new DataError('Missing result.');
        }
        if (this.getServerVersion() <= 158) {
            if (this.data.result === 3) {
                throw new NotImplementedError('Old version: Result 3');
            }
            if (this.data.endCondition === 20) {
                throw new NotImplementedError('Old version: End condition 20');
            }
        }
        if (this.data.result < 0 || this.data.result > 2) {
            throw new DataError('Unknown result.', this.data.result);
        }
        const winner = this.data.result === 2 ? null : this.data.result;

        if (END_CONDITIONS[this.data.endCondition] === undefined) {
            throw new DataError(`Unknown end condition: ${this.data.endCondition}`);
        }
        const endCondition = END_CONDITIONS[this.data.endCondition];

        if (DRAW_END_CONDITIONS.includes(endCondition)) {
            if (winner !== null) {
                throw new DataError('Expected draw with end condition.', endCondition);
            }
        } else {
            if (winner === null) {
                throw new DataError('Expected non-draw with end condition.', endCondition);
            }
        }

        return {
            endCondition,
            winner,
        };
    }
}