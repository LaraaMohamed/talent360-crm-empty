"""
CLI entry point for the RAG system.

Usage:
    python main.py path/to/document.pdf
    python main.py path/to/sheet.xlsx
"""
import sys

from rag_pipeline import build_rag_chain, answer_question


def main():
    if len(sys.argv) != 2:
        print("Usage: python main.py <path-to-pdf-or-xlsx>")
        sys.exit(1)

    file_path = sys.argv[1]
    print(f"Loading knowledge base from: {file_path}")
    chain = build_rag_chain(file_path)
    print("Knowledge base ready. Ask questions below (type 'exit' to quit).\n")

    while True:
        question = input("Question: ").strip()
        if question.lower() in ("exit", "quit"):
            break
        if not question:
            continue
        answer, sources = answer_question(chain, question)
        print(f"\nAnswer: {answer}\n")
        print("Sources:")
        for doc in sources:
            snippet = doc.page_content[:150].replace("\n", " ")
            print(f"  - {snippet}...")
        print()


if __name__ == "__main__":
    main()
