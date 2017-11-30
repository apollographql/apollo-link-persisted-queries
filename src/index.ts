import { ApolloLink, Observable } from 'apollo-link';
const sha256 = require('hash.js/lib/hash/sha/256');
import { print } from 'graphql/language/printer';
import { DocumentNode } from 'graphql';

export const VERSION = 1;

export type Options = {
  generateHash?: (DocumentNode) => string;
};

export const defaultGenerateHash = query =>
  sha256()
    .update(print(query))
    .digest('hex');

export const defaultOptions = {
  generateHash: defaultGenerateHash,
};

export const createPersistedQueryLink = (
  { generateHash }: Options = defaultOptions,
) => {
  let doesNotSupportPersistedQueries = false;

  const calculated: Map<DocumentNode, string> = new Map();
  return new ApolloLink((operation, forward) => {
    const { query } = operation;

    let hashError;
    if (!doesNotSupportPersistedQueries) {
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

      let subscription;
      let tried;
      const handler = {
        next: ({ data, errors, ...rest }) => {
          if (
            !tried &&
            errors &&
            errors.some(
              ({ message }) => message.indexOf('PersistedQueryNot') > -1,
            )
          ) {
            // if the server doesn't support persisted queries, don't try anymore
            if (
              errors.some(
                ({ message }) => message === 'PersistedQueryNotSupported',
              )
            ) {
              doesNotSupportPersistedQueries = true;
            }

            tried = true;
            // need to recall the link chain
            if (subscription) subscription.unsubscribe();
            // actually send the query this time
            operation.setContext({
              http: {
                includeQuery: true,
                includeExtensions: !doesNotSupportPersistedQueries,
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
          includeQuery: doesNotSupportPersistedQueries,
          includeExtensions: !doesNotSupportPersistedQueries,
        },
      });
      subscription = forward(operation).subscribe(handler);

      return () => {
        if (subscription) subscription.unsubscribe();
      };
    });
  });
};
