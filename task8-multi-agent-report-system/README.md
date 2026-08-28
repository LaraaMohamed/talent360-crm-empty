# Task 8 — Multi-Agent AI System for Report Generation

Multiple specialized agents collaborate step by step to turn a single user
question into a structured report, instead of relying on one LLM call.

## Objectives checklist
- [x] Planner Agent
- [x] Research Agent
- [x] Writer Agent
- [x] Summary Agent
- [x] Evaluator Agent (optional, on by default, can be disabled)
- [x] Agents work together step by step, each consuming the previous agent's output
- [x] Automated tests proving the hand-off order and error handling

## Agents
1. **Planner Agent** (`agents.py:PlannerAgent`) — breaks the question into a short numbered research plan.
2. **Research Agent** (`agents.py:ResearchAgent`) — produces notes for each point in the plan (swap in a real search/retrieval API for production use).
3. **Writer Agent** (`agents.py:WriterAgent`) — drafts a structured report (intro/body/conclusion) from the research notes.
4. **Summary Agent** (`agents.py:SummaryAgent`) — condenses the report into a short executive summary.
5. **Evaluator Agent** (`agents.py:EvaluatorAgent`, optional) — reviews the report against the original question and flags gaps.

`orchestrator.py` (`ReportOrchestrator`) runs the agents in sequence, each one consuming the previous agent's output, and returns all intermediate artifacts plus the final report.

## Setup
```bash
pip install -r requirements.txt
```

## Run
```bash
python main.py
```

## Example flow
```
Enter a question to build a report on: What are the benefits of remote work for small businesses?

=== PLAN (Planner Agent) ===
1. Cost savings ...
=== RESEARCH NOTES (Research Agent) ===
...
=== REPORT (Writer Agent) ===
...
=== SUMMARY (Summary Agent) ===
...
=== EVALUATION (Evaluator Agent) ===
...
```

## Automated tests (run offline, no model download required)
`test_orchestrator.py` injects a fake LLM that returns a distinct, traceable
label per agent role, then asserts each agent's prompt actually contains the
previous agent's output — proving the hand-off chain (Planner → Research →
Writer → Summary/Evaluator) is real, not just that some text comes back.

```bash
python test_orchestrator.py
```

Verified output (see `test_output.txt`):
```
PASS test_agents_run_in_order_with_evaluator
PASS test_evaluator_is_optional
PASS test_empty_question_is_rejected
PASS test_all_four_required_agents_exist

All multi-agent orchestrator tests passed.
```

## Notes
- All agents share one `LLMBackend` (a Hugging Face `text2text-generation` pipeline, `google/flan-t5-base`, loaded lazily) to keep the system self-contained and runnable offline; each agent uses a different prompt/role rather than a different model. `LLMBackend(generator=...)` accepts any `callable(prompt) -> str`, which is how the tests substitute a fake model.
- To use a stronger model or an API-based LLM (OpenAI/Anthropic), only `agents.py:LLMBackend` needs to change — the agent roles and orchestration stay the same.
