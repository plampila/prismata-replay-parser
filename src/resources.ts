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
        return (resources.match(new RegExp(type, 'g')) || []).length;
    }

    return {
        gold: parseInt(resources, 10) || 0,
        green: count('G'),
        blue: count('B'),
        red: count('C'),
        energy: count('H'),
        attack: count('A'),
    };
}
