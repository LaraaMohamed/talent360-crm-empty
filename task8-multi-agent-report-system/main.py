"""
CLI entry point for the multi-agent report generation system.

Run:
    python main.py
"""
from orchestrator import ReportOrchestrator


def main():
    print("Loading agents...")
    orchestrator = ReportOrchestrator(use_evaluator=True)
    print("Multi-agent system ready. Type 'exit' to quit.\n")

    while True:
        question = input("Enter a question to build a report on: ").strip()
        if question.lower() in ("exit", "quit"):
            break
        if not question:
            continue

        try:
            result = orchestrator.generate_report(question)
        except ValueError as e:
            print(f"Error: {e}\n")
            continue

        print("\n=== PLAN (Planner Agent) ===")
        print(result["plan"])
        print("\n=== RESEARCH NOTES (Research Agent) ===")
        print(result["research_notes"])
        print("\n=== REPORT (Writer Agent) ===")
        print(result["report"])
        print("\n=== SUMMARY (Summary Agent) ===")
        print(result["summary"])
        if "evaluation" in result:
            print("\n=== EVALUATION (Evaluator Agent) ===")
            print(result["evaluation"])
        print()


if __name__ == "__main__":
    main()
