import gql from 'graphql-tag';
import { ApolloLink, execute, Observable } from 'apollo-link';
import { createHash } from 'crypto';
import { print, parse } from 'graphql';
import { createHttpLink } from 'apollo-link-http';
import { cloneDeep, find, times } from 'lodash';

import { createPersistedQueryLink as createPersistedQuery, VERSION } from '../';

const makeAliasFields = (fieldName, numAliases) =>
  times(numAliases, idx => `${fieldName}${idx}: ${fieldName}`).reduce(
    (aliasBody, currentAlias) => `${aliasBody}\n    ${currentAlias}`,
  );

const sleep = ms => new Promise(s => setTimeout(s, ms));

const serverSideSha256 = text =>
  createHash('sha256')
    .update(text)
    .digest('hex');

export const query = gql`
  query Test($id: ID!) {
    foo(id: $id) {
      bar
      ${makeAliasFields('title', 1000)}
    }
  }
`;

export const shortQuery = gql`
  query Test($id: ID!) {
    foo(id: $id) {
      bar
    }
  }
`;

export const queryWithUtf8Chars = gql`
  query Test($id: ID!) {
    foo(
      id: $id
      twoByteChars: "привет"
      threeByteChars: "您好"
      fourByteChars: "👋🙌"
    ) {
      bar
    }
  }
`;

export const variables = { id: 1 };
export const queryString = print(query);
export const hash = serverSideSha256(queryString);

export const shortQueryString = print(shortQuery);
export const shortHash = serverSideSha256(queryString);

export const queryWithUtf8CharsString = print(queryWithUtf8Chars);
export const queryWithUtf8CharsHash = serverSideSha256(
  queryWithUtf8CharsString,
);

// support buildtime hash generation
query.documentId = hash;
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

const mockObserver = jest.fn(observer => {
  setTimeout(() => {
    observer.next({ data });
    observer.complete();
  }, 10);
});
const mockApolloLink = new ApolloLink(() => new Observable(mockObserver));

const mockErrorObserver = jest.fn(observer => {
  setTimeout(() => {
    observer.error(new Error('something went wrong!'));
  }, 10);
});
const mockErroredLink = new ApolloLink(() => new Observable(mockErrorObserver));

