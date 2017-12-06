import { ApolloLink, Observable } from 'apollo-link';
const sha256 = require('hash.js/lib/hash/sha/256');
import { print } from 'graphql/language/printer';
import { DocumentNode, ExecutionResult } from 'graphql';

export const VERSION = 1;

namespace PersistedQueryLink {
  export type Options = {
    generateHash?: (DocumentNode) => string;
    disable?: (result: ExecutionResult, context: any) => boolean;
  };
}

export const defaultGenerateHash = query =>
  sha256()
    .update(print(query))
    .digest('hex');

export const defaultOptions = {
  generateHash: defaultGenerateHash,
  disable: ({ errors }, { response }) => {
    // if the server doesn't support persisted queries, don't try anymore
    if (
      errors.some(({ message }) => message === 'PersistedQueryNotSupported')
    ) {
      return true;
    }

    // if the server explodes from trying persisted queries
    if (response && response.statusCode && response.statusCode >= 500) {
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
      const handler = {
        next: ({ data, errors, ...rest }) => {
          if (!tried && errors) {
            // if the server doesn't support persisted queries, don't try anymore
            supportsPersistedQueries = !disable(
              { data, errors, ...rest },
              operation.getContext(),
            );

            tried = true;
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

          observer.next({ data, errors, ...rest });
        },
        error: observer.error.bind(observer),
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
