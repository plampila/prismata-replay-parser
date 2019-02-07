import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as timsort from 'timsort';

import { ActionType } from './constants';
import { DataError, InvalidStateError, NotImplementedError } from './customErrors';
import { blocking, deepClone, frozen, parseResources, purchasedThisTurn, validTarget } from './util';

export enum Player {
    First = 0,
    Second = 1,
}

export type Unit = any;
export interface IBlueprint {
    [property: string]: any;
}

export type Deck = IBlueprint[];

/** Unit name, target (own or enemy), count, build time, lifespan */
type ScriptCreateRule = [string, 'own' | 'enemy', number, number?, number?];

interface IScript {
    create?: ScriptCreateRule[];
    delay?: number;
    receive?: string;
    selfsac?: true;
}

/** Unit name and count */
type SacrificeRule = [string, number];

export interface ISupplies {
    [unitName: string]: number;
}

export interface IResources {
    gold: number;
    green: number;
    blue: number;
    red: number;
    energy: number;
    attack: number;
}

const UNIT_ATTRIBUTE_SUPPORT: {
    [attribute: string]: boolean | undefined;
} = {
    // Basic info
    buildTime: true,
    charge: true, // Stamina
    defaultBlocking: true,
    fragile: true,
    HPGained: true,
    HPMax: true,
    lifespan: true,
    name: true,
    rarity: true,
    spell: true,
    toughness: true, // Health
    undefendable: true, // Frontline

    // Click abilities
    abilityCost: true,
    abilityNetherfy: true, // Deadeye snipe
    abilitySac: true,
    abilityScript: true,
    HPUsed: true, // Health cost to use ability
    targetAction: true,
    targetAmount: true,

    // Purchasing
    buyCost: true,
    buySac: true,
    buyScript: true,

    // Other
    beginOwnTurnScript: true,
    goldResonate: true, // One gold per named unit, eg. Savior
    resonate: true, // One attack per named unit, eg. Antima Comet
    condition: true, // Targeted snipe action limitations

    // Not needed
    assignedBlocking: true,
    baseSet: true,
    description: true,
    fullDescription: true,
    fullDescription_en: true,
    group: true,
    needs: true,
    originalName: true, // Added by us to save remapped name
    position: true,
    potentiallyMoreAttack: true, // Apollo snipe UI
    score: true,
    UIArt: true,
    UIName: true,
    UIShortname: true,
    xOffset: true,
    yOffset: true,
};

const RARITIES: {
    [name: string]: number | undefined;
} = {
    trinket: 20,
    normal: 10,
    rare: 4,
    legendary: 1,
};

const DEFAULT_PROPERTIES: {
    [property: string]: boolean | number;
} = {
    abilityNetherfy: false,
    assignedAttack: 0,
    buildTime: 1,
    defaultBlocking: false,
    disruption: 0,
    fragile: false,
    HPGained: 0,
    HPUsed: 0,
    sacrificed: false,
    spell: false,
    toughness: 1, // Some units such as Gauss Charge has no health defined
    undefendable: false,
};

type InitialUnitList = Array<[number, string]>;
type PurchasableUnitList = Array<string | [string, number]>;

export interface IInitialState {
    initResources: [string | number, string | number]; // TODO: get rid of the number in replayParser
    deck: Deck;
    initCards: [InitialUnitList, InitialUnitList];
    baseSets: [PurchasableUnitList, PurchasableUnitList];
    randomSets: [PurchasableUnitList, PurchasableUnitList];
    infiniteSupplies?: boolean;
}

export interface IGameStateSnapshot {
    deck: Deck;
    turnNumber: number;
    activePlayer: Player;
    inDefensePhase: boolean;
    supplies: ISupplies;
    resources: IResources;
    units: Unit[];
}

export declare interface GameState { // tslint:disable-line:interface-name
    on(event: 'assignAttackBlocker', listener: (unit: Unit) => void): this;
    on(event: 'autoAction', listener: (action: ActionType, unit: Unit) => void): this;
    on(event: 'turnStarted', listener: (turnNumber: number, player: Player) => void): this;
    on(event: 'unitConstructed', listener: (constructed: Unit, by: Unit) => void): this;
    on(event: 'unitDestroyed', listener: (unit: Unit, reason: string) => void): this;
}

export class GameState extends EventEmitter {
    public deck: Deck = [];
    private turnNumber: number = 0;
    public activePlayer: Player = Player.First;
    public inDefensePhase: boolean = false;
    private supplies: [ISupplies, ISupplies] = [{}, {}];
    private resources: [IResources, IResources] = [parseResources('0'), parseResources('0')];
    public units: Unit[] = [];

