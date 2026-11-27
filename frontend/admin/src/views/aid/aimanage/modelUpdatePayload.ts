import type { Model } from './types.ts';

/**
 * Stable structural snapshot used only for edit dirty tracking.
 *
 * Object key order is irrelevant, while array order, missing keys, undefined and null stay distinct.
 * That lets an explicit field clear trigger a definition update without treating server/client key
 * serialization order as a real capability edit.
 */
export function modelEditSnapshot(value: unknown): string {
  const visit = (current: unknown): unknown => {
    if (current === undefined) return ['undefined'];
    if (current === null) return ['null'];
    if (Array.isArray(current)) return ['array', ...current.map(visit)];
    if (typeof current === 'object') {
      return ['object', ...Object.keys(current as Record<string, unknown>).sort()
        .map((key) => [key, visit((current as Record<string, unknown>)[key])])];
    }
    if (typeof current === 'number') {
      if (Number.isNaN(current)) return ['number', 'NaN'];
      if (!Number.isFinite(current)) return ['number', current > 0 ? 'Infinity' : '-Infinity'];
      if (Object.is(current, -0)) return ['number', '-0'];
    }
    return [typeof current, current];
  };
  return JSON.stringify(visit(value));
}

export function modelEditChanged(initialSnapshot: string, current: unknown): boolean {
  return initialSnapshot !== modelEditSnapshot(current);
}

const EDITABLE_UPDATE_FIELDS = [
  'modelName', 'realModelCode', 'logoUrl', 'remark',
  'status', 'priority', 'billingMultiplier', 'isFree', 'scheduleStrategyJson',
  'dedicatedConnectionEnabled', 'dedicatedBaseUrl', 'dedicatedApiKey'
] as const satisfies readonly (keyof Model)[];

export type ModelEditableBaseline = Record<(typeof EDITABLE_UPDATE_FIELDS)[number], string>;

const fieldSnapshot = (model: Partial<Model>, field: keyof Model): string => modelEditSnapshot([
  Object.prototype.hasOwnProperty.call(model, field), model[field]
]);

const partialUpdateValue = (complete: Model, field: keyof Model): unknown => {
  // The existing entity PUT treats a top-level null as "not supplied".  An empty JSON object is
  // the canonical persisted form for explicitly clearing the model-level scheduling override.
  if (field === 'scheduleStrategyJson' && complete[field] == null) return '{}';
  return complete[field];
};

/** Capture the values after load-time normalization, before the administrator starts editing. */
export function modelEditableBaseline(model: Partial<Model>): ModelEditableBaseline {
  return Object.fromEntries(EDITABLE_UPDATE_FIELDS.map((field) => [field, fieldSnapshot(model, field)])) as ModelEditableBaseline;
}

/**
 * Existing models use the server's partial PUT contract until a definition was actually edited.
 * In particular, an operational-only save must not replay normalized/legacy capabilities and
 * accidentally invoke definition replacement or historical-reference deletion guards.
 */
export function existingModelUpdatePayload(
  complete: Model,
  options: {
    capabilitiesChanged: boolean;
    businessBindingsChanged: boolean;
    editableBaseline: ModelEditableBaseline;
  }
): Model {
  if (options.capabilitiesChanged) {
    const result = { ...complete };
    if (options.editableBaseline.scheduleStrategyJson
        !== fieldSnapshot(complete, 'scheduleStrategyJson')) {
      result.scheduleStrategyJson = partialUpdateValue(
        complete, 'scheduleStrategyJson') as Model['scheduleStrategyJson'];
    }
    if (!options.businessBindingsChanged) delete result.businessBindings;
    return result;
  }

  const partial: Partial<Model> = {
    id: complete.id,
    modelCode: complete.modelCode,
    configVersion: complete.configVersion
  };
  for (const field of EDITABLE_UPDATE_FIELDS) {
    if (options.editableBaseline[field] !== fieldSnapshot(complete, field)) {
      (partial as Record<string, unknown>)[field] = partialUpdateValue(complete, field);
    }
  }
  if (options.businessBindingsChanged) partial.businessBindings = complete.businessBindings;
  return partial as Model;
}
