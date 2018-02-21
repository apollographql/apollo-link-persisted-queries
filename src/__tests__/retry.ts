import gql from 'graphql-tag';
import { execute, ApolloLink, Observable, FetchResult } from 'apollo-link';
import waitFor from 'wait-for-observables';
import { RetryLink } from 'apollo-link-retry';
import { createHttpLink } from 'apollo-link-http';

import { createPersistedQueryLink } from '../';

export const query = gql`
  query Test($id: ID!) {
    foo(id: $id) {
      bar
    }
  }
`;

export const variables = { id: 1 };
const standardError = new Error('I never work');

export const data = {
  foo: { bar: true },
};
export const response = JSON.stringify({ data });
const errors = [{ message: 'PersistedQueryNotFound' }];
const giveUpErrors = [{ message: 'PersistedQueryNotSupported' }];
const multipleErrors = [...errors, { message: 'not logged in' }];
const errorResponse = JSON.stringify({ errors });
const giveUpResponse = JSON.stringify({ errors: giveUpErrors });
const multiResponse = JSON.stringify({ errors: multipleErrors });

const fromError = (errorValue: any) => {
  return new Observable(observer => {
    observer.error(errorValue);
  });
};

describe('RetryLink', () => {
  beforeEach(fetch.mockReset);
  it('correctly allows retry link integration', done => {
    fetch.mockResponseOnce(errorResponse);
    fetch.mockResponseOnce(response);

    let count = 0;
    const fetcher = (...args) => {
      count++;
      const [_, payload] = args;
      const body = JSON.parse(payload.body);
      // on the first fetch, we return not found
      if (count === 1) expect(body.query).toBeUndefined();
      // on the second, a critical error (retried from persisted query with query in payload)
      if (count === 2) {
        expect(body.query).toBeDefined();
        return Promise.reject(new Error('server error'));
      }
      // on the third (retried with query in the payload), we return good data
      if (count === 3) expect(body.query).toBeDefined();
      if (count > 3) done.fail('fetch called too many times');
      return fetch(...args);
    };

    const retry = new RetryLink();
    const persist = createPersistedQueryLink();
    const http = createHttpLink({ fetch: fetcher });

    const link = ApolloLink.from([persist, retry, http]);

    execute(link, { query, variables }).subscribe(result => {
      expect(result.data).toEqual(data);
      expect(count).toEqual(3);
      done();
    }, done.fail);
  });
});