describe('happy path', () => {
  beforeEach(fetch.mockReset);
  it('sends a sha256 hash of the query under extensions', done => {
    fetch.mockResponseOnce(response);
    const link = createPersistedQuery().concat(createHttpLink());

    execute(link, { query, variables }).subscribe(result => {
      expect(result.data).toEqual(data);
      const [uri, request] = fetch.mock.calls[0];
      expect(uri).toEqual('/graphql');
      expect(request.body).toBe(
        JSON.stringify({
          operationName: 'Test',
          variables,
          extensions: {
            persistedQuery: {
              version: VERSION,
              sha256Hash: hash,
            },
          },
        }),
      );
      done();
    }, done.fail);
  });
  it('sends a version along with the request', done => {
    fetch.mockResponseOnce(response);
    const link = createPersistedQuery().concat(createHttpLink());

    execute(link, { query, variables }).subscribe(result => {
      expect(result.data).toEqual(data);
      const [uri, request] = fetch.mock.calls[0];
      expect(uri).toEqual('/graphql');
      const parsed = JSON.parse(request.body);
      expect(parsed.extensions.persistedQuery.version).toBe(VERSION);
      done();
    }, done.fail);
  });
  it('memoizes between requests', done => {
    fetch.mockResponseOnce(response);
    fetch.mockResponseOnce(response);
    const link = createPersistedQuery().concat(createHttpLink());

    let start = new Date();
    execute(link, { query, variables }).subscribe(result => {
      const firstRun = new Date() - start;
      expect(result.data).toEqual(data);
      // this one should go faster becuase of memoization
      let secondStart = new Date();
      execute(link, { query, variables }).subscribe(result2 => {
        const secondRun = new Date() - secondStart;
        expect(firstRun).toBeGreaterThan(secondRun);
        expect(result2.data).toEqual(data);
        done();
      }, done.fail);
    }, done.fail);
  });
  it('correctly calculates hash when utf8 characters are present in the query', done => {
    fetch.mockResponseOnce(response);
    const link = createPersistedQuery().concat(createHttpLink());

    execute(link, {
      query: queryWithUtf8Chars,
      variables,
    }).subscribe(result => {
      expect(result.data).toEqual(data);
      const [uri, request] = fetch.mock.calls[0];
      expect(uri).toEqual('/graphql');
      const parsed = JSON.parse(request.body);
      expect(parsed.extensions.persistedQuery.sha256Hash).toBe(
        queryWithUtf8CharsHash,
      );
      done();
    }, done.fail);
  });
  it('supports loading the hash from other method', done => {
    fetch.mockResponseOnce(response);
    const generateHash = query => query.documentId + 'foo';
    const link = createPersistedQuery({ generateHash }).concat(
      createHttpLink(),
    );

    execute(link, { query, variables }).subscribe(result => {
      expect(result.data).toEqual(data);
      const [uri, request] = fetch.mock.calls[0];
      expect(uri).toEqual('/graphql');
      const parsed = JSON.parse(request.body);
      expect(parsed.extensions.persistedQuery.sha256Hash).toBe(
        `${query.documentId}foo`,
      );

      done();
    }, done.fail);
  });

  it('errors if unable to convert to sha256', done => {
    fetch.mockResponseOnce(response);
    const link = createPersistedQuery().concat(createHttpLink());

    execute(link, { query: '1234', variables }).subscribe(done.fail, error => {
      expect(error.message).toMatch(/Invalid AST Node/);
      done();
    });
  });
  it('unsubscribes correctly', done => {
    const delay = new ApolloLink(() => {
      return new Observable(ob => {
        setTimeout(() => {
          ob.next({ data });
          ob.complete();
        }, 100);
      });
    });
    const link = createPersistedQuery().concat(delay);

    const sub = execute(link, { query, variables }).subscribe(
      done.fail,
      done.fail,
      done.fail,
    );

    setTimeout(() => {
      sub.unsubscribe();
      done();
    }, 10);
  });
});
describe('failure path', () => {
  beforeEach(fetch.mockReset);
  it('correctly identifies the error shape from the server', done => {
    fetch.mockResponseOnce(errorResponse);
    fetch.mockResponseOnce(response);
    const link = createPersistedQuery().concat(createHttpLink());

    execute(link, { query, variables }).subscribe(result => {
      expect(result.data).toEqual(data);
      const [_, failure] = fetch.mock.calls[0];
      expect(JSON.parse(failure.body).query).not.toBeDefined();
      const [uri, success] = fetch.mock.calls[1];
      expect(JSON.parse(success.body).query).toBe(queryString);
      expect(
        JSON.parse(success.body).extensions.persistedQuery.sha256Hash,
      ).toBe(hash);
      done();
    }, done.fail);
  });
  it('sends GET for the first response only with useGETForHashedQueries', done => {
    fetch.mockResponseOnce(errorResponse);
    fetch.mockResponseOnce(response);
    const link = createPersistedQuery({ useGETForHashedQueries: true }).concat(
      createHttpLink(),
    );

    execute(link, { query, variables }).subscribe(result => {
      expect(result.data).toEqual(data);
      const [_, failure] = fetch.mock.calls[0];
      expect(failure.method).toBe('GET');
      expect(failure.body).not.toBeDefined();
      const [uri, success] = fetch.mock.calls[1];
      expect(success.method).toBe('POST');
      expect(JSON.parse(success.body).query).toBe(queryString);
      expect(
        JSON.parse(success.body).extensions.persistedQuery.sha256Hash,
      ).toBe(hash);
      done();
    }, done.fail);
  });
  it('does not try again after receiving NotSupported error', done => {
    fetch.mockResponseOnce(giveUpResponse);
    fetch.mockResponseOnce(response);

    // mock it again so we can verify it doesn't try anymore
    fetch.mockResponseOnce(response);
    const link = createPersistedQuery().concat(createHttpLink());

    execute(link, { query, variables }).subscribe(result => {
      expect(result.data).toEqual(data);
      const [_, failure] = fetch.mock.calls[0];
      expect(JSON.parse(failure.body).query).not.toBeDefined();
      const [uri, success] = fetch.mock.calls[1];
      expect(JSON.parse(success.body).query).toBe(queryString);
      expect(JSON.parse(success.body).extensions).toBeUndefined();
      execute(link, { query, variables }).subscribe(secondResult => {
        expect(secondResult.data).toEqual(data);

        const [uri, success] = fetch.mock.calls[2];
        expect(JSON.parse(success.body).query).toBe(queryString);
        expect(JSON.parse(success.body).extensions).toBeUndefined();
        done();
      }, done.fail);
    }, done.fail);
  });

  it('works with multiple errors', done => {
    fetch.mockResponseOnce(multiResponse);
    fetch.mockResponseOnce(response);
    const link = createPersistedQuery().concat(createHttpLink());

    execute(link, { query, variables }).subscribe(result => {
      expect(result.data).toEqual(data);
      const [_, failure] = fetch.mock.calls[0];
      expect(JSON.parse(failure.body).query).not.toBeDefined();
      const [uri, success] = fetch.mock.calls[1];
      expect(JSON.parse(success.body).query).toBe(queryString);
      expect(
        JSON.parse(success.body).extensions.persistedQuery.sha256Hash,
      ).toBe(hash);
      done();
    }, done.fail);
  });
  it('handles a 500 network error and still retries', done => {
    let failed = false;
    fetch.mockResponseOnce(response);

    // mock it again so we can verify it doesn't try anymore
    fetch.mockResponseOnce(response);

    const fetcher = (...args) => {
      if (!failed) {
        failed = true;
        return Promise.resolve({
          json: () => Promise.resolve('This will blow up'),
          text: () => Promise.resolve('THIS WILL BLOW UP'),
          status: 500,
        });
      }

      return fetch(...args);
    };
    const link = createPersistedQuery().concat(
      createHttpLink({ fetch: fetcher }),
    );

    execute(link, { query, variables }).subscribe(result => {
      expect(result.data).toEqual(data);
      const [uri, success] = fetch.mock.calls[0];
      expect(JSON.parse(success.body).query).toBe(queryString);
      expect(JSON.parse(success.body).extensions).toBeUndefined();
      execute(link, { query, variables }).subscribe(secondResult => {
        expect(secondResult.data).toEqual(data);

        const [uri, success] = fetch.mock.calls[1];
        expect(JSON.parse(success.body).query).toBe(queryString);
        expect(JSON.parse(success.body).extensions).toBeUndefined();
        done();
      }, done.fail);
    }, done.fail);
  });
  it('handles a 400 network error and still retries', done => {
    let failed = false;
    fetch.mockResponseOnce(response);

    // mock it again so we can verify it doesn't try anymore
    fetch.mockResponseOnce(response);

    const fetcher = (...args) => {
      if (!failed) {
        failed = true;
        return Promise.resolve({
          json: () => Promise.resolve('This will blow up'),
          text: () => Promise.resolve('THIS WILL BLOW UP'),
          status: 400,
        });
      }

      return fetch(...args);
    };
    const link = createPersistedQuery().concat(
      createHttpLink({ fetch: fetcher }),
    );

    execute(link, { query, variables }).subscribe(result => {
      expect(result.data).toEqual(data);
      const [uri, success] = fetch.mock.calls[0];
      expect(JSON.parse(success.body).query).toBe(queryString);
      expect(JSON.parse(success.body).extensions).toBeUndefined();
      execute(link, { query, variables }).subscribe(secondResult => {
        expect(secondResult.data).toEqual(data);

        const [uri, success] = fetch.mock.calls[1];
        expect(JSON.parse(success.body).query).toBe(queryString);
        expect(JSON.parse(success.body).extensions).toBeUndefined();
        done();
      }, done.fail);
    }, done.fail);
  });

  it('only retries a 400 network error once', done => {
    let fetchCalls = 0;
    const fetcher = (...args) => {
      fetchCalls++;
      return Promise.resolve({
        json: () => Promise.resolve('This will blow up'),
        text: () => Promise.resolve('THIS WILL BLOW UP'),
        status: 400,
      });
    };
    const link = createPersistedQuery().concat(
      createHttpLink({ fetch: fetcher }),
    );

    execute(link, { query, variables }).subscribe(
      result => done.fail,
      error => {
        expect(fetchCalls).toBe(2);
        done();
      },
    );
  });
});
