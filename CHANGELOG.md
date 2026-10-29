# Changelog

### v1.10.4 (2026-10-29)

**Bug fixes:**

- \[PATCH] fix: remove hard-coded PostgreSQL replication password (● [831e97f](https://github.com/corejslib/app/commit/831e97f); 👬 zdm)

- \[PATCH] fix: resolve cluster operation on process exit (● [54b560a](https://github.com/corejslib/app/commit/54b560a); 👬 zdm)

**Code refactoring:**

- \[PATCH] refactor: refactor postgres (● [0838cb8](https://github.com/corejslib/app/commit/0838cb8), [ce53075](https://github.com/corejslib/app/commit/ce53075), [00229fd](https://github.com/corejslib/app/commit/00229fd), [a6b766d](https://github.com/corejslib/app/commit/a6b766d), [cdeb783](https://github.com/corejslib/app/commit/cdeb783), [91f3f0a](https://github.com/corejslib/app/commit/91f3f0a), [280e9cc](https://github.com/corejslib/app/commit/280e9cc), [7814168](https://github.com/corejslib/app/commit/7814168), [4f5e840](https://github.com/corejslib/app/commit/4f5e840), [0018514](https://github.com/corejslib/app/commit/0018514), [ff0537f](https://github.com/corejslib/app/commit/ff0537f), [22855c5](https://github.com/corejslib/app/commit/22855c5), [c670244](https://github.com/corejslib/app/commit/c670244), [fc5c38d](https://github.com/corejslib/app/commit/fc5c38d), [11f5138](https://github.com/corejslib/app/commit/11f5138), [621152e](https://github.com/corejslib/app/commit/621152e), [7c13cd9](https://github.com/corejslib/app/commit/7c13cd9), [4100ec6](https://github.com/corejslib/app/commit/4100ec6), [6aa8207](https://github.com/corejslib/app/commit/6aa8207), [a37d281](https://github.com/corejslib/app/commit/a37d281), [ce1c50b](https://github.com/corejslib/app/commit/ce1c50b), [cb87100](https://github.com/corejslib/app/commit/cb87100), [a23d8b1](https://github.com/corejslib/app/commit/a23d8b1), [448f022](https://github.com/corejslib/app/commit/448f022), [7f2889d](https://github.com/corejslib/app/commit/7f2889d), [aac042f](https://github.com/corejslib/app/commit/aac042f), [41f86d7](https://github.com/corejslib/app/commit/41f86d7), [caed4ec](https://github.com/corejslib/app/commit/caed4ec), [95ca687](https://github.com/corejslib/app/commit/95ca687), [0cb3ed9](https://github.com/corejslib/app/commit/0cb3ed9), [96c2d45](https://github.com/corejslib/app/commit/96c2d45), [956d295](https://github.com/corejslib/app/commit/956d295), [cd47af0](https://github.com/corejslib/app/commit/cd47af0), [b93fc9f](https://github.com/corejslib/app/commit/b93fc9f), [ced24ff](https://github.com/corejslib/app/commit/ced24ff), [f45531e](https://github.com/corejslib/app/commit/f45531e), [8f0e932](https://github.com/corejslib/app/commit/8f0e932), [9a7b766](https://github.com/corejslib/app/commit/9a7b766), [3b5130a](https://github.com/corejslib/app/commit/3b5130a); 👬 zdm)

- \[PATCH] refactor: remove temporal import from storage (● [90e3354](https://github.com/corejslib/app/commit/90e3354); 👬 zdm)

- \[PATCH] refactor: replace array spreads with Iterator.concat (● [ae8a657](https://github.com/corejslib/app/commit/ae8a657); 👬 zdm)

- \[PATCH] refactor: use iterator toArray for collection conversion (● [e830893](https://github.com/corejslib/app/commit/e830893); 👬 zdm)

Compare with the previous release: [v1.10.3...v1.10.4](https://github.com/corejslib/app/compare/v1.10.3...v1.10.4)

### v1.10.3 (2026-10-28)

**Bug fixes:**

- \[PATCH] fix: correct replication role SQL construction (● [0dd01af](https://github.com/corejslib/app/commit/0dd01af); 👬 zdm)

Compare with the previous release: [v1.10.2...v1.10.3](https://github.com/corejslib/app/compare/v1.10.2...v1.10.3)

### v1.10.2 (2026-10-28)

**Code refactoring:**

- \[PATCH] refactor: refactor postgres (● [c064d21](https://github.com/corejslib/app/commit/c064d21); 👬 zdm)

Compare with the previous release: [v1.10.1...v1.10.2](https://github.com/corejslib/app/compare/v1.10.1...v1.10.2)

### v1.10.1 (2026-10-25)

**Code refactoring:**

- \[PATCH] refactor: initialize cluster and service discovery earlier (● [db196f9](https://github.com/corejslib/app/commit/db196f9); 👬 zdm)

Compare with the previous release: [v1.10.0...v1.10.1](https://github.com/corejslib/app/compare/v1.10.0...v1.10.1)

### v1.10.0 (2026-10-25)

**New features:**

- \[MINOR] feat: configure database connection options (● [5abd7e2](https://github.com/corejslib/app/commit/5abd7e2); 👬 zdm)

- \[MINOR] feat: validate database hostnames and rename standby connection limit (● [7f26f4a](https://github.com/corejslib/app/commit/7f26f4a); 👬 zdm)

**Bug fixes:**

- \[PATCH] fix: correct database password config key (● [ab634fb](https://github.com/corejslib/app/commit/ab634fb); 👬 zdm)

**Code refactoring:**

- \[PATCH] refactor: clarify service discovery configuration names (● [2e93d07](https://github.com/corejslib/app/commit/2e93d07); 👬 zdm)

**Other changes:**

- build(deps): add cluster as an optional dependency (● [61954d2](https://github.com/corejslib/app/commit/61954d2); 👬 zdm)

Compare with the previous release: [v1.9.0...v1.10.0](https://github.com/corejslib/app/compare/v1.9.0...v1.10.0)

### v1.9.0 (2026-10-24)

**New features:**

- \[MINOR] feat: pass cluster service discovery to SQL client (● [5958a34](https://github.com/corejslib/app/commit/5958a34); 👬 zdm)

Compare with the previous release: [v1.8.1...v1.9.0](https://github.com/corejslib/app/compare/v1.8.1...v1.9.0)

### v1.8.1 (2026-10-20)

**Other changes:**

- style: clarify startup and shutdown log messages (● [0be3d9d](https://github.com/corejslib/app/commit/0be3d9d); 👬 zdm)

Compare with the previous release: [v1.8.0...v1.8.1](https://github.com/corejslib/app/compare/v1.8.0...v1.8.1)

### v1.8.0 (2026-10-20)

**New features:**

- \[MINOR] feat: enable cluster component by default (● [2826e40](https://github.com/corejslib/app/commit/2826e40); 👬 zdm)

Compare with the previous release: [v1.7.1...v1.8.0](https://github.com/corejslib/app/compare/v1.7.1...v1.8.0)

### v1.7.1 (2026-10-19)

**Bug fixes:**

- \[PATCH] fix: register PostgreSQL service under its canonical name (● [afb075a](https://github.com/corejslib/app/commit/afb075a); 👬 zdm)

Compare with the previous release: [v1.7.0...v1.7.1](https://github.com/corejslib/app/compare/v1.7.0...v1.7.1)

### v1.7.0 (2026-10-19)

**New features:**

- \[MINOR] feat: identify nginx proxy apps by name instead of service name (● [2995823](https://github.com/corejslib/app/commit/2995823); 👬 zdm)

**Bug fixes:**

- \[PATCH] fix: stop proxy updates after destroy (● [ecd7abc](https://github.com/corejslib/app/commit/ecd7abc); 👬 zdm)

- \[PATCH] fix: sync proxy updates after reconnect (● [8bc9b4c](https://github.com/corejslib/app/commit/8bc9b4c); 👬 zdm)

- \[PATCH] fix: synchronize nginx proxies reliably (● [631a29b](https://github.com/corejslib/app/commit/631a29b); 👬 zdm)

    Retry failed proxy updates, resync on reconnect, and unregister proxies when destroyed.

Compare with the previous release: [v1.6.3...v1.7.0](https://github.com/corejslib/app/compare/v1.6.3...v1.7.0)

### v1.6.3 (2026-10-19)

**Code refactoring:**

- \[PATCH] refactor: remove nginx server name defaults (● [3ee9c31](https://github.com/corejslib/app/commit/3ee9c31); 👬 zdm)

Compare with the previous release: [v1.6.2...v1.6.3](https://github.com/corejslib/app/compare/v1.6.2...v1.6.3)

### v1.6.2 (2026-10-19)

**Bug fixes:**

- \[PATCH] fix: use cluster service discovery in nginx upstream (● [392635e](https://github.com/corejslib/app/commit/392635e); 👬 zdm)

Compare with the previous release: [v1.6.1...v1.6.2](https://github.com/corejslib/app/compare/v1.6.1...v1.6.2)

### v1.6.1 (2026-10-19)

**Bug fixes:**

- \[PATCH] fix: return the upstream instance initialization result (● [d701e9e](https://github.com/corejslib/app/commit/d701e9e); 👬 zdm)

Compare with the previous release: [v1.6.0...v1.6.1](https://github.com/corejslib/app/compare/v1.6.0...v1.6.1)

### v1.6.0 (2026-10-19)

**New features:**

- \[MINOR] feat: return success result after initializing API (● [00fabd6](https://github.com/corejslib/app/commit/00fabd6); 👬 zdm)

Compare with the previous release: [v1.5.0...v1.6.0](https://github.com/corejslib/app/compare/v1.5.0...v1.6.0)

### v1.5.0 (2026-10-19)

**New features:**

- \[MINOR] feat: add cluster service discovery to services (● [0525099](https://github.com/corejslib/app/commit/0525099); 👬 zdm)

- \[MINOR] feat: add service-discovery-backed nginx upstream management (● [207ac3e](https://github.com/corejslib/app/commit/207ac3e); 👬 zdm)

Compare with the previous release: [v1.4.6...v1.5.0](https://github.com/corejslib/app/compare/v1.4.6...v1.5.0)

### v1.4.6 (2026-10-19)

**Code refactoring:**

- \[PATCH] refactor: use core service discovery API (● [c48d25b](https://github.com/corejslib/app/commit/c48d25b); 👬 zdm)

Compare with the previous release: [v1.4.5...v1.4.6](https://github.com/corejslib/app/compare/v1.4.5...v1.4.6)

### v1.4.5 (2026-10-18)

**Bug fixes:**

- \[PATCH] fix: dispatch multipart requests by method header (● [0e5a7db](https://github.com/corejslib/app/commit/0e5a7db); 👬 zdm)

- \[PATCH] fix: fix api method extraction (● [cad125e](https://github.com/corejslib/app/commit/cad125e); 👬 zdm)

- \[PATCH] fix: fix http server locations (● [9ef234b](https://github.com/corejslib/app/commit/9ef234b); 👬 zdm)

- \[PATCH] fix: resolve API method from decoded request body (● [015c717](https://github.com/corejslib/app/commit/015c717); 👬 zdm)

- \[PATCH] fix: use JSON-RPC response header (● [a18e672](https://github.com/corejslib/app/commit/a18e672); 👬 zdm)

Compare with the previous release: [v1.4.4...v1.4.5](https://github.com/corejslib/app/compare/v1.4.4...v1.4.5)

### v1.4.4 (2026-10-18)

**Bug fixes:**

- \[PATCH] fix: restrict frontend API calls to POST (● [dd4861b](https://github.com/corejslib/app/commit/dd4861b); 👬 zdm)

Compare with the previous release: [v1.4.3...v1.4.4](https://github.com/corejslib/app/compare/v1.4.3...v1.4.4)

### v1.4.3 (2026-10-18)

**Code refactoring:**

- \[PATCH] refactor: use default API connection settings for clusters (● [493ae44](https://github.com/corejslib/app/commit/493ae44); 👬 zdm)

    Remove the maxConnections override and its schema option.

Compare with the previous release: [v1.4.2...v1.4.3](https://github.com/corejslib/app/compare/v1.4.2...v1.4.3)

### v1.4.2 (2026-10-16)

**Bug fixes:**

- \[PATCH] fix: pass connection options through waitConnect (● [f3c8dba](https://github.com/corejslib/app/commit/f3c8dba); 👬 zdm)

Compare with the previous release: [v1.4.1...v1.4.2](https://github.com/corejslib/app/compare/v1.4.1...v1.4.2)

### v1.4.1 (2026-10-14)

**Bug fixes:**

- \[PATCH] fix: gate GeoIP directives and reload trusted subnet updates (● [fa99e13](https://github.com/corejslib/app/commit/fa99e13); 👬 zdm)

- \[PATCH] fix: invalidate cached trusted subnet config on updates (● [3eddee2](https://github.com/corejslib/app/commit/3eddee2); 👬 zdm)

Compare with the previous release: [v1.4.0...v1.4.1](https://github.com/corejslib/app/compare/v1.4.0...v1.4.1)

### v1.4.0 (2026-10-14)

**New features:**

- \[MINOR] feat: add nginx GeoIP configuration support (● [2ce40b3](https://github.com/corejslib/app/commit/2ce40b3); 👬 zdm)

    Reload Nginx when GeoIP databases update and add optional GeoIP directives to the HTTP and stream templates.

- \[MINOR] feat: configure GeoIP proxies from trusted subnets (● [fb52963](https://github.com/corejslib/app/commit/fb52963); 👬 zdm)

Compare with the previous release: [v1.3.9...v1.4.0](https://github.com/corejslib/app/compare/v1.3.9...v1.4.0)

### v1.3.9 (2026-10-12)

**Bug fixes:**

- \[PATCH] fix: recognize attach-prefixed multipart fields in JSON-RPC data (● [f132d99](https://github.com/corejslib/app/commit/f132d99); 👬 zdm)

Compare with the previous release: [v1.3.8...v1.3.9](https://github.com/corejslib/app/compare/v1.3.8...v1.3.9)

### v1.3.8 (2026-10-11)

**Bug fixes:**

- \[PATCH] fix: correct attachment content type validation (● [d550e74](https://github.com/corejslib/app/commit/d550e74); 👬 zdm)

    Adjust the attachment keyword check to read the content type from the headers object instead of the getter-based API, fixing invalid content-type validation.

- \[PATCH] fix: use JSON-RPC request id when present (● [ff339d4](https://github.com/corejslib/app/commit/ff339d4); 👬 zdm)

    This change fixes incorrect behavior in the frontend API by reading the request id from the JSON-RPC payload instead of the raw args object, ensuring the correct identifier is preserved when present.

- \[PATCH] fix: validate JSON-RPC POST requests (● [a0ad1bb](https://github.com/corejslib/app/commit/a0ad1bb); 👬 zdm)

    The POST handler now decodes JSON-RPC payloads before checking protocol details, rejects non-JSON-RPC requests, and preserves void-call behavior based on the parsed request id. It also normalizes undefined params to an empty array while keeping single-argument payloads wrapped as arrays.

Compare with the previous release: [v1.3.7...v1.3.8](https://github.com/corejslib/app/compare/v1.3.7...v1.3.8)

### v1.3.7 (2026-10-10)

**Other changes:**

- chore: update translations (● [bb18453](https://github.com/corejslib/app/commit/bb18453); 👬 zdm)

Compare with the previous release: [v1.3.6...v1.3.7](https://github.com/corejslib/app/compare/v1.3.6...v1.3.7)

### v1.3.6 (2026-10-09)

**Code refactoring:**

- \[PATCH] refactor: refactor msgpack (● [c2ba55d](https://github.com/corejslib/app/commit/c2ba55d); 👬 zdm)

Compare with the previous release: [v1.3.5...v1.3.6](https://github.com/corejslib/app/compare/v1.3.5...v1.3.6)

### v1.3.5 (2026-10-07)

**Other changes:**

- style: lint (● [ddd6a02](https://github.com/corejslib/app/commit/ddd6a02); 👬 zdm)

Compare with the previous release: [v1.3.4...v1.3.5](https://github.com/corejslib/app/compare/v1.3.4...v1.3.5)

### v1.3.4 (2026-10-06)

**Other changes:**

- chore: update .pot template (● [5cba32b](https://github.com/corejslib/app/commit/5cba32b); 👬 zdm)

- chore: update translations (● [04a2cac](https://github.com/corejslib/app/commit/04a2cac); 👬 zdm)

Compare with the previous release: [v1.3.3...v1.3.4](https://github.com/corejslib/app/compare/v1.3.3...v1.3.4)

### v1.3.3 (2026-10-05)

**Bug fixes:**

- \[PATCH] fix: align proxy update version field (● [638c501](https://github.com/corejslib/app/commit/638c501); 👬 zdm)

Compare with the previous release: [v1.3.2...v1.3.3](https://github.com/corejslib/app/compare/v1.3.2...v1.3.3)

### v1.3.2 (2026-10-03)

**Other changes:**

- style: annotate service discovery registration (● [80be5f6](https://github.com/corejslib/app/commit/80be5f6); 👬 zdm)

Compare with the previous release: [v1.3.1...v1.3.2](https://github.com/corejslib/app/compare/v1.3.1...v1.3.2)

### v1.3.1 (2026-10-03)

**Bug fixes:**

- \[PATCH] fix: use configured service name for PostgreSQL discovery (● [c1af272](https://github.com/corejslib/app/commit/c1af272); 👬 zdm)

Compare with the previous release: [v1.3.0...v1.3.1](https://github.com/corejslib/app/compare/v1.3.0...v1.3.1)

### v1.3.0 (2026-10-03)

**New features:**

- \[MINOR] feat: add cluster service discovery for app services (● [8687b74](https://github.com/corejslib/app/commit/8687b74); 👬 zdm)

**Bug fixes:**

- \[PATCH] fix: register API services only when their components are present (● [ef22375](https://github.com/corejslib/app/commit/ef22375); 👬 zdm)

Compare with the previous release: [v1.2.1...v1.3.0](https://github.com/corejslib/app/compare/v1.2.1...v1.3.0)

### v1.2.1 (2026-10-03)

**Code refactoring:**

- \[PATCH] refactor: use core service discovery client (● [67d98f2](https://github.com/corejslib/app/commit/67d98f2); 👬 zdm)

Compare with the previous release: [v1.2.0...v1.2.1](https://github.com/corejslib/app/compare/v1.2.0...v1.2.1)

### v1.2.0 (2026-10-03)

**New features:**

- \[MINOR] feat: add cluster service discovery client (● [f59b76e](https://github.com/corejslib/app/commit/f59b76e); 👬 zdm)

Compare with the previous release: [v1.1.10...v1.2.0](https://github.com/corejslib/app/compare/v1.1.10...v1.2.0)

### v1.1.10 (2026-09-27)

**Other changes:**

- chore: update locale source references (● [59e052b](https://github.com/corejslib/app/commit/59e052b); 👬 zdm)

Compare with the previous release: [v1.1.9...v1.1.10](https://github.com/corejslib/app/compare/v1.1.9...v1.1.10)

### v1.1.9 (2026-09-27)

**Bug fixes:**

- \[PATCH] fix: await locale domain loading during initialization (● [1705246](https://github.com/corejslib/app/commit/1705246); 👬 zdm)

Compare with the previous release: [v1.1.8...v1.1.9](https://github.com/corejslib/app/compare/v1.1.8...v1.1.9)

### v1.1.8 (2026-09-27)

**Other changes:**

- Revert "chore: remove .pot" (● [19e7aeb](https://github.com/corejslib/app/commit/19e7aeb); 👬 zdm)

    This reverts commit [96cab21](https://github.com/corejslib/app/commit/96cab215f3284a841cd3b79a880f4a8aba87bf3e).

Compare with the previous release: [v1.1.7...v1.1.8](https://github.com/corejslib/app/compare/v1.1.7...v1.1.8)

### v1.1.7 (2026-09-27)

**Other changes:**

- chore: remove .pot (● [96cab21](https://github.com/corejslib/app/commit/96cab21); 👬 zdm)

Compare with the previous release: [v1.1.6...v1.1.7](https://github.com/corejslib/app/compare/v1.1.6...v1.1.7)

### v1.1.6 (2026-09-26)

**Bug fixes:**

- \[PATCH] fix: use correct template rendering methods (● [ae468b3](https://github.com/corejslib/app/commit/ae468b3); 👬 zdm)

Compare with the previous release: [v1.1.5...v1.1.6](https://github.com/corejslib/app/compare/v1.1.5...v1.1.6)

### v1.1.5 (2026-09-26)

**Other changes:**

- Revert "fix: expose JSON in schema generation contexts" (● [c2a213f](https://github.com/corejslib/app/commit/c2a213f); 👬 zdm)

    This reverts commit [c7fc901](https://github.com/corejslib/app/commit/c7fc90187fb5efe0ff5eede9a000b7888921ec0f).

Compare with the previous release: [v1.1.4...v1.1.5](https://github.com/corejslib/app/compare/v1.1.4...v1.1.5)

### v1.1.4 (2026-09-26)

**Bug fixes:**

- \[PATCH] fix: expose JSON in schema generation contexts (● [c7fc901](https://github.com/corejslib/app/commit/c7fc901); 👬 zdm)

- \[PATCH] fix: stringify user-agent details in sign-in email (● [94d44ce](https://github.com/corejslib/app/commit/94d44ce); 👬 zdm)

Compare with the previous release: [v1.1.3...v1.1.4](https://github.com/corejslib/app/compare/v1.1.3...v1.1.4)

### v1.1.3 (2026-09-24)

**Other changes:**

- chore: update translations (● [0a11183](https://github.com/corejslib/app/commit/0a11183); 👬 zdm)

- chore: update Ukrainian and Russian locale copy (● [201c573](https://github.com/corejslib/app/commit/201c573); 👬 zdm)

- docs: fix wording in email and notification copy (● [262ecbc](https://github.com/corejslib/app/commit/262ecbc); 👬 zdm)

Compare with the previous release: [v1.1.2...v1.1.3](https://github.com/corejslib/app/compare/v1.1.2...v1.1.3)

### v1.1.2 (2026-09-21)

**Code refactoring:**

- \[PATCH] refactor: use named msgpack imports in keyring (● [221f01b](https://github.com/corejslib/app/commit/221f01b); 👬 zdm)

Compare with the previous release: [v1.1.1...v1.1.2](https://github.com/corejslib/app/compare/v1.1.1...v1.1.2)

### v1.1.1 (2026-09-21)

**Other changes:**

- chore: update Russian locale strings (● [6ea50b1](https://github.com/corejslib/app/commit/6ea50b1); 👬 zdm)

Compare with the previous release: [v1.1.0...v1.1.1](https://github.com/corejslib/app/compare/v1.1.0...v1.1.1)

### v1.1.0 (2026-09-15)

**New features:**

- \[MINOR] feat: expose package root entry point (● [9c1ad2e](https://github.com/corejslib/app/commit/9c1ad2e); 👬 zdm)

Compare with the previous release: [v1.0.0...v1.1.0](https://github.com/corejslib/app/compare/v1.0.0...v1.1.0)

### v1.0.0 (2026-09-15)

**Migration notes:**

See the list of the breaking changes below for details.

**Breaking changes:**

- \[MAJOR] feat!: public release (● [dc40d0d](https://github.com/corejslib/app/commit/dc40d0d); 👬 zdm)

Compare with the previous release: [v0.1.0...v1.0.0](https://github.com/corejslib/app/compare/v0.1.0...v1.0.0)
