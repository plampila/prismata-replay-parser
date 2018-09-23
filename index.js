const constants = require('./lib/constants');
const util = require('./lib/util');
const GameState = require('./lib/gameState');
const ReplayParser = require('./lib/replayParser');
const { InvalidStateError, DataError, NotImplementedError } = require('./lib/customErrors');

module.exports.constants = constants;
module.exports.util = util;
module.exports.GameState = GameState;
module.exports.ReplayParser = ReplayParser;
module.exports.InvalidStateError = InvalidStateError;
module.exports.DataError = DataError;
module.exports.NotImplementedError = NotImplementedError;
