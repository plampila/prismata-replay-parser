import { DataError } from './customErrors';

export function deepClone(o: any) {
    if (o === undefined || o === null || typeof(o) !== 'object') {
        return o;
    }
    const temp = new o.constructor();
    Object.setPrototypeOf(temp, Object.getPrototypeOf(o));
    Object.keys(o).forEach(key => {
        temp[key] = module.exports.deepClone(o[key]);
    });
    return temp;
};

export function blocking(unit) {
    return (!unit.destroyed && !unit.sacrificed && !unit.delay && unit.defaultBlocking &&
        !unit.abilityUsed) === true;
}

export function purchasedThisTurn(unit) {
    if (unit.destroyed || !unit.purchased) {
        return false;
    }
    if (unit.buildTime === 0) {
        return unit.delay === undefined;
    }
    return unit.delay === unit.buildTime;
};

export function frozen(unit) {
    return !unit.destroyed && unit.disruption >= unit.toughness;
};

function validSnipeTarget(unit, condition) {
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

function validChillTarget(unit) {
    if (!blocking(unit)) {
        return false;
    }
    if (unit.assignedDamage === unit.toughness) {
        return false;
    }
    return true;
}

export function validTarget(unit, targetAction, condition) {
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
};

export function parseResources(resources) {
    function count(type) {
        return (resources.match(new RegExp(type, 'g')) || []).length;
    }

    // Pure gold might be given as a number instead of a string.
    if (typeof resources === 'number') {
        resources = new String(resources);
    }

    return {
        gold: parseInt(resources) || 0,
        green: count('G'),
        blue: count('B'),
        red: count('C'),
        energy: count('H'),
        attack: count('A'),
    };
};

export function targetingIsUseful(units, target) {
    switch (units[0].targetAction) {
    case 'disrupt':
        // Bug in the game: Should be taking existing freeze into account
        return !target.disruption && target.toughness <= units[0].targetAmount * units.length;
    case 'snipe':
        return true;
    default:
        throw new DataError('Unknown target action.', units[0].targetAction);
    }
};
