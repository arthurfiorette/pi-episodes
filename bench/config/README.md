Conditions live in `run.json` (`conditions[]`, `extension` relative to this directory); there is no `conditions.json`.
Credentials go in `auth.json` here (gitignored, pi's `auth.json` format; `auth.example.json` is the shape) or in environment variables.
Custom endpoints (proxies, OpenAI- or Anthropic-compatible servers) go in `models.pi.json`, pi's `models.json` format; `models.pi.example.json` is the shape. It is tracked, so `apiKey` must be a `$ENV` reference.
