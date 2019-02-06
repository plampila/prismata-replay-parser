import { DataError } from './customErrors';
import { IResources, Unit } from './gameState';

export function deepClone<T>(o: any): T {
    if (o === undefined || o === null || typeof(o) !== 'object') {
        return o;
    }
    const temp = new o.constructor();
    Object.setPrototypeOf(temp, Object.getPrototypeOf(o));
    Object.keys(o).forEach(key => {
        temp[key] = module.exports.deepClone(o[key]);
    });
    return temp;
}

export function blocking(unit: Unit): boolean {
    return (!unit.destroyed && !unit.sacrificed && !unit.delay && unit.defaultBlocking &&
        !unit.abilityUsed) === true;
}

export function purchasedThisTurn(unit: Unit): boolean {
    if (unit.destroyed || !unit.purchased) {
        return false;
    }
    if (unit.buildTime === 0) {
        return unit.delay === undefined;
    }
    return unit.delay === unit.buildTime;
}

export function frozen(unit: Unit): boolean {
    return !unit.destroyed && unit.disruption >= unit.toughness;
}

function validSnipeTarget(unit: Unit, condition: any): boolean {
    if (unit.delay && unit.purchased) {
        return false;
    }
    if (unit.assignedAttack >= unit.toughness) {
        return false;
    }

    return !Object.keys(condition).some(key => {
        switch (key) {
        case 'isABC':
            if (!['Animus', 'Blastforge', 'Conduit'].includes(unit.name)) {
                return true;
            }
            return false;
        case 'healthAtMost':
            if (unit.toughness - (unit.fragile ? unit.assignedAttack : 0) >
                    condition.healthAtMost) {
                return true;
            }
            return false;
        case 'nameIn':
            if (!condition.nameIn.includes(unit.name)) {
                return true;
            }
            return false;
        case 'isEngineerTempHack':
            if (unit.name !== 'Engineer') {
                return true;
            }
            return false;
        default:
            throw new DataError('Unknown condition.', key);
        }
    });
}

function validChillTarget(unit: Unit): boolean {
    if (!blocking(unit)) {
        return false;
    }
    if (unit.assignedDamage === unit.toughness) {
        return false;
    }
    return true;
}

export function validTarget(unit: Unit, targetAction: string, condition: any): boolean {
    switch (targetAction) {
    case 'disrupt':
        return validChillTarget(unit);
    case 'snipe':
        if (!condition) {
            throw new DataError('No snipe condition given.', targetAction);
        }
        return validSnipeTarget(unit, condition);
    default:
        throw new DataError('Unknown target action.', targetAction);
    }
}

export function parseResources(resources: string | number): IResources {
    function count(str: string, type: string): number {
        return (str.match(new RegExp(type, 'g')) || []).length;
    }

    // Pure gold might be given as a number instead of a string.
    if (typeof resources === 'number') {
        resources = String(resources);
    }

    return {
        gold: parseInt(resources, 10) || 0,
        green: count(resources, 'G'),
        blue: count(resources, 'B'),
        red: count(resources, 'C'),
        energy: count(resources, 'H'),
        attack: count(resources, 'A'),
    };
}

export function targetingIsUseful(units: Unit[], target: Unit): boolean {
    switch (units[0].targetAction) {
    case 'disrupt':
        // Bug in the game: Should be taking existing freeze into account
        return !target.disruption && target.toughness <= units[0].targetAmount * units.length;
    case 'snipe':
        return true;
    default:
        throw new DataError('Unknown target action.', units[0].targetAction);
    }
}
