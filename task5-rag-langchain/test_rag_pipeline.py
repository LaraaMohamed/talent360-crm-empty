"""
Offline tests for the RAG pipeline.

These tests use a deterministic fake embedding model (no network/model
download required) so the retriever + generator wiring can be verified in
any environment, including ones without internet access to Hugging Face.
Run with:
    python test_rag_pipeline.py
"""
import hashlib
import os

from langchain_core.embeddings import Embeddings

from rag_pipeline import RAGSystem, load_documents, split_documents, build_vector_store


class FakeEmbeddings(Embeddings):
    """Deterministic bag-of-words style embedding, no model download needed."""

    def _embed(self, text: str):
        vector = [0.0] * 32
        for word in text.lower().split():
            idx = int(hashlib.md5(word.encode()).hexdigest(), 16) % 32
            vector[idx] += 1.0
        return vector

    def embed_documents(self, texts):
        return [self._embed(t) for t in texts]

    def embed_query(self, text):
        return self._embed(text)


def fake_generator(prompt: str) -> str:
    """Echoes back the context so tests can assert retrieval actually happened."""
    return f"[FAKE ANSWER based on]: {prompt.split('Context:')[1].split('Question:')[0].strip()}"


def test_load_and_split_excel():
    here = os.path.dirname(__file__)
    documents = load_documents(os.path.join(here, "sample_data", "company_faq.xlsx"))
    assert len(documents) > 0, "Excel loader should produce at least one document"
    assert any("refund" in d.page_content.lower() for d in documents), "Expected FAQ content about refunds"
    chunks = split_documents(documents)
    assert len(chunks) >= len(documents)
    print(f"PASS test_load_and_split_excel ({len(documents)} rows -> {len(chunks)} chunks)")


def test_load_pdf():
    here = os.path.dirname(__file__)
    pdf_path = os.path.join(here, "sample_data", "company_handbook.pdf")
    documents = load_documents(pdf_path)
    assert len(documents) > 0, "PDF loader should produce at least one page"
    print(f"PASS test_load_pdf ({len(documents)} pages)")


def test_retriever_finds_relevant_chunk():
    here = os.path.dirname(__file__)
    documents = load_documents(os.path.join(here, "sample_data", "company_faq.xlsx"))
    chunks = split_documents(documents)
    vector_store = build_vector_store(chunks, FakeEmbeddings())
    rag = RAGSystem(vector_store, fake_generator, top_k=2)

    retrieved = rag.retrieve("What is the refund policy?")
    assert any("refund" in d.page_content.lower() for d in retrieved), (
        "Retriever should surface the refund-related chunk for a refund question"
    )
    print("PASS test_retriever_finds_relevant_chunk")


def test_answer_uses_retrieved_context():
    here = os.path.dirname(__file__)
    documents = load_documents(os.path.join(here, "sample_data", "company_faq.xlsx"))
    chunks = split_documents(documents)
    vector_store = build_vector_store(chunks, FakeEmbeddings())
    rag = RAGSystem(vector_store, fake_generator, top_k=2)

    answer, sources = rag.answer("What are the working hours?")
    assert "FAKE ANSWER" in answer
    assert len(sources) == 2
    print("PASS test_answer_uses_retrieved_context")


def test_unsupported_file_type_raises():
    try:
        load_documents("notes.txt")
    except ValueError:
        print("PASS test_unsupported_file_type_raises")
        return
    raise AssertionError("Expected ValueError for unsupported file type")


if __name__ == "__main__":
    test_load_and_split_excel()
    test_load_pdf()
    test_retriever_finds_relevant_chunk()
    test_answer_uses_retrieved_context()
    test_unsupported_file_type_raises()
    print("\nAll RAG pipeline tests passed.")
