class NotImplementedError extends Error {
    constructor(feature) {
        super(feature ? `Feature not implemented: ${feature}` : 'Not implemented.');
    }
}

class InvalidStateError extends Error {
    constructor(message, data) {
        super(`Invalid state: ${message}`);
        this.data = data;
    }
}

class DataError extends Error {
    constructor(message, data) {
        super(`Data error: ${message}`);
        this.data = data;
    }
}

module.exports.NotImplementedError = NotImplementedError;
module.exports.InvalidStateError = InvalidStateError;
module.exports.DataError = DataError;
