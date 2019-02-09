 // tslint:disable:no-null-keyword

import Ajv from 'ajv';

import {
    ReplayCommandInfo, ReplayData, ReplayPlayerRating, ReplayRatingInfo, ReplayVersionInfo,
} from './replayData.js';

import {
    convert as convert153, ReplayDeckInfo153, ReplayInitInfo153, ReplayPlayerInfo153, ReplayTimeInfo153,
} from './replayData153.js';
import schema from './schemas/ReplayData139.schema.json';

const ajv = new Ajv({ allErrors: true });
const validateSchema = ajv.compile(schema);

export interface ReplayServerVersion {
    versionInfo: {
        serverVersion: number;
        [name: string]: any;
    };
    [name: string]: any;
}

export interface ReplayData139 {
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
    ratingInfo: ReplayRatingInfo139;
    timeInfo: ReplayTimeInfo153;
    versionInfo: ReplayVersionInfo;
}

export interface ReplayRatingInfo139 {
    ratedGame?: boolean;

    finalRatings: [ReplayPlayerRating139 | null, ReplayPlayerRating139 | null];
    initialRatings: [ReplayPlayerRating139 | null, ReplayPlayerRating139 | null];
    ratingChanges: [[number, number] | number | null, [number, number] | number | null];
    scoreChanges?: [number | null, number | null];

    expChanges?: [number | null, number | null];
    starChanges?: [number | null, number | null];
}

export interface ReplayPlayerRating139 {
    dominionELO?: number;
    exp?: number;
    hStars?: number;
    score?: { [num: string]: number };
    shalevU?: number;
    shalevV?: number;
    winLast?: boolean;
    winLastLast?: boolean;
}

export function validate(data: any): data is ReplayData139 {
    return validateSchema(data) as boolean;
}

export function validationErrorText(): string {
    // return ajv.errorsText(validateSchema.errors);
    return JSON.stringify(validateSchema.errors, undefined, 2);
}

export function convert(data: ReplayData139): ReplayData {
    return convert153({
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
        deckInfo: data.deckInfo,
        initInfo: data.initInfo,
        logInfo: data.logInfo,
        playerInfo: data.playerInfo,
        ratingInfo: convertRatingInfo(data.ratingInfo),
        timeInfo: data.timeInfo,
        versionInfo: data.versionInfo,
    });
}

function convertRatingInfo(data: ReplayRatingInfo139): ReplayRatingInfo {
    return {
        ratedGame: data.ratedGame,

        finalRatings: [convertPlayerRating(data.finalRatings[0]), convertPlayerRating(data.finalRatings[1])],
        initialRatings: [convertPlayerRating(data.initialRatings[0]), convertPlayerRating(data.initialRatings[1])],
        ratingChanges: [Array.isArray(data.ratingChanges[0]) ? data.ratingChanges[0] : null,
            Array.isArray(data.ratingChanges[0]) ? data.ratingChanges[0] : null],
        scoreChanges: data.scoreChanges,

        expChanges: data.expChanges,
        starChanges: data.starChanges,
    };
}

function convertPlayerRating(data: ReplayPlayerRating139 | null): ReplayPlayerRating | null {
    if (data === null) {
        return null;
    }

    return {
        displayRating: 0, // FIXME
        dominionELO: data.dominionELO,
        exp: data.exp,
        hStars: data.hStars,
        score: data.score,
        shalevU: data.shalevU,
        shalevV: data.shalevV,
        tier: 0, // FIXME
        tierPercent: 0, // FIXME
        winLast: data.winLast,
        winLastLast: data.winLastLast,
    };
}
