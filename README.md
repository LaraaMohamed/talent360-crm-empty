# Generative AI Tasks

Four independent, self-contained mini-projects, each in its own folder with
its own `README.md` and `requirements.txt`:

| Folder | Task | Summary |
|---|---|---|
| `task5-rag-langchain/` | RAG System using LangChain | Answers questions over a PDF/Excel knowledge base using a LangChain retriever + generator pipeline (FAISS + Hugging Face embeddings/LLM). |
| `task6-context-aware-chat-assistant/` | Context-Aware Chat Assistant with Memory | A chat loop that stores conversation history and injects it into every new prompt so the model remembers earlier turns. |
| `task7-email-assistant/` | Automated Generative AI Email Assistant with API Functions | Generates a professional email reply from a customer message and automatically formats, saves, and simulates sending it, with error handling. |
| `task8-multi-agent-report-system/` | Multi-Agent AI System for Report Generation | Planner, Research, Writer, Summary, and Evaluator agents collaborate step by step to turn a question into a structured report. |

Each folder can be run independently:
```bash
cd <task-folder>
pip install -r requirements.txt
python main.py
```
