export interface ReplayServerVersion {
    versionInfo: {
        serverVersion: number;
        [name: string]: any;
    };
    [name: string]: any;
}

export interface ReplayData {
    code: string;
    endCondition: number;
    endTime: number;
    format: number;
    result: number;
    startTime: number;

    commandInfo: ReplayCommandInfo;
    deckInfo: ReplayDeckInfo;
    initInfo: ReplayInitInfo;
    playerInfo: [ReplayPlayerInfo, ReplayPlayerInfo];
    ratingInfo: ReplayRatingInfo;
    timeInfo: ReplayTimeInfo;
    versionInfo: ReplayVersionInfo;
}

export interface ReplayDataStrict extends ReplayData {
    rawHash: number;
    seed?: number; // serverVersion >= 379
    id?: number; // serverVersion <= 184

    chatInfo: {};
    commandInfo: ReplayCommandInfoStrict;
    deckInfo: ReplayDeckInfoStrict;
    initInfo: ReplayInitInfoStrict;
    logInfo: { [name: string]: any };
    playerInfo: [ReplayPlayerInfoStrict, ReplayPlayerInfoStrict];
    ratingInfo: ReplayRatingInfoStrict;
    timeInfo: ReplayTimeInfoStrict;
    versionInfo: ReplayVersionInfoStrict;
}

export interface ReplayCommandInfo {
    commandList: ReplayCommand[];
}

interface ReplayCommandInfoStrict extends ReplayCommandInfo {
    commandList: ReplayCommand[];
    clicksPerTurn: number[];
    commandForced?: boolean[]; // serverVersion >= 195
    commandTimes: number[];
    moveDurations: number[];
    timeBanksRemaining: number[];
    timesRemaining: number[];
}

export interface ReplayCommand {
    _type: string;
    _id: number;
    _params?: any;
}

export interface ReplayDeckInfo {
    base: [ReplayDeckList, ReplayDeckList];
    mergedDeck: [ReplayBlueprint];
    randomizer: [ReplayDeckList, ReplayDeckList];
}

interface ReplayDeckInfoStrict extends ReplayDeckInfo {
    deckName?: string; // serverVersion >= 215
    skinInfo?: any; // serverVersion <= 194

    draft: [ReplayDeckList, ReplayDeckList];
}

export type ReplayDeckList = Array<string | [string, number]>;

export interface ReplayBlueprint {
    name: string;
    [attribute: string]: any;
}

export interface ReplayInitInfo {
    infiniteSupplies?: boolean;

    initCards: [ReplayInitCards, ReplayInitCards];
    initResources: [string, string];
}

interface ReplayInitInfoStrict extends ReplayInitInfo {
    eventInfo?: any; // TODO serverVersion >= 228
}

export type ReplayInitCards = Array<[number, string]>;

export interface ReplayPlayerInfo {
    bot?: string;
    displayName: string;
    name: string;
}

interface ReplayPlayerInfoStrict extends ReplayPlayerInfo {
    avatarFrame?: string; // serverVersion >= 219
    cosmetics: { [unitName: string]: string };
    id: number;
    loadingCompleted?: boolean; // serverVersion >= 353
    percentLoaded?: number; // serverVersion >= 353
    portrait: string;
    trophies: Array<string | -1>; // TODO: investigate -1
}

export interface ReplayRatingInfo {
    finalRatings: [ReplayPlayerRating | null, ReplayPlayerRating | null];
    initialRatings: [ReplayPlayerRating | null, ReplayPlayerRating | null];
    ratingChanges: [[number, number] | null, [number, number] | null];
}

export interface ReplayRatingInfoStrict extends ReplayRatingInfo {
    ratedGame?: boolean; // serverVersion <= 343

    expChanges?: [number | null, number | null]; // serverVersion <= 343
    finalRatings: [ReplayPlayerRatingStrict | null, ReplayPlayerRatingStrict | null];
    initialRatings: [ReplayPlayerRatingStrict | null, ReplayPlayerRatingStrict | null];
    scoreChanges: [number | null, number | null];
    starChanges?: [number | null, number | null]; // serverVersion <= 343
}

export interface ReplayPlayerRating {
    displayRating?: number; // serverVersion > 153, optional 147-153
    tier: number;
    tierPercent: number;
}

export interface ReplayPlayerRatingStrict extends ReplayPlayerRating {
    botGamesPlayed: number;
    casualGamesWon?: number; // serverVersion >= 345, optional
    customGamesPlayed: number;
    dominionELO: number;
    exp?: number; // optional
    hStars?: number; // optional
    peakAdjustedShalevU?: number; // optional
    ratedGamesPlayed: number;
    score: { [num: string]: number };
    shalevU: number;
    shalevV: number;
    version?: 0; // optional
    winLast?: boolean; // optional after serverVersion >= 353
    winLastLast?: boolean; // optional after serverVersion >= 353
}

export interface ReplayTimeInfo {
    playerTime: [ReplayPlayerTime, ReplayPlayerTime];
}

export interface ReplayTimeInfoStrict extends ReplayTimeInfo {
    correspondence: false;
    graceCurrentTime: number;
    gracePeriod: number;
    turnNumber: number;
    useClocks: true;

    playerCurrentTimeBanks: [number, number];
    playerCurrentTimes: [number, number];
}

export interface ReplayPlayerTime {
    bank: number;
    bankDilution: number;
    increment: number;
    initial: number;
}

export interface ReplayVersionInfo {
    serverVersion: number;
}

export interface ReplayVersionInfoStrict extends ReplayVersionInfo {
    playerVersions: ['', ''];
}
