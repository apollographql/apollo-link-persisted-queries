# Change log

### vNEXT

### 0.2.0
- New option: useGETForHashedQueries
- Improve error checking
- Never retry a single request more than once, even with network errors

### 0.1.0
- handle network errors correctly for 400 and 500

### 0.0.1-beta.3
- change default error handling to only disable on 400 error, not >= 500

### 0.0.1-beta.2
- improve error handling through 500s and optional function to disable

### 0.0.1-beta.1
- support hash lookup function for build time generation

### 0.0.1-beta.0
- added memoziation to hash generation based on equality of ASTs

### 0.0.1-alpha.4
- improved failsafe if server doesn't support persisted queries

### 0.0.1-alpha.3
- change key to sha256Hash that is hex encoded

### 0.0.1-alpha.2
- change from type to message for error identification

### 0.0.1-alpha.1
- if server doesn't support PQ, don't try anymore

### 0.0.1-alpha.0
- initial release
