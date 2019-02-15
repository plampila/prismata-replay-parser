import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as timsort from 'timsort';

import { Blueprint, SacrificeRule, Script } from './blueprint';
import { DataError, InvalidStateError } from './customErrors';
import { ActionType } from './replayParser';
import { parseResources, Resources } from './resources';
import { Unit } from './unit';
import { deepClone } from './util';

export enum Player {
    First = 0,
    Second = 1,
}

type Deck = Blueprint[];

interface Supplies {
    [unitName: string]: number;
}

type InitialUnitList = Array<[number, string]>;
type PurchasableUnitList = Array<string | [string, number]>;

export interface InitialState {
    baseSets: [PurchasableUnitList, PurchasableUnitList];
    deck: Deck;
    infiniteSupplies?: boolean;
    initCards: [InitialUnitList, InitialUnitList];
    initResources: [string, string];
    randomSets: [PurchasableUnitList, PurchasableUnitList];
}

export interface GameStateSnapshot {
    deck: Deck;
    turnNumber: number;
    activePlayer: Player;
    inDefensePhase: boolean;
    supplies: Supplies;
    resources: Resources;
    units: Unit[];
}

export declare interface GameState {
    on(event: 'assignAttackBlocker', listener: (unit: Unit) => void): this;
    on(event: 'autoAction', listener: (action: ActionType, unit: Unit) => void): this;
    on(event: 'turnStarted', listener: (turnNumber: number, player: Player) => void): this;
    on(event: 'unitConstructed', listener: (constructed: Unit, by: Unit) => void): this;
    on(event: 'unitDestroyed', listener: (unit: Unit, reason: string) => void): this;
}

export class GameState extends EventEmitter {
    public deck: Deck = [];
    public activePlayer: Player = Player.First;
    public inDefensePhase: boolean = false;
    public units: Array<Unit | undefined> = [];

    private turnNumberValue: number = 0;
    private supplies: [Supplies, Supplies] = [{}, {}];
    private resources: [Resources, Resources] = [parseResources('0'), parseResources('0')];

    constructor() {
        super();
    }

    public get turnNumber(): number {
        return this.turnNumberValue;
    }

    public getSupplies(player: Player): Supplies {
        return this.supplies[player];
    }

    // Helpers
    public villain(): Player {
        return this.activePlayer === Player.First ? Player.Second : Player.First;
    }

    public attack(player: Player = this.activePlayer): number {
        return this.resources[player].attack;
    }

    public slate(player?: Player): Unit[] {
        function isUnit(x: Unit | undefined): x is Unit {
            return x !== undefined;
        }
        return this.units.filter(isUnit)
            .filter(x => !x.destroyed && (player === undefined || x.player === player));
    }

    public blockers(player: Player = this.activePlayer): Unit[] {
        return this.slate(player).filter(x => x.blocking() && !x.frozen());
    }

    public absorber(): Unit | undefined {
        return this.slate(this.activePlayer)
            .find(x => x.blocking() && x.assignedAttack > 0 && x.assignedAttack < x.toughness);
    }

    public breachAbsorber(): Unit | undefined {
        const candidates = this.slate(this.villain())
            .filter(x => !x.blocking() && x.assignedAttack > 0 && x.assignedAttack < x.toughness);
        if (candidates.length === 2 && candidates[0].sacrificed) {
            return candidates[1];
        }
        return candidates.length > 0 ? candidates[0] : undefined;
    }

    public defensesOverran(): boolean {
        return !this.blockers(this.villain()).some(x => x.assignedAttack < x.toughness);
    }

    public canOverrunDefenses(): boolean {
        this.requireActionPhase();
        if (this.defensesOverran()) {
            throw new InvalidStateError('Defenses already overran.');
        }

        const totalDefense = this.blockers(this.villain())
            .filter(x => x.assignedAttack === 0)
            .reduce((t, x) => t + x.toughness, 0);
        return this.attack() >= Math.max(totalDefense, 1);
    }

    public breaching(): boolean {
        return this.slate(this.villain())
            .some(x => !x.sacrificed && !x.blocking() && x.assignedAttack > 0);
    }

