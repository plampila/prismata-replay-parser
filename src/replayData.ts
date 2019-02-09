import Ajv from 'ajv';

import schema from './schemas/ReplayData.schema.json';
import serverVersionSchema from './schemas/ReplayServerVersion.schema.json';

const ajv = new Ajv({ allErrors: true }); // { removeAdditional: true }
const validateSchema = ajv.compile(schema);
const validateServerVersionSchema = ajv.compile(serverVersionSchema);

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
    rawHash?: number;
    result: number;
    seed?: number;
    startTime: number;

    chatInfo?: {};
    commandInfo: ReplayCommandInfo;
    deckInfo: ReplayDeckInfo;
    initInfo: ReplayInitInfo;
    logInfo?: any;
    playerInfo: [ReplayPlayerInfo, ReplayPlayerInfo];
    ratingInfo: ReplayRatingInfo;
    timeInfo: ReplayTimeInfo;
    versionInfo: ReplayVersionInfo;

    id?: number; // old replays
}

export interface ReplayCommandInfo {
    clicksPerTurn?: number[];
    commandForced?: boolean[];
    commandList: ReplayCommand[];
    commandTimes?: number[];
    moveDurations?: number[];
    timeBanksRemaining?: number[];
    timesRemaining?: number[];
}

export interface ReplayCommand {
    _type: string;
    _id: number;
    _params?: any;
}

export interface ReplayDeckInfo {
    deckName?: string;

    base: [ReplayDeckList, ReplayDeckList];
    draft: [ReplayDeckList, ReplayDeckList];
    mergedDeck: [ReplayBlueprint];
    randomizer: [ReplayDeckList, ReplayDeckList];

    skinInfo?: any; // old replays
}

export type ReplayDeckList = Array<string | [string, number]>;

export interface ReplayBlueprint {
    name: string;
    [attribute: string]: any;
}

export interface ReplayInitInfo {
    eventInfo?: any; // FIXME
    infiniteSupplies?: boolean;

    initCards: [ReplayInitCards, ReplayInitCards];
    initResources: [string, string];
}

export interface ReplayEventInfo {
    fullName: string;
    explanation: string;
    customTab1Hotkeys: any;
}

export type ReplayInitCards = Array<[number, string]>;

export interface ReplayPlayerInfo {
    avatarFrame?: string;
    bot?: string;
    cosmetics?: { [unitName: string]: string };
    displayName: string;
    id?: number;
    loadingCompleted?: boolean;
    name: string;
    percentLoaded?: number;
    portrait?: string;
    trophies?: Array<string | -1>;
}

export interface ReplayRatingInfo {
    ratedGame?: boolean;

    finalRatings: [ReplayPlayerRating | null, ReplayPlayerRating | null];
    initialRatings: [ReplayPlayerRating | null, ReplayPlayerRating | null];
    ratingChanges: [[number, number] | null, [number, number] | null];
    scoreChanges?: [number | null, number | null];

    expChanges?: [number | null, number | null];
    starChanges?: [number | null, number | null];
}

export interface ReplayPlayerRating {
    botGamesPlayed?: number;
    casualGamesWon?: number;
    customGamesPlayed?: number;
    displayRating?: number;
    dominionELO?: number;
    exp?: number;
    hStars?: number;
    peakAdjustedShalevU?: number;
    ratedGamesPlayed?: number;
    score?: { [num: string]: number };
    shalevU?: number;
    shalevV?: number;
    tier: number;
    tierPercent: number;
    version?: number;
    winLast?: boolean;
    winLastLast?: boolean;
}

export interface ReplayTimeInfo {
    correspondence: boolean;
    graceCurrentTime?: number;
    gracePeriod?: number;
    turnNumber?: number;
    useClocks: boolean;

    playerCurrentTimeBanks?: [number, number];
    playerCurrentTimes?: [number, number];
    playerTime: [ReplayPlayerTime, ReplayPlayerTime];
}

export interface ReplayPlayerTime {
    bank: number;
    bankDilution: number;
    increment: number;
    initial: number;
}

export interface ReplayVersionInfo {
    serverVersion: number;
    playerVersions?: [string, string];
}

export function validate(data: any): data is ReplayData {
    return validateSchema(data) as boolean;
}

export function validateServerVersion(data: any): data is ReplayServerVersion {
    return validateServerVersionSchema(data) as boolean;
}

export function validationErrorText(): string {
    // return ajv.errorsText(validateSchema.errors);
    return JSON.stringify(validateSchema.errors, undefined, 2);
}
