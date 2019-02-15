export class NotImplementedError extends Error {
    constructor(feature: string) {
        super(`Feature not implemented: ${feature}`);
    }
}

export class InvalidStateError extends Error {
    public readonly data: any;

    constructor(message: string, data?: any) {
        super(`Invalid state: ${message}`);
        this.data = data;
    }
}

export class DataError extends Error {
    public readonly data: any;

    constructor(message: string, data?: any) {
        super(`Data error: ${message}`);
        this.data = data;
    }
}
