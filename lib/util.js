const { DataError } = require('./customErrors');

module.exports.deepClone = function (o) {
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

function blocking(unit) {
    return (!unit.destroyed && !unit.sacrificed && !unit.delay && unit.defaultBlocking &&
        !unit.abilityUsed) === true;
}
module.exports.blocking = blocking;

module.exports.purchasedThisTurn = function (unit) {
    if (unit.destroyed || !unit.purchased) {
        return false;
    }
    if (unit.buildTime === 0) {
        return unit.delay === undefined;
    }
    return unit.delay === unit.buildTime;
};

module.exports.frozen = function (unit) {
    return !unit.destroyed && unit.disruption >= unit.toughness;
};

function validSnipeTarget(unit, condition) {
    if (unit.delay && unit.purchased) {
        return false;
    }
    if (unit.assignedAttack >= unit.toughness) {
        return false;
    }

    Object.keys(condition).forEach(key => {
        switch (key) {
        case 'isABC':
            if (!['Animus', 'Blastforge', 'Conduit'].includes(unit.name)) {
                return false;
            }
            break;
        case 'healthAtMost':
            if (unit.toughness - (unit.fragile ? unit.assignedAttack : 0) >
                    condition.healthAtMost) {
                return false;
            }
            break;
        case 'nameIn':
            if (!condition.nameIn.includes(unit.name)) {
                return false;
            }
            break;
        case 'isEngineerTempHack':
            if (unit.name !== 'Engineer') {
                return false;
            }
            break;
        default:
            throw new DataError('Unknown condition.', key);
        }
    });

    return true;
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

module.exports.validTarget = function (unit, targetAction, condition) {
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

module.exports.parseResources = function (resources) {
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

module.exports.targetingIsUseful = function (units, target) {
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