    public canOverKill(): boolean {
        return !this.slate(this.villain())
            .some(x => !x.sacrificed && x.assignedAttack < x.toughness && (!x.delayed || !x.purchased));
    }

    private targetedUnit(unit: Unit): Unit | undefined {
        const id = this.unitId(unit);
        if (id === undefined) {
            throw new InvalidStateError('Unit ID not found.', unit);
        }
        return this.slate().find(x => x.targetedBy.includes(id));
    }

    public targetingUnits(unit: Unit): Unit[] {
        return unit.targetedBy.map(id => {
            const targetter = this.units[id];
            if (targetter === undefined) {
                throw new InvalidStateError('Targeted by removed unit.', unit);
            }
            return targetter;
        });
    }

    private unitId(unit: Unit): number | undefined {
        const id = this.units.indexOf(unit);
        return id >= 0 ? id : undefined;
    }

    private blueprintForName(name: string): Blueprint | undefined {
        return this.deck.find(x => x.name === name);
    }

    // Internal
    private requireActionPhase(): void {
        if (this.inDefensePhase) {
            throw new InvalidStateError('Not in action phase.');
        }
    }

    private requireValidUnit(unit: Unit, allowSacrificed: boolean): void {
        if (this.unitId(unit) === undefined) {
            throw new InvalidStateError('Unit with no ID.', unit);
        }
        if (unit.destroyed) {
            throw new InvalidStateError('Destroyed unit.', unit);
        }
        if (unit.sacrificed && !allowSacrificed) {
            throw new InvalidStateError('Sacrificed unit.', unit);
        }
    }

    private requireFriendlyUnit(unit: Unit, allowSacrificed: boolean = false): void {
        this.requireValidUnit(unit, allowSacrificed);
        if (unit.player !== this.activePlayer) {
            throw new InvalidStateError('Enemy unit.', unit);
        }
    }

    private requireEnemyUnit(unit: Unit, allowSacrificed: boolean = false): void {
        this.requireValidUnit(unit, allowSacrificed);
        if (unit.player === this.activePlayer) {
            throw new InvalidStateError('Friendly unit.', unit);
        }
    }

    private constructUnit(blueprint: Blueprint, buildTime?: number, player: Player = this.activePlayer,
                          lifespan?: number): Unit {
        /*if (blueprint.UIShortname === 'Robo Santa') {
            throw new NotImplementedError('Robo Santa');
        }*/

        const unit = new Unit(blueprint, player, { buildTime, lifespan });
        this.units.push(unit);
        return unit;
    }

    private destroyUnit(unit: Unit, reason: string): void {
        if (this.unitId(unit) === undefined) {
            throw new InvalidStateError('Tried to destroy non-added unit.', unit);
        }
        if (unit.destroyed) {
            throw new InvalidStateError('Unit already destroyed.', unit);
        }
        unit.destroyed = true;
        this.emit('unitDestroyed', unit, reason);
    }

    private initPlayer(player: Player, cards: InitialUnitList, baseSet: PurchasableUnitList,
                       randomSet: PurchasableUnitList, infiniteSupplies: boolean = false): void {
        baseSet.concat(randomSet).forEach(x => {
            if (Array.isArray(x)) {
                if (x[1] <= 0) {
                    throw new DataError('Invalid set supply.', x);
                }
                this.supplies[player][x[0]] = infiniteSupplies ? Infinity : x[1];
            } else {
                const blueprint = this.blueprintForName(x);
                if (blueprint === undefined) {
                    throw new DataError('Unknown unit.', x);
                }
                if (blueprint.supply === undefined) {
                    throw new DataError('Unit with no supply.', x);
                }
                this.supplies[player][x] = infiniteSupplies ? Infinity : blueprint.supply;
            }
        });

        cards.forEach(x => {
            const blueprint = this.blueprintForName(x[1]);
            if (!blueprint) {
                throw new DataError('Blueprint not found.', x[1]);
            }
            for (let i = 0; i < x[0]; i++) {
                this.constructUnit(blueprint, 0, player);
            }
        });
    }

