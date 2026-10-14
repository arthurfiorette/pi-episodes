# Judge configuration and calibration

`judge.json`: `{ "models": ["<provider/modelId>", ...], "authPath": "bench/config/auth.json" }`. For each trial the judge is the first listed model whose family differs from the trial's model; `bench judge <run> --judge <provider/modelId>` forces one for every trial. `authPath` is relative to the repository root (same format as pi's `auth.json`, gitignored). Per DESIGN 9 the judge is never the model under test: a trial for which no listed model is outside its family, or whose model is the family of the forced `--judge`, is not judged (its judge questions stay `pending`, `judge.json` records `refused`).

A model's family is its provider plus its id with version suffixes stripped: a trailing dated snapshot (`-20250929`, `-2025-08-07`), a Vertex-style `@20250929`, `-latest` or `-preview`. So `anthropic/claude-sonnet-4-5-20250929` and `anthropic/claude-sonnet-4-5` are one family and never judge each other, while `openai/gpt-5-mini` is a family of its own. `judge-summary.json` lists the judge models used under `judgeModels`.

Judged `abstain` and `judge` probe answers (rubric `probes`) are written back into the trial's `checks.json` (`answers[].pass`, `scoreProbe`), then `trial.json` and `metrics.json`, so `score_probe` has the same denominator before and after judging.

`labels.jsonl`: one hand label per line, added after the pilot (30 to 50 per judged rubric). Record shape:

```json
{ "run": "<run-id>", "trial": "<trial dir name>", "rubric": "b1", "subject": "ep-1a2b3c4d", "label": "PASS", "note": "optional" }
```

`run`, `trial`, `rubric` and `subject` identify an item in `bench/results/<run>/trials/<trial>/judge.json` (`rubrics[rubric].items[].subject`); `label` is the human verdict. `bench judge <run> --kappa` prints the confusion matrix (PASS positive, rows human, columns judge) and Cohen's kappa per rubric and judge model over the labels of that run, and writes `judge-kappa.json` next to `judge-summary.json`. Verdicts of every judge model that ran on an item are kept under `items[].verdicts`, so running `bench judge` once per configured model and then `--kappa` compares them.

Rubric ids follow DESIGN 9; `b3` is "fact present" and `b3c` "condition kept". Script rubrics (`a1` to `a4`, `b5`, `b6`, `c1` to `c3`, `c6`, `d1` to `d4`, `e1`, `e2`, `e4`) need no model; `c1` and `e1` count detections, so their `pass` equals their `total`. `pass` always means the desirable outcome (`c3`: no re-derivation; `c6`: not spurious; `e2`: re-read before acting). `d1` says in its evidence whether it read the tree at `treeAfter` or used the proxy (trap file in the fold's `files`, trap left on the final tree).
