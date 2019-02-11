import { DataError } from './customErrors';
import { Resources } from './gameState';
import { Unit } from './unit';

// tslint:disable:no-unsafe-any
export function deepClone<T>(o: any): T {
    if (o === undefined || o === null || typeof(o) !== 'object') {
        return o;
    }
    if (typeof o.clone === 'function') {
        return o.clone();
    }
    const temp = new o.constructor();
    Object.setPrototypeOf(temp, Object.getPrototypeOf(o));
    Object.keys(o).forEach(key => {
        temp[key] = module.exports.deepClone(o[key]);
    });
    return temp;
}
// tslint:enable:no-unsafe-any

export function parseResources(resources: string | number): Resources {
    function count(str: string, type: string): number {
        return (str.match(new RegExp(type, 'g')) || []).length;
    }

    // Pure gold might be given as a number instead of a string.
    let res = resources;
    if (typeof res === 'number') {
        res = String(resources);
    }

    return {
        gold: parseInt(res, 10) || 0,
        green: count(res, 'G'),
        blue: count(res, 'B'),
        red: count(res, 'C'),
        energy: count(res, 'H'),
        attack: count(res, 'A'),
    };
}

export function targetingIsUseful(units: Unit[], target: Unit): boolean {
    switch (units[0].targetAction) {
    case 'disrupt':
        if (units[0].targetAmount === undefined) {
            throw new DataError('Invalid targetAmount.', units[0]);
        }
        // Bug in the game: Should be taking existing freeze into account
        return !target.disruption && target.toughness <= units[0].targetAmount * units.length;
    case 'snipe':
        return true;
    default:
        throw new DataError('Unknown target action.', units[0].targetAction);
    }
}
