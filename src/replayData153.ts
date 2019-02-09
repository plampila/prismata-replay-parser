import {
    ReplayBlueprint, ReplayCommandInfo, ReplayData, ReplayDeckInfo, ReplayInitCards, ReplayInitInfo, ReplayPlayerInfo,
    ReplayRatingInfo, ReplayTimeInfo, ReplayVersionInfo,
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
    rawHash?: number;
    result: number;
    startTime: number;
    id?: number;

    chatInfo?: {};
    commandInfo: ReplayCommandInfo;
    deckInfo: ReplayDeckInfo153;
    initInfo: ReplayInitInfo153;
    logInfo?: any;
    playerInfo: ReplayPlayerInfo153;
    ratingInfo: ReplayRatingInfo;
    timeInfo: ReplayTimeInfo153;
    versionInfo: ReplayVersionInfo;
}

export interface ReplayDeckInfo153 {
    mergedDeck: [ReplayBlueprint];

    blackBase: string[];
    blackDominion: string[];
    blackDraft?: string[];

    whiteBase: string[];
    whiteDominion: string[];
    whiteDraft?: string[];

    skinInfo?: any;
}

export interface ReplayInitInfo153 {
    blackInitCards: ReplayInitCards;
    blackInitResources: string;

    whiteInitCards: ReplayInitCards;
    whiteInitResources: string;

    seed?: number;
}

export interface ReplayPlayerInfo153 {
    playerIDs: [number, number];
    numPlayers: 2;
    playerNames: [string, string];
    playerBots: [ReplayBotInfo153 | null, ReplayBotInfo153 | null];
}

export interface ReplayBotInfo153 {
    name?: string;
    difficulty?: string;
    version?: number;
    params?: {};
}

export interface ReplayTimeInfo153 {
    correspondence: boolean;
    graceCurrentTime?: number;
    gracePeriod?: number;
    turnNumber?: number;
    useClocks: boolean;

    blackInitialTime: number;
    whiteInitialTime: number;

    playerCurrentTimeBanks?: [number, number];
    playerCurrentTimes?: [number, number];
    playerIncrements: [number, number];
    playerInitialTimeBanks: [number, number];
    playerTimeBankDilutions: [number, number];
}

export function convert(data: ReplayData153): ReplayData {
    return {
        code: data.code,
        endCondition: data.endCondition,
        endTime: data.endTime,
        format: data.format,
        rawHash: data.rawHash,
        result: data.result,
        startTime: data.startTime,
        id: data.id,

        chatInfo: data.chatInfo,
        commandInfo: data.commandInfo,
        deckInfo: convertDeckInfo(data.deckInfo),
        initInfo: convertInitInfo(data.initInfo),
        logInfo: data.logInfo,
        playerInfo: convertPlayerInfo(data.playerInfo),
        ratingInfo: data.ratingInfo,
        timeInfo: convertTimeInfo(data.timeInfo),
        versionInfo: data.versionInfo,
    };
}

function convertDeckInfo(data: ReplayDeckInfo153): ReplayDeckInfo {
    return {
        base: [data.whiteBase, data.blackBase],
        draft: [data.whiteDraft !== undefined ? data.whiteDraft : [],
            data.blackDraft !== undefined ? data.blackDraft : []],
        mergedDeck: data.mergedDeck,
        randomizer: [data.whiteDominion, data.blackDominion],

        skinInfo: data.skinInfo,
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
        id: data.playerIDs[0],
        name: data.playerNames[0],
        displayName: data.playerNames[0],
    }, {
        bot: data.playerBots[1] !== null ? (data.playerBots[1].name || data.playerBots[1].difficulty) : undefined,
        id: data.playerIDs[1],
        name: data.playerNames[1],
        displayName: data.playerNames[1],
    }];
}

function convertTimeInfo(data: ReplayTimeInfo153): ReplayTimeInfo {
    return {
        correspondence: data.correspondence,
        graceCurrentTime: data.graceCurrentTime,
        gracePeriod: data.gracePeriod,
        turnNumber: data.turnNumber,
        useClocks: data.useClocks,

        playerCurrentTimeBanks: data.playerCurrentTimeBanks,
        playerCurrentTimes: data.playerCurrentTimes,
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
