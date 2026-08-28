# Task 5 — RAG System with LangChain

Answers questions over a PDF or Excel knowledge base using Retrieval-Augmented
Generation (RAG): a retriever finds the most relevant chunks and a generator
LLM composes the answer from them.

## Architecture
1. **Loader** — `PyPDFLoader` (PDF) or `UnstructuredExcelLoader` (Excel) reads the source file.
2. **Splitter** — `RecursiveCharacterTextSplitter` breaks the document into overlapping chunks.
3. **Retriever** — chunks are embedded with `sentence-transformers/all-MiniLM-L6-v2` and stored in a FAISS vector index; the retriever pulls the top-k relevant chunks for a query.
4. **Generator** — a local `google/flan-t5-base` model (via Hugging Face `transformers`) generates the final answer conditioned on the retrieved chunks, orchestrated by LangChain's `RetrievalQA` chain.

## Setup
```bash
pip install -r requirements.txt
```

## Run
```bash
python main.py sample_data/company_faq.pdf
# or
python main.py sample_data/employees.xlsx
```

Then ask questions interactively, e.g.:
```
Question: What is the company's refund policy?
```

## Notes
- Swap `build_generator()` in `rag_pipeline.py` for an API-based LLM (e.g. `ChatOpenAI`, `ChatAnthropic`) if you have API access — the retrieval logic stays unchanged.
- `sample_data/` contains a small sample Excel sheet to test the pipeline end to end.