    private addAttack(amount: number, player: Player = this.activePlayer): void {
        assert(amount >= 0, 'Amount can not be negative.');

        if (amount === 0) {
            return;
        }

        this.resources[player].attack += amount;

        const unit = this.breachAbsorber();
        if (unit) {
            this.targetingUnits(unit).forEach(x => {
                if (x.targetAction === 'snipe') {
                    this.emit('autoAction', ActionType.CancelUseAbility, x);
                    this.cancelUseAbility(x);
                }
            });
            if (unit.sacrificed) {
                throw new InvalidStateError('Partially damaged unit sacrificed.', unit);
            }
            this.emit('autoAction', ActionType.CancelAssignAttack, unit);
            this.cancelAssignAttack(unit);
        }
    }

    private removeAttack(amount: number, player: Player = this.activePlayer): void {
        assert(amount >= 0, 'Amount can not be negative.');

        if (this.resources[player].attack < amount) {
            throw new InvalidStateError('Negative attack.');
        }
        this.resources[player].attack -= amount;
    }

    private addResources(resources: Resources, player: Player = this.activePlayer): void {
        this.resources[player].gold += resources.gold;
        this.resources[player].green += resources.green;
        this.resources[player].blue += resources.blue;
        this.resources[player].red += resources.red;
        this.resources[player].energy += resources.energy;
        this.addAttack(resources.attack);
    }

    private removeResources(resources: Resources, player: Player = this.activePlayer): void {
        this.resources[player].gold -= resources.gold;
        this.resources[player].green -= resources.green;
        this.resources[player].blue -= resources.blue;
        this.resources[player].red -= resources.red;
        this.resources[player].energy -= resources.energy;
        this.removeAttack(resources.attack);
    }

    private canRemoveResources(resources: Resources, player: Player = this.activePlayer): boolean {
        return this.resources[player].gold >= resources.gold &&
            this.resources[player].green >= resources.green &&
            this.resources[player].blue >= resources.blue &&
            this.resources[player].red >= resources.red &&
            this.resources[player].energy >= resources.energy &&
            this.resources[player].attack >= resources.attack;
    }

    private sacrificeList(name: string, player: Player = this.activePlayer): Unit[] {
        const found = this.slate(player).filter(x => x.name === name && !x.sacrificed && !x.delayed);
        found.reverse();
        // Must be a stable sort
        timsort.sort(found, (a, b) => a.abilityUsed === b.abilityUsed ? 0 : a.abilityUsed ? -1 : 1);
        return found;
    }

    private canSacrificeUnits(rules: SacrificeRule[]): boolean {
        return !rules.some(rule => this.sacrificeList(rule.unitName).length < rule.count);
    }

    private sacrificeUnits(rules: SacrificeRule[]): void {
        rules.forEach(rule => {
            const targets = this.sacrificeList(rule.unitName);
            if (targets.length < rule.count) {
                throw new InvalidStateError('Not enough units to sacrifice.', rules);
            }
            targets.length = rule.count;
            targets.forEach(target => {
                if (target.defaultBlocking && target.abilityScript !== undefined && !target.abilityUsed) {
                    this.useAbility(target);
                }
                target.sacrificed = true;
            });
        });
    }

    private cancelSacrificeUnits(rules: SacrificeRule[]): void {
        rules.forEach(rule => {
            for (let i = 0; i < rule.count; i++) {
                const found = this.slate(this.activePlayer).find(y => y.name === rule.unitName && y.sacrificed);
                if (found === undefined) {
                    throw new InvalidStateError('No unit found to cancel ability sacrifice.', rules);
                }
                found.sacrificed = false;
            }
        });
    }

