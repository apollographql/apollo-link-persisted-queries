import * as React from 'react';
import * as ReactDOM from 'react-dom/server';
import { graphql, ApolloProvider, getDataFromTree } from 'react-apollo';
import { InMemoryCache as Cache } from 'apollo-cache-inmemory';
import { ApolloClient } from 'apollo-client';
import gql from 'graphql-tag';
import { createHttpLink } from 'apollo-link-http';
import { print, parse } from 'graphql';
import { createHash } from 'crypto';

import { data, response, shortHash as hash } from './';

export const query = gql`
  query Test($filter: FilterObject) {
    foo(filter: $filter) {
      bar
    }
  }
`;

export const variables = {
  filter: {
    $filter: 'smash',
  },
};
export const variables2 = {
  filter: null,
};
const data = {
  foo: { bar: true },
};
const data2 = {
  foo: { bar: false },
};
const response = JSON.stringify({ data });
const response2 = JSON.stringify({ data: data2 });
const queryString = print(query);
const hash = createHash('sha256')
  .update(queryString)
  .digest('hex');

import { createPersistedQueryLink as createPersistedQuery, VERSION } from '../';

describe('react application', () => {
  beforeEach(fetch.mockReset);
  it('works on a simple tree', async () => {
    fetch.mockResponseOnce(response);
    fetch.mockResponseOnce(response2);

    const link = createPersistedQuery().concat(createHttpLink());

    const client = new ApolloClient({
      link,
      cache: new Cache({ addTypename: false }),
      ssrMode: true,
    });

    const Query = graphql(query)(({ data, children }) => {
      if (data.loading) return null;

      return (
        <div>
          {data.foo.bar && 'data was returned!'}
          {children}
        </div>
      );
    });
    const app = (
      <ApolloProvider client={client}>
        <Query {...variables}>
          <h1>Hello!</h1>
        </Query>
      </ApolloProvider>
    );

    // preload all the data for client side request (with filter)
    await getDataFromTree(app);
    const markup = ReactDOM.renderToString(app);
    expect(markup).toContain('data was returned');
    let [_, request] = fetch.mock.calls[0];
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

    // reset client and try with different input object
    const client2 = new ApolloClient({
      link,
      cache: new Cache({ addTypename: false }),
      ssrMode: true,
    });

    const app2 = (
      <ApolloProvider client={client2}>
        <Query {...variables2}>
          <h1>Hello!</h1>
        </Query>
      </ApolloProvider>
    );

    // change filter object to different variables and SSR
    await getDataFromTree(app2);
    const markup2 = ReactDOM.renderToString(app2);

    let [_, request] = fetch.mock.calls[1];

    expect(markup2).not.toContain('data was returned');
    expect(request.body).toBe(
      JSON.stringify({
        operationName: 'Test',
        variables: variables2,
        extensions: {
          persistedQuery: {
            version: VERSION,
            sha256Hash: hash,
          },
        },
      }),
    );
  });
});
