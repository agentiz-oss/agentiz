import {
    Adminizer,
    DataAccessor,
    ModelResource,
    User,
} from '@nodeknit/app-adminizer';
import * as adminizerApi from '@nodeknit/app-adminizer';

/**
 * The three helpers below landed in adminizer 5.0.0-build.12; `local_modules/app-adminizer` pins
 * build.7, which exports none of them — they are `undefined` at runtime, not just missing from the
 * declarations. Reaching for them through the namespace keeps this file compiling against either
 * build, and the guard in `buildAgentizAgentSkills` is what keeps the older one working: a skill
 * registered there would throw `listModelResources is not a function` the first time somebody asked
 * the assistant to create a record.
 */
const listModelResources = (adminizerApi as any).listModelResources as
    ((adminizer: Adminizer) => ModelResource[]) | undefined;
const resolveModelResource = (adminizerApi as any).resolveModelResource as
    ((adminizer: Adminizer, name: string) => ModelResource | undefined) | undefined;
const toJsonSafe = (adminizerApi as any).toJsonSafe as ((value: unknown) => any) | undefined;

/** Whether this adminizer build ships the data-skill helpers this file builds on. */
export function agentSkillsSupported(): boolean {
    return !!listModelResources && !!resolveModelResource && !!toJsonSafe;
}

/**
 * App-owned assistant skills.
 *
 * Adminizer 5.0.0-build.12 ships read/update data skills (`read_model_records`,
 * `update_model_record`) through `AiAssistantAgentSkillHandler` but no way to create a record.
 * This adds the missing half through the same handler: permissions are re-checked per call, the
 * model list the agent sees is an enum of exactly what this user may create, and the write goes
 * through a DataAccessor, so fields the user may not set are dropped instead of trusted. Mirrors
 * restoapp's lib/ai/agentSkills.ts — delete this once a build carrying create_model_record in
 * adminizer's own builtinAgentSkills lands (see AppAgentiz.mount()'s registration try/catch).
 */

/** Names of the model resources this user may create records in. */
function creatableModels(adminizer: Adminizer, user: User): string[] {
    return listModelResources!(adminizer)
        .filter((resource) => adminizer.accessRightsHelper.hasPermission(`create-${resource.name}-model`, user))
        .map((resource) => resource.name);
}

/** Resolves a model this user may create in; anything else is simply not reachable. */
function requireCreatableModel(adminizer: Adminizer, user: User, name: string) {
    const resource = resolveModelResource!(adminizer, name);
    if (!resource?.model) throw new Error(`Model "${name}" is not available.`);
    if (!adminizer.accessRightsHelper.hasPermission(`create-${resource.name}-model`, user)) {
        throw new Error(`You are not allowed to create records in the "${resource.name}" model.`);
    }
    return resource;
}

/** Adds an `enum` of permitted models, so the agent cannot invent a model name. */
function withModelEnum(schema: Record<string, any>, models: string[]): Record<string, any> {
    const properties = { ...schema.properties };
    properties.model = { ...properties.model, enum: models };
    return { ...schema, properties };
}

export function buildAgentizAgentSkills(adminizer: Adminizer): any[] {
    if (!agentSkillsSupported()) {
        console.warn('[AppAgentiz] create_model_record needs adminizer >= 5.0.0-build.12; skipping it on this build');
        return [];
    }
    const createRecord: any = {
        id: 'create_model_record',
        description: 'Create one record in a data model the current user may add to.',
        inputSchema: {
            type: 'object',
            properties: {
                model: { type: 'string', description: 'Model name as returned by list_data_models.' },
                values: {
                    type: 'object',
                    description: 'Field values of the new record, e.g. {"name": "Test project"}.'
                        + ' Use list_data_models to see the fields; ones this user may not set are dropped.',
                    additionalProperties: true,
                },
            },
            required: ['model', 'values'],
            additionalProperties: false,
        },
        requiresUser: true,
        describe: (user: User) => {
            const models = creatableModels(adminizer, user);
            return {
                description: `Create one record in a data model the current user may add to. Creatable models: ${models.join(', ') || 'none'}.`,
                inputSchema: withModelEnum(createRecord.inputSchema, models),
            };
        },
        execute: async (input: Record<string, any>, { user }: { user: User }) => {
            const resource = requireCreatableModel(adminizer, user, String(input.model ?? ''));
            const values = input.values && typeof input.values === 'object' && !Array.isArray(input.values)
                ? input.values
                : null;
            if (!values || !Object.keys(values).length) {
                throw new Error('values must be a non-empty object of field values');
            }
            const accessor = new DataAccessor(adminizer, user, resource, 'add');
            const record = await resource.model.create(values as any, accessor);
            return toJsonSafe!({ model: resource.name, record });
        },
    };

    return [createRecord];
}
