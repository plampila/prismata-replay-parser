import Ajv from 'ajv';

import { ReplayData, ReplayServerVersion } from './replayData.js';
import { ReplayData139 } from './replayData139.js';
import { ReplayData153 } from './replayData153.js';

import dataSchema from './schemas/ReplayData.schema.json';
import data139Schema from './schemas/ReplayData139.schema.json';
import data153Schema from './schemas/ReplayData153.schema.json';
import dataStrictSchema from './schemas/ReplayDataStrict.schema.json';
import dataStrict139Schema from './schemas/ReplayDataStrict139.schema.json';
import dataStrict153Schema from './schemas/ReplayDataStrict153.schema.json';
import serverVersionSchema from './schemas/ReplayServerVersion.schema.json';

export class ReplayDataValidator {
    private readonly ajv: Ajv.Ajv;
    private readonly validateSchema: Ajv.ValidateFunction;
    private readonly validate139Schema: Ajv.ValidateFunction;
    private readonly validate153Schema: Ajv.ValidateFunction;
    private readonly validateServerVersionSchema: Ajv.ValidateFunction;

    private lastSchema?: Ajv.ValidateFunction;

    constructor(strict: boolean) {
        if (strict) {
            this.ajv = new Ajv();
            this.validateSchema = this.ajv.compile(dataStrictSchema);
            this.validate139Schema = this.ajv.compile(dataStrict139Schema);
            this.validate153Schema = this.ajv.compile(dataStrict153Schema);
            this.validateServerVersionSchema = this.ajv.compile(serverVersionSchema);
        } else {
            this.ajv = new Ajv({ removeAdditional: true });
            this.validateSchema = this.ajv.compile(dataSchema);
            this.validate139Schema = this.ajv.compile(data139Schema);
            this.validate153Schema = this.ajv.compile(data153Schema);
            this.validateServerVersionSchema = this.ajv.compile(serverVersionSchema);
        }
    }

    public isReplayServerVersion(data: any): data is ReplayServerVersion {
        this.lastSchema = this.validateServerVersionSchema;
        return this.lastSchema(data) as boolean;
    }

    public isReplayData(data: any): data is ReplayData {
        this.lastSchema = this.validateSchema;
        return this.lastSchema(data) as boolean;
    }

    public isReplayData139(data: any): data is ReplayData139 {
        this.lastSchema = this.validate139Schema;
        return this.lastSchema(data) as boolean;
    }

    public isReplayData153(data: any): data is ReplayData153 {
        this.lastSchema = this.validate153Schema;
        return this.lastSchema(data) as boolean;
    }

    public errorText(): string {
        // return this.ajv.errorsText(this.lastSchema ? this.lastSchema.errors : undefined);
        return this.lastSchema ? JSON.stringify(this.lastSchema.errors, undefined, 2) : 'nope';
    }
}
