import Ajv from 'ajv';

import { ReplayData, ReplayServerVersion } from './replayData.js';
import { ReplayData139 } from './replayData139.js';
import { ReplayData153 } from './replayData153.js';

import dataSchema from './schemas/ReplayData.schema.json';
import data139Schema from './schemas/ReplayData139.schema.json';
import data153Schema from './schemas/ReplayData153.schema.json';
import serverVersionSchema from './schemas/ReplayServerVersion.schema.json';

const ajv = new Ajv();

const validateSchema = ajv.compile(dataSchema);
const validate139Schema = ajv.compile(data139Schema);
const validate153Schema = ajv.compile(data153Schema);
const validateServerVersionSchema = ajv.compile(serverVersionSchema);

export function validateServerVersion(data: any): data is ReplayServerVersion {
    return validateServerVersionSchema(data) as boolean;
}

export function validate(data: any): data is ReplayData {
    return validateSchema(data) as boolean;
}

export function validate139(data: any): data is ReplayData139 {
    return validate139Schema(data) as boolean;
}

export function validate153(data: any): data is ReplayData153 {
    return validate153Schema(data) as boolean;
}

export function validationErrorText(): string {
    return ajv.errorsText(validateSchema.errors);
}
