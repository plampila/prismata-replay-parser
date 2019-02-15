import { DataError } from './customErrors';
import {
    ReplayBlueprint, ReplayBlueprintSacrificeRule, ReplayBlueprintScript, ReplayBlueprintScriptCreateRule,
} from './replayData';
import { parseResources, Resources } from './resources';

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
    HPMax: number;
    lifespan?: number;
    spell: boolean;
    supply?: number;
    toughness: number; // Health
    undefendable: boolean; // Frontline

    // Click abilities
    abilityCost: Resources;
    abilityNetherfy: boolean; // Deadeye snipe
    abilitySac?: SacrificeRule[];
    abilityScript?: Script;
    HPUsed: number; // Health cost to use ability
    targetAction?: string; // TODO: enum
    targetAmount?: number;

    // Purchasing
    buyCost: Resources;
    buySac?: SacrificeRule[];
    buyScript?: Script;

    // Other
    beginOwnTurnScript?: Script;
    goldResonate?: string; // One gold per named unit, eg. Savior
    resonate?: string; // One attack per named unit, eg. Antima Comet
    condition?: Condition; // Targeted snipe action limitations
}

export interface Script {
    create: ScriptCreateRule[];
    delay: number;
    receive: Resources;
    selfsac: boolean;
}

interface ScriptCreateRule {
    unitName: string;
    forOpponent: boolean;
    count: number;
    buildTime: number;
    customLifespan?: number;
}

export interface SacrificeRule {
    unitName: string;
    count: number;
}

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
        HPMax: data.HPMax !== undefined ? data.HPMax : def(data.toughness, 1),
        lifespan: typeof data.lifespan === 'string' ? parseInt(data.lifespan, 10) : data.lifespan,
        spell: data.spell === 1,
        supply: rarityToSupply(data.rarity),
        toughness: def(data.toughness, 1),
        undefendable: data.undefendable === 1,

        abilityCost: convertResources(data.abilityCost),
        abilityNetherfy: def(data.abilityNetherfy, false),
        abilitySac: data.abilitySac !== undefined ? data.abilitySac.map(convertSacrificeRule) : undefined,
        abilityScript: convertScript(data.abilityScript),
        HPUsed: def(data.HPUsed, 0),
        targetAction: data.targetAction,
        targetAmount: data.targetAmount,

        buyCost: convertResources(data.buyCost),
        buySac: data.buySac !== undefined ? data.buySac.map(convertSacrificeRule) : undefined,
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

function convertSacrificeRule(rule: ReplayBlueprintSacrificeRule): SacrificeRule {
    return {
        unitName: rule[0],
        count: rule[1] !== undefined ? rule[1] : 1,
    };
}

function convertScript(script?: ReplayBlueprintScript): Script | undefined {
    if (script === undefined) {
        return undefined;
    }
    return {
        create: script.create !== undefined ? script.create.map(convertScriptCreateRule) : [],
        delay: script.delay !== undefined ? script.delay : 0,
        receive: convertResources(script.receive),
        selfsac: script.selfsac === true,
    };
}

function convertScriptCreateRule(rule: ReplayBlueprintScriptCreateRule): ScriptCreateRule {
    return {
        unitName: rule[0],
        forOpponent: rule[1] === 'opponent',
        count: rule[2] !== undefined ? rule[2] : 1,
        buildTime: rule[3] !== undefined ? rule[3] : 1,
        customLifespan: rule[4],
    };
}

function convertResources(value: string | number | undefined): Resources {
    return parseResources(value === undefined ? '0' : String(value));
}

function renameScript(script: Script, renames: Map<string, string>): void {
    script.create.forEach(rule => {
        const newName = renames.get(rule.unitName);
        if (newName !== undefined) {
            rule.unitName = newName;
        }
    });
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
            const newRuleName = renames.get(rule.unitName);
            if (newRuleName !== undefined) {
                rule.unitName = newRuleName;
            }
        });
    }
    if (x.buySac !== undefined) {
        x.buySac.forEach(rule => {
            const newRuleName = renames.get(rule.unitName);
            if (newRuleName !== undefined) {
                rule.unitName = newRuleName;
            }
        });
    }
}
