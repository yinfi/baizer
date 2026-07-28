# Third-Party Licenses

Baizer is distributed as a single bundled `main.js`. That bundle inlines the
dependencies listed below; only `obsidian`, `electron`, `@codemirror/*`,
`@lezer/*`, and Node built-ins are left external.

This file exists to satisfy the attribution requirements of those licenses —
notably Apache License 2.0 section 4(d), which is not discharged by Baizer's own
MIT license. Baizer's own code is MIT; see [LICENSE](./LICENSE).

Regenerate with `npm run licenses`.

## Summary

| License | Packages |
|---------|----------|
| 0BSD | 1 |
| Apache-2.0 | 45 |
| BSD-3-Clause | 12 |
| ISC | 2 |
| MIT | 41 |

Total: 101 bundled packages.

## Apache License 2.0

The following packages are licensed under the Apache License, Version 2.0. You
may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
Each retains its own copyright notices; see the package sources for details.

- @aws-crypto/crc32 5.2.0
- @aws-crypto/sha256-browser 5.2.0
- @aws-crypto/sha256-js 5.2.0
- @aws-crypto/supports-web-crypto 5.2.0
- @aws-crypto/util 5.2.0
- @aws-sdk/client-bedrock-runtime 3.1048.0
- @aws-sdk/core 3.974.13
- @aws-sdk/credential-provider-env 3.972.39
- @aws-sdk/credential-provider-http 3.972.41
- @aws-sdk/credential-provider-ini 3.972.43
- @aws-sdk/credential-provider-login 3.972.43
- @aws-sdk/credential-provider-node 3.972.44
- @aws-sdk/credential-provider-process 3.972.39
- @aws-sdk/credential-provider-sso 3.972.43
- @aws-sdk/credential-provider-web-identity 3.972.43
- @aws-sdk/eventstream-handler-node 3.972.17
- @aws-sdk/middleware-eventstream 3.972.13
- @aws-sdk/middleware-websocket 3.972.21
- @aws-sdk/nested-clients 3.997.11
- @aws-sdk/signature-v4-multi-region 3.996.28
- @aws-sdk/token-providers 3.1048.0
- @aws-sdk/types 3.973.9
- @aws-sdk/util-locate-window 3.965.5
- @aws-sdk/xml-builder 3.972.25
- @aws/lambda-invoke-store 0.2.4
- @google/genai 1.52.0
- @google/generative-ai 0.21.0
- @mistralai/mistralai 2.2.1
- @mozilla/readability 0.6.0
- @smithy/core 3.24.4
- @smithy/credential-provider-imds 4.3.4
- @smithy/fetch-http-handler 5.4.4
- @smithy/is-array-buffer 2.2.0
- @smithy/node-http-handler 4.7.3
- @smithy/signature-v4 5.4.4
- @smithy/types 4.14.2
- @smithy/util-buffer-from 2.2.0
- @smithy/util-utf8 2.3.0
- ecdsa-sig-formatter 1.0.11
- gaxios 7.1.4
- gcp-metadata 8.1.2
- google-auth-library 10.6.2
- google-logging-utils 1.1.3
- long 5.3.2
- openai 6.26.0

## 0BSD

- tslib 2.8.1

## BSD-3-Clause

- @protobufjs/aspromise 1.1.2
- @protobufjs/base64 1.1.2
- @protobufjs/codegen 2.0.5
- @protobufjs/eventemitter 1.1.1
- @protobufjs/fetch 1.1.1
- @protobufjs/float 1.0.2
- @protobufjs/inquire 1.1.2
- @protobufjs/path 1.1.2
- @protobufjs/pool 1.1.0
- @protobufjs/utf8 1.1.1
- buffer-equal-constant-time 1.0.1
- protobufjs 7.6.1

## ISC

- yaml 2.8.3
- zod-to-json-schema 3.25.2

## MIT

- @anthropic-ai/sdk 0.91.1
- @babel/runtime 7.29.2
- @earendil-works/pi-agent-core 0.75.5
- @earendil-works/pi-ai 0.75.5
- @nodable/entities 2.1.0
- @types/node 16.18.126
- @types/retry 0.12.0
- agent-base 7.1.4
- base64-js 1.5.1
- bignumber.js 9.3.1
- bowser 2.14.1
- data-uri-to-buffer 4.0.1
- debug 4.4.3
- extend 3.0.2
- fast-xml-builder 1.2.0
- fast-xml-parser 5.7.3
- fetch-blob 3.2.0
- formdata-polyfill 4.0.10
- http-proxy-agent 7.0.2
- https-proxy-agent 7.0.6
- ignore 7.0.5
- json-bigint 1.0.0
- json-schema-to-ts 3.1.1
- jwa 2.0.1
- jws 4.0.1
- ms 2.1.3
- node-domexception 1.0.0
- node-fetch 3.3.2
- p-retry 4.6.2
- partial-json 0.1.7
- path-expression-matcher 1.5.0
- retry 0.13.1
- safe-buffer 5.2.1
- strnum 2.3.0
- ts-algebra 2.0.0
- typebox 1.1.38
- web-streams-polyfill 3.3.3
- ws 8.21.0
- xml-naming 0.1.0
- youtube-transcript 1.2.1
- zod 4.4.3

## Note on the pi runtime

`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` declare MIT in
their `package.json` but ship no LICENSE file in the published tarball (their
`files` field includes only `dist` and `README.md`). The MIT grant is taken
from the package metadata and the upstream README.
