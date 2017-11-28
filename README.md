---
title: Persisted Queries
---

## Purpose
An Apollo Link to send a hash of a query instead of the full document!

## Installation

`npm install apollo-link-persisted-queries --save`

## Usage

The persisted query link requires using the `http-link`. The easiest way to use them together to to concat them into a single link.

```js
import { createPersistedQuery } from "apollo-link-persisted-queries";
import { createHttpLink } from "apollo-link-http";

const persistedHttp = createPersistedQuery().concat(createHttpLink({ uri: "/graphql" }));

```