    private runScript(unit: Unit, script: Script): void {
        script.create.forEach(rule => {
            const blueprint = this.blueprintForName(rule.unitName);
            if (blueprint === undefined) {
                throw new DataError('Blueprint not found.', rule.unitName);
            }
            for (let i = 0; i < rule.count; i++) {
                const constructed = this.constructUnit(blueprint, rule.buildTime,
                    rule.forOpponent ? this.villain() : this.activePlayer, rule.customLifespan);
                constructed.constructedBy = this.unitId(unit);
                this.emit('unitConstructed', constructed, unit);
            }
        });

        if (script.delay > 0) {
            if (unit.delayed) {
                throw new InvalidStateError('Already delayed.', unit);
            }
            unit.delay = script.delay;
        }

        this.addResources(script.receive);

        if (script.selfsac) {
            if (unit.sacrificed) {
                throw new InvalidStateError('Already sacrificed.', unit);
            }
            unit.sacrificed = true;
        }
    }

    private canReverseScript(script: Script): boolean {
        if (!this.canRemoveResources(script.receive)) {
            return false;
        }
        return true;
    }

    private reverseScript(unit: Unit, script: Script): void {
        script.create.forEach(rule => {
            const targetPlayer = rule.forOpponent ? this.villain() : this.activePlayer;
            for (let i = 0; i < rule.count; i++) {
                const found = this.slate(targetPlayer).slice().reverse()
                    .find(x => x.name === rule.unitName && x.constructedBy === this.unitId(unit));
                if (!found) {
                    throw new InvalidStateError('No unit to deconstruct.', unit);
                }
                this.destroyUnit(found, 'deconstructed');
            }
        });

        if (script.delay > 0) {
            if (!unit.delayed) {
                throw new InvalidStateError('Not delayed.', unit);
            }
            unit.delay = 0;
        }

        this.removeResources(script.receive);

        if (script.selfsac) {
            if (!unit.sacrificed) {
                throw new InvalidStateError('Not sacrificed.', unit);
            }
            unit.sacrificed = false;
        }
    }

    private runStartTurn(): void {
        this.slate(this.activePlayer).forEach(unit => {
            if (unit.assignedAttack > 0) {
                if (unit.assignedAttack >= unit.toughness) {
                    this.destroyUnit(unit, 'defense');
                    return;
                }
                if (unit.fragile) {
                    unit.toughness -= unit.assignedAttack;
                }
                unit.assignedAttack = 0;
            }
            unit.toughness += unit.HPGained;
            unit.toughness = Math.min(unit.toughness, unit.HPMax);
            if (!unit.delayed && unit.lifespan !== undefined && unit.lifespan > 0) {
                unit.lifespan--;
                if (unit.lifespan === 0) {
                    this.destroyUnit(unit, 'lifespan');
                    return;
                }
            }

            unit.disruption = 0;
            unit.abilityUsed = false;
            if (unit.delayed) {
                unit.delay--;
                if (!unit.delayed) {
                    unit.building = false;
                }
            }
        });

        this.slate(this.activePlayer).filter(x => !x.delayed).forEach(unit => {
            if (unit.beginOwnTurnScript) {
                this.runScript(unit, unit.beginOwnTurnScript);
            }
            if (unit.goldResonate !== undefined) {
                this.resources[unit.player].gold +=
                    this.slate(unit.player).filter(x => x.name === unit.goldResonate && !x.delayed).length;
            }
            if (unit.resonate !== undefined) {
                this.addAttack(this.slate(unit.player).filter(x => x.name === unit.resonate && !x.delayed).length);
            }
        });
    }

    private runEndTurn(): void {
        this.resources[this.activePlayer].blue = 0;
        this.resources[this.activePlayer].red = 0;
        this.resources[this.activePlayer].energy = 0;

        this.slate().forEach(unit => {
            if (unit.toughness === 0) {
                this.destroyUnit(unit, 'noHealth');
            } else if (unit.spell) {
                this.destroyUnit(unit, 'spell');
            } else if (unit.assignedAttack >= unit.toughness) {
                this.destroyUnit(unit, 'attack');
            } else if (unit.sacrificed) {
                this.destroyUnit(unit, 'sacrificed');
            }

            unit.sacrificed = false;
            unit.constructedBy = undefined;
            unit.targetedBy.length = 0;
        });

        if (this.defensesOverran() && this.attack() > 0) {
            // FIXME: Overkill
            if (this.slate(this.villain()).some(x => !x.purchased && x.assignedAttack === 0 &&
                    (x.fragile || x.toughness < this.attack()))) {
                throw new InvalidStateError('Attack left unassigned after defenses overran.');
            }
            this.removeAttack(this.attack());
        }
    }

