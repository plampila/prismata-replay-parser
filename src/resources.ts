export interface Resources {
    gold: number;
    green: number;
    blue: number;
    red: number;
    energy: number;
    attack: number;
}

export function parseResources(resources: string): Resources { // TODO: more strict parsing
    function count(type: string): number {
        const m = resources.match(new RegExp(type, 'g'));
        return m !== null ? m.length : 0;
    }

    let gold = parseInt(resources, 10);
    if (!isFinite(gold)) {
        gold = 0;
    }

    return {
        gold,
        green: count('G'),
        blue: count('B'),
        red: count('C'),
        energy: count('H'),
        attack: count('A'),
    };
}
