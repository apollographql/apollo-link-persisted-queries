Automatic Persisted Queries
---

## Problem to solve
Unlike REST APIs that use a fixed URL to load data, GraphQL provides a rich query language that can be used to express the shape of application data requirements.  This is a marvellous advancement in technology, but it comes at a cost: GraphQL query strings are often much longer than REST URLS — in some cases by many kilobytes.

In practice we've seen GraphQL query sizes ranging well above 10 KB *just for the query text*.  This is actually significant overhead when compared with a simple URL of 50-100 characters.  When paired with the fact that the uplink speed from the client is typically the most bandwidth-constrained part of the chain, large queries can become bottlenecks for client performance.

Automatic Persisted Queries solves this problem by sending a generated id instead of the query text as the request.

For more information about this solution, read [this article announcing Automatic Persisted Queries].

## How it works
1. When the client makes a query, it will optimistically send a short (64-byte) cryptographic hash instead of the full query text.
2. If the backend recognizes the hash, it will retrieve the full text of the query and execute it
3. If the backend doesn't recogize the hash, it will ask the client to send the hash and the query text to it can store them mapped together for future lookups. During this request, the backend will also fufil the data request.

This library is a client implementation for use with Apollo Client by using custom Apollo Link.

## Installation

`npm install apollo-link-persisted-queries --save`

## Usage

The persisted query link requires using the `http-link`. The easiest way to use them together to to concat them into a single link.

```js
import { createPersistedQuery } from "apollo-link-persisted-queries";
import { createHttpLink } from "apollo-link-http";

// use this with Apollo Client
const link = createPersistedQuery().concat(createHttpLink({ uri: "/graphql" }));
```

Thats it! Now your client will start sending query signatures instead of the full text resulting in improved network performance!

## Apollo Engine
Apollo Engine supports recieving and fufulling Automatic Persisted Queries. Simply adding this link into your client app will improve your network response times when using Apollo Engine.


### Protocal
Automatic Persisted Queries are made up of three parts: the query signature, error responses, and the negotiaion protocal.

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

When sending an Automatic Persisted Query, the client ommits the `query` field normally present, and instead sends an extension field with a `persistedQuery` object as shown above. The hash is a `sha256` hash of the query string.

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

**Negotiation Protocal**
In order to support Automatic Persisted Queries, the client and server must follow the negotiaion steps as outlined here:

*Happy Path*
1. Client sends query signature with no `query` field
2. Server looks up query based on hash, if found, it resolves the data
3. Client recieves data and completes request

*Missing hash path*
1. Client sends query signature with no `query` field
2. Server looks up query based on hash, none is found
3. Server responds with NotFound error response
4. Client sends both hash and query string to Server
5. Server fufils response and saves query string + hash for future lookup
6. Client recieves data and completes request

