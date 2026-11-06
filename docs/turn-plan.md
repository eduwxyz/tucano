# The turn's plan

The router answers a channel message with the **plan of the turn**: the layers of who answers, in order. This document covers the shape of that answer, the ceilings, how the Runner executes it and how the Jev adapter builds the same plan. Spec §2 is the design decision; this is the implementation.

## The plan

```json
{"plano": [["lia"], ["theo"]], "reason": "ela acha o erro, ele escreve o texto"}
```

- A plan is a list of layers. Everyone in a layer answers **at once**.
- The next layer only starts when the one before is **done**, so it reads what it wrote (the transcript is rebuilt from the database when each reply starts).
- `[]` is nobody answering; `{"todos": true}` is every agent of the channel, in a single layer.
- `handles` (the old flat list, one layer) is still read, so a model that answers the old format isn't lost.

Ceilings, in `src/core/router.ts`:

| | |
|---|---|
| `MAX_ROUTED` | 2 handles per layer (as before) |
| `MAX_LAYERS` | 2 layers |
| `MAX_PLANNED` | 3 agents in the whole plan |

So a plan calls 1 agent, 2 at once (what the router already did), or 2 layers — at most one run more than before. Nobody answers twice: a handle repeated in another layer is dropped.

## How the Runner executes it

`routed()` in `src/core/runs.ts` posts the note (`Chamei **Lia**; depois **Theo** · motivo`) and queues the first layer. Each agent is queued on its own, so it takes a place in the global ceiling of 4 like any other reply. When the whole layer is done, the next one is queued.

The plan counts as one step of depth: every layer runs at `depth: 1`, the same as before. `MAX_DEPTH` (3) still only counts the chain of @mentions between agent replies.

`plans` (a counter on the Runner) is what keeps `idle()` honest: the next layer is queued a microtask after the layer before ends, and without it a test or the shutdown could see the queue empty in between and think the turn was over.

## Jev

Jev is a classifier, not a writer: it can't return a plan in one answer. So the adapter (`src/core/jev.ts`) asks once per layer — at most `MAX_LAYERS` questions, each under a second:

1. `Qual agente do canal deve responder à última mensagem humana?` — options: the channel's handles, "todos", "ninguém". A second agent joins the same layer when it gets at least 30% (`SECOND_AT`), as before.
2. The state of the second question names who is already answering; the options are the remaining handles plus `__encerrar` ("ninguém mais"). The answer either opens the second layer or ends the plan.

The cost, honestly: one TypeSafe call per layer instead of one per message, and the recent messages go to TypeSafe once per call. A crossed dependency ("Lia depends on nobody, Theo depends on Lia") doesn't fit a typed choice: the second layer is a whole layer, so an agent that could have run in parallel waits. That's the expressiveness Jev gives up against the CLI router, which writes the plan in one answer.

## What it doesn't do

There is no second pass of an LLM over a reply before it's posted: no reconciliation, no rewrite, no de-duplication against what another agent wrote in parallel. Prevention is the mechanism — if a reply depends on another, they go in different layers; if they don't, they're independent by construction, and the prompt tells the router not to invent a dependency. A reviewer agent, if wanted, is an agent called by @mention, not a fixed step on every reply.

## Tests

- `test/router.test.ts`: the shape of a plan, the ceilings, nobody twice, the old `handles`.
- `test/runner.test.ts`: two layers (the second only starts when the first is done, and its turn sees the first reply), and a layer of two answering at once.
- `test/jev.test.ts`: the second question (criteria, state, the plan it builds) and the one-layer cases.