    constructor() {
        super();
    }

    // Helpers
    public villain(): Player {
        return this.activePlayer === Player.First ? Player.Second : Player.First;
    }

    public attack(player: Player = this.activePlayer): number {
        return this.resources[player].attack;
    }

    public slate(player?: Player): Unit[] {
        return this.units.filter(x => !x.destroyed && (player === undefined || x.player === player));
    }

    public blockers(player: Player = this.activePlayer): Unit[] {
        return this.slate(player).filter(x => blocking(x) && !frozen(x));
    }

    public absorber(): Unit | undefined {
        return this.slate(this.activePlayer)
            .find(x => blocking(x) && x.assignedAttack > 0 && x.assignedAttack < x.toughness);
    }

    public breachAbsorber(): Unit | undefined {
        const candidates = this.slate(this.villain()).filter(x => !blocking(x) &&
            x.assignedAttack > 0 && x.assignedAttack < x.toughness);
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
            .filter(x => !x.assignedAttack)
            .reduce((t, x) => t + x.toughness, 0); // tslint:disable-line:restrict-plus-operands
        return this.attack() >= Math.max(totalDefense, 1);
    }

    public breaching(): boolean {
        return this.slate(this.villain())
            .some(x => !x.sacrificed && !blocking(x) && x.assignedAttack);
    }

    public canOverKill(): boolean {
        return !this.slate(this.villain()).some(x => !x.sacrificed &&
            x.assignedAttack < x.toughness && (!x.delay || !x.purchased));
    }

    private targetedUnit(unit: Unit): Unit {
        return this.slate().find(x => x.targetedBy && x.targetedBy.includes(this.unitId(unit)));
    }

    private unitId(unit: Unit): number | undefined {
        const id = this.units.indexOf(unit);
        return id >= 0 ? id : undefined;
    }

    private blueprintForName(name: string): IBlueprint | undefined {
        return this.deck.find(x => x.name === name);
    }

    // Internal
    private requireActionPhase(): void {
        if (this.inDefensePhase) {
            throw new InvalidStateError('Not in action phase.');
        }
    }

