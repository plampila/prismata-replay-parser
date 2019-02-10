 // tslint:disable:no-null-keyword

import {
    ReplayCommandInfo, ReplayData, ReplayRatingInfo, ReplayVersionInfo,
} from './replayData.js';

import {
    convert as convert153, ReplayCommandInfoStrict153, ReplayDeckInfo153, ReplayDeckInfoStrict153, ReplayInitInfo153,
    ReplayInitInfoStrict153, ReplayPlayerInfo153, ReplayPlayerInfoStrict153, ReplayTimeInfo153, ReplayTimeInfoStrict153,
} from './replayData153.js';

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
    result: number;
    startTime: number;

    commandInfo: ReplayCommandInfo;
    deckInfo: ReplayDeckInfo153;
    initInfo: ReplayInitInfo153;
    playerInfo: ReplayPlayerInfo153;
    ratingInfo: ReplayRatingInfo139;
    timeInfo: ReplayTimeInfo153;
    versionInfo: ReplayVersionInfo;
}

export interface ReplayDataStrict139 extends ReplayData139 {
    rawHash: number;
    id: number;

    chatInfo: {};
    commandInfo: ReplayCommandInfoStrict153;
    deckInfo: ReplayDeckInfoStrict153;
    initInfo: ReplayInitInfoStrict153;
    logInfo: { [name: string]: any };
    playerInfo: ReplayPlayerInfoStrict153;
    ratingInfo: ReplayRatingInfoStrict139;
    timeInfo: ReplayTimeInfoStrict153;
    versionInfo: ReplayVersionInfoStrict139;
}

interface ReplayRatingInfo139 {
    finalRatings: [ReplayPlayerRating139 | null, ReplayPlayerRating139 | null];
    initialRatings: [ReplayPlayerRating139 | null, ReplayPlayerRating139 | null];
    ratingChanges: [[number, number] | number | null, [number, number] | number | null];
}

interface ReplayRatingInfoStrict139 extends ReplayRatingInfo139 {
    ratedGame: boolean;

    expChanges?: [number | null, number | null]; // serverVersion >= 57
    finalRatings: [ReplayPlayerRatingStrict139 | null, ReplayPlayerRatingStrict139 | null];
    initialRatings: [ReplayPlayerRatingStrict139 | null, ReplayPlayerRatingStrict139 | null];
    scoreChanges?: [number | null, number | null]; // serverVersion >= 57
    starChanges: [number | null, number | null];
}

// tslint:disable-next-line:no-empty-interface
export interface ReplayPlayerRating139 {
}

export interface ReplayPlayerRatingStrict139 extends ReplayPlayerRating139 {
    dominionELO: number;
    exp?: number; // optional
    hStars: number;
    score?: { [num: string]: number }; // optional
    shalevU?: number; // serverVersion >= 112
    shalevV?: number; // serverVersion >= 112
    winLast: boolean;
    winLastLast: boolean;
}

export interface ReplayVersionInfoStrict139 extends ReplayVersionInfo {
    playerVersions: [string, string]; // always empty strings if serverVersion >= 139
}

export function convert(data: ReplayData139): ReplayData {
    return convert153({
        code: data.code,
        endCondition: data.endCondition,
        endTime: data.endTime,
        format: data.format,
        result: data.result,
        startTime: data.startTime,

        commandInfo: data.commandInfo,
        deckInfo: data.deckInfo,
        initInfo: data.initInfo,
        playerInfo: data.playerInfo,
        ratingInfo: convertRatingInfo(data.ratingInfo),
        timeInfo: data.timeInfo,
        versionInfo: data.versionInfo,
    });
}

function convertRatingInfo(data: ReplayRatingInfo139): ReplayRatingInfo {
    return {
        finalRatings: [null, null],
        initialRatings: [null, null],
        ratingChanges: [Array.isArray(data.ratingChanges[0]) ? data.ratingChanges[0] : null,
            Array.isArray(data.ratingChanges[0]) ? data.ratingChanges[0] : null],
    };
}
