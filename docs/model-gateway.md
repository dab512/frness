# HTTP model gateway v1

`std.llm` implements `Generate.generate: ModelRequest → ModelCompletion`. The single-call reducer emits one effect through its `provider` slot. It does not depend on sessions, tabs or projects. Execution owns durable effects and optional budget accounting.

The first HTTP adapter uses an explicit **FRNESS gateway protocol**, not an implicit OpenAI/Anthropic compatibility promise. Configure `endpoint`, `model`, `credentialBinding`, and `decoder: "frness.model.ndjson.v1"`. An operator-provided gateway translates this protocol to its model provider. No endpoint/model/credential is discovered automatically.

The adapter sends one POST, `Authorization: Bearer <resolved credential>`, `Content-Type: application/json`, and `Accept: application/x-ndjson`:

```json
{"protocol":"frness.model.ndjson.v1","model":"configured-model","request":{"messages":[{"role":"user","content":"6 * 7?","toolCallId":null}],"tools":[],"outputType":null,"maxOutputTokens":100}}
```

The response must have `Content-Type: application/x-ndjson` and newline-terminated UTF-8 JSON records:

```json
{"kind":"text","delta":"42"}
{"kind":"final","completion":{"text":"42","structured":null,"toolCalls":[],"finish":"stop","usage":null}}
```

Only one final is accepted. EOF without final, length/error markers, malformed UTF-8/JSON, invalid structured output/tool arguments, conflicting/extra events after final, or transport failure never produce a successful completion. Individual records are limited to 1 MiB as a protocol framing bound. Redirects are rejected to prevent forwarding the bearer credential.

The effect adapter saves received provisional text in its completion evidence, including incomplete responses. A caller can additionally supply a chunk sink, awaited before further records are consumed. The default HTTP composition persists evidence at the outbox completion transaction; it does not guarantee recovery of chunks emitted immediately before a process crash. Provisional text never invokes tools or enters accepted knowledge. The complete final carries the authoritative text; chunks are not parsed as tool calls. Unknown usage stays null. The adapter makes no implicit retries and cannot reconcile a charged but incomplete request.

The native composition layer supplies scoped credential/network capabilities. Configuration stores only a binding name. Live model acceptance remains a separate gate from the local HTTP fixture.
