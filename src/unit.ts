import { DataError } from '.';
import { Blueprint, Condition, SacrificeRule, Script } from './blueprint';
import { Player } from './gameState';
import { Resources } from './resources';

interface UnitOptions {
    buildTime?: number;
    lifespan?: number;
}

export class Unit {
    // Constants
    public readonly player: Player;
    public readonly buildTime: number;
    public readonly HPMax: number; // tslint:disable-line:variable-name

    private readonly blueprint: Blueprint;

    // State
    public abilityUsed: boolean = false;
    public assignedAttack: number = 0;
    public building: boolean;
    public constructedBy?: number;
    public defensesBypassed: boolean = false;
    public delay?: number;
    public destroyed: boolean = false;
    public disruption: number = 0;
    public purchased: boolean = false;
    public sacrificed: boolean = false;

    public readonly targetedBy: number[] = [];

    // State from Blueprint
    public charge?: number;
    public lifespan?: number;
    public targetAction?: string;
    public toughness: number;

    constructor(blueprint: Blueprint, player: Player, options: UnitOptions = {}) {
        this.blueprint = blueprint;
        this.player = player;
        this.buildTime = options.buildTime !== undefined ? options.buildTime : blueprint.buildTime;
        this.HPMax = blueprint.HPMax !== undefined ? blueprint.HPMax : blueprint.toughness;

        this.building = this.buildTime > 0;
        this.delay = this.buildTime > 0 ? this.buildTime : undefined;
        this.charge = blueprint.charge;
        this.lifespan = options.lifespan !== undefined ? options.lifespan : blueprint.lifespan;
        this.targetAction = blueprint.targetAction;
        this.toughness = blueprint.toughness;
    }

    public get abilityCost(): Resources | undefined { return this.blueprint.abilityCost; }
    public get abilityNetherfy(): boolean { return this.blueprint.abilityNetherfy; }
    public get abilitySac(): SacrificeRule[] | undefined { return this.blueprint.abilitySac; }
    public get abilityScript(): Script | undefined { return this.blueprint.abilityScript; }
    public get beginOwnTurnScript(): Script | undefined { return this.blueprint.beginOwnTurnScript; }
    public get buyCost(): Resources | undefined { return this.blueprint.buyCost; }
    public get buySac(): SacrificeRule[] | undefined { return this.blueprint.buySac; }
    public get buyScript(): Script | undefined { return this.blueprint.buyScript; }
    public get condition(): Condition | undefined { return this.blueprint.condition; }
    public get defaultBlocking(): boolean { return this.blueprint.defaultBlocking; }
    public get fragile(): boolean { return this.blueprint.fragile; }
    public get goldResonate(): string | undefined { return this.blueprint.goldResonate; }
    public get HPGained(): number { return this.blueprint.HPGained; }
    public get HPUsed(): number { return this.blueprint.HPUsed; }
    public get name(): string { return this.blueprint.name; }
    public get originalName(): string | undefined { return this.blueprint.originalName; }
    public get resonate(): string | undefined { return this.blueprint.resonate; }
    public get spell(): boolean { return this.blueprint.spell; }
    public get targetAmount(): number | undefined { return this.blueprint.targetAmount; }
    public get undefendable(): boolean { return this.blueprint.undefendable; }

    public clone(): Unit {
        const other = new Unit(this.blueprint, this.player);

        other.abilityUsed = this.abilityUsed;
        other.assignedAttack = this.assignedAttack;
        other.building = this.building;
        other.constructedBy = this.constructedBy;
        other.defensesBypassed = this.defensesBypassed;
        other.delay = this.delay;
        other.destroyed = this.destroyed;
        other.disruption = this.disruption;
        other.purchased = this.purchased;
        other.sacrificed = this.sacrificed;

        this.targetedBy.forEach(x => {
            other.targetedBy.push(x);
        });

        other.charge = this.charge;
        other.lifespan = this.lifespan;
        other.targetAction = this.targetAction;
        other.toughness = this.toughness;

        return other;
    }

    public blocking(): boolean {
        return !this.destroyed && !this.sacrificed && (this.delay === undefined || this.delay === 0) &&
            this.defaultBlocking && !this.abilityUsed;
    }

    public purchasedThisTurn(): boolean {
        if (this.destroyed || !this.purchased) {
            return false;
        }
        if (this.buildTime === 0) {
            return this.delay === undefined;
        }
        return this.delay === this.buildTime;
    }

    public frozen(): boolean {
        return !this.destroyed && this.disruption >= this.toughness;
    }

    private validSnipeTarget(condition: Condition): boolean {
        if (this.delay && this.purchased) {
            return false;
        }
        if (this.assignedAttack >= this.toughness) {
            return false;
        }

        if (condition.healthAtMost !== undefined) {
            if (this.toughness - (this.fragile ? this.assignedAttack : 0) > condition.healthAtMost) {
                return false;
            }
        }

        if (condition.isABC === 1) {
            if (!['Animus', 'Blastforge', 'Conduit'].includes(this.name)) {
                return false;
            }
        }

        if (condition.isEngineerTempHack === 1) {
            if (this.name !== 'Engineer') {
                return false;
            }
        }

        if (condition.nameIn !== undefined) {
            if (!condition.nameIn.includes(this.name)) {
                return false;
            }
        }

        return true;
    }

    private validChillTarget(): boolean {
        if (!this.blocking()) {
            return false;
        }
        /*if (this.assignedAttack === this.toughness) {
            return false;
        }*/
        return true;
    }

    public validTarget(targetAction: string, condition: Condition | undefined): boolean {
        switch (targetAction) {
        case 'disrupt':
            return this.validChillTarget();
        case 'snipe':
            if (!condition) {
                throw new DataError('No snipe condition given.', targetAction);
            }
            return this.validSnipeTarget(condition);
        default:
            throw new DataError('Unknown target action.', targetAction);
        }
    }
}
