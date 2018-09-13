Automatic Persisted Queries
---

## Problem to solve
Unlike REST APIs that use a fixed URL to load data, GraphQL provides a rich query language that can be used to express the shape of application data requirements.  This is a marvellous advancement in technology, but it comes at a cost: GraphQL query strings are often much longer than REST URLS — in some cases by many kilobytes.

In practice we've seen GraphQL query sizes ranging well above 10 KB *just for the query text*.  This is actually significant overhead when compared with a simple URL of 50-100 characters.  When paired with the fact that the uplink speed from the client is typically the most bandwidth-constrained part of the chain, large queries can become bottlenecks for client performance.

Automatic Persisted Queries solves this problem by sending a generated ID instead of the query text as the request.

For more information about this solution, read [this article announcing Automatic Persisted Queries](https://dev-blog.apollodata.com/improve-graphql-performance-with-automatic-persisted-queries-c31d27b8e6ea).

## How it works
1. When the client makes a query, it will optimistically send a short (64-byte) cryptographic hash instead of the full query text.
2. If the backend recognizes the hash, it will retrieve the full text of the query and execute it.
3. If the backend doesn't recogize the hash, it will ask the client to send the hash and the query text to it can store them mapped together for future lookups. During this request, the backend will also fulfill the data request.

This library is a client implementation for use with Apollo Client by using custom Apollo Link.

## Installation

`npm install apollo-link-persisted-queries --save`

## Usage

The persisted query link requires using the `http-link`. The easiest way to use them together to to concat them into a single link.

```js
import { createPersistedQueryLink } from "apollo-link-persisted-queries";
import { createHttpLink } from "apollo-link-http";
import { InMemoryCache } from "apollo-cache-inmemory";
import ApolloClient from "apollo-client";


// use this with Apollo Client
const link = createPersistedQueryLink().concat(createHttpLink({ uri: "/graphql" }));
const client = new ApolloClient({
  cache: new InMemoryCache(),
  link: link,
});
```

Thats it! Now your client will start sending query signatures instead of the full text resulting in improved network performance!

#### Options
The createPersistedQueryLink function takes an optional object with configuration. Currently the only supported configutations are a key called `generateHash` which receives the query and returns the hash, a function to conditionally disabled sending persisted queries on error
- `generateHash`: a function that takes the query document and returns the hash. If not provided, `generateHash` defaults to a fast implementation of sha256 + hex digest.
- `useGETForHashedQueries`: set to `true` to use the HTTP `GET` method when sending the hashed version of queries (but not for mutations). `GET` requests require `apollo-link-http` 1.4.0 or newer, and are not compatible with `apollo-link-batch-http`. 
> If you want to use `GET` for non-mutation queries whether or not they are hashed, pass `useGETForQueries: true` option to `createHttpLink` from `apollo-link-http` instead. If you want to use `GET` for all requests, pass `fetchOptions: {method: 'GET'}` to `createHttpLink`.
- `disable`: a function which takes an ErrorResponse (see below) and returns a boolean to disable any future persited queries for that session. This defaults to disabling on `PersistedQueryNotSupported` or a 400 or 500 http error

**ErrorResponse**
The argument that the optional `disable` function is given is an object with the following keys:
- `operation`: The Operation that errored (contains query, variables, operationName, and context)
- `response`: The Execution of the reponse (contains data and errors as well extensions if sent from the server)
- `graphQLErrors`: An array of errors from the GraphQL endpoint
- `networkError`: any error during the link execution or server response

*Note*: `networkError` is the value from the downlink's `error` callback. In most cases, `graphQLErrors` is the `errors` field of the result from the last `next` call. A `networkError` can contain additional fields, such as a GraphQL object in the case of a failing HTTP status code from `apollo-link-http`. In this situation, `graphQLErrors` is an alias for `networkError.result.errors` if the property exists.

## Apollo Engine
Apollo Engine supports receiving and fulfulling Automatic Persisted Queries. Simply adding this link into your client app will improve your network response times when using Apollo Engine.


### Protocol
Automatic Persisted Queries are made up of three parts: the query signature, error responses, and the negotiaion protocol.

**Query Signature**
The query signature for Automatic Persisted Queries is sent along the extensions field of a request from the client. This is a transport independent way to send extra information along with the operation. 

```js
{
  operationName: 'MyQuery',
  variables: null,
  extensions: {
    persistedQuery: {
      version: 1,
      sha256Hash: hashOfQuery
    }
  }
}
```

When sending an Automatic Persisted Query, the client ommits the `query` field normally present, and instead sends an extension field with a `persistedQuery` object as shown above. The hash algorithm defaults to a `sha256` hash of the query string.

If the client needs to register the hash, the query signature will be the same but include the full query text like so:

```js
{
  operationName: 'MyQuery',
  variables: null,
  query: `query MyQuery { id }`,
  extensions: {
    persistedQuery: {
      version: 1,
      sha256Hash: hashOfQuery
    }
  }
}
```

This should only happen once across all clients when a new query is introduced into your application.

**Error Responses**
When the initial query signature is received by a backend, if it is unable to find the hash previously stored, it must send back the following response signature:

```js
{
  errors: [
    { message: 'PersistedQueryNotFound' }
  ]
}
```

If the backend doesn't support Automatic Persisted Queries, or does not want to support it for that particular client, it can send back the following which will tell the client to stop trying to send hashes all together:

```
{
  errors: [
    { message: 'PersistedQueryNotSupported' }
  ]
}
```

**Negotiation Protocol**
In order to support Automatic Persisted Queries, the client and server must follow the negotiaion steps as outlined here:

*Happy Path*
1. Client sends query signature with no `query` field
2. Server looks up query based on hash, if found, it resolves the data
3. Client receives data and completes request

*Missing hash path*
1. Client sends query signature with no `query` field
2. Server looks up query based on hash, none is found
3. Server responds with NotFound error response
4. Client sends both hash and query string to Server
5. Server fulfills response and saves query string + hash for future lookup
6. Client receives data and completes request

### Build time generation
If you want to avoid hashing in the browser, you can use a build script to include the hash as part of the request. Then you pass a function to retrieve that hash when the operation is run. This works well with projects like [this](https://github.com/leoasis/graphql-persisted-document-loader) which uses webpack to generate the hashes at build time.

If you use the above loader, you can pass `{ generateHash: ({ documentId }) => documentId }` to the `createPersistedQueryLink` call.
