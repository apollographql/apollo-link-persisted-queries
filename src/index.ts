import { ApolloLink, Observable, Operation } from 'apollo-link';
const sha256 = require('hash.js/lib/hash/sha/256');
import { print } from 'graphql/language/printer';
import {
  DefinitionNode,
  DocumentNode,
  ExecutionResult,
  GraphQLError,
} from 'graphql';

export const VERSION = 1;

export interface ErrorResponse {
  graphQLErrors?: GraphQLError[];
  networkError?: Error;
  response?: ExecutionResult;
  operation: Operation;
}

namespace PersistedQueryLink {
  export type Options = {
    generateHash?: (document: DocumentNode) => string;
    disable?: (error: ErrorResponse) => boolean;
    useGETForHashedQueries?: boolean;
  };
}

export const defaultGenerateHash = (query: DocumentNode): string =>
  sha256()
    .update(print(query))
    .digest('hex');

export const defaultOptions = {
  generateHash: defaultGenerateHash,
  disable: ({ graphQLErrors, operation }: ErrorResponse) => {
    // if the server doesn't support persisted queries, don't try anymore
    if (
      graphQLErrors &&
      graphQLErrors.some(
        ({ message }) => message === 'PersistedQueryNotSupported',
      )
    ) {
      return true;
    }

    const { response } = operation.getContext();
    // if the server responds with bad request
    // apollo-server responds with 400 for GET and 500 for POST when no query is found
    if (
      response &&
      response.status &&
      (response.status === 400 || response.status === 500)
    ) {
      return true;
    }

    return false;
  },
  useGETForHashedQueries: false,
};

function definitionIsMutation(d: DefinitionNode) {
  return d.kind === 'OperationDefinition' && d.operation === 'mutation';
}

// Note that this also returns true for subscriptions.
function operationIsQuery(operation: Operation) {
  return !operation.query.definitions.some(definitionIsMutation);
}

const { hasOwnProperty } = Object.prototype;
const hashesKeyString = '__createPersistedQueryLink_hashes';
const hashesKey = typeof Symbol === 'function'
  ? Symbol.for(hashesKeyString)
  : hashesKeyString;
let nextHashesChildKey = 0;

export const createPersistedQueryLink = (
  options: PersistedQueryLink.Options = {},
) => {
  const { generateHash, disable, useGETForHashedQueries } = Object.assign(
    {},
    defaultOptions,
    options,
  );
  let supportsPersistedQueries = true;

  const hashesChildKey = 'forLink' + nextHashesChildKey++;
  function getQueryHash(query: DocumentNode): string {
    if (!query || typeof query !== "object") {
      // If the query is not an object, we won't be able to store its hash as
      // a property of query[hashesKey], so we let generateHash(query) decide
      // what to do with the bogus query.
      return generateHash(query);
    }
    if (!hasOwnProperty.call(query, hashesKey)) {
      Object.defineProperty(query, hashesKey, {
        value: Object.create(null),
        enumerable: false,
      });
    }
    const hashes = (query as any)[hashesKey];
    return hasOwnProperty.call(hashes, hashesChildKey)
      ? hashes[hashesChildKey]
      : hashes[hashesChildKey] = generateHash(query);
  }

  return new ApolloLink((operation, forward) => {
    if (!forward) {
      throw new Error(
        'PersistedQueryLink cannot be the last link in the chain.',
      );
    }

    const { query } = operation;

    let hashError: any;
    if (supportsPersistedQueries) {
      try {
        operation.extensions.persistedQuery = {
          version: VERSION,
          sha256Hash: getQueryHash(query),
        };
      } catch (e) {
        hashError = e;
      }
    }

    return new Observable(observer => {
      if (hashError) {
        observer.error(hashError);
        return;
      }

      let subscription: ZenObservable.Subscription;
      let retried = false;
      let originalFetchOptions: any;
      let setFetchOptions = false;
      const retry = (
        {
          response,
          networkError,
        }: { response?: ExecutionResult; networkError?: Error },
        cb: () => void,
      ) => {
        if (!retried && ((response && response.errors) || networkError)) {
          retried = true;

          const disablePayload = {
            response,
            networkError,
            operation,
            graphQLErrors: response ? response.errors : undefined,
          };
          // if the server doesn't support persisted queries, don't try anymore
          supportsPersistedQueries = !disable(disablePayload);

          // if its not found, we can try it again, otherwise just report the error
          if (
            (response &&
              response.errors &&
              response.errors.some(
                ({ message }) => message === 'PersistedQueryNotFound',
              )) ||
            !supportsPersistedQueries
          ) {
            // need to recall the link chain
            if (subscription) subscription.unsubscribe();
            // actually send the query this time
            operation.setContext({
              http: {
                includeQuery: true,
                includeExtensions: supportsPersistedQueries,
              },
            });
            if (setFetchOptions) {
              operation.setContext({ fetchOptions: originalFetchOptions });
            }
            subscription = forward(operation).subscribe(handler);

            return;
          }
        }
        cb();
      };
      const handler = {
        next: (response: ExecutionResult) => {
          retry({ response }, () => observer.next(response));
        },
        error: (networkError: Error) => {
          retry({ networkError }, () => observer.error(networkError));
        },
        complete: observer.complete.bind(observer),
      };

      // don't send the query the first time
      operation.setContext({
        http: {
          includeQuery: !supportsPersistedQueries,
          includeExtensions: supportsPersistedQueries,
        },
      });

      // If requested, set method to GET if there are no mutations. Remember the
      // original fetchOptions so we can restore them if we fall back to a
      // non-hashed request.
      if (
        useGETForHashedQueries &&
        supportsPersistedQueries &&
        operationIsQuery(operation)
      ) {
        operation.setContext(({ fetchOptions = {} }) => {
          originalFetchOptions = fetchOptions;
          return {
            fetchOptions: Object.assign({}, fetchOptions, { method: 'GET' }),
          };
        });
        setFetchOptions = true;
      }

      subscription = forward(operation).subscribe(handler);

      return () => {
        if (subscription) subscription.unsubscribe();
      };
    });
  });
};
