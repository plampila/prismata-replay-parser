# Prismata Replay Parser

Library to parse Prismata's replay files. Runs through the game based on the
commands given in the replay, allowing inspection of the game state at any
point.

Used by
[prismata-replay-info](https://github.com/plampila/prismata-replay-info) to
provide easy to parse replay info in JSON format.

## Status

Works on most replays. Some edge cases remain that aren't handled correctly
yet.

Fails on some old replays. Many of which aren't played back properly by the
client either.

## API

*Not stable yet.* Feedback is welcome.

ReplayParser is the main class. Initialized with the replay data (Buffer,
String or parsed JSON object).

Methods to get simple information from the JSON data:

* getCode
* getStartTime
* getEndTime
* getServerVersion
* getPlayerInfo
* getGameFormat
* getTimeControl
* getDeck
* getStartPosition
* getResult

These methods try to give the data in a simple format and handle old replays.

Calling the run method parses the actual game play commands. Events are thrown
by the ReplayParser and GameState classes. You can get the GameState from
ReplayParser using the state property.

ReplayParser events:

* initGame
* initGameDone
* command
* commandDone
* action
* actionDone
* undoSnapshot 

GameState events:

* turnStarted
* unitConstructed
* unitDestroyed
* autoAction
* assignAttackBlocker

Care has to be taken when using the events to collect data, as any action can
be canceled until the turn has been committed.
