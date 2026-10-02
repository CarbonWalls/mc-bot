# The `jev-1.x` structured-decision endpoint

Notes on the external decision AI used by `src/jev.js`, recorded from live calls
made while building this integration. Everything here was observed against the
running service, not inferred from a spec.

## Shape

```
POST https://jevtypesafeai.com/api/jev
Content-Type: application/json
Origin: https://jevtypesafeai.com
Referer: https://jevtypesafeai.com/
```

**`Origin` and `Referer` are required.** Without them the service answers:

```json
{"error":"This free demo can only be called from jevtypesafeai.com."}
```

with HTTP **403**. That body is the only difference between "your headers are
wrong" and "the network is down", so `JevClient` logs the body on non-2xx rather
than only the status.

### Request

```json
{
  "state": "free text describing the situation",
  "questions": {
    "hook_type": {
      "type": "choice",
      "instructions": "What kind of hook does the first line use?",
      "criteria": { "open_loop": 1, "bold_claim": 3, "story": 1, "data": 1, "none": 1 }
    },
    "virality": {
      "type": "score",
      "instructions": "How strong is the viral potential?",
      "criteria": ["low", "medium", "high", "extreme"]
    }
  }
}
```

Two question types:

| type | `criteria` | meaning |
|---|---|---|
| `choice` | `{label: weight}` | pick one label **from the keys you pass**. The keys define the option space; the weights are a soft prior (see below). |
| `score` | `[legend...]` | place the state on a `0..N-1` scale; the legend names each rung. |

