"""
RAG (Retrieval-Augmented Generation) pipeline built with LangChain.

Loads a knowledge base from a PDF or Excel file, splits it into chunks,
embeds the chunks into a FAISS vector store, and answers questions by
retrieving relevant chunks and feeding them to a generator model.
"""
import os

from langchain_community.document_loaders import PyPDFLoader, UnstructuredExcelLoader
from langchain_community.vectorstores import FAISS
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.llms import HuggingFacePipeline
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain.chains import RetrievalQA


def load_documents(file_path: str):
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".pdf":
        loader = PyPDFLoader(file_path)
    elif ext in (".xlsx", ".xls"):
        loader = UnstructuredExcelLoader(file_path, mode="elements")
    else:
        raise ValueError(f"Unsupported file type: {ext}. Use a .pdf or .xlsx file.")
    return loader.load()


def build_vector_store(documents, chunk_size: int = 500, chunk_overlap: int = 50):
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size, chunk_overlap=chunk_overlap
    )
    chunks = splitter.split_documents(documents)
    embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
    return FAISS.from_documents(chunks, embeddings)


def build_generator(model_name: str = "google/flan-t5-base", max_new_tokens: int = 256):
    from transformers import pipeline as hf_pipeline

    pipe = hf_pipeline(
        "text2text-generation",
        model=model_name,
        max_new_tokens=max_new_tokens,
    )
    return HuggingFacePipeline(pipeline=pipe)


def build_rag_chain(file_path: str):
    documents = load_documents(file_path)
    vector_store = build_vector_store(documents)
    retriever = vector_store.as_retriever(search_kwargs={"k": 3})
    llm = build_generator()
    return RetrievalQA.from_chain_type(
        llm=llm,
        retriever=retriever,
        return_source_documents=True,
    )


def answer_question(chain, question: str):
    result = chain.invoke({"query": question})
    return result["result"], result["source_documents"]