    // Actions
    public startTurn(): void {
        this.activePlayer = this.villain();
        if (this.activePlayer === Player.First) {
            this.turnNumberValue++;
        }
        this.emit('turnStarted', this.turnNumber, this.activePlayer);
        if (this.attack(this.villain()) > 0) {
            this.inDefensePhase = true;
        } else {
            this.runStartTurn();
        }
    }

    public canAssignDefense(unit: Unit): boolean {
        if (!this.inDefensePhase) {
            throw new InvalidStateError('Not in defense phase.');
        }
        this.requireFriendlyUnit(unit);
        if (unit.assignedAttack > 0) {
            throw new InvalidStateError('Already assigned.', unit);
        }
        if (!unit.blocking()) {
            throw new InvalidStateError('Not blocking.', unit);
        }
        if (unit.frozen()) {
            throw new InvalidStateError('Frozen unit.', unit);
        }

        return this.attack(this.villain()) > 0;
    }

    public assignDefense(unit: Unit): void {
        if (!this.canAssignDefense(unit)) {
            throw new InvalidStateError('Unavailable action.', unit);
        }

        unit.assignedAttack = Math.min(unit.toughness, this.attack(this.villain()));
        this.removeAttack(unit.assignedAttack, this.villain());
    }

    public canCancelAssignDefense(unit: Unit): boolean {
        if (!this.inDefensePhase) {
            throw new InvalidStateError('Not in defense phase.');
        }
        this.requireFriendlyUnit(unit);
        if (unit.assignedAttack === 0) {
            throw new InvalidStateError('Not assigned.', unit);
        }

        return this.attack(this.villain()) > 0 || !this.absorber() || this.absorber() === unit;
    }

    public cancelAssignDefense(unit: Unit): void {
        if (!this.canCancelAssignDefense(unit)) {
            throw new InvalidStateError('Unavailable action.', unit);
        }

        this.addAttack(unit.assignedAttack, this.villain());
        unit.assignedAttack = 0;
    }

    public endDefense(): void {
        if (!this.inDefensePhase) {
            throw new InvalidStateError('Not in defense phase.');
        }
        if (this.attack(this.villain()) > 0) {
            throw new InvalidStateError('Ended defense with unassigned attack.');
        }
        assert(this.attack(this.villain()) === 0, 'Negative attack.');

        this.inDefensePhase = false;
        this.runStartTurn();
    }

    public canPurchase(name: string): boolean {
        this.requireActionPhase();

        const blueprint = this.blueprintForName(name);
        if (!blueprint) {
            throw new InvalidStateError('Blueprint not found.');
        }

        if (this.supplies[this.activePlayer][blueprint.name] === 0) {
            return false;
        }
        if (!this.canRemoveResources(blueprint.buyCost)) {
            return false;
        }
        if (blueprint.buySac && !this.canSacrificeUnits(blueprint.buySac)) {
            return false;
        }
        return true;
    }

    public purchase(name: string): void {
        if (!this.canPurchase(name)) {
            throw new InvalidStateError('Unavailable action.', name);
        }

        const blueprint = this.blueprintForName(name);
        if (blueprint === undefined) {
            throw new DataError('Blueprint not found.', name);
        }

        this.supplies[this.activePlayer][blueprint.name]--;
        assert(this.supplies[this.activePlayer][blueprint.name] >= 0);

        this.removeResources(blueprint.buyCost);

        if (blueprint.buySac) {
            this.sacrificeUnits(blueprint.buySac);
        }

        const unit = this.constructUnit(blueprint);
        unit.purchased = true;

        if (unit.buyScript) {
            this.runScript(unit, unit.buyScript);
        }
        this.slate().filter(x => x.constructedBy === this.unitId(unit)).forEach(x => {
            x.purchased = true;
        });
    }

    public canCancelPurchase(unit: Unit): boolean {
        this.requireActionPhase();
        this.requireFriendlyUnit(unit);
        if (!unit.purchasedThisTurn()) {
            throw new InvalidStateError('Not purchased this turn.', unit);
        }

        return !unit.buyScript || this.canReverseScript(unit.buyScript);
    }