    private requireValidUnit(unit: Unit, allowSacrificed: boolean): void {
        if (!unit) {
            throw new InvalidStateError('No unit given.');
        }
        if (this.unitId(unit) === null) {
            throw new InvalidStateError('Unit with no ID.', unit);
        }
        if (unit.player === undefined) {
            throw new InvalidStateError('No player defined.', unit);
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

    private constructUnit(unitData: IBlueprint, buildTime?: number, player: Player = this.activePlayer,
                          lifespan?: number): Unit {
        Object.keys(unitData).forEach(key => {
            if (UNIT_ATTRIBUTE_SUPPORT[key] === undefined) {
                throw new DataError('Unknown unit attribute.', key);
            } else if (!UNIT_ATTRIBUTE_SUPPORT[key]) {
                throw new NotImplementedError(`Unit attribute ${key}`);
            }
        });
        if (unitData.UIShortname === 'Robo Santa') {
            throw new NotImplementedError('Robo Santa');
        }

        const unit = Object.create(unitData);
        unit.player = player;
        const delay = buildTime !== undefined ? buildTime : unit.buildTime;
        if (delay !== 0) {
            unit.building = true;
            unit.delay = delay;
        }
        if (lifespan) {
            unit.lifespan = lifespan;
        }
        this.units.push(unit);
        return unit;
    }

    private destroyUnit(unit: Unit, reason: string): void {
        if (this.unitId(unit) === null) {
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
                const supply = RARITIES[blueprint.rarity];
                if (supply === undefined) {
                    throw new DataError('Unknown rarity.', blueprint.rarity);
                }
                this.supplies[player][x] = infiniteSupplies ? Infinity : supply;
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
            if (unit.targetedBy) {
                unit.targetedBy.map((id: number) => this.units[id]).forEach((x: Unit) => {
                    if (x.targetAction === 'snipe') {
                        this.emit('autoAction', ActionType.CancelUseAbility, x);
                        this.cancelUseAbility(x);
                    }
                });
            }
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

    private addResources(resources: string, player: Player = this.activePlayer): void {
        const parsed = parseResources(resources);
        this.resources[player].gold += parsed.gold;
        this.resources[player].green += parsed.green;
        this.resources[player].blue += parsed.blue;
        this.resources[player].red += parsed.red;
        this.resources[player].energy += parsed.energy;
        this.addAttack(parsed.attack);
    }

    private removeResources(resources: string, player: Player = this.activePlayer): void {
        const parsed = parseResources(resources);
        this.resources[player].gold -= parsed.gold;
        this.resources[player].green -= parsed.green;
        this.resources[player].blue -= parsed.blue;
        this.resources[player].red -= parsed.red;
        this.resources[player].energy -= parsed.energy;
        this.removeAttack(parsed.attack);
    }

    private canRemoveResources(resources: string, player: Player = this.activePlayer): boolean {
        const parsed = parseResources(resources);
        return this.resources[player].gold >= parsed.gold &&
            this.resources[player].green >= parsed.green &&
            this.resources[player].blue >= parsed.blue &&
            this.resources[player].red >= parsed.red &&
            this.resources[player].energy >= parsed.energy &&
            this.resources[player].attack >= parsed.attack;
    }

    private sacrificeList(name: string, player: Player = this.activePlayer): Unit[] {
        const found = this.slate(player).filter(x => !x.sacrificed && x.name === name && !x.delay);
        found.reverse();
        // Must be a stable sort
        timsort.sort(found, (a, b) => a.abilityUsed === b.abilityUsed ? 0 : a.abilityUsed ? -1 : 1);
        return found;
    }

    private canSacrificeUnits(rules: SacrificeRule[]): boolean {
        return !rules.some(x => this.sacrificeList(x[0]).length < (x[1] || 1));
    }

    private sacrificeUnits(rules: SacrificeRule[]): void {
        rules.forEach(x => {
            const name = x[0];
            const count = (x[1] || 1);

            const targets = this.sacrificeList(name);
            if (targets.length < count) {
                throw new InvalidStateError('Not enough units to sacrifice.', rules);
            }
            targets.length = count;
            targets.forEach(target => {
                if (target.defaultBlocking && target.abilityScript && !target.abilityUsed) {
                    this.useAbility(target);
                }
                target.sacrificed = true;
            });
        });
    }

    private cancelSacrificeUnits(rules: SacrificeRule[]): void {
        rules.forEach(x => {
            for (let i = 0; i < (x[1] || 1); i++) {
                const found = this.slate(this.activePlayer).find(y => y.name === x[0] && y.sacrificed);
                if (!found) {
                    throw new InvalidStateError('No unit found to cancel ability sacrifice.', rules);
                }
                delete found.sacrificed;
            }
        });
    }

    private runScript(unit: Unit, script: IScript): void {
        if (script.create !== undefined) {
            script.create.forEach(x => {
                const blueprint = this.blueprintForName(x[0]);
                if (blueprint === undefined) {
                    throw new DataError('Blueprint not found.', x[0]);
                }
                for (let i = 0; i < (x[2] || 1); i++) {
                    const constructed = this.constructUnit(blueprint, x[3] === undefined ? 1 : x[3],
                        x[1] === 'own' ? this.activePlayer : this.villain(), x[4]);
                    constructed.constructedBy = this.unitId(unit);
                    this.emit('unitConstructed', constructed, unit);
                }
            });
        }

        if (script.delay !== undefined) {
            unit.delay = script.delay;
        }

        if (script.receive !== undefined) {
            this.addResources(script.receive);
        }

        if (script.selfsac) {
            unit.sacrificed = true;
        }
    }

    private canReverseScript(script: IScript): boolean {
        if (script.receive !== undefined && !this.canRemoveResources(script.receive)) {
            return false;
        }
        return true;
    }

    private reverseScript(unit: Unit, script: IScript): void {
        if (script.create !== undefined) {
            script.create.forEach(x => {
                const targetPlayer = x[1] === 'own' ? this.activePlayer : this.villain();
                for (let i = 0; i < (x[2] || 1); i++) {
                    const found = this.slate(targetPlayer).slice().reverse().find(y => {
                        return y.name === x[0] && y.constructedBy === this.unitId(unit);
                    });
                    if (!found) {
                        throw new InvalidStateError('No unit to deconstruct.', unit);
                    }
                    this.destroyUnit(found, 'deconstructed');
                }
            });
        }

        if (script.delay !== undefined) {
            delete unit.delay;
        }

        if (script.receive !== undefined) {
            this.removeResources(script.receive);
        }

        if (script.selfsac) {
            if (!unit.sacrificed) {
                throw new InvalidStateError('Not sacrificed.', unit);
            }
            delete unit.sacrificed;
        }
    }

    private runStartTurn(): void {
        this.slate(this.activePlayer).forEach(unit => {
            if (unit.assignedAttack) {
                if (unit.assignedAttack >= unit.toughness) {
                    this.destroyUnit(unit, 'defense');
                    return;
                }
                if (unit.fragile) {
                    unit.toughness -= unit.assignedAttack;
                }
                delete unit.assignedAttack;
            }
            unit.toughness += unit.HPGained;
            unit.toughness = Math.min(unit.toughness,
                unit.HPMax ? unit.HPMax : Object.getPrototypeOf(unit).toughness);
            if (!unit.delay && unit.lifespan > 0) {
                unit.lifespan--;
                if (unit.lifespan === 0) {
                    this.destroyUnit(unit, 'lifespan');
                    return;
                }
            }

            delete unit.disruption;
            delete unit.abilityUsed;
            if (unit.delay) {
                unit.delay--;
                if (unit.delay <= 0) {
                    delete unit.delay;
                    delete unit.building;
                    delete unit.purchased;
                }
            } else if (unit.purchased) {
                delete unit.purchased;
            }
        });

        this.slate(this.activePlayer).filter(x => !x.delay).forEach(unit => {
            if (unit.beginOwnTurnScript) {
                this.runScript(unit, unit.beginOwnTurnScript);
            }
            if (unit.goldResonate) {
                this.resources[unit.player].gold += this.slate(unit.player)
                    .filter(x => !x.delay && x.name === unit.goldResonate).length;
            }
            if (unit.resonate) {
                this.addAttack(this.slate(unit.player)
                    .filter(x => !x.delay && x.name === unit.resonate).length);
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

            delete unit.sacrificed;
            delete unit.constructedBy;
            delete unit.targetedBy;
        });

        if (this.defensesOverran() && this.attack() > 0) {
            // FIXME: Overkill
            if (this.slate(this.villain()).some(x => !x.purchased && !x.assignedAttack &&
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
            this.turnNumber++;
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
        if (unit.assignedAttack) {
            throw new InvalidStateError('Already assigned.', unit);
        }
        if (!blocking(unit)) {
            throw new InvalidStateError('Not blocking.', unit);
        }
        if (frozen(unit)) {
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
        if (!unit.assignedAttack) {
            throw new InvalidStateError('Not assigned.', unit);
        }

        return this.attack(this.villain()) > 0 || !this.absorber() || this.absorber() === unit;
    }

    public cancelAssignDefense(unit: Unit): void {
        if (!this.canCancelAssignDefense(unit)) {
            throw new InvalidStateError('Unavailable action.', unit);
        }

        this.addAttack(unit.assignedAttack, this.villain());
        delete unit.assignedAttack;
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

        if (!this.supplies[this.activePlayer][blueprint.name]) {
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
        if (!purchasedThisTurn(unit)) {
            throw new InvalidStateError('Not purchased this turn.', unit);
        }

        return !unit.buyScript || this.canReverseScript(unit.buyScript);
    }

    public cancelPurchase(unit: Unit): void {
        if (!this.canCancelPurchase(unit)) {
            throw new InvalidStateError('Unavailable action.', unit);
        }

        this.supplies[unit.player][unit.name]++;
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
        if (!unit.abilityScript && !unit.targetAction) {
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
            if (!this.slate(this.villain()).some(x => x.name === 'Drone' &&
                !x.sacrificed && (!x.delay || !x.purchased) && !blocking(x))) {
                return false;
            }
        }
        if (!unit.targetAction) {
            if (target) {
                throw new InvalidStateError('Target given, but no target action.', unit);
            }
            return true;
        }

        this.requireEnemyUnit(target, true);
        if (!validTarget(target, unit.targetAction, unit.condition)) {
            throw new InvalidStateError('Invalid target.', target);
        }

        switch (unit.targetAction) {
        case 'disrupt':
            if (unit.targetAmount <= 0) {
                throw new DataError('Invalid target amount.', unit);
            }

            return !frozen(target);
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
            const candidates = this.slate(this.villain()).filter(x => x.name === 'Drone' &&
                !x.sacrificed && (!x.delay || !x.purchased) && !blocking(x));
            assert(candidates.length > 0);
            // Already built drones are sniped before building ones
            timsort.sort(candidates, (a, b) => (b.delay || 0) - (a.delay || 0));
            candidates[candidates.length - 1].sacrificed = true;
        }

        if (unit.abilityScript) {
            this.runScript(unit, unit.abilityScript);
        }

        if (unit.charge > 0) {
            unit.charge--;
        }

        if (!unit.targetAction) {
            if (target) {
                throw new InvalidStateError('Target given, but no target action.', unit);
            }
            return;
        }

        if (!target.targetedBy) {
            target.targetedBy = [];
        }
        target.targetedBy.push(this.unitId(unit));

        switch (unit.targetAction) {
        case 'disrupt':
            if (frozen(target)) {
                throw new InvalidStateError('Target already frozen.', target);
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
        if (!unit.abilityScript && !unit.targetAction) {
            throw new InvalidStateError('Unit has no ability.', unit);
        }
        if (!unit.abilityUsed) {
            throw new InvalidStateError('Unit\'s ability not used.', unit);
        }

        if (unit.abilityScript && !this.canReverseScript(unit.abilityScript)) {
            return false;
        }

        if (!unit.targetAction) {
            return true;
        }

        const target = this.targetedUnit(unit);
        if (!target) {
            throw new InvalidStateError('No target found.', unit);
        }

        this.requireEnemyUnit(target, true);
        if (!validTarget(target, unit.targetAction, unit.condition)) {
            throw new InvalidStateError('Invalid target.', target);
        }

        switch (unit.targetAction) {
        case 'disrupt':
            if (unit.targetAmount <= 0) {
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
            assert(found, 'No sniped drone found.');
            delete found.sacrificed;
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
        delete unit.abilityUsed;

        if (!unit.targetAction) {
            return;
        }

        const target = this.targetedUnit(unit);
        target.targetedBy.splice(target.targetedBy.indexOf(this.unitId(unit)), 1);
        if (target.targetedBy.length === 0) {
            delete target.targetedBy;
        }

        switch (unit.targetAction) {
        case 'disrupt':
            target.disruption -= unit.targetAmount;
            if (target.disruption === 0) {
                delete target.disruption;
            }
            break;
        case 'snipe':
            delete target.sacrificed;
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
                assert(!x.assignedAttack);
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
                delete x.assignedAttack;
            });
    }

    public canAssignAttack(unit: Unit): boolean {
        this.requireActionPhase();
        this.requireEnemyUnit(unit);
        if (!this.defensesOverran() && !unit.undefendable) {
            throw new InvalidStateError('Can not target unit before defenses are overrun.', unit);
        }
        if (unit.assignedAttack) {
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
        if (this.defensesOverran() && blocking(unit) && !frozen(unit)) {
            throw new InvalidStateError('Can not cancel attack on blocker after overran.', unit);
        }

        return unit.assignedAttack > 0;
    }

    public cancelAssignAttack(unit: Unit): void {
        if (!this.canCancelAssignAttack(unit)) {
            throw new InvalidStateError('Unavailable action.', unit);
        }

        if (unit.targetedBy) {
            unit.targetedBy.map((id: number) => this.units[id]).forEach((x: Unit) => {
                if (x.targetAction === 'snipe') {
                    this.emit('autoAction', ActionType.CancelUseAbility, x);
                    this.cancelUseAbility(x);
                }
            });
        }
        if (unit.sacrificed) {
            throw new InvalidStateError('Sacrificed unit', unit);
        }

        const amount = unit.assignedAttack;
        delete unit.assignedAttack;
        delete unit.defensesBypassed;
        this.addAttack(amount);
    }

    public endTurn(): void {
        this.requireActionPhase();

        this.runEndTurn();
    }

    // Public
    public init(info: IInitialState): void {
        if (this.turnNumber !== 0) {
            throw new InvalidStateError('Already initialized.');
        }

        this.resources = [parseResources(info.initResources[0]), parseResources(info.initResources[1])];
        this.deck = info.deck.map((x: any) => Object.assign(Object.create(DEFAULT_PROPERTIES), x));
        this.supplies = [{}, {}];
        this.initPlayer(Player.First, info.initCards[0], info.baseSets[0], info.randomSets[0], info.infiniteSupplies);
        this.initPlayer(Player.Second, info.initCards[1], info.baseSets[1], info.randomSets[1], info.infiniteSupplies);

        this.turnNumber = 1;
        this.activePlayer = Player.First;
        this.inDefensePhase = false;
        this.emit('turnStarted', this.turnNumber, this.activePlayer);
        this.runStartTurn();
    }

    public getSnapshot(): IGameStateSnapshot {
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

    public restoreSnapshot(snapshot: IGameStateSnapshot): void {
        this.deck = deepClone(snapshot.deck);
        this.turnNumber = snapshot.turnNumber;
        this.activePlayer = snapshot.activePlayer;
        this.inDefensePhase = snapshot.inDefensePhase;
        this.supplies = deepClone(snapshot.supplies);
        this.resources = deepClone(snapshot.resources);
        this.units = deepClone(snapshot.units);
    }
}
