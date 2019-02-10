import {
    ReplayBlueprint, ReplayCommandInfo, ReplayData, ReplayDeckInfo, ReplayInitCards, ReplayInitInfo, ReplayPlayerInfo,
    ReplayRatingInfo, ReplayRatingInfoStrict, ReplayTimeInfo, ReplayVersionInfo, ReplayVersionInfoStrict,
} from './replayData.js';

export interface ReplayServerVersion {
    versionInfo: {
        serverVersion: number;
        [name: string]: any;
    };
    [name: string]: any;
}

export interface ReplayData153 {
    code: string;
    endCondition: number;
    endTime: number;
    format: number;
    result: number;
    startTime: number;

    commandInfo: ReplayCommandInfo;
    deckInfo: ReplayDeckInfo153;
    initInfo: ReplayInitInfo153;
    playerInfo: ReplayPlayerInfo153;
    ratingInfo: ReplayRatingInfo;
    timeInfo: ReplayTimeInfo153;
    versionInfo: ReplayVersionInfo;
}

export interface ReplayDataStrict153 extends ReplayData153 {
    rawHash: number;
    id: number;

    chatInfo: {};
    commandInfo: ReplayCommandInfoStrict153;
    deckInfo: ReplayDeckInfoStrict153;
    initInfo: ReplayInitInfoStrict153;
    logInfo: { [name: string]: any };
    playerInfo: ReplayPlayerInfoStrict153;
    ratingInfo: ReplayRatingInfoStrict;
    timeInfo: ReplayTimeInfoStrict153;
    versionInfo: ReplayVersionInfoStrict;
}

export interface ReplayCommandInfoStrict153 extends ReplayCommandInfo {
    clicksPerTurn: number[];
    commandTimes: number[];
    moveDurations: number[];
    timeBanksRemaining: number[];
    timesRemaining: number[];
}

export interface ReplayDeckInfo153 {
    mergedDeck: [ReplayBlueprint];

    blackBase: string[];
    blackDominion: string[];

    whiteBase: string[];
    whiteDominion: string[];
}

export interface ReplayDeckInfoStrict153 extends ReplayDeckInfo153 {
    blackDraft?: string[]; // optional
    whiteDraft?: string[]; // optional
    skinInfo: { [name: string]: any }; // TODO
}

export interface ReplayInitInfo153 {
    blackInitCards: ReplayInitCards;
    blackInitResources: string;

    whiteInitCards: ReplayInitCards;
    whiteInitResources: string;
}

export interface ReplayInitInfoStrict153 extends ReplayInitInfo153 {
    seed: number;
}

export interface ReplayPlayerInfo153 {
    playerIDs: [number, number];
    playerNames: [string, string];
    playerBots: [ReplayBotInfo153 | null, ReplayBotInfo153 | null];
}

export interface ReplayPlayerInfoStrict153 extends ReplayPlayerInfo153 {
    numPlayers: 2;
    playerBots: [ReplayBotInfoStrict153 | null, ReplayBotInfoStrict153 | null];
}

export interface ReplayBotInfo153 {
    name?: string;
    difficulty?: string;
}

export interface ReplayBotInfoStrict153 extends ReplayBotInfo153 {
    version?: number;
    params?: {};
}

export interface ReplayTimeInfo153 {
    blackInitialTime: number;
    whiteInitialTime: number;

    playerIncrements: [number, number];
    playerInitialTimeBanks: [number, number];
    playerTimeBankDilutions: [number, number];
}

export interface ReplayTimeInfoStrict153 extends ReplayTimeInfo153 {
    correspondence: false;
    graceCurrentTime: number;
    gracePeriod: number;
    turnNumber: number;
    useClocks: true;

    playerCurrentTimeBanks: [number, number];
    playerCurrentTimes: [number, number];
}

export function convert(data: ReplayData153): ReplayData {
    return {
        code: data.code,
        endCondition: data.endCondition,
        endTime: data.endTime,
        format: data.format,
        result: data.result,
        startTime: data.startTime,

        commandInfo: data.commandInfo,
        deckInfo: convertDeckInfo(data.deckInfo),
        initInfo: convertInitInfo(data.initInfo),
        playerInfo: convertPlayerInfo(data.playerInfo),
        ratingInfo: data.ratingInfo,
        timeInfo: convertTimeInfo(data.timeInfo),
        versionInfo: data.versionInfo,
    };
}

function convertDeckInfo(data: ReplayDeckInfo153): ReplayDeckInfo {
    return {
        base: [data.whiteBase, data.blackBase],
        mergedDeck: data.mergedDeck,
        randomizer: [data.whiteDominion, data.blackDominion],
    };
}

function convertInitInfo(data: ReplayInitInfo153): ReplayInitInfo {
    return {
        initCards: [data.whiteInitCards, data.blackInitCards],
        initResources: [data.whiteInitResources, data.blackInitResources],
    };
}

function convertPlayerInfo(data: ReplayPlayerInfo153): [ReplayPlayerInfo, ReplayPlayerInfo] {
    return [{
        bot: data.playerBots[0] !== null ? (data.playerBots[0].name || data.playerBots[0].difficulty) : undefined,
        name: data.playerNames[0],
        displayName: data.playerNames[0],
    }, {
        bot: data.playerBots[1] !== null ? (data.playerBots[1].name || data.playerBots[1].difficulty) : undefined,
        name: data.playerNames[1],
        displayName: data.playerNames[1],
    }];
}

function convertTimeInfo(data: ReplayTimeInfo153): ReplayTimeInfo {
    return {
        playerTime: [{
            bank: data.playerInitialTimeBanks[0],
            bankDilution: data.playerTimeBankDilutions[0],
            increment: data.playerIncrements[0],
            initial: data.playerInitialTimeBanks[0],
        }, {
            bank: data.playerInitialTimeBanks[1],
            bankDilution: data.playerTimeBankDilutions[1],
            increment: data.playerIncrements[1],
            initial: data.playerInitialTimeBanks[1],
        }],
    };
}
