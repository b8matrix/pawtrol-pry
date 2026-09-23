# Agent benchmark

Held-out tasks for measuring the agent across models and providers. The tasks run on five local fixture sites with made-up brands (`sites.mjs`): a webmail inbox, a shop, an appointment/support desk, a wiki, and a ticketing site. Neither the prompts nor the models have seen them. Each task (`tasks.mjs`) is graded on the agent's final answer or on the server state it left behind (archived mail, cart, booking, support ticket, seat hold). Most tasks include a decoy: a higher-rated mouse that is wired, an earliest date with no afternoon slots, an unsorted table, a look-alike wiki article.

| Category | Tasks |
|---|---|
| Email triage | `mail-important`, `mail-count`, `mail-archive` |
| Product comparison | `shop-best-mouse`, `shop-compare-weight`, `shop-cart-monitor` |
| Form filling | `civic-book`, `civic-support` |
| Search and summarise | `kb-bridge`, `kb-longest-river`, `kb-release-notes` |
| Multi-step booking | `tix-book` (must stop at payment) |

## Run

```sh
npm run build
# GROQ_API_KEY in the environment or in the repo's .env (gitignored)
npm run bench -- --models openai/gpt-oss-20b,openai/gpt-oss-120b
npm run bench -- --tasks mail-count,tix-book --repeat 3 --headed
```

Options: `--provider` (default `groq`; any provider id the extension supports), `--models`, `--tasks`, `--repeat`, `--gap <ms>` (pause between runs, 4000 by default, for rate limits), `--timeout <s>` (300), `--headed`.

Each run uses a fresh browser profile, so learned lessons never carry over. Confirmation prompts are approved automatically and logged, so an agent that pays when told not to fails `tix-book`.

## Output

`results/<timestamp>-<provider>.json` has one record per run: pass/fail and the reason, planner calls (steps), tool calls, wall time, provider-reported input/output tokens, cost, errors, confirmations, final answer and a trimmed transcript. `results/<timestamp>-<provider>.md` has the summary table. Prices per million tokens are in `PRICES` in `run.mjs`; check the provider's pricing page before quoting costs.
