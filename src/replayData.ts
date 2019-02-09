import Ajv from 'ajv';

// typescript-json-schema --refs --aliasRefs --noExtraProps --required --strictNullChecks tsconfig.json <type>
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
    base: [ReplayDeckList, ReplayDeckList];
    deckName?: string;
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
    initCards: [ReplayInitCards, ReplayInitCards];
    initResources: [string, string];
    infiniteSupplies?: boolean;
    eventInfo?: any; // FIXME
}

export interface ReplayEventInfo {
    fullName: string;
    explanation: string;
    customTab1Hotkeys: any;
}

export type ReplayInitCards = Array<[number, string]>;

export interface ReplayPlayerInfo {
    displayName: string;
    name: string;
    loadingCompleted?: boolean;
    bot?: string;
    trophies?: Array<string | -1>;
    id?: number;
    percentLoaded?: number;
    avatarFrame?: string;
    portrait?: string;
    cosmetics?: { [unitName: string]: string };
}

export interface ReplayRatingInfo {
    finalRatings: [ReplayPlayerRating | null, ReplayPlayerRating | null];
    initialRatings: [ReplayPlayerRating | null, ReplayPlayerRating | null];
    ratingChanges: [[number, number] | null, [number, number] | null];
    scoreChanges: [number | null, number | null];

    expChanges?: [number | null, number | null];
    ratedGame?: boolean;
    starChanges?: [number | null, number | null];
}

export interface ReplayPlayerRating {
    botGamesPlayed?: number;
    casualGamesWon?: number;
    customGamesPlayed?: number;
    displayRating: number;
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
    playerCurrentTimeBanks?: [number, number];
    playerCurrentTimes?: [number, number];
    playerTime: [ReplayPlayerTime, ReplayPlayerTime];
    turnNumber?: number;
    useClocks: boolean;
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