    public cancelPurchase(unit: Unit): void {
        if (!this.canCancelPurchase(unit)) {
            throw new InvalidStateError('Unavailable action.', unit);
        }

        this.supplies[unit.player][unit.name]++;
        if (unit.buyCost === undefined) {
            throw new DataError('Unit buyCost not set.', unit);
        }
        this.addResources(unit.buyCost);
        if (unit.buySac) {
            this.cancelSacrificeUnits(unit.buySac);
        }
        if (unit.buyScript) {
            this.reverseScript(unit, unit.buyScript);
        }
        unit.destroyed = true;
    }

    public canUseAbility(unit: Unit, target?: Unit): boolean {
        this.requireActionPhase();
        this.requireFriendlyUnit(unit);
        if (!unit.abilityScript && unit.targetAction === undefined) {
            throw new InvalidStateError('Unit has no ability.', unit);
        }
        if (unit.abilityUsed) {
            throw new InvalidStateError('Unit\'s ability already used.', unit);
        }
        if (unit.charge === 0) {
            throw new InvalidStateError('No stamina.', unit);
        }

        if (unit.abilityCost && !this.canRemoveResources(unit.abilityCost)) {
            return false;
        }
        if (unit.abilitySac && !this.canSacrificeUnits(unit.abilitySac)) {
            return false;
        }
        if (unit.toughness < unit.HPUsed) {
            return false;
        }
        if (unit.abilityNetherfy) {
            if (!this.slate(this.villain())
                    .some(x => x.name === 'Drone' && !x.sacrificed && (!x.delayed || !x.purchased) && !x.blocking())) {
                return false;
            }
        }
        if (unit.targetAction === undefined) {
            if (target) {
                throw new InvalidStateError('Target given, but no target action.', unit);
            }
            return true;
        }
        if (target === undefined) {
            throw new InvalidStateError('No target given, but target action.', unit);
        }

        this.requireEnemyUnit(target, true);
        if (!target.validTarget(unit.targetAction, unit.condition)) {
            throw new InvalidStateError('Invalid target.', target);
        }

        switch (unit.targetAction) {
        case 'disrupt':
            if (unit.targetAmount === undefined || unit.targetAmount <= 0) {
                throw new DataError('Invalid target amount.', unit);
            }

            return !target.frozen();
        case 'snipe':
            return !target.sacrificed;
        default:
            throw new DataError('Unknown target action.', unit.targetAction);
        }
    }

    public useAbility(unit: Unit, target?: Unit): void {
        if (!this.canUseAbility(unit, target)) {
            throw new InvalidStateError('Unavailable action.', { unit, target });
        }

        unit.abilityUsed = true;

        if (unit.abilityCost) {
            this.removeResources(unit.abilityCost);
        }

        if (unit.abilitySac) {
            this.sacrificeUnits(unit.abilitySac);
        }

        unit.toughness -= unit.HPUsed;
        assert(unit.toughness >= 0);

        if (unit.abilityNetherfy) {
            const candidates = this.slate(this.villain())
                .filter(x => x.name === 'Drone' && !x.sacrificed && (!x.delayed || !x.purchased) && !x.blocking());
            assert(candidates.length > 0);
            // Already built drones are sniped before building ones
            timsort.sort(candidates, (a, b) => b.delay - a.delay);
            candidates[candidates.length - 1].sacrificed = true;
        }

        if (unit.abilityScript) {
            this.runScript(unit, unit.abilityScript);
        }

        if (unit.charge !== undefined) {
            unit.charge--;
        }

        if (unit.targetAction === undefined) {
            if (target) {
                throw new InvalidStateError('Target given, but no target action.', unit);
            }
            return;
        }
        if (target === undefined) {
            throw new InvalidStateError('No target given, but target action.', unit);
        }

        const id = this.unitId(unit);
        if (id === undefined) {
            throw new InvalidStateError('Unit ID not found.', unit);
        }
        target.targetedBy.push(id);

        switch (unit.targetAction) {
        case 'disrupt':
            if (target.frozen()) {
                throw new InvalidStateError('Target already frozen.', target);
            }

            if (unit.targetAmount === undefined) {
                throw new DataError('Invalid target amount.', unit);
            }
            target.disruption += unit.targetAmount; // tslint:disable-line:restrict-plus-operands
            break;
        case 'snipe':
            if (target.sacrificed) {
                throw new InvalidStateError('Target has been sacrificed.', target);
            }

            target.sacrificed = true;
            break;
        default:
            throw new DataError('Unknown target action.', unit.targetAction);
        }
    }