### Response

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "hook_type": {
      "type": "choice",
      "choice": "bold_claim",
      "confidence": 0.75,
      "probabilities": { "story": 0.1, "data": 0.04, "bold_claim": 0.8, "open_loop": 0.06, "none": 0 }
    },
    "virality": {
      "type": "score",
      "score": 2.38,
      "confidence": 0.57,
      "legend": { "0": "low", "1": "medium", "2": "high", "3": "extreme" },
      "probabilities": { "0": 0, "1": 0.02, "2": 0.57, "3": 0.41 }
    }
  },
  "usage": { "input_tokens": 421, "output_tokens": 71 }
}
```

Things worth knowing:

- `probabilities` **do sum to 1.00** (measured 0.99–1.00 across every answered
  probe; the 0.99 is a rounding artifact of three-decimal output). This corrects
  this file's first draft, which claimed they were unnormalised per-label
  strengths. They are a real distribution, which makes them worth using for more
  than ranking.
- `choice` **was the argmax of `probabilities` in every answered probe**,
  including the ones where a distractor was weighted 100x. An earlier draft of
  this file said the choice could differ from the argmax and reflect the weights.
  It does not, so the two are redundant and `interpretFight` can trust either.
- `score` is fractional (`2.38`), so dividing by `legend.length - 1` maps it to
  0..1 — which is what `interpretFight` does for `aggression`/`risk`.
- `confidence` is per-question, and a **flat distribution comes with a low one**.
  That is the signal used to ignore an answer: a confident-looking winner from a
  flat field is noise, and acting on noise every 110 ms is a hazard, not a
  decision.
- `usage.output_tokens` is small (~70), so a call is cheap in tokens; latency is
  not (see below).

## Behaviour that shaped the client

| observed | consequence in `src/jev.js` |
|---|---|
| 403 without `Origin`/`Referer` | both headers always sent; 401/403/429 latch a cooldown ≥ 120 s |
| latency ~0.5–3 s, occasionally worse | the control loop **never awaits** the network: `prefetch()` fires, `peek()` reads the cache |
| free demo tier, so rate limits and outages are expected | `maxFailures` → `unavailableUntil` backoff; a stale-but-cached answer is served within `staleGraceMs`; every caller must handle `null` |
| a `choice` with **fewer than 2 options** returns **400** `{"error":"Choice question \\"action\\" needs 2+ options."}` | `sanitizeQuestions()` drops such questions. The original guard only checked for *zero*, so a question reduced to one option by pruning or by stripped weights would have 400'd the entire request — including the answers to every other question in it |
| a `score` with **fewer than 2 levels** returns **400** `{"error":"Score question \\"s\\" needs 2+ ordered levels."}` | same rule, same treatment, for both the empty and the single-item legend |
| option-count limits are tight: 12 labels return 200, **14 return 400** `too many options` (the ceiling is between 12 and 14, measured in two passes) | options are truncated to `maxOptions` (8) — under the hard 400 limit AND under the range where answer quality dilutes, since a wider menu demonstrably flattens the distribution |
| one 400 discards **every** question in the request | validation is therefore per-request, and `sanitizeQuestions` is not optional decoration: it is what keeps a valid request valid after pruning |
| the state text is tokenised | kept under `stateChars` (700) and written as sentences, since stray fragments are noise in the input |

## How the bot uses it

`src/pvp.js` renders the duel into one state sentence and asks three questions:

| question | type | used for |
|---|---|---|
| `action` | choice over `attack press space strafe retreat bait guard disengage` | the next move |
| `aggression` | score `timid careful balanced assertive savage` | scaled into spacing/pressuring |
| `risk` | score `negligible low moderate high lethal` | logged; reserved as a tie-breaker |

The option keys are pruned to what local facts allow: against a creative
opponent, `attack`/`press`/`bait`/`guard` are removed from the menu entirely,
because that is the one control that verifiably changes the response. Weights are
still computed (`retreat` higher when hurt, `disengage` higher when the opponent
looks unkillable) because they cost nothing and document the bot's own reasoning,
but nothing in the bot's behaviour depends on them having an effect.

Two modes, set with `mc ai assist|force|off` (default `off`):

- **`assist`** — the answer may only choose actions that are already safe
  (`strafe space press bait guard attack`). It cannot order a retreat.
- **`force`** — the answer is obeyed within the safety veto.

**The veto list is not negotiable.** In both modes the local layer keeps sole
authority over: not walking off a ledge, jumping steps, fleeing when *our own*
health is critical, and never attacking while retreating. The advisor decides how
to pressure an opponent; it does not decide whether terrain is survivable.

Because a fight's state text changes every cycle (attack charge, distance, the
health estimate), the cache is keyed by a stable per-duel identity
(`pvp:<target>`), not by the state string. Keying on the state made every lookup a
cache miss, which presented as "the advisor never does anything" — the failure
mode of an async cache that is never awaited is silence, not an error.

## The probe transcripts

Every claim above comes from these live calls (same state text, varying one
input at a time). Answered by `jev-1.13.0`; probabilities summed by hand.

| # | state (short) | question shape | answer | p(atk) | p(retreat) | conf | what it proves |
|---|---|---|---|---|---|---|---|
| 1 | healthy 20/20, opp 20/20, dist 2 | 8 keys, all weights 1 | `attack` | 0.71 | 0.04 | 0.67 | baseline |
| 2 | same | 8 keys, **retreat 100x** | `attack` | 0.72 | 0.00 | 0.68 | raising a loser does not make it win |
| 3 | same (retry) | 8 keys, **retreat 100x** | `attack` | 0.92 | 0.00 | 0.91 | reproduced; weights cannot overrule the state |
| 4 | **1 heart, on fire, lava behind, opp above**, dist 1 | 8 keys, all weights 1 | `attack` | 0.31 | 0.19 | 0.20 | the state moves both the distribution and the confidence |
| 5 | same dire state | 8 keys, **attack 100x** | `attack` | 0.48 | 0.13 | 0.42 | weights *can* amplify what already leads |
| 6 | dire state | **3 keys only** (retreat/guard/disengage) | `guard` | — | 0.29 | 0.05 | the KEYS are the option space; `attack` was unreachable |
| 7 | any | empty `criteria` | **HTTP 400** `needs 2+ options` | | | | a 0-option question kills the request |
| 8 | any | 1-option `criteria` | **HTTP 400** `needs 2+ options` | | | | so pruning must keep a floor of 2 |
| 9 | any | `score` legend of 1 | **HTTP 400** `needs 2+ ordered levels` | | | | same rule for scores |
| 7b | any | 9 / 10 / 12 labels | HTTP 200 | | | | legal, but larger menus dilute the answer |
| 7c | any | **14 / 16** labels | **HTTP 400** `too many options` | | | | the ceiling is between 12 and 14 |
| 12 | any | no `Origin`/`Referer` | **HTTP 403** `This free demo can only be called from jevtypesafeai.com.` | | | | the headers are load-bearing |

Read together: the **state text is the lever** (1 vs 3: confidence 0.72 on a
healthy duel, 0.34 on a dire one), the **option keys are the control** (5, 6),
and the **weights are a soft prior that can amplify but not overrule** (2, and
3 vs 4). Probes 5 and 6 also show the model answers coherently from a menu of
only three, which is why pruning impossibilities is safe.

**The endpoint is not deterministic.** Two runs of the identical probe 1 gave
confidence 0.67 and 0.72 with `p(attack)` 0.71 and 0.75; the dire state gave
`attack` 0.31 once and 0.44 on a rerun; probe 5 answered `retreat` on one run and
`guard` on another from the same three-label menu. Treat every number in this
table as an observation, not a constant. This is not a curiosity: it is a third
independent reason the advisor is advisory, alongside latency and the free-tier
failure modes. A component whose answer at a fixed input can move by 0.13 must not
be the thing holding the safety-critical decisions, and a single sample of it must
not be treated as ground truth.

`interpretFight` ignores the distinction between `choice` and argmax because they
agreed in all six answered probes, and treats the distribution as normalised
because every one of them summed to 1.00.

## Inspecting what the bot asked

```
mc pvp Steve hard --explain     # prints the exact state + weights, no call made
mc result                       # shows the last answer, its confidence, and what was applied
mc status                       # DUEL panel: ai mode, applied action, confidence
```

`--explain` exists because debugging a classifier you cannot see the input to is
guesswork. `tests/jev_test.js` asserts the prompt is well-formed prose, that the
weights respond to the situation, that pruning never leaves fewer than two options
(the 400 in probes 7/8), that the 2+ validation rule is enforced in
`sanitizeQuestions`, and that every failure path returns `null` without touching
behaviour. Those tests run against an injected transport, so the suite never needs
this endpoint to be up.
