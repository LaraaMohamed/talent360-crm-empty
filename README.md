# Generative AI Tasks

Four independent, self-contained mini-projects, each in its own folder,
each ready to hand in and grade on its own — with its own `README.md`,
`requirements.txt`, runnable code, sample data, and a passing offline test
suite whose output is saved to `test_output.txt` in that folder.

| Folder | Task | Summary |
|---|---|---|
| `task5-rag-langchain/` | RAG System using LangChain | Answers questions over a PDF/Excel knowledge base using a LangChain retriever + generator pipeline (FAISS + Hugging Face embeddings/LLM). |
| `task6-context-aware-chat-assistant/` | Context-Aware Chat Assistant with Memory | A chat loop that stores conversation history and injects it into every new prompt so the model remembers earlier turns. |
| `task7-email-assistant/` | Automated Generative AI Email Assistant with API Functions | Generates a professional email reply from a customer message and automatically formats, saves, and simulates sending it, with error handling. |
| `task8-multi-agent-report-system/` | Multi-Agent AI System for Report Generation | Planner, Research, Writer, Summary, and Evaluator agents collaborate step by step to turn a question into a structured report. |

## Running a task
```bash
cd <task-folder>
pip install -r requirements.txt
python main.py
```

## Grading / verification
Each folder includes an offline automated test file (`test_*.py`) that
exercises the actual logic (retrieval, memory, API error handling, agent
hand-offs) using a lightweight fake model, so it runs without downloading
any LLM or needing internet access — useful for a fast, deterministic check
before running the interactive `main.py` with a real model:

```bash
cd <task-folder>
python test_*.py
```

Each folder's `test_output.txt` is a saved run of that command, and each
`README.md` has an "Objectives checklist" mapping the task's stated
requirements to the code that satisfies them.

## Development notes
- Every LLM call is behind an injectable `generator` callable, defaulting
  to a local Hugging Face `transformers` model (`google/flan-t5-base`), so
  each project runs fully offline once dependencies + model weights are
  cached, and can be swapped for an API-based LLM (OpenAI/Anthropic) by
  passing a different callable — no other code changes needed.
- `task5-rag-langchain` builds the retriever and generator steps
  explicitly rather than using LangChain's legacy `RetrievalQA` chain,
  which was removed in `langchain` 1.0.
