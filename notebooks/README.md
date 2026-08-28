# Notebooks

Each task as one single, self-contained `.ipynb` file — everything needed
(code, sample data generation, a demo run, and an automated offline test
suite) is inside the notebook itself, with outputs already saved from a
verified run.

| Notebook | Task |
|---|---|
| `Task5_RAG_System_LangChain.ipynb` | RAG System using LangChain |
| `Task6_Context_Aware_Chat_Assistant.ipynb` | Context-Aware Chat Assistant with Memory |
| `Task7_Email_Assistant.ipynb` | Automated Generative AI Email Assistant with API Functions |
| `Task8_MultiAgent_Report_System.ipynb` | Multi-Agent AI System for Report Generation |

## How to use

Open a notebook in Jupyter (`jupyter notebook` / `jupyter lab` / VS Code /
Google Colab) and run all cells top to bottom (**Run All**). Each notebook:

1. Installs its dependencies (`%pip install -q ...`).
2. Generates any sample data it needs (Task 5 creates its own sample PDF + Excel file).
3. Defines the implementation (loaders/retriever/generator, memory, API functions, or agents, depending on the task).
4. Runs a scripted demo showing the required behavior (e.g. Task 6 demonstrates the assistant recalling "My name is Ahmed" a few turns later).
5. Runs an automated, offline test suite that proves the logic works, printing `PASS ...` lines.
6. Has an optional "Interactive mode" cell you can run yourself in Jupyter (it does nothing when executed non-interactively, e.g. by "Run All").

## `USE_LIVE_MODEL` flag

Every notebook defines `USE_LIVE_MODEL = False` near the top. As shipped,
each notebook runs entirely offline using a lightweight deterministic
stand-in in place of a real LLM, which is what produced the saved outputs —
this keeps the notebook runnable and gradeable with no internet access or
model download required.

**To use a real Hugging Face model** (`google/flan-t5-base` and, for Task 5,
`sentence-transformers/all-MiniLM-L6-v2`), change that line to
`USE_LIVE_MODEL = True` and re-run the notebook. This requires internet
access to download the model on first use.
