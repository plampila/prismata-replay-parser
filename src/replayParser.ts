import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as timsort from 'timsort';

import { convertBlueprintFromReplay, renameBlueprintFields } from './blueprint';
import { DataError, InvalidStateError, NotImplementedError } from './customErrors';
import { GameState, GameStateSnapshot, InitialState, Player } from './gameState';
import { ReplayCommand, ReplayData, ReplayPlayerRating } from './replayData';
import { convert as convert146 } from './replayData146';
import { convert as convert153 } from './replayData153';
import { ReplayDataValidator } from './replayDataValidator';
import { parseResources, Resources } from './resources';
import { Unit } from './unit';
import { targetingIsUseful } from './util';

export interface PlayerTime {
    bank: number;
    bankDilution: number;
    increment: number;
    initial: number;
}

export interface DeckInfo {
    baseSet: string[];
    randomSet: string[];
    customSupplies?: { [unitName: string]: number };
}

export interface PlayerStartPosition {
    units: { [unitName: string]: number };
    resources?: Resources;
}

export interface PlayerInfo {
    name: string;
    bot: boolean;
    displayName?: string;
    rating?: PlayerRating;
    finalRating?: PlayerRating;
}

export interface Result {
    endCondition: EndCondition;
    winner?: Player;
}

export enum GameFormat {
    Ranked = 200,
    VersusBot = 201,
    Versus = 202,
    Event = 203,
    Casual = 204,
}

export enum EndCondition {
    Resign = 0,
    Elimination = 1,
    Defeated = 2,
    Repetition = 11,
    Disconnect = 30,
    DoubleDisconnect = 31,
    Draw = 32, // is this some specific type of draw?
}

const DRAW_END_CONDITIONS = [EndCondition.Repetition, EndCondition.DoubleDisconnect, EndCondition.Draw];

export enum ActionType {
    AssignDefense = 1, // Safety
    CancelAssignDefense,
    EndDefense,
    SelectForTargeting,
    CancelTargeting,
    UseAbility,
    CancelUseAbility,
    Purchase,
    CancelPurchase,
    ProceedToDamage,
    OverrunDefenses,
    CancelOverrunDefenses,
    AssignAttack,
    CancelAssignAttack,
    EndTurn,
    CommitTurn,
    Undo,
    Redo,
    Revert,
}

enum CommandType {
    ClickUnit = 'inst clicked',
    ShiftClickUnit = 'inst shift clicked',
    ClickBlueprint = 'card clicked',
    ShiftClickBlueprint = 'card shift clicked',
    ClickSpace = 'space clicked',
    ClickRevert = 'revert clicked',
    ClickUndo = 'undo clicked',
    ClickRedo = 'redo clicked',
    CancelTargeting = 'cancel target processed',
    EndCombinedAction = 'end swipe processed',
    Emote = 'emote',
}

const COMMAND_TYPES_WITH_IDS = [
    CommandType.ClickUnit,
    CommandType.ShiftClickUnit,
    CommandType.ClickBlueprint,
    CommandType.ShiftClickBlueprint,
];

const replayDataValidator = new ReplayDataValidator(false);
let replayDataValidatorStrict: ReplayDataValidator | undefined;

function canExecuteAction(state: GameState, actionType: ActionType, unit: Unit): boolean {
    switch (actionType) {
    case ActionType.AssignDefense:
        return state.canAssignDefense(unit);
    case ActionType.CancelAssignDefense:
        return state.canCancelAssignDefense(unit);
    case ActionType.CancelPurchase:
        return state.canCancelPurchase(unit);
    case ActionType.AssignAttack:
        return state.canAssignAttack(unit);
    case ActionType.CancelAssignAttack:
        return state.canCancelAssignAttack(unit);
    case ActionType.UseAbility:
        return state.canUseAbility(unit);
    case ActionType.CancelUseAbility:
        return state.canCancelUseAbility(unit);
    default:
        throw new Error(`Not testable action: ${actionType}`);
    }
}

