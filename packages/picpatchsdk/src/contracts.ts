import { Ajv, type ValidateFunction } from 'ajv';
import schema from '../protocol/contracts.schema.json' with { type: 'json' };
export const contractAjv = new Ajv({ strict: true, strictRequired: false });
contractAjv.addSchema(schema, 'contracts.schema.json');
export function contractValidator<T>(name: keyof typeof schema.definitions): ValidateFunction<T> {
  return contractAjv.compile<T>({ $ref: `contracts.schema.json#/definitions/${name}` });
}