    public canCancelUseAbility(unit: Unit): boolean {
        this.requireActionPhase();
        this.requireFriendlyUnit(unit, true);
        if (!unit.abilityScript && unit.targetAction === undefined) {
            throw new InvalidStateError('Unit has no ability.', unit);
        }
        if (!unit.abilityUsed) {
            throw new InvalidStateError('Unit\'s ability not used.', unit);
        }

        if (unit.abilityScript && !this.canReverseScript(unit.abilityScript)) {
            return false;
        }

        if (unit.targetAction === undefined) {
            return true;
        }

        const target = this.targetedUnit(unit);
        if (!target) {
            throw new InvalidStateError('No target found.', unit);
        }

        this.requireEnemyUnit(target, true);
        if (!target.validTarget(unit.targetAction, unit.condition)) {
            throw new InvalidStateError('Invalid target.', target);
        }

        switch (unit.targetAction) {
        case 'disrupt':
            if (unit.targetAmount === undefined || unit.targetAmount <= 0) {
                throw new DataError('Invalid target amount.', unit);
            }
            if (target.disruption < unit.targetAmount) {
                throw new InvalidStateError('Not enough existing chill.', target);
            }
            break;
        case 'snipe':
            if (!target.sacrificed) {
                throw new InvalidStateError('Not sacrificed.', target);
            }
            break;
        default:
            throw new DataError('Unknown target action.', unit.targetAction);
        }

        return true;
    }

    public cancelUseAbility(unit: Unit): void {
        if (!this.canCancelUseAbility(unit)) {
            throw new InvalidStateError('Unavailable action.', unit);
        }

        if (unit.abilityScript) {
            this.reverseScript(unit, unit.abilityScript);
        }
        if (unit.abilityNetherfy) {
            const found = this.slate(this.villain()).find(x => x.name === 'Drone' && x.sacrificed);
            if (found === undefined) {
                throw new InvalidStateError('No sniped drone found.');
            }
            found.sacrificed = false;
        }
        if (unit.abilityCost) {
            this.addResources(unit.abilityCost);
        }
        if (unit.abilitySac) {
            this.cancelSacrificeUnits(unit.abilitySac);
        }
        unit.toughness += unit.HPUsed;
        if (unit.charge !== undefined) {
            unit.charge++;
        }
        unit.abilityUsed = false;

        if (unit.targetAction === undefined) {
            return;
        }

        const target = this.targetedUnit(unit);
        if (target === undefined) {
            throw new InvalidStateError('Targeted unit not found.', unit);
        }
        const id = this.unitId(unit);
        if (id === undefined) {
            throw new InvalidStateError('Unit ID not found.', unit);
        }
        target.targetedBy.splice(target.targetedBy.indexOf(id), 1);

        switch (unit.targetAction) {
        case 'disrupt':
            if (unit.targetAmount === undefined) {
                throw new DataError('Invalid target amount.', unit);
            }
            target.disruption -= unit.targetAmount;
            break;
        case 'snipe':
            target.sacrificed = false;
            break;
        default:
            throw new DataError('Unknown target action.', unit.targetAction);
        }
    }

    public overrunDefenses(): void {
        this.requireActionPhase();
        if (this.defensesOverran()) {
            throw new InvalidStateError('Defenses already overran.');
        }

        this.blockers(this.villain())
            .filter(x => !x.defensesBypassed)
            .forEach(x => {
                assert(x.assignedAttack === 0);
                this.emit('assignAttackBlocker', x);
                this.removeAttack(x.toughness);
                x.assignedAttack = x.toughness;
            });
    }

