import { Ajv, type ValidateFunction } from 'ajv';
import schema from '../protocol/contracts.schema.json' with { type: 'json' };
export const contractAjv = new Ajv({ strict: true, strictRequired: false });
contractAjv.addSchema(schema, 'contracts.schema.json');
// Ajv caches a compiled schema by object identity, so a fresh `$ref` object per call would compile again every time
// and keep each copy. One validator per definition serves every caller.
const validators = new Map<string, ValidateFunction>();
export function contractValidator<T>(name: keyof typeof schema.definitions): ValidateFunction<T> {
  let validate = validators.get(name);
  if (!validate) validators.set(name, validate = contractAjv.compile({ $ref: `contracts.schema.json#/definitions/${name}` }));
  return validate as ValidateFunction<T>;
}
