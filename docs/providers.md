# Your own model

The `lab` profile comes with the Globus Labs endpoints configured. Everyone else — the `example`
profile — brings their own model. Any model Pi can use works with the harness: the column, the
fleet, `/stuck` and the rest do not care where inference comes from. There are two routes.

## A built-in provider (Anthropic, OpenAI, Google, OpenRouter, …)

Pi knows these already. Either sign in from inside Pi:

```
/login
```

— which walks you through the provider's sign-in or API-key flow and stores the credential in
`~/.pi/agent/auth.json` — or export the provider's key in your shell (for example
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`); Pi's [providers documentation](https://pi.dev) lists each
one. Then pick a model with `/model`, or set the default:

```json
{ "defaultProvider": "anthropic", "defaultModel": "claude-sonnet-5" }
```

in `~/.pi/agent/settings.json`.

## Any OpenAI-compatible server (vLLM, Ollama, LM Studio, a gateway, …)

Describe it in `~/.pi/agent/models.json`. Find the model id the server serves first:

```bash
curl -s http://your-server:8000/v1/models        # add -H "Authorization: Bearer $MY_API_KEY" if it needs one
```

then:

```json
{
  "providers": {
    "my-server": {
      "name": "My server",
      "baseUrl": "http://your-server:8000/v1",
      "api": "openai-completions",
      "apiKey": "$MY_API_KEY",
      "models": [
        {
          "id": "the-model-id",
          "name": "The model",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 131072,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

- **`"apiKey": "$MY_API_KEY"`** is read from the environment when a request is made, so the key
  never sits in the file: export `MY_API_KEY` in your shell rc (near the top — some rc files stop
  early for non-interactive shells), then open a new terminal. `"!some-command"` runs a command
  for it instead (a password manager, a token helper). A server with no auth still needs some value;
  any string will do.
- **`contextWindow` and `maxTokens`** should be the model's real limits; the column's context gauge
  and Pi's automatic compaction trust them. vLLM's `/v1/models` reports the window as
  `max_model_len`; for anything else, the model card or the server's operator knows.
- **`reasoning: true`** for a model that thinks; then Pi's thinking levels apply. A vLLM model that
  accepts only certain `reasoning_effort` values needs a `thinkingLevelMap` — the lab's
  `profiles/lab/models.json` has a worked example.

Set it as the default (`"defaultProvider": "my-server"`, `"defaultModel": "the-model-id"` in
`settings.json`), then check:

```bash
pi --list-models my-server                       # it is listed
pi --no-session -p "Reply with just: ok" </dev/null   # it answers
```

It also appears in `/endpoints`, probed with the same key, and in the column's `ENDPOINT` row by
its `name` — the part before ` · `, so `"name": "mine · vLLM on the lab box"` reads `mine`. Two
optional keys Pi ignores but the harness reads:

- **`"_hint": "run: my-tunnel up"`** — what `/endpoints` says when nothing answers at the server,
  instead of the generic "nothing answers at <url>". The lab's entry names its tunnel command.

## Review rounds with your models

`/round` and `/review` use a panel of two reviewers and a critic, ideally on **different** models —
two copies of one model share their blind spots. `scripts/install.sh example` installs a template
`~/.pi/agent/rounds.json`; name models you actually have:

```json
{
  "dev": null,
  "panel": [
    { "label": "reviewer A", "model": "my-server/the-model-id" },
    { "label": "reviewer B", "model": "anthropic/claude-sonnet-5" }
  ],
  "critic": "openai/gpt-5"
}
```

A seat whose model cannot be resolved falls back to the session's model, so a template you have
not edited still runs — just as one model reviewing itself. [Agents and
rounds](agents-and-rounds.md#review-rounds) has the rest.
