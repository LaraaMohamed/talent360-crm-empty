# Task 5 — RAG System with LangChain

Answers questions over a PDF or Excel knowledge base using Retrieval-Augmented
Generation (RAG): a **retriever** finds the most relevant chunks and a
**generator** LLM composes the answer from them.

## Objectives checklist
- [x] Load a PDF as knowledge base (`sample_data/company_handbook.pdf`)
- [x] Load an Excel sheet as knowledge base (`sample_data/company_faq.xlsx`)
- [x] Split documents into chunks
- [x] Build a retriever (embeddings + FAISS vector index)
- [x] Build a generator (LLM that answers from retrieved context)
- [x] Wire retriever + generator into one RAG system
- [x] Automated tests proving retrieval and generation work correctly

## Architecture
1. **Loader** (`rag_pipeline.py:load_documents`) — `PyPDFLoader` reads PDFs page by page; a custom pandas-based loader (`load_excel`) turns every Excel row into one `Document`, avoiding heavyweight optional dependencies.
2. **Splitter** — `RecursiveCharacterTextSplitter` breaks documents into overlapping chunks (`split_documents`).
3. **Retriever** — chunks are embedded (`sentence-transformers/all-MiniLM-L6-v2` via `HuggingFaceEmbeddings`) and stored in a FAISS vector index (`build_vector_store`); `RAGSystem.retrieve()` returns the top-k most relevant chunks for a query.
4. **Generator** — `RAGSystem.build_prompt()` inserts the retrieved chunks into a prompt template, and a local `google/flan-t5-base` model (Hugging Face `transformers`) generates the final answer (`RAGSystem.answer()`).

The retriever and generator are injected as plain objects/callables
(`RAGSystem.__init__`), so the pipeline logic is decoupled from any specific
embedding or LLM backend and can be unit-tested without one.

## Setup
```bash
pip install -r requirements.txt
```

## Run
```bash
python main.py sample_data/company_handbook.pdf
# or
python main.py sample_data/company_faq.xlsx
```

Then ask questions interactively, e.g.:
```
Question: What is the company's refund policy?
Question: What are the working hours?
```

## Automated tests (run offline, no model download required)
`test_rag_pipeline.py` verifies the pipeline's logic — loading, chunking,
and that the retriever actually surfaces the relevant chunk for a query —
using a deterministic fake embedding model, so it runs in any environment
(including ones without internet access to Hugging Face).

```bash
python test_rag_pipeline.py
```

Verified output (see `test_output.txt`):
```
PASS test_load_and_split_excel (5 rows -> 5 chunks)
PASS test_load_pdf (3 pages)
PASS test_retriever_finds_relevant_chunk
PASS test_answer_uses_retrieved_context
PASS test_unsupported_file_type_raises

All RAG pipeline tests passed.
```

## Notes
- Swap `build_default_generator()` in `rag_pipeline.py` for an API-based LLM (e.g. `ChatOpenAI`, `ChatAnthropic`) if you have API access — pass it as the `generator` argument to `RAGSystem.from_file()`. The retrieval logic stays unchanged.
- `sample_data/` contains a sample PDF (employee handbook) and a sample Excel FAQ sheet to test both loaders end to end.
- Package versions in `requirements.txt` are pinned to what was actually installed and tested (LangChain 1.x; the legacy `RetrievalQA` chain from LangChain 0.x was intentionally not used since it was removed in `langchain` 1.0 — this pipeline builds the retriever+generator steps explicitly instead).