    public cancelOverrunDefenses(): void {
        this.requireActionPhase();
        if (!this.defensesOverran()) {
            throw new InvalidStateError('Defenses not overran.');
        }

        this.blockers(this.villain())
            .filter(x => !x.defensesBypassed)
            .forEach(x => {
                this.addAttack(x.assignedAttack);
                x.assignedAttack = 0;
            });
    }

    public canAssignAttack(unit: Unit): boolean {
        this.requireActionPhase();
        this.requireEnemyUnit(unit);
        if (!this.defensesOverran() && !unit.undefendable) {
            throw new InvalidStateError('Can not target unit before defenses are overrun.', unit);
        }
        if (unit.assignedAttack > 0) {
            throw new InvalidStateError('Unit already targeted.', unit);
        }

        assert(unit.toughness > 0);
        return this.attack() >= (unit.fragile ? 1 : unit.toughness);
    }

    public assignAttack(unit: Unit): void {
        if (!this.canAssignAttack(unit)) {
            throw new InvalidStateError('Unavailable action.', unit);
        }

        if (!this.defensesOverran()) {
            unit.defensesBypassed = true;
        }
        const amount = Math.min(unit.toughness, this.attack());
        this.removeAttack(amount);
        unit.assignedAttack = amount;
    }

    public canCancelAssignAttack(unit: Unit): boolean {
        this.requireActionPhase();
        this.requireEnemyUnit(unit, true);
        if (this.defensesOverran() && unit.blocking() && !unit.frozen()) {
            throw new InvalidStateError('Can not cancel attack on blocker after overran.', unit);
        }

        return unit.assignedAttack > 0;
    }

    public cancelAssignAttack(unit: Unit): void {
        if (!this.canCancelAssignAttack(unit)) {
            throw new InvalidStateError('Unavailable action.', unit);
        }

        this.targetingUnits(unit).forEach(x => {
            if (x.targetAction === 'snipe') {
                this.emit('autoAction', ActionType.CancelUseAbility, x);
                this.cancelUseAbility(x);
            }
        });
        if (unit.sacrificed) {
            throw new InvalidStateError('Sacrificed unit', unit);
        }

        const amount = unit.assignedAttack;
        unit.assignedAttack = 0;
        unit.defensesBypassed = false;
        this.addAttack(amount);
    }

    public endTurn(): void {
        this.requireActionPhase();

        this.runEndTurn();
    }

    // Public
    public init(info: InitialState): void {
        if (this.turnNumber !== 0) {
            throw new InvalidStateError('Already initialized.');
        }

        this.resources = [parseResources(info.initResources[0]), parseResources(info.initResources[1])];
        this.deck = info.deck;
        this.supplies = [{}, {}];
        this.initPlayer(Player.First, info.initCards[0], info.baseSets[0], info.randomSets[0], info.infiniteSupplies);
        this.initPlayer(Player.Second, info.initCards[1], info.baseSets[1], info.randomSets[1], info.infiniteSupplies);

        this.turnNumberValue = 1;
        this.activePlayer = Player.First;
        this.inDefensePhase = false;
        this.emit('turnStarted', this.turnNumber, this.activePlayer);
        this.runStartTurn();
    }

    public getSnapshot(): GameStateSnapshot {
        return {
            deck: deepClone(this.deck),
            turnNumber: this.turnNumber,
            activePlayer: this.activePlayer,
            inDefensePhase: this.inDefensePhase,
            supplies: deepClone(this.supplies),
            resources: deepClone(this.resources),
            units: deepClone(this.units),
        };
    }

    public restoreSnapshot(snapshot: GameStateSnapshot): void {
        this.deck = deepClone(snapshot.deck);
        this.turnNumberValue = snapshot.turnNumber;
        this.activePlayer = snapshot.activePlayer;
        this.inDefensePhase = snapshot.inDefensePhase;
        this.supplies = deepClone(snapshot.supplies);
        this.resources = deepClone(snapshot.resources);
        this.units = deepClone(snapshot.units);
    }
}
