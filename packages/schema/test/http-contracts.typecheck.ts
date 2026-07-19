import { z } from 'zod';

import {
  undefinedResultSchema,
  type HttpContractDescriptor,
} from '@colorful-code/schema/commands';

type ExtendsHttpContract<Candidate> = Candidate extends HttpContractDescriptor
  ? true
  : false;
type ExpectFalse<Value extends false> = Value;
type ExpectTrue<Value extends true> = Value;

type ResultSchema = typeof undefinedResultSchema;
type IsExactlyUndefined<Value> = [Value] extends [undefined]
  ? [undefined] extends [Value]
    ? true
    : false
  : false;

type ValidQuery = {
  readonly method: 'GET';
  readonly path: '/test';
  readonly operationId: 'test.get';
  readonly resultSchema: ResultSchema;
  readonly responseKind: 'query';
};

type ValidMutation = {
  readonly method: 'POST';
  readonly path: '/test';
  readonly operationId: 'test.create';
  readonly bodySchema: ResultSchema;
  readonly resultSchema: ResultSchema;
  readonly responseKind: 'commandAck';
};

type QueryWithCommandAck = Omit<ValidQuery, 'responseKind'> & {
  readonly responseKind: 'commandAck';
};
type QueryWithBody = ValidQuery & { readonly bodySchema: ResultSchema };
type MutationWithQueryResponse = Omit<ValidMutation, 'responseKind'> & {
  readonly responseKind: 'query';
};
type MutationWithoutBody = Omit<ValidMutation, 'bodySchema'>;

export type ValidQueryContract = ExpectTrue<ExtendsHttpContract<ValidQuery>>;
export type UndefinedResultOutput = ExpectTrue<
  IsExactlyUndefined<z.output<ResultSchema>>
>;
export type ValidMutationContract = ExpectTrue<
  ExtendsHttpContract<ValidMutation>
>;
export type QueryCannotUseCommandAck = ExpectFalse<
  ExtendsHttpContract<QueryWithCommandAck>
>;
export type QueryCannotDeclareBody = ExpectFalse<
  ExtendsHttpContract<QueryWithBody>
>;
export type MutationCannotUseQueryResponse = ExpectFalse<
  ExtendsHttpContract<MutationWithQueryResponse>
>;
export type MutationRequiresBody = ExpectFalse<
  ExtendsHttpContract<MutationWithoutBody>
>;
