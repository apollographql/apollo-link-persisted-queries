import { ApolloLink, Observable, Operation } from 'apollo-link';
const sha256 = require('hash.js/lib/hash/sha/256');
import { print } from 'graphql/language/printer';
import { DocumentNode, ExecutionResult, GraphQLError } from 'graphql';

export const VERSION = 1;

export interface ErrorResponse {
  graphQLErrors?: GraphQLError[];
  networkError?: Error;
  response?: ExecutionResult;
  operation: Operation;
}

namespace PersistedQueryLink {
  export type Options = {
    generateHash?: (DocumentNode) => string;
    disable?: (error: ErrorResponse) => boolean;
  };
}

export const defaultGenerateHash = query =>
  sha256()
    .update(print(query))
    .digest('hex');

export const defaultOptions = {
  generateHash: defaultGenerateHash,
  disable: ({ graphQLErrors, operation }) => {
    // if the server doesn't support persisted queries, don't try anymore
    if (
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
      response.statusCode &&
      (response.statusCode === 400 || response.statusCode === 500)
    ) {
      return true;
    }

    return false;
  },
};

export const createPersistedQueryLink = (
  { generateHash, disable }: PersistedQueryLink.Options = defaultOptions,
) => {
  let supportsPersistedQueries = true;

  const calculated: Map<DocumentNode, string> = new Map();
  return new ApolloLink((operation, forward) => {
    const { query } = operation;

    let hashError;
    if (supportsPersistedQueries) {
      let hash = calculated.get(query);
      if (!hash) {
        try {
          hash = generateHash(query);
          calculated.set(query, hash);
        } catch (e) {
          hashError = e;
        }
      }

      operation.extensions.persistedQuery = {
        version: VERSION,
        sha256Hash: hash,
      };
    }

    return new Observable(observer => {
      if (hashError) {
        observer.error(hashError);
        return;
      }

      let subscription: ZenObservable.Subscription;
      let tried = false;
      const retry = (
        {
          response,
          networkError,
        }: { response?: ExecutionResult; networkError?: Error },
        cb,
      ) => {
        if ((!tried && (response && response.errors)) || networkError) {
          tried = true;

          const disablePayload = {
            response,
            networkError,
            operation,
            graphQLErrors: response ? response.errors : null,
          };
          // if the server doesn't support persisted queries, don't try anymore
          supportsPersistedQueries = !disable(disablePayload);

          // if its not found, we can try it again, otherwise just report the error
          if (
            response.errors.some(
              ({ message }) => message === 'PersistedQueryNotFound',
            ) ||
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
            subscription = forward(operation).subscribe(handler);

            return;
          }
        }
        cb();
      };
      const handler = {
        next: response => {
          retry({ response }, () => observer.next(response));
        },
        error: networkError => {
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
      subscription = forward(operation).subscribe(handler);

      return () => {
        if (subscription) subscription.unsubscribe();
      };
    });
  });
};
