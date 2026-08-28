"""
RAG (Retrieval-Augmented Generation) pipeline built with LangChain.

Loads a knowledge base from a PDF or Excel file, splits it into chunks,
embeds the chunks into a FAISS vector store (the retriever), and answers
questions by retrieving relevant chunks and feeding them to a generator LLM.

The retriever and generator are injected as plain callables/objects so the
pipeline logic can be unit-tested offline with fakes (see test_rag_pipeline.py)
and swapped for different embedding/LLM backends without touching this file.
"""
import os

import pandas as pd
from langchain_core.documents import Document
from langchain_community.document_loaders import PyPDFLoader
from langchain_community.vectorstores import FAISS
from langchain_text_splitters import RecursiveCharacterTextSplitter

PROMPT_TEMPLATE = (
    "Answer the question using only the context below. If the answer is not "
    "in the context, say you don't know.\n\n"
    "Context:\n{context}\n\nQuestion: {question}\n\nAnswer:"
)


def load_excel(file_path: str) -> list[Document]:
    """Loads every sheet of an Excel workbook into one Document per row."""
    sheets = pd.read_excel(file_path, sheet_name=None)
    documents = []
    for sheet_name, df in sheets.items():
        for row_idx, row in df.iterrows():
            text = "; ".join(f"{col}: {val}" for col, val in row.items() if pd.notna(val))
            if text:
                documents.append(
                    Document(
                        page_content=text,
                        metadata={"source": file_path, "sheet": sheet_name, "row": int(row_idx)},
                    )
                )
    return documents


def load_documents(file_path: str) -> list[Document]:
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".pdf":
        return PyPDFLoader(file_path).load()
    if ext in (".xlsx", ".xls"):
        return load_excel(file_path)
    raise ValueError(f"Unsupported file type: {ext}. Use a .pdf or .xlsx file.")


def split_documents(documents: list[Document], chunk_size: int = 500, chunk_overlap: int = 50) -> list[Document]:
    splitter = RecursiveCharacterTextSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    return splitter.split_documents(documents)


def build_vector_store(chunks: list[Document], embeddings) -> FAISS:
    """The retriever's index: embeds chunks and stores them for similarity search."""
    return FAISS.from_documents(chunks, embeddings)


def build_default_embeddings():
    from langchain_community.embeddings import HuggingFaceEmbeddings

    return HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")


def build_default_generator(model_name: str = "google/flan-t5-base", max_new_tokens: int = 256):
    """Returns a callable(prompt: str) -> str backed by a local Hugging Face model."""
    from transformers import pipeline as hf_pipeline

    pipe = hf_pipeline("text2text-generation", model=model_name, max_new_tokens=max_new_tokens)
    return lambda prompt: pipe(prompt)[0]["generated_text"].strip()


class RAGSystem:
    """Ties the retriever (vector store) and generator (LLM) together."""

    def __init__(self, vector_store: FAISS, generator, top_k: int = 3):
        self.vector_store = vector_store
        self.generator = generator
        self.top_k = top_k

    @classmethod
    def from_file(cls, file_path: str, embeddings=None, generator=None, top_k: int = 3) -> "RAGSystem":
        documents = load_documents(file_path)
        chunks = split_documents(documents)
        vector_store = build_vector_store(chunks, embeddings or build_default_embeddings())
        return cls(vector_store, generator or build_default_generator(), top_k=top_k)

    def retrieve(self, question: str) -> list[Document]:
        return self.vector_store.similarity_search(question, k=self.top_k)

    def build_prompt(self, question: str, retrieved_docs: list[Document]) -> str:
        context = "\n\n".join(doc.page_content for doc in retrieved_docs)
        return PROMPT_TEMPLATE.format(context=context, question=question)

    def answer(self, question: str):
        retrieved_docs = self.retrieve(question)
        prompt = self.build_prompt(question, retrieved_docs)
        answer_text = self.generator(prompt)
        return answer_text, retrieved_docs