function sortShiftClickMatches(action: ActionType, units: Unit[]): Unit[] {
    function sortUnits(rules: string[], offset?: number): void {
        if (offset !== undefined && offset < 0) {
            throw new Error('Invalid offset.');
        }
        timsort.sort(units, (a: Unit, b: Unit) => {
            for (const rule of rules) {
                const key = rule.slice(1);
                let aVal: number;
                let bVal: number;
                if (key === 'delay-1') {
                    aVal = a.delay > 0 ? a.delay - 1 : 0;
                    bVal = b.delay > 0 ? b.delay - 1 : 0;
                } else if (key === 'lifespan+delay') {
                    aVal = a.lifespan !== undefined ? a.lifespan + a.delay : 0;
                    bVal = b.lifespan !== undefined ? b.lifespan + b.delay : 0;
                } else {
                    switch (key) {
                    case 'abilityUsed':
                        aVal = a[key] === true ? 1 : 0;
                        bVal = b[key] === true ? 1 : 0;
                        break;
                    case 'lifespan':
                        aVal = a.lifespan !== undefined ? a.lifespan : Infinity;
                        bVal = b.lifespan !== undefined ? b.lifespan : Infinity;
                        break;
                    case 'assignedAttack':
                    case 'delay':
                    case 'charge':
                    case 'toughness': {
                        const aTmp = a[key];
                        aVal = aTmp !== undefined ? aTmp : 0;
                        const bTmp = b[key];
                        bVal = bTmp !== undefined ? bTmp : 0;
                        break;
                    }
                    default:
                        throw new InvalidStateError('Unknown sort order.', key);
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
        } else if (units[0].HPUsed > 0) {
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
            const offset = units.findIndex(x => x.abilityUsed || x.delayed);
            sortUnits(['<assignedAttack', '<delay-1', '>lifespan+delay', '<toughness', '>charge'],
                      offset < 0 ? undefined : offset);
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

interface Command {
    command: CommandType;
    id?: number;
    player?: number;
}

function isReplayCommandType(value: string): value is CommandType {
    return Object.values(CommandType).includes(value);
}

function parseCommand(data: ReplayCommand): Command {
    if (data._type.startsWith('emote')) {
        return {
            command: CommandType.Emote,
            player: data._id,
        };
    }

    const id = data._id;
    const command = data._type;
    if (!isReplayCommandType(command)) {
        throw new DataError('Unknown command type.', data);
    }

    if (COMMAND_TYPES_WITH_IDS.includes(command)) {
        return { command, id };
    }

    if (command === CommandType.ClickSpace || command === CommandType.EndCombinedAction) {
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

function parseDeckAndInitInfo(data: ReplayData): InitialState {
    const baseSets = data.deckInfo.base;
    const deck = data.deckInfo.mergedDeck.map(x => convertBlueprintFromReplay(x));
    const initCards = data.initInfo.initCards;
    const randomSets = data.deckInfo.randomizer;

    // Renames are used even in new replays for some event units
    const renames: Map<string, string> = new Map();
    data.deckInfo.mergedDeck.forEach(x => {
        if (x.UIName !== undefined && x.UIName !== x.name) {
            renames.set(x.name, x.UIName);
        }
    });

    deck.forEach(x => {
        renameBlueprintFields(x, renames);
    });

    initCards.forEach(initCardsForPlayer => {
        initCardsForPlayer.forEach(x => {
            const newName = renames.get(x[1]);
            if (newName !== undefined) {
                x[1] = newName;
            }
        });
    });

    baseSets.forEach(baseSetForPlayer => {
        for (let i = 0; i < baseSetForPlayer.length; i++) {
            const x = baseSetForPlayer[i];
            if (Array.isArray(x)) {
                const newName = renames.get(x[0]);
                if (newName !== undefined) {
                    x[0] = newName;
                }
            } else {
                const newName = renames.get(x);
                if (newName !== undefined) {
                    baseSetForPlayer[i] = newName;
                }
            }
        }
    });

    randomSets.forEach(randomSetForPlayer => {
        for (let i = 0; i < randomSetForPlayer.length; i++) {
            const x = randomSetForPlayer[i];
            if (Array.isArray(x)) {
                const newName = renames.get(x[0]);
                if (newName !== undefined) {
                    x[0] = newName;
                }
            } else {
                const newName = renames.get(x);
                if (newName !== undefined) {
                    randomSetForPlayer[i] = newName;
                }
            }
        }
    });

    return {
        deck,
        baseSets,
        randomSets,
        initCards,
        initResources: data.initInfo.initResources,
        infiniteSupplies: data.initInfo.infiniteSupplies,
    };
}

interface PlayerRating {
    value: number;
    tier: number;
    tierPercent?: number;
}

function parseRating(data: ReplayPlayerRating | null): PlayerRating | undefined {
    function formatRating(value: number): number {
        return parseFloat(value.toFixed(2));
    }

    function formatTierPercent(value: number): number {
        return parseFloat((value * 100).toFixed(1));
    }

    if (data === null) {
        return undefined;
    }

    const rating: PlayerRating = {
        value: formatRating(data.displayRating),
        tier: data.tier,
    };
    if (rating.tier !== 10) {
        rating.tierPercent = formatTierPercent(data.tierPercent);
    }
    return rating;
}

interface Snapshot {
    inConfirmPhase: boolean;
    inDamagePhase: boolean;
    targetingUnits: Unit[];
    endDefenseSnapshot?: SnapshotImpl;
    endActionSnapshot?: SnapshotImpl;
    stateSnapshot: GameStateSnapshot;
}

class SnapshotImpl implements Snapshot {
    public readonly inConfirmPhase: boolean;
    public readonly inDamagePhase: boolean;
    public readonly targetingUnits: Unit[];
    public readonly endDefenseSnapshot?: SnapshotImpl;
    public readonly endActionSnapshot?: SnapshotImpl;
    public readonly stateSnapshot: GameStateSnapshot;

    constructor(source: Snapshot) {
        this.inConfirmPhase = source.inConfirmPhase;
        this.inDamagePhase = source.inDamagePhase;
        this.targetingUnits = source.targetingUnits.slice();
        this.endDefenseSnapshot = source.endDefenseSnapshot;
        this.endActionSnapshot = source.endActionSnapshot;
        this.stateSnapshot = source.stateSnapshot;
    }
}

interface ClickAction {
    action?: ActionType;
    unit?: Unit;
}

interface ActionData {
    name?: string;
    unit?: Unit;
    target?: Unit;
}

interface ReplayParserOptions {
    strict?: boolean;
}

export declare interface ReplayParser {
    on(event: 'undoSnapshot' | 'initGame' | 'initGameDone', listener: () => void): this;
    on(event: 'command' | 'commandDone', listener: (action: CommandType, id?: number) => void): this;
    on(event: 'action' | 'actionDone', listener: (action: ActionType, data: ActionData) => void): this;
}

export class ReplayParser extends EventEmitter {
    public readonly state: GameState = new GameState();

    private readonly data: ReplayData;

    private inConfirmPhase: boolean = false;
    private inDamagePhase: boolean = false;
    private targetingUnits: Unit[] = [];

    private undoSnapshots: SnapshotImpl[] = [];
    private combinedAction: boolean = false;
    private startTurnSnapshot?: SnapshotImpl;
    private endDefenseSnapshot?: SnapshotImpl;
    private endActionSnapshot?: SnapshotImpl;

    constructor(replayData: any, options: ReplayParserOptions = {}) {
        super();

        let parsed;
        if (Buffer.isBuffer(replayData)) {
            parsed = JSON.parse(replayData.toString());
        } else if (typeof replayData === 'string') {
            parsed = JSON.parse(replayData);
        } else {
            parsed = replayData;
        }

        let validator: ReplayDataValidator;
        if (options.strict === true) {
            if (replayDataValidatorStrict === undefined) {
                replayDataValidatorStrict = new ReplayDataValidator(true);
            }
            validator = replayDataValidatorStrict;
        } else {
            validator = replayDataValidator;
        }

        if (!validator.isReplayServerVersion(parsed)) {
            throw new Error('Failed to parse server version.');
        }

        if (parsed.versionInfo.serverVersion <= 146) {
            if (!validator.isReplayData146(parsed)) {
                throw new Error(`Invalid replay data (${parsed.versionInfo.serverVersion}): ${validator.errorText()}`);
            }
            parsed = convert146(parsed);
        } else if (parsed.versionInfo.serverVersion <= 153) {
            if (!validator.isReplayData153(parsed)) {
                throw new Error(`Invalid replay data (${parsed.versionInfo.serverVersion}): ${validator.errorText()}`);
            }
            parsed = convert153(parsed);
        } else if (!validator.isReplayData(parsed)) {
            throw new Error(`Invalid replay data (${parsed.versionInfo.serverVersion}): ${validator.errorText()}`);
        }

        if (options.strict === true) {
            replayDataValidator.isReplayData(parsed); // remove unused properties
        }

        this.data = parsed;
    }

    private getSnapshot(): SnapshotImpl {
        return new SnapshotImpl({
            inConfirmPhase: this.inConfirmPhase,
            inDamagePhase: this.inDamagePhase,
            targetingUnits: this.targetingUnits.slice(),
            endDefenseSnapshot: this.endDefenseSnapshot,
            endActionSnapshot: this.endActionSnapshot,
            stateSnapshot: this.state.getSnapshot(),
        });
    }

    private restoreSnapshot(snapshot: Snapshot): void {
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

    private getClickAction(unit: Unit): ClickAction {
        assert(this.targetingUnits.length === 0, 'In targeting mode.');
        assert(!this.inConfirmPhase, 'In confirm phase.');

        if (unit.destroyed) {
            return {};
        }

        if (this.state.inDefensePhase) {
            assert(this.targetingUnits.length === 0, 'Targeting in defense phase.');
            if (unit.player !== this.state.activePlayer || !unit.blocking() || unit.frozen()) {
                return {};
            }
            if (unit.assignedAttack > 0) {
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

        if (unit.constructedBy !== undefined) {
            const constructedByUnit = this.state.units[unit.constructedBy];
            if (constructedByUnit === undefined) {
                throw new InvalidStateError('Constructed by removed unit.', unit);
            }
            if (constructedByUnit.purchasedThisTurn()) {
                return {
                    action: ActionType.CancelPurchase,
                    unit: this.state.units[unit.constructedBy],
                };
            }
        }

        if (unit.player !== this.state.activePlayer) {
            for (const source of this.state.targetingUnits(unit)) {
                switch (source.targetAction) {
                case 'disrupt':
                    if (!unit.sacrificed) {
                        if (!this.inDamagePhase) {
                            return {
                                action: ActionType.CancelUseAbility,
                                unit: source,
                            };
                        }
                        if (!this.state.breaching() && !unit.fragile && unit.assignedAttack === 0 &&
                                this.state.attack() < unit.toughness) {
                            return {
                                action: ActionType.CancelUseAbility,
                                unit: source,
                            };
                        }
                    }
                    break;
                case 'snipe':
                    if (unit.assignedAttack > 0) {
                        return { action: ActionType.CancelAssignAttack, unit };
                    }
                    return { action: ActionType.CancelUseAbility, unit: source };
                default:
                    throw new DataError('Unknown targetAction.', source.targetAction);
                }
            }

            if (unit.sacrificed) {
                return {};
            }

            if (unit.assignedAttack > 0) {
                const breachAbsorber = this.state.breachAbsorber();
                if (this.state.attack() === 0 && breachAbsorber && unit !== breachAbsorber) {
                    return {
                        action: ActionType.CancelAssignAttack,
                        unit: breachAbsorber,
                    };
                }
                if (this.state.defensesOverran() && unit.blocking()) {
                    if (unit.frozen()) {
                        return { action: ActionType.CancelAssignAttack, unit };
                    }
                    if (this.state.breaching() || unit.defensesBypassed) {
                        return {};
                    }
                    return { action: ActionType.CancelOverrunDefenses };
                }
                return { action: ActionType.CancelAssignAttack, unit };
            }

            if (unit.undefendable && !unit.delayed) {
                return { action: ActionType.AssignAttack, unit };
            }
            if (this.state.defensesOverran()) {
                if ((unit.delayed && unit.purchased && !unit.blocking()) &&
                    !this.state.canOverKill()) {
                    return {};
                }
                if (!unit.fragile && this.state.attack() < unit.toughness) {
                    return {};
                }
                return { action: ActionType.AssignAttack, unit };
            }
            if (!unit.blocking() || !this.state.canOverrunDefenses()) {
                return {};
            }
            return { action: ActionType.OverrunDefenses };
        }

        if (unit.purchasedThisTurn()) {
            return { action: ActionType.CancelPurchase, unit };
        }
        if (unit.constructedBy !== undefined) {
            return {
                action: ActionType.CancelUseAbility,
                unit: this.state.units[unit.constructedBy],
            };
        }

        if (!unit.abilityScript && unit.targetAction === undefined) {
            return {};
        }
        if (unit.abilityUsed) {
            if (unit.sacrificed && (!unit.abilityScript || !unit.abilityScript.selfsac)) {
                return {};
            }
            return { action: ActionType.CancelUseAbility, unit };
        }
        if (unit.sacrificed || unit.delayed || unit.charge === 0 || unit.toughness < unit.HPUsed) {
            return {};
        }
        if (unit.targetAction !== undefined) {
            // TODO: Check if there are legal targets
            return { action: ActionType.SelectForTargeting, unit };
        }
        return { action: ActionType.UseAbility, unit };
    }

    private runAction(action: ActionType, data: ActionData = {}): void {
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
            if (data.name === undefined) {
                throw new DataError('Action requires a unit name.', action);
            }
            this.state.purchase(data.name);
            break;
        case ActionType.AssignDefense: {
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }
            this.state.assignDefense(data.unit);
            break;
        }
        case ActionType.CancelAssignDefense: {
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }
            this.state.cancelAssignDefense(data.unit);
            break;
        }
        case ActionType.CancelPurchase: {
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }
            this.state.cancelPurchase(data.unit);
            break;
        }
        case ActionType.CancelUseAbility: {
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }

            this.state.cancelUseAbility(data.unit);

            if (data.unit.targetAction === 'disrupt' && !this.state.defensesOverran()) {
                this.inDamagePhase = false;
            }
            break;
        }
        case ActionType.AssignAttack: {
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }

            this.state.assignAttack(data.unit);

            if (!data.unit.undefendable &&
                !this.state.blockers(this.state.villain()).some(x => x.assignedAttack === 0)) {
                this.inDamagePhase = true;
            }
            break;
        }
        case ActionType.CancelAssignAttack: {
            if (!data.unit) {
                throw new DataError('Action requires a unit.', action);
            }
            this.state.cancelAssignAttack(data.unit);
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
            this.endDefenseSnapshot = undefined;
            this.endActionSnapshot = undefined;
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
                    this.state.units.push(undefined);
                }
            }
            break;
        }
        case ActionType.Redo:
            throw new NotImplementedError('Redo');
        case ActionType.Revert:
            if (this.endActionSnapshot) {
                this.restoreSnapshot(this.endActionSnapshot);
                assert(this.endActionSnapshot === undefined); // tslint:disable-line:strict-type-predicates
            } else if (this.endDefenseSnapshot) {
                this.restoreSnapshot(this.endDefenseSnapshot);
                assert(this.endDefenseSnapshot === undefined); // tslint:disable-line:strict-type-predicates
            } else {
                if (this.startTurnSnapshot === undefined) {
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
        if (targetAction === undefined) {
            throw new InvalidStateError('Target action not set.', this.targetingUnits[0]);
        }
        const condition = this.targetingUnits[0].condition;
        if (!clickedUnit.validTarget(targetAction, condition)) {
            throw new InvalidStateError('Invalid target.', clickedUnit);
        }
        switch (targetAction) {
        case 'disrupt':
            if (clickedUnit.frozen()) {
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
                if (!x.validTarget(targetAction, condition)) {
                    return false;
                }
                switch (targetAction) {
                case 'disrupt':
                    return !x.frozen() && x.assignedAttack === clickedUnit.assignedAttack;
                case 'snipe':
                    return !x.sacrificed;
                default:
                    throw new DataError('Unknown target action.', targetAction);
                }
            });
            timsort.sort(targets, (a, b) => b.toughness - a.toughness);
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
            if (!x.validTarget(targetAction, condition)) {
                return false;
            }
            switch (targetAction) {
            case 'disrupt':
                return !x.frozen();
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

        const { action, unit }: ClickAction = this.getClickAction(clickedUnit);
        if (action === undefined) {
            throw new InvalidStateError('No click action.', clickedUnit);
        }

        let snapshotDone = false;
        if (action === ActionType.CancelAssignAttack) {
            if (unit === undefined) {
                throw new InvalidStateError(`No unit for action: ${action}`);
            }
            if (unit.assignedAttack < unit.toughness) {
                this.addUndoSnapshot();
                if (unit === clickedUnit && this.state.slate(clickedUnit.player)
                    .some(x => x !== clickedUnit && x.name === clickedUnit.name && !x.delayed)) {
                    this.startCombinedAction();
                }
                snapshotDone = true;
            }
        } else if (action === ActionType.CancelAssignDefense) {
            if (unit === undefined) {
                throw new InvalidStateError(`No unit for action: ${action}`);
            }
            if (unit.assignedAttack < unit.toughness) {
                this.addUndoSnapshot();
                snapshotDone = true;
            }
        }

        if (!snapshotDone) {
            switch (action) {
            case ActionType.AssignDefense:
            case ActionType.CancelAssignDefense:
            case ActionType.AssignAttack:
            case ActionType.CancelAssignAttack:
            case ActionType.UseAbility:
            case ActionType.CancelUseAbility:
            case ActionType.SelectForTargeting:
                if (!this.combinedAction) {
                    this.addUndoSnapshot();
                    this.startCombinedAction();
                }
                break;
            case ActionType.Undo:
                break;
            default:
                this.addUndoSnapshot();
                break;
            }
        }

        if (action === ActionType.CancelUseAbility) {
            if (unit === undefined) {
                throw new InvalidStateError(`No unit for action: ${action}`);
            }
            if (unit.targetAction !== undefined && clickedUnit !== unit) {
                this.state.targetingUnits(clickedUnit).forEach(x => {
                    this.runAction(action, { unit: x });
                });
                return;
            }
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

        const { action, unit }: ClickAction = this.getClickAction(clickedUnit);
        if (action === undefined) {
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

        if (action === ActionType.CancelUseAbility && unit.targetAction !== undefined && clickedUnit !== unit) {
            const targets = this.state.slate(clickedUnit.player).filter(x => {
                if (x.name !== clickedUnit.name) {
                    return false;
                }
                const xClick = this.getClickAction(x);
                if (xClick.action !== action) {
                    return false;
                }
                // Completely chilled and partly chilled units are considered different
                if (unit.targetAction === 'disrupt' && clickedUnit.frozen() !== x.frozen()) {
                    return false;
                }
                return true;
            });
            targets.reduce((s, x) => s.concat(x.targetedBy), [] as number[])
                .map(x => this.state.units[x])
                .forEach(x => {
                    if (x === undefined) {
                        throw new InvalidStateError('Targeted by removed unit.');
                    }
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
            if (action === ActionType.AssignAttack && x.undefendable && x.blocking() !== unit.blocking()) {
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
        if (action === ActionType.CancelAssignAttack) {
            const breachAbsorber = this.state.breachAbsorber();
            if (breachAbsorber !== undefined && matching.includes(breachAbsorber)) {
                const i = matching.indexOf(breachAbsorber);
                if (i !== 0) {
                    matching[i] = matching[0];
                    matching[0] = breachAbsorber;
                }
            }
        }

        this.runAction(action, { unit: matching[0] });
        matching.slice(1).some(x => {
            if (action !== ActionType.SelectForTargeting && !canExecuteAction(this.state, action, x)) {
                return true;
            }
            this.runAction(action, { unit: x });
            return false;
        });
    }

    private runCommand(command: CommandType, id?: number): void {
        this.emit('command', command, id);

        switch (command) {
        case CommandType.ClickUnit: {
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
        case CommandType.ShiftClickUnit: {
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
        case CommandType.ClickBlueprint:
        case CommandType.ShiftClickBlueprint: {
            if (id === undefined) {
                throw new InvalidStateError('Command requires ID.', command);
            }
            const blueprint = this.state.deck[id];
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
            } while (command === CommandType.ShiftClickBlueprint &&
                this.state.canPurchase(blueprint.name));
            break;
        }
        case CommandType.ClickSpace:
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
                    !this.state.blockers(this.state.villain()).some(x => x.assignedAttack === 0)) {
                this.runAction(ActionType.ProceedToDamage);
                break;
            }
            // TODO: Check that attack is spent
            this.runAction(ActionType.EndTurn);
            break;
        case CommandType.CancelTargeting:
            this.runAction(ActionType.CancelTargeting);
            break;
        case CommandType.EndCombinedAction:
            if (!this.combinedAction) {
                throw new InvalidStateError('Not in combined action.');
            }
            if (this.targetingUnits.length === 0) {
                this.stopCombinedAction();
            }
            break;
        case CommandType.ClickRevert:
            this.addUndoSnapshot();
            this.runAction(ActionType.Revert);
            break;
        case CommandType.ClickUndo:
            this.runAction(ActionType.Undo);
            break;
        case CommandType.ClickRedo:
            this.runAction(ActionType.Redo);
            break;
        case CommandType.Emote:
            break;
        default:
            throw new DataError('Unknown command type.', command);
        }

        this.emit('commandDone', command, id);
    }

    private initGame(): void {
        this.state.init(parseDeckAndInitInfo(this.data));

        this.undoSnapshots = [];
        this.combinedAction = false;
        this.startTurnSnapshot = this.getSnapshot();
        this.endDefenseSnapshot = undefined;
        this.endActionSnapshot = undefined;
    }

    // Publicly usable methods

    public run(): void {
        this.emit('initGame');
        this.initGame();
        this.emit('initGameDone');
        this.data.commandInfo.commandList.forEach(x => {
            const { command, id }: Command = parseCommand(x);
            this.runCommand(command, id);
        });
    }

    public getCode(): string {
        return this.data.code;
    }

    public getStartTime(): Date {
        if (!isFinite(this.data.startTime)) {
            throw new DataError('Invalid start time.', this.data.startTime);
        }
        return new Date(this.data.startTime * 1000);
    }

    public getEndTime(): Date {
        if (!isFinite(this.data.endTime)) {
            throw new DataError('Invalid end time.', this.data.endTime);
        }
        return new Date(this.data.endTime * 1000);
    }

    public getServerVersion(): number {
        return this.data.versionInfo.serverVersion;
    }

    public getGameFormat(): GameFormat {
        if (!(this.data.format in GameFormat)) {
            throw new DataError(`Unknown game format: ${this.data.format}`);
        }
        return this.data.format;
    }

    public getPlayerInfo(player: Player): PlayerInfo {
        const playerInfo = this.data.playerInfo;

        const info: PlayerInfo = {
            name: playerInfo[player].name,
            bot: playerInfo[player].bot !== '',
        };
        if (playerInfo[player].name !== playerInfo[player].displayName) {
            info.displayName = playerInfo[player].displayName;
        }

        info.rating = parseRating(this.data.ratingInfo.initialRatings[player]);
        if (this.getGameFormat() === GameFormat.Ranked) {
            info.finalRating = parseRating(this.data.ratingInfo.finalRatings[player]);
        }
        return info;
    }

    public getTimeControl(player: Player): PlayerTime {
        return this.data.timeInfo.playerTime[player];
    }

    public getDeck(player: Player): DeckInfo {
        const info = parseDeckAndInitInfo(this.data);

        const deck: DeckInfo = {
            baseSet: info.baseSets[player].map(x => Array.isArray(x) ? x[0] : x),
            randomSet: info.randomSets[player].map(x => Array.isArray(x) ? x[0] : x),
        };

        const customSupplies: { [unitName: string]: number; } = {};
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

    public getStartPosition(player: Player): PlayerStartPosition {
        const info = parseDeckAndInitInfo(this.data);

        const startPosition: PlayerStartPosition = {
            units: {},
        };

        info.initCards[player].forEach(rule => {
            startPosition.units[rule[1]] = rule[0];
        });

        if (info.initResources[player] !== '0') {
            startPosition.resources = parseResources(info.initResources[player]);
        }

        return startPosition;
    }

    public getResult(): Result {
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
        const winner = this.data.result === 2 ? undefined : this.data.result;

        if (!(this.data.endCondition in EndCondition)) {
            throw new DataError(`Unknown end condition: ${this.data.endCondition}`);
        }

        if (DRAW_END_CONDITIONS.includes(this.data.endCondition)) {
            if (winner !== undefined) {
                throw new DataError('Expected draw with end condition.', this.data.endCondition);
            }
        } else {
            if (winner === undefined) {
                throw new DataError('Expected non-draw with end condition.', this.data.endCondition);
            }
        }

        return {
            endCondition: this.data.endCondition,
            winner,
        };
    }
}
