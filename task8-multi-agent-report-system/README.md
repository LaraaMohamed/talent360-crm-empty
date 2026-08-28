# Task 8 — Multi-Agent AI System for Report Generation

Multiple specialized agents collaborate step by step to turn a single user
question into a structured report, instead of relying on one LLM call.

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

## Notes
- All agents share one `LLMBackend` (a Hugging Face `text2text-generation` pipeline, `google/flan-t5-base`) to keep the system self-contained and runnable offline; each agent uses a different prompt/role rather than a different model.
- To use a stronger model or an API-based LLM (OpenAI/Anthropic), only `agents.py:LLMBackend` needs to change — the agent roles and orchestration stay the same.
