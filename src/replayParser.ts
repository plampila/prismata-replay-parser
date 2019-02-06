import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as timsort from 'timsort';

import { ActionType, EndCondition, GameFormat, ReplayCommandType } from './constants';
import { DataError, InvalidStateError, NotImplementedError } from './customErrors';
import { Deck, GameState, IGameStateSnapshot, Player, Unit } from './gameState';
import {
    blocking, deepClone, frozen, parseResources, purchasedThisTurn, targetingIsUseful, validTarget,
} from './util';

const DRAW_END_CONDITIONS = [EndCondition.Repetition, EndCondition.DoubleDisconnect, EndCondition.Draw];

const REPLAY_COMMANDS_WITH_IDS = [
    ReplayCommandType.ClickUnit,
    ReplayCommandType.ShiftClickUnit,
    ReplayCommandType.ClickBlueprint,
    ReplayCommandType.ShiftClickBlueprint,
];

const ACTION_TO_GAME_STATE_METHOD: {
    [action: string]: string;
} = {
    [ActionType.AssignDefense.toString()]: 'assignDefense',
    [ActionType.CancelAssignDefense.toString()]: 'cancelAssignDefense',
    [ActionType.CancelPurchase.toString()]: 'cancelPurchase',
    [ActionType.CancelUseAbility.toString()]: 'cancelUseAbility',
    [ActionType.AssignAttack.toString()]: 'assignAttack',
    [ActionType.CancelAssignAttack.toString()]: 'cancelAssignAttack',
};

const ACTION_TO_GAME_STATE_UNIT_TEST_METHOD: {
    [action: string]: string;
} = {
    [ActionType.AssignDefense.toString()]: 'canAssignDefense',
    [ActionType.CancelAssignDefense.toString()]: 'canCancelAssignDefense',
    [ActionType.CancelPurchase.toString()]: 'canCancelPurchase',
    [ActionType.AssignAttack.toString()]: 'canAssignAttack',
    [ActionType.CancelAssignAttack.toString()]: 'canCancelAssignAttack',
    [ActionType.UseAbility.toString()]: 'canUseAbility',
    [ActionType.CancelUseAbility.toString()]: 'canCancelUseAbility',
};

