# 0005. The request body is parsed once, and rewrites are scoped to Messages

Status: Accepted

## Context

Three rewrites change the outgoing body: the Claude Code request shape, the
cache TTL on existing `cache_control` markers, and the optional
`context_management` block. Each parsed and re-serialised the whole JSON, so
a long conversation was parsed three or four times per request.

A review of these rewrites also found:

- `context_management` was added to every endpoint. A `count_tokens` call
  could fail on it and switch context editing off for the whole process.
- Any 400 whose body contained the field name switched editing off.
- When a request needed both the prefill fix and the context-editing retry,
  the second retry resent the conversation the server had already refused.
- Forwarded `content-length` / `content-encoding` headers described the body
  before it was rewritten.
- The TTL log recorded a 1h write even when the body had no marker to carry it.

## Decision

- The body is parsed once. `prepareBody` applies all three rewrites to that
  object and serialises it once; the form without context editing is only
  serialised if the server refuses it.
- Context editing is added only on `/v1/messages`, and is switched off only
  when the 400's error message names the feature.
- A retry starts from the body actually sent, including an earlier prefill fix.
- Length and encoding headers are dropped before the rewritten body is sent.
- The TTL is logged as 1h only when a marker actually carried it.
- Request captures, which can hold whole conversations, are written owner-only.

## Consequences

- One parse per request on the request path. Request capture, off by
  default, still parses the final body to describe it.
- `transformBody` remains for callers that hold only a string;
  `transformParsed` is the same rewrite on an object.
