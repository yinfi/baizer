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
| Apache-2.0 | 34 |
| BSD-3-Clause | 11 |
| ISC | 1 |
| MIT | 42 |
| Unlicense | 1 |

Total: 90 bundled packages.

## Apache License 2.0

The following packages are licensed under the Apache License, Version 2.0. You
may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
Each retains its own copyright notices; see the package sources for details.

- @aws-sdk/client-bedrock-runtime 3.1127.0
- @aws-sdk/core 3.978.5
- @aws-sdk/credential-provider-env 3.972.76
- @aws-sdk/credential-provider-http 3.972.78
- @aws-sdk/credential-provider-ini 3.973.21
- @aws-sdk/credential-provider-login 3.972.83
- @aws-sdk/credential-provider-node 3.972.88
- @aws-sdk/credential-provider-process 3.972.76
- @aws-sdk/credential-provider-sso 3.973.20
- @aws-sdk/credential-provider-web-identity 3.972.82
- @aws-sdk/eventstream-handler-node 3.972.38
- @aws-sdk/middleware-eventstream 3.972.33
- @aws-sdk/middleware-websocket 3.972.58
- @aws-sdk/nested-clients 3.997.50
- @aws-sdk/signature-v4-multi-region 3.996.49
- @aws-sdk/token-providers 3.1127.0
- @aws-sdk/types 3.975.0
- @aws-sdk/xml-builder 3.972.41
- @aws/lambda-invoke-store 0.3.0
- @google/genai 2.21.0
- @mozilla/readability 0.6.0
- @smithy/core 3.36.2
- @smithy/credential-provider-imds 4.5.2
- @smithy/fetch-http-handler 5.8.0
- @smithy/node-http-handler 4.12.1
- @smithy/signature-v4 5.7.4
- @smithy/types 4.19.0
- ecdsa-sig-formatter 1.0.11
- gaxios 7.3.1
- gcp-metadata 8.1.2
- google-auth-library 10.9.1
- google-logging-utils 1.1.3
- long 5.3.2
- openai 7.19.0

## 0BSD

- tslib 2.8.1

## BSD-3-Clause

- @protobufjs/aspromise 1.1.2
- @protobufjs/base64 1.1.2
- @protobufjs/codegen 2.0.5
- @protobufjs/eventemitter 1.1.1
- @protobufjs/fetch 1.1.1
- @protobufjs/float 1.0.2
- @protobufjs/path 1.1.2
- @protobufjs/pool 1.1.0
- @protobufjs/utf8 1.1.2
- buffer-equal-constant-time 1.0.1
- protobufjs 7.6.6

## ISC

- yaml 2.8.3

## MIT

- @anthropic-ai/sdk 0.129.0
- @babel/runtime 7.29.10
- @codemirror/state 6.5.0
- @codemirror/view 6.38.6
- @earendil-works/pi-agent-core 1.3.0
- @earendil-works/pi-ai 1.3.0
- @earendil-works/pi-telemetry 1.3.0
- @marijn/find-cluster-break 1.0.2
- @stablelib/base64 1.0.1
- @types/node 16.18.126
- @types/retry 0.12.0
- agent-base 9.0.0
- base64-js 1.5.1
- bignumber.js 9.3.1
- bowser 2.14.1
- crelt 1.0.6
- data-uri-to-buffer 4.0.1
- debug 4.4.3
- extend 3.0.2
- fetch-blob 3.2.0
- formdata-polyfill 4.0.10
- http-proxy-agent 9.1.0
- https-proxy-agent 9.1.0
- json-bigint 1.0.0
- json-schema-to-ts 3.1.1
- jwa 2.0.1
- jws 4.0.1
- ms 2.1.3
- node-domexception 1.0.0
- node-fetch 3.3.2
- p-retry 4.6.2
- partial-json 0.1.7
- proxy-agent-negotiate 1.1.0
- retry 0.13.1
- safe-buffer 5.2.1
- standardwebhooks 1.1.1
- style-mod 4.1.3
- ts-algebra 2.0.0
- typebox 1.3.27
- w3c-keyname 2.2.8
- web-streams-polyfill 3.3.3
- ws 8.22.0

## Unlicense

- fast-sha256 1.3.0

## Note on the pi runtime

`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` declare MIT in
their `package.json` but ship no LICENSE file in the published tarball (their
`files` field includes only `dist` and `README.md`). The MIT grant is taken
from the package metadata and the upstream README.
