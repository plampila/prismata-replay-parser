import Ajv from 'ajv';

import { ReplayData, ReplayServerVersion } from './replayData';
import { ReplayData146 } from './replayData146';
import { ReplayData153 } from './replayData153';

import dataSchema from './schemas/ReplayData.schema.json';
import data146Schema from './schemas/ReplayData146.schema.json';
import data153Schema from './schemas/ReplayData153.schema.json';
import dataStrictSchema from './schemas/ReplayDataStrict.schema.json';
import dataStrict146Schema from './schemas/ReplayDataStrict146.schema.json';
import dataStrict153Schema from './schemas/ReplayDataStrict153.schema.json';
import serverVersionSchema from './schemas/ReplayServerVersion.schema.json';

export class ReplayDataValidator {
    private readonly ajv: Ajv.Ajv;
    private readonly validateSchema: Ajv.ValidateFunction;
    private readonly validate146Schema: Ajv.ValidateFunction;
    private readonly validate153Schema: Ajv.ValidateFunction;
    private readonly validateServerVersionSchema: Ajv.ValidateFunction;

    private lastSchema?: Ajv.ValidateFunction;

    constructor(strict: boolean) {
        if (strict) {
            this.ajv = new Ajv({ extendRefs: 'fail' });
            this.validateSchema = this.ajv.compile(dataStrictSchema);
            this.validate146Schema = this.ajv.compile(dataStrict146Schema);
            this.validate153Schema = this.ajv.compile(dataStrict153Schema);
            this.validateServerVersionSchema = this.ajv.compile(serverVersionSchema);
        } else {
            this.ajv = new Ajv({ extendRefs: 'fail', removeAdditional: true });
            this.validateSchema = this.ajv.compile(dataSchema);
            this.validate146Schema = this.ajv.compile(data146Schema);
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

    public isReplayData146(data: any): data is ReplayData146 {
        this.lastSchema = this.validate146Schema;
        return this.lastSchema(data) as boolean;
    }

    public isReplayData153(data: any): data is ReplayData153 {
        this.lastSchema = this.validate153Schema;
        return this.lastSchema(data) as boolean;
    }

    public errorText(): string {
        return this.ajv.errorsText(this.lastSchema ? this.lastSchema.errors : undefined);
    }
}