function sortShiftClickMatches(action: ActionType, units: Unit[]): Unit[] {
    function sortUnits(rules: string[], offset?: number): void {
        if (offset !== undefined && offset < 0) {
            offset = undefined;
        }
        timsort.sort(units, (a: Unit, b: Unit) => {
            for (const rule of rules) {
                const key = rule.slice(1);
                let aVal;
                let bVal;
                if (key === 'delay-1') {
                    aVal = a.delay ? a.delay - 1 : 0;
                    bVal = b.delay ? b.delay - 1 : 0;
                } else if (key === 'lifespan+delay') {
                    aVal = a.lifespan ? a.lifespan + (a.delay || 0) : 0;
                    bVal = b.lifespan ? b.lifespan + (b.delay || 0) : 0;
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
                if (rule[0] === '>') {
                    return bVal - aVal;
                }
                return aVal - bVal;
            }
            return 0;
        }, offset);
    }

    switch (action) {
    case ActionType.SelectForTargeting:
        sortUnits(['<lifespan', '>toughness', '>charge']);
        break;
    case ActionType.UseAbility:
    case ActionType.CancelUseAbility:
        if (units[0].defaultBlocking) {
            sortUnits(['>lifespan', '<toughness', '>charge']);
        } else if (units[0].HPUsed) {
            sortUnits(['<lifespan', '>toughness', '>charge']);
        } else {
            sortUnits(['<lifespan', '<toughness', '>charge']);
        }
        break;
    case ActionType.AssignDefense:
    case ActionType.CancelAssignDefense:
        sortUnits(['<assignedAttack', '<lifespan', '<toughness', '<charge']);
        break;
    case ActionType.AssignAttack:
    case ActionType.CancelAssignAttack:
        if (units[0].defaultBlocking) {
            // Sort blockers and non-blockers separately
            sortUnits(['<delay', '<abilityUsed', '<lifespan', '>toughness', '>charge']);
            sortUnits(['<assignedAttack', '<delay-1', '>lifespan+delay', '<toughness', '>charge'],
                units.findIndex(x => x.abilityUsed || x.delay));
        } else {
            sortUnits(['<assignedAttack', '<delay-1', '>lifespan+delay', '<toughness', '>charge']);
        }
        break;
    case ActionType.Purchase:
    case ActionType.CancelPurchase:
        break;
    default:
        throw new Error(`Unsupported action: ${String(action)}`);
    }
    return units;
}

interface IReplayCommand {
    command: ReplayCommandType;
    id?: number;
    player?: number;
    params?: any;
}

function parseCommand(data: any): IReplayCommand {
    if (data._type.startsWith('emote')) {
        if (!data.hasOwnProperty('_id') && !data.hasOwnProperty('_params')) {
            throw new DataError('Missing properties.', data);
        }
        if (Object.keys(data).length !== 2 &&
            (Object.keys(data).length !== 3 || !data.hasOwnProperty('_type'))) {
            throw new DataError('Unknown properties.', data);
        }
        return {
            command: ReplayCommandType.Emote,
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
    const command: ReplayCommandType | undefined = Object.values(ReplayCommandType).find(x => data._type === x);
    if (command === undefined) {
        throw new DataError('Unknown command type.', data);
    }

    if (REPLAY_COMMANDS_WITH_IDS.includes(command)) {
        return { command, id };
    }

    if (command === ReplayCommandType.ClickSpace || ReplayCommandType.EndCombinedAction) {
        if (id !== -1 && id !== 0) {
            throw new DataError('Unknown ID.', data);
        }
    } else {
        if (id !== -1) {
            throw new DataError('Unknown ID.', data);
        }
    }

    return { command };
}

function parseDeckAndInitInfo(data: any): any {
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
    const renames = info.deck.filter((x: any) => x.UIName && x.UIName !== x.name).reduce((list: any, x: any) => {
        list[x.name] = x.UIName;
        x.originalName = x.name;
        x.name = x.UIName;
        delete x.UIName;
        return list;
    }, {});
    if (Object.keys(renames).length > 0) {
        info.deck.forEach((x: any) => {
            ['resonate', 'goldResonate'].forEach(key => {
                if (renames[x[key]]) {
                    x[key] = renames[x[key]];
                }
            });

            ['abilityScript', 'buyScript', 'beginOwnTurnScript']
                .filter(key => x[key] && x[key].create)
                .forEach(key => {
                    x[key].create.forEach((rule: any) => {
                        if (renames[rule[0]]) {
                            rule[0] = renames[rule[0]];
                        }
                    });
                });

            ['abilitySac', 'buySac'].filter(key => x[key]).forEach(key => {
                x[key].forEach((rule: any) => {
                    if (renames[rule[0]]) {
                        rule[0] = renames[rule[0]];
                    }
                });
            });
        });

        info.initCards.forEach((initCardsForPlayer: any) => {
            initCardsForPlayer.forEach((x: any) => {
                if (renames[x[1]]) {
                    x[1] = renames[x[1]];
                }
            });
        });

        info.baseSets.forEach((baseSetForPlayer: any) => {
            for (let i = 0; i < baseSetForPlayer.length; i++) {
                if (renames[baseSetForPlayer[i]]) {
                    baseSetForPlayer[i] = renames[baseSetForPlayer[i]];
                }
            }
        });

        info.randomSets.forEach((randomSetForPlayer: any) => {
            for (let i = 0; i < randomSetForPlayer.length; i++) {
                if (renames[randomSetForPlayer[i]]) {
                    randomSetForPlayer[i] = renames[randomSetForPlayer[i]];
                }
            }
        });
    }

    return info;
}

interface ISnapshot {
    inConfirmPhase: boolean;
    inDamagePhase: boolean;
    targetingUnits: Unit[];
    endDefenseSnapshot: Snapshot | null;
    endActionSnapshot: Snapshot | null;
    stateSnapshot: IGameStateSnapshot;
}

class Snapshot implements ISnapshot {
    public readonly inConfirmPhase: boolean;
    public readonly inDamagePhase: boolean;
    public readonly targetingUnits: Unit[];
    public readonly endDefenseSnapshot: Snapshot | null;
    public readonly endActionSnapshot: Snapshot | null;
    public readonly stateSnapshot: IGameStateSnapshot;

    constructor(source: ISnapshot) {
        this.inConfirmPhase = source.inConfirmPhase;
        this.inDamagePhase = source.inDamagePhase;
        this.targetingUnits = source.targetingUnits.slice();
        this.endDefenseSnapshot = source.endDefenseSnapshot;
        this.endActionSnapshot = source.endActionSnapshot;
        this.stateSnapshot = source.stateSnapshot;
    }
}

interface IClickAction {
    action?: ActionType;
    unit?: Unit;
}

interface ITimeControl {
    bankDilution: number;
    initial: number;
    bank: number;
    increment: number;
}

interface IResult {
    endCondition: EndCondition;
    winner: Player;
}

export class ReplayParser extends EventEmitter {
    public readonly state: GameState = new GameState();

    private readonly data: { [property: string]: any };
    private inConfirmPhase: boolean = false;
    private inDamagePhase: boolean = false;
    private targetingUnits: Unit[] = [];

    private undoSnapshots: Snapshot[] = [];
    private combinedAction: boolean | null = null;
    private startTurnSnapshot: Snapshot | null = null;
    private endDefenseSnapshot: Snapshot | null = null;
    private endActionSnapshot: Snapshot | null = null;

    constructor(replayData: any) {
        super();

        let parsed;
        if (Buffer.isBuffer(replayData)) {
            parsed = JSON.parse(replayData.toString());
        } else if (typeof replayData === 'string') {
            parsed = JSON.parse(replayData);
        } else {
            parsed = replayData;
        }

        if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
            throw new Error('Invalid replay data.');
        }
        this.data = parsed;
    }

    private getSnapshot(): Snapshot {
        return new Snapshot({
            inConfirmPhase: this.inConfirmPhase,
            inDamagePhase: this.inDamagePhase,
            targetingUnits: this.targetingUnits.slice(),
            endDefenseSnapshot: this.endDefenseSnapshot,
            endActionSnapshot: this.endActionSnapshot,
            stateSnapshot: this.state.getSnapshot(),
        });
    }

    private restoreSnapshot(snapshot: ISnapshot): void {
        this.inConfirmPhase = snapshot.inConfirmPhase;
        this.inDamagePhase = snapshot.inDamagePhase;
        this.targetingUnits = snapshot.targetingUnits.slice();
        this.endDefenseSnapshot = snapshot.endDefenseSnapshot;
        this.endActionSnapshot = snapshot.endActionSnapshot;
        this.state.restoreSnapshot(snapshot.stateSnapshot);
    }

    private addUndoSnapshot(): void {
        this.stopCombinedAction();
        this.emit('undoSnapshot');
        this.undoSnapshots.push(this.getSnapshot());
    }

    private startCombinedAction(): void {
        this.combinedAction = true;
    }

    private stopCombinedAction(): void {
        this.combinedAction = false;
    }

    private getClickAction(unit: Unit): IClickAction {
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
                        action: ActionType.CancelAssignDefense,
                        unit: this.state.absorber(),
                    };
                }
                return { action: ActionType.CancelAssignDefense, unit };
            }
            if (this.state.attack(this.state.villain()) <= 0) {
                return {};
            }
            return { action: ActionType.AssignDefense, unit };
        }

        if (unit.constructedBy && purchasedThisTurn(this.state.units[unit.constructedBy])) {
            return {
                action: ActionType.CancelPurchase,
                unit: this.state.units[unit.constructedBy],
            };
        }

        if (unit.player !== this.state.activePlayer) {
            if (unit.targetedBy) {
                const sources = unit.targetedBy.map((x: number) => this.state.units[x]);
                for (const source of sources) {
                    switch (source.targetAction) {
                    case 'disrupt':
                        if (!unit.sacrificed) {
                            if (!this.inDamagePhase) {
                                return {
                                    action: ActionType.CancelUseAbility,
                                    unit: source,
                                };
                            }
                            if (!this.state.breaching() && !unit.fragile && !unit.assignedAttack &&
                                    this.state.attack() < unit.toughness) {
                                return {
                                    action: ActionType.CancelUseAbility,
                                    unit: source,
                                };
                            }
                        }
                        break;
                    case 'snipe':
                        if (unit.assignedAttack) {
                            return { action: ActionType.CancelAssignAttack, unit };
                        }
                        return { action: ActionType.CancelUseAbility, unit: source };
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
                        action: ActionType.CancelAssignAttack,
                        unit: this.state.breachAbsorber(),
                    };
                }
                if (this.state.defensesOverran() && blocking(unit)) {
                    if (frozen(unit)) {
                        return { action: ActionType.CancelAssignAttack, unit };
                    }
                    if (this.state.breaching() || unit.defensesBypassed) {
                        return {};
                    }
                    return { action: ActionType.CancelOverrunDefenses };
                }
                return { action: ActionType.CancelAssignAttack, unit };
            }

            if (unit.undefendable && !unit.delay) {
                return { action: ActionType.AssignAttack, unit };
            }
            if (this.state.defensesOverran()) {
                if ((unit.delay && unit.purchased && !blocking(unit)) &&
                    !this.state.canOverKill()) {
                    return {};
                }
                if (!unit.fragile && this.state.attack() < unit.toughness) {
                    return {};
                }
                return { action: ActionType.AssignAttack, unit };
            }
            if (!blocking(unit) || !this.state.canOverrunDefenses()) {
                return {};
            }
            return { action: ActionType.OverrunDefenses };
        }

        if (purchasedThisTurn(unit)) {
            return { action: ActionType.CancelPurchase, unit };
        }
        if (unit.constructedBy) {
            return {
                action: ActionType.CancelUseAbility,
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
            return { action: ActionType.CancelUseAbility, unit };
        }
        if (unit.sacrificed || unit.delay || unit.charge === 0 ||
            (unit.HPUsed && unit.toughness < unit.HPUsed)) {
            return {};
        }
        if (unit.targetAction) {
            // TODO: Check if there are legal targets
            return { action: ActionType.SelectForTargeting, unit };
        }
        return { action: ActionType.UseAbility, unit };
    }

    private runAction(action: ActionType, data?: any): void {
        this.emit('action', action, data);

        switch (action) {
        case ActionType.EndDefense:
            this.endDefenseSnapshot = this.getSnapshot();
            this.state.endDefense();
            break;
        case ActionType.SelectForTargeting:
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }
            this.targetingUnits.push(data.unit);
            break;
        case ActionType.CancelTargeting:
            if (this.targetingUnits.length === 0) {
                throw new InvalidStateError('Not targeting.');
            }
            this.targetingUnits = [];
            this.stopCombinedAction();
            break;
        case ActionType.UseAbility:
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }
            this.state.useAbility(data.unit, data.target);
            break;
        case ActionType.Purchase:
            if (!data.name) {
                throw new DataError('Action requires a unit name.', action);
            }
            this.state.purchase(data.name);
            break;
        case ActionType.AssignDefense:
        case ActionType.CancelAssignDefense:
        case ActionType.CancelPurchase:
        case ActionType.CancelUseAbility:
        case ActionType.AssignAttack:
        case ActionType.CancelAssignAttack: {
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }

            this.state[ACTION_TO_GAME_STATE_METHOD[action.toString()]](data.unit);

            if (action === ActionType.AssignAttack && !data.unit.undefendable &&
                !this.state.blockers(this.state.villain()).some(x => !x.assignedAttack)) {
                this.inDamagePhase = true;
            }
            if (action === ActionType.CancelUseAbility &&
                data.unit.targetAction === 'disrupt' && !this.state.defensesOverran()) {
                this.inDamagePhase = false;
            }
            break;
        }
        case ActionType.ProceedToDamage:
            if (this.inDamagePhase) {
                throw new InvalidStateError('Already proceeded to damage.');
            }
            this.inDamagePhase = true;
            break;
        case ActionType.OverrunDefenses:
            this.state.overrunDefenses();
            this.inDamagePhase = true;
            break;
        case ActionType.CancelOverrunDefenses:
            this.state.cancelOverrunDefenses();
            this.inDamagePhase = false;
            break;
        case ActionType.EndTurn:
            if (this.inConfirmPhase) {
                throw new InvalidStateError('Already in confirm phase.');
            }
            this.endActionSnapshot = this.getSnapshot();
            this.state.endTurn();
            this.inDamagePhase = false;
            this.inConfirmPhase = true;
            break;
        case ActionType.CommitTurn:
            this.stopCombinedAction();
            this.inConfirmPhase = false;
            this.state.startTurn();
            this.endDefenseSnapshot = null;
            this.endActionSnapshot = null;
            this.undoSnapshots = [];
            this.startTurnSnapshot = this.getSnapshot();
            break;
        case ActionType.Undo: {
            const snapshot = this.undoSnapshots.pop();
            if (snapshot === undefined) {
                throw new InvalidStateError('No undo available.');
            }
            const firstFreeId = this.state.units.length;
            const wasInDefensePhase = this.state.inDefensePhase;
            this.restoreSnapshot(snapshot);
            if (wasInDefensePhase === this.state.inDefensePhase) {
                for (let i = this.state.units.length; i < firstFreeId; i++) {
                    this.state.units.push({ name: 'UNDO', destroyed: true });
                }
            }
            break;
        }
        case ActionType.Redo:
            throw new NotImplementedError('Redo');
        case ActionType.Revert:
            if (this.endActionSnapshot) {
                this.restoreSnapshot(this.endActionSnapshot);
                assert(this.endActionSnapshot === null);
            } else if (this.endDefenseSnapshot) {
                this.restoreSnapshot(this.endDefenseSnapshot);
                assert(this.endDefenseSnapshot === null);
            } else {
                if (this.startTurnSnapshot === null) {
                    throw new Error('Start turn snapshot not set.');
                }
                this.restoreSnapshot(this.startTurnSnapshot);
            }
            break;
        default:
            throw new DataError('Unknown action.', action);
        }

        this.emit('actionDone', action, data);
    }

    private runTargetClick(clickedUnit: Unit, shiftClick: boolean): void {
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
                this.runAction(ActionType.UseAbility, {
                    unit: this.targetingUnits[i],
                    target,
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
            this.runAction(ActionType.CancelTargeting);
        }
    }

    private runClickUnit(clickedUnit: Unit): void {
        if (this.inConfirmPhase) {
            assert(!this.state.inDefensePhase, 'Overlapping defense and confirm phases.');
            if (this.targetingUnits.length > 0) {
                throw new InvalidStateError('Targeting in confirm phase.');
            }
            this.runAction(ActionType.Undo);
            return;
        }

        if (this.targetingUnits.length > 0) {
            if (this.state.inDefensePhase) {
                throw new InvalidStateError('Targeting in defense phase.');
            }
            this.runTargetClick(clickedUnit, false);
            return;
        }

        const { action, unit }: IClickAction = this.getClickAction(clickedUnit);
        if (!action) {
            throw new InvalidStateError('No click action.', clickedUnit);
        }

        if (action === ActionType.CancelAssignAttack && unit.assignedAttack < unit.toughness) {
            this.addUndoSnapshot();
            if (unit === clickedUnit && this.state.slate(clickedUnit.player)
                .some(x => x !== clickedUnit && x.name === clickedUnit.name && !x.delay)) {
                this.startCombinedAction();
            }
        } else if (action === ActionType.CancelAssignDefense && unit.assignedAttack < unit.toughness) {
            this.addUndoSnapshot();
        } else if ((ACTION_TO_GAME_STATE_UNIT_TEST_METHOD[action.toString()] && action !== ActionType.CancelPurchase) ||
                   action === ActionType.SelectForTargeting) {
            if (!this.combinedAction) {
                this.addUndoSnapshot();
                this.startCombinedAction();
            }
        } else if (action !== ActionType.Undo) {
            this.addUndoSnapshot();
        }

        if (action === ActionType.CancelUseAbility && unit.targetAction && clickedUnit !== unit) {
            clickedUnit.targetedBy.map((x: number) => this.state.units[x]).forEach((x: Unit) => {
                this.runAction(action, { unit: x });
            });
            return;
        }

        this.runAction(action, { unit });
    }

    private runShiftClickUnit(clickedUnit: Unit): void {
        if (this.inConfirmPhase) {
            assert(!this.state.inDefensePhase, 'Overlapping defense and confirm phases.');
            if (this.targetingUnits.length > 0) {
                throw new InvalidStateError('Targeting in confirm phase.');
            }
            this.runAction(ActionType.Undo);
            return;
        }

        if (this.targetingUnits.length > 0) {
            if (this.state.inDefensePhase) {
                throw new InvalidStateError('Targeting in defense phase.');
            }
            this.runTargetClick(clickedUnit, true);
            return;
        }

        const { action, unit }: IClickAction = this.getClickAction(clickedUnit);
        if (!action) {
            throw new InvalidStateError('No click action.', clickedUnit);
        }

        if (action === ActionType.SelectForTargeting) {
            if (!this.combinedAction) {
                this.addUndoSnapshot();
                this.startCombinedAction();
            }
        } else if (action !== ActionType.Undo) {
            this.addUndoSnapshot();
        }

        if (!unit) {
            this.runAction(action);
            return;
        }

        if (action === ActionType.CancelUseAbility && unit.targetAction && clickedUnit !== unit) {
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
            targets.reduce((s, x) => s.concat(x.targetedBy), []).map((x: number) => this.state.units[x])
                .forEach((x: Unit) => {
                    this.runAction(ActionType.CancelUseAbility, { unit: x });
                });
            return;
        }

        if ([ActionType.CancelAssignDefense, ActionType.CancelAssignAttack].includes(action) &&
            unit.name !== clickedUnit.name) {
            this.runAction(action, { unit });
            return;
        }

        const matching = this.state.slate(unit.player).filter(x => {
            if (x.name !== unit.name) {
                return false;
            }
            // Frontline units are in different groups based on blocking status
            if (action === ActionType.AssignAttack && x.undefendable &&
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
                if (![ActionType.CancelAssignDefense, ActionType.CancelAssignAttack].includes(action) ||
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
        if (action === ActionType.CancelAssignAttack && this.state.breachAbsorber() &&
            matching.includes(this.state.breachAbsorber())) {
            const i = matching.indexOf(this.state.breachAbsorber());
            if (i !== 0) {
                matching[i] = matching[0];
                matching[0] = this.state.breachAbsorber();
            }
        }
        this.runAction(action, { unit: matching[0] });
        matching.slice(1).some(x => {
            if (action !== ActionType.SelectForTargeting &&
                !this.state[ACTION_TO_GAME_STATE_UNIT_TEST_METHOD[action.toString()]](x)) {
                return true;
            }
            this.runAction(action, { unit: x });
            return false;
        });
    }

    private runCommand(command: ReplayCommandType, id?: number): void {
        this.emit('command', command, id);

        switch (command) {
        case ReplayCommandType.ClickUnit: {
            if (id === undefined) {
                throw new InvalidStateError('Command requires ID.', command);
            }
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
        case ReplayCommandType.ShiftClickUnit: {
            if (id === undefined) {
                throw new InvalidStateError('Command requires ID.', command);
            }
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
        case ReplayCommandType.ClickBlueprint:
        case ReplayCommandType.ShiftClickBlueprint: {
            if (id === undefined) {
                throw new InvalidStateError('Command requires ID.', command);
            }
            const blueprint = this.state.deck[id];
            if (!blueprint) {
                throw new InvalidStateError('Blueprint not found', id);
            }
            if (this.inConfirmPhase) {
                this.runAction(ActionType.Undo);
                break;
            }
            if (this.targetingUnits.length > 0) {
                this.runAction(ActionType.CancelTargeting);
                // continue
            }
            this.addUndoSnapshot();
            do {
                this.runAction(ActionType.Purchase, { name: blueprint.name });
            } while (command === ReplayCommandType.ShiftClickBlueprint &&
                this.state.canPurchase(blueprint.name));
            break;
        }
        case ReplayCommandType.ClickSpace:
            if (this.inConfirmPhase) {
                this.runAction(ActionType.CommitTurn);
                break;
            }

            if (this.targetingUnits.length > 0) {
                this.runAction(ActionType.CancelTargeting);
                // continue
            }

            this.addUndoSnapshot();

            if (this.state.inDefensePhase) {
                this.runAction(ActionType.EndDefense);
                break;
            }
            if (!this.state.defensesOverran() && this.state.canOverrunDefenses()) {
                this.runAction(ActionType.OverrunDefenses);
                break;
            }
            if (this.state.attack() > 0 && !this.inDamagePhase &&
                    !this.state.blockers(this.state.villain()).some(x => !x.assignedAttack)) {
                this.runAction(ActionType.ProceedToDamage);
                break;
            }
            // TODO: Check that attack is spent
            this.runAction(ActionType.EndTurn);
            break;
        case ReplayCommandType.CancelTargeting:
            this.runAction(ActionType.CancelTargeting);
            break;
        case ReplayCommandType.EndCombinedAction:
            if (!this.combinedAction) {
                throw new InvalidStateError('Not in combined action.');
            }
            if (this.targetingUnits.length === 0) {
                this.stopCombinedAction();
            }
            break;
        case ReplayCommandType.ClickRevert:
            this.addUndoSnapshot();
            this.runAction(ActionType.Revert);
            break;
        case ReplayCommandType.ClickUndo:
            this.runAction(ActionType.Undo);
            break;
        case ReplayCommandType.ClickRedo:
            this.runAction(ActionType.Redo);
            break;
        case ReplayCommandType.Emote:
            break;
        default:
            throw new DataError('Unknown command type.', command);
        }

        this.emit('commandDone', command, id);
    }

    private getCommandList(): any {
        return this.data.commandInfo.commandList;
    }

    private initGame(): void {
        this.state.init(parseDeckAndInitInfo(this.data));

        this.undoSnapshots = [];
        this.combinedAction = false;
        this.startTurnSnapshot = this.getSnapshot();
        this.endDefenseSnapshot = null;
        this.endActionSnapshot = null;
    }

    // Publicly usable methods

    public run(): void {
        this.emit('initGame');
        this.initGame();
        this.emit('initGameDone');
        this.getCommandList().forEach((x: any) => {
            const { command, id }: IReplayCommand = parseCommand(x);
            this.runCommand(command, id);
        });
    }

    public getCode(): string {
        return this.data.code;
    }

    public getStartTime(): Date {
        return new Date(this.data.startTime * 1000);
    }

    public getEndTime(): Date {
        return new Date(this.data.endTime * 1000);
    }

    public getServerVersion(): number {
        if (!this.data.versionInfo) {
            throw new DataError('Version info missing.');
        }
        return this.data.versionInfo.serverVersion;
    }

    public getGameFormat(): GameFormat {
        const gameFormat: GameFormat | undefined = Object.values(GameFormat).find(x => this.data.format === x);
        if (gameFormat === undefined) {
            throw new DataError(`Unknown game format: ${this.data.format}`);
        }
        return gameFormat;
    }

    public getPlayerInfo(player: number): any {
        function formatRating(value: number): number {
            return parseFloat(value.toFixed(2));
        }

        function formatTierPercent(value: number): number {
            return parseFloat((value * 100).toFixed(1));
        }

        function getRating(obj: any): any {
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
        if (this.getGameFormat() === GameFormat.Ranked && ratingInfo.finalRatings[player] !== null) {
            info.finalRating = getRating(ratingInfo.finalRatings[player]);
        }
        return info;
    }

    public getTimeControl(player: number): ITimeControl {
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

    public getDeck(player: number): Deck {
        const info = parseDeckAndInitInfo(this.data);

        const deck: any = {
            baseSet: info.baseSets[player].map((x: any) => Array.isArray(x) ? x[0] : x),
            randomSet: info.randomSets[player].map((x: any) => Array.isArray(x) ? x[0] : x),
        };

        const customSupplies: any = {};
        info.baseSets[player].forEach((x: any) => {
            if (Array.isArray(x)) {
                customSupplies[x[0]] = x[1];
            }
        });
        info.randomSets[player].forEach((x: any) => {
            if (Array.isArray(x)) {
                customSupplies[x[0]] = x[1];
            }
        });
        if (Object.keys(customSupplies).length > 0) {
            deck.customSupplies = customSupplies;
        }
        return deck;
    }

    public getStartPosition(player: number): any {
        const info = parseDeckAndInitInfo(this.data);

        const startPosition: any = {
            units: {},
        };

        info.initCards[player].forEach((rule: any) => {
            startPosition.units[rule[1]] = rule[0];
        });

        if (info.initResources[player] && info.initResources[player] !== '0') {
            startPosition.resources = parseResources(info.initResources[player]);
        }

        return startPosition;
    }

    public getResult(): IResult {
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

        const endCondition: EndCondition | undefined =
            Object.values(EndCondition).find(x => this.data.endCondition === x);
        if (endCondition === undefined) {
            throw new DataError(`Unknown end condition: ${this.data.endCondition}`);
        }

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
