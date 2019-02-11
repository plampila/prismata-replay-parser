import { DataError } from './customErrors';
import { ReplayBlueprint, ReplayBlueprintScript } from './replayData';

const RARITIES: {
    [name: string]: number | undefined;
} = {
    trinket: 20,
    normal: 10,
    rare: 4,
    legendary: 1,
};

export interface Blueprint {
    name: string;
    originalName?: string; // Set by us if renamed

    // Basic info
    buildTime: number;
    charge?: number;
    defaultBlocking: boolean;
    fragile: boolean;
    HPGained: number;
    HPMax?: number;
    lifespan?: number;
    spell: boolean;
    supply?: number;
    toughness: number; // Health
    undefendable: boolean; // Frontline

    // Click abilities
    abilityCost?: string;
    abilityNetherfy: boolean; // Deadeye snipe
    abilitySac?: SacrificeRule[];
    abilityScript?: Script;
    HPUsed: number; // Health cost to use ability
    targetAction?: string; // TODO: enum
    targetAmount?: number;

    // Purchasing
    buyCost?: string;
    buySac?: SacrificeRule[];
    buyScript?: Script;

    // Other
    beginOwnTurnScript?: Script;
    goldResonate?: string; // One gold per named unit, eg. Savior
    resonate?: string; // One attack per named unit, eg. Antima Comet
    condition?: Condition; // Targeted snipe action limitations
}

export interface Script {
    create?: ScriptCreateRule[];
    delay?: number;
    receive?: string;
    selfsac?: boolean;
}

/** Unit name, target (own or enemy), count, build time, lifespan */
type ScriptCreateRule = [string, 'own' | 'opponent', number?, number?, number?];

/** Unit name and count */
export type SacrificeRule = [string, number?];

export interface Condition {
    isABC?: 1;
    healthAtMost?: number;
    nameIn?: string[];
    isEngineerTempHack?: 1;
}

export function convertBlueprintFromReplay(data: ReplayBlueprint): Blueprint {
    function def<T>(x: T | undefined, value: T): T {
        return x !== undefined ? x : value;
    }

    return {
        name: data.name,

        buildTime: def(data.buildTime, 1),
        charge: data.charge,
        defaultBlocking: data.defaultBlocking === 1,
        fragile: data.fragile === 1,
        HPGained: def(data.HPGained, 0),
        HPMax: data.HPMax,
        lifespan: typeof data.lifespan === 'string' ? parseInt(data.lifespan, 10) : data.lifespan,
        spell: data.spell === 1,
        supply: rarityToSupply(data.rarity),
        toughness: def(data.toughness, 1),
        undefendable: data.undefendable === 1,

        abilityCost: data.abilityCost === undefined || typeof data.abilityCost === 'string' ?
            data.abilityCost : String(data.abilityCost),
        abilityNetherfy: def(data.abilityNetherfy, false),
        abilitySac: data.abilitySac,
        abilityScript: convertScript(data.abilityScript),
        HPUsed: def(data.HPUsed, 0),
        targetAction: data.targetAction,
        targetAmount: data.targetAmount,

        buyCost: data.buyCost,
        buySac: data.buySac,
        buyScript: convertScript(data.buyScript),

        beginOwnTurnScript: convertScript(data.beginOwnTurnScript),
        goldResonate: data.goldResonate,
        resonate: data.resonate,
        condition: data.condition,
    };
}

function rarityToSupply(rarity?: string): number | undefined {
    if (rarity === undefined || rarity === 'unbuyable') {
        return undefined;
    }
    const supply = RARITIES[rarity];
    if (supply === undefined) {
        throw new DataError('Unknown rarity.', rarity);
    }
    return supply;
}

function convertScript(script?: ReplayBlueprintScript): Script | undefined {
    if (script === undefined) {
        return undefined;
    }
    return {
        create: script.create,
        delay: script.delay,
        receive: typeof script.receive === 'string' ? script.receive : String(script.receive),
        selfsac: script.selfsac,
    };
}

function renameScript(script: Script, renames: Map<string, string>): void {
    if (script.create !== undefined) {
        script.create.forEach(rule => {
            const newName = renames.get(rule[0]);
            if (newName !== undefined) {
                rule[0] = newName;
            }
        });
    }
}

export function renameBlueprintFields(x: Blueprint, renames: Map<string, string>): void {
    const newName = renames.get(x.name);
    if (newName !== undefined) {
        x.originalName = x.name;
        x.name = newName;
    }

    if (x.resonate !== undefined && renames.get(x.resonate) !== undefined) {
        x.resonate = renames.get(x.resonate);
    }
    if (x.goldResonate !== undefined && renames.get(x.goldResonate) !== undefined) {
        x.goldResonate = renames.get(x.goldResonate);
    }

    if (x.abilityScript !== undefined) {
        renameScript(x.abilityScript, renames);
    }
    if (x.buyScript !== undefined) {
        renameScript(x.buyScript, renames);
    }
    if (x.beginOwnTurnScript !== undefined) {
        renameScript(x.beginOwnTurnScript, renames);
    }

    if (x.abilitySac !== undefined) {
        x.abilitySac.forEach(rule => {
            const newRuleName = renames.get(rule[0]);
            if (newRuleName !== undefined) {
                rule[0] = newRuleName;
            }
        });
    }
    if (x.buySac !== undefined) {
        x.buySac.forEach(rule => {
            const newRuleName = renames.get(rule[0]);
            if (newRuleName !== undefined) {
                rule[0] = newRuleName;
            }
        });
    }
}
